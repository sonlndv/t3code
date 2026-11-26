// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const makeSettings = (binaryName: string, displayName: string) =>
  makeProviderSettingsSchema(
    {
      enabled: Schema.Boolean.pipe(
        Schema.withDecodingDefault(Effect.succeed(false)),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
      binaryPath: makeBinaryPathSetting(binaryName).pipe(
        Schema.annotateKey({
          title: "Binary path",
          description: `Path to the ${displayName} coding agent binary.`,
          providerSettingsForm: { placeholder: binaryName, clearWhenEmpty: "omit" },
        }),
      ),
      launchArgs: TrimmedString.pipe(
        Schema.withDecodingDefault(Effect.succeed("")),
        Schema.annotateKey({
          title: "Launch arguments",
          description: `Additional CLI arguments passed to ${binaryName} --mode ${binaryName === "pi" ? "rpc" : "rpc-ui"} on session start.`,
          providerSettingsForm: { clearWhenEmpty: "omit" },
        }),
      ),
      customModels: Schema.Array(CustomModelSetting).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
    },
    {
      order: ["binaryPath", "launchArgs"],
    },
  );

export const PiSettings = makeSettings("pi", "Pi");
export type PiSettings = typeof PiSettings.Type;

export const OmpSettings = makeSettings("omp", "Oh My Pi");
export type OmpSettings = typeof OmpSettings.Type;
