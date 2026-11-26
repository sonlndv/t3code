import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  brokenVersionDetail,
  noCompatibilityPolicy,
  type ProviderCompatibilityLookup,
} from "@t3tools/provider-core/server/compatibility";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import type { PiSettings } from "../settings.ts";
import { PI_FLAVOR, type PiFlavor } from "./flavor.ts";

import {
  makePiRpcConnection,
  piRecordField,
  piRecordString,
  requireOmpApprovalSupport,
  resolvePiModelSlug,
} from "./rpc.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { isPiThinkingLevel } from "./modelCapabilities.ts";
import { runPiVersionCommand } from "./status.ts";

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

// Pi's `errorMessage` is the provider's raw response text and can echo
// credentials, so only a leading HTTP status reaches the error detail.
const piTurnErrorDetail = (displayName: string, errorMessage: string | undefined) => {
  const status = errorMessage?.match(/^([45]\d\d)\b/)?.[1];
  return status === undefined
    ? `${displayName} could not generate text: the model provider reported an error.`
    : `${displayName} could not generate text: the model provider returned HTTP ${status}.`;
};

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  compatibility: ProviderCompatibilityLookup = noCompatibilityPolicy,
  flavor: PiFlavor = PI_FLAVOR,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { binaryName, displayName } = flavor;

  const runPiJson: TextGenerationOperations.Runner = Effect.fn(
    `${displayName}TextGeneration.runJson`,
  )(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      const hasThinkingLevel =
        thinking !== undefined &&
        (isPiThinkingLevel(thinking) || (binaryName === "omp" && thinking === "auto"));
      if (hasThinkingLevel) {
        const output = yield* runPiVersionCommand(piSettings, environment, cwd, flavor).pipe(
          Effect.timeoutOption(4_000),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const version =
          Option.isSome(output) && output.value.code === 0
            ? parseGenericCliVersion(`${output.value.stdout}\n${output.value.stderr}`)
            : null;
        const broken =
          version === null
            ? `T3 Code could not determine the ${displayName} version. Update ${displayName} and try again.`
            : brokenVersionDetail({
                name: displayName,
                version,
                advisory: yield* compatibility(flavor.driverKind, version),
              });
        if (broken !== undefined) {
          return yield* new TextGenerationError({ operation, detail: broken });
        }
      }

      const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs, flavor);
      if (!resolvedLaunchArgs.ok) {
        return yield* new TextGenerationError({
          operation,
          detail: resolvedLaunchArgs.message,
        });
      }
      if (binaryName === "omp") {
        yield* requireOmpApprovalSupport(
          piSettings.binaryPath || binaryName,
          environment,
          cwd,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail:
                  "Cannot confirm OMP can disable tools and extensions for text generation. Update OMP and try again.",
                cause,
              }),
          ),
        );
      }
      const launch = buildPiRpcLaunch({
        flavor,
        launchArgs: resolvedLaunchArgs.args,
        environment,
        mcpSession: undefined,
        extensionPath: undefined,
        ephemeral: true,
        shortLived: true,
        disableExtensions: true,
        // Background naming/content helpers must never mutate the workspace.
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: piSettings.binaryPath || binaryName,
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (modelSelection.model !== "default") {
        // Reject unusable custom slugs; silently using Pi's default would misreport the requested model.
        const inventory = yield* connection
          .request({ type: "get_available_models" })
          .pipe(Effect.orElseSucceed(() => undefined));
        const parsed = resolvePiModelSlug(modelSelection.model, piRecordField(inventory, "models"));
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `${displayName} model '${modelSelection.model}' must use provider/model format.`,
          });
        }
        yield* connection
          .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
          .pipe(
            // Model discovery loads extensions that this background helper disables.
            Effect.mapError((error) =>
              error._tag === "PiRpcError" && error.operation === "set_model"
                ? new TextGenerationError({
                    operation,
                    detail:
                      `${displayName} rejected model '${modelSelection.model}': ${error.detail ?? "unknown error"}. ` +
                      `Text generation runs ${displayName} with --no-extensions. Pick a built-in model or one defined in ${binaryName === "omp" ? "models.yml" : "models.json"}.`,
                    cause: error,
                  })
                : error,
            ),
          );
      }

      if (hasThinkingLevel) {
        // Pi rejects xhigh/max for models without a thinkingLevelMap entry; a stale saved
        // level falls back to Pi's default instead of failing the whole generation.
        yield* connection
          .request({ type: "set_thinking_level", level: thinking })
          .pipe(Effect.catchTags({ PiRpcError: () => Effect.void }));
      }

      yield* connection.request({ type: "prompt", message: prompt });
      // Provider failures (bad key, rate limit, 5xx) arrive on the assistant
      // `message_end`. Keep only the latest, since Pi can retry and still answer.
      let turnError: string | undefined;
      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === (binaryName === "omp" ? "session_settled" : "agent_settled"))
            return;
          if (
            binaryName === "omp" &&
            event["type"] === "prompt_result" &&
            event["status"] === "error"
          ) {
            return yield* new TextGenerationError({
              operation,
              detail: turnError ?? piTurnErrorDetail(displayName, undefined),
            });
          }
          const message = event["message"];
          if (event["type"] === "message_end" && piRecordString(message, "role") === "assistant") {
            turnError =
              piRecordString(message, "stopReason") === "error"
                ? piTurnErrorDetail(displayName, piRecordString(message, "errorMessage"))
                : undefined;
          }
        }
      });
      const data = yield* connection.request({ type: "get_last_assistant_text" });
      const text = piRecordString(data, "text")?.trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: turnError ?? `${displayName} returned empty output.`,
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, displayName, text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: `${displayName} request timed out.` }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: `${displayName} text generation failed.`,
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    `${displayName}TextGeneration`,
    TextGenerationOperations.withoutInvestigation(displayName, runPiJson),
  );
});
