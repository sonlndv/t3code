// @effect-diagnostics nodeBuiltinImport:off -- The native TUI must inherit the reopened Windows console fd.
import * as NodeChildProcess from "node:child_process";

import {
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  RuntimeMode,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  prepareOmpResume,
  requireOmpApprovalSupport,
  resolveOmpLaunchArgs,
} from "@t3tools/provider-pi/server";
import { OmpSettings } from "@t3tools/provider-pi/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { ompEnvironmentFingerprint, readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { readServerSettingsFromDisk } from "../serverSettings.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { interactiveStdin } from "./consoleStdin.ts";
import { ThreadUsageError } from "./thread.ts";

interface NativeThreadRow {
  readonly archivedAt: string | null;
  readonly projectId: ProjectId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly busy: number;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly fenced: number;
}

const isRuntimeMode = Schema.is(RuntimeMode);
const decodeOmpSettings = Schema.decodeUnknownOption(OmpSettings, { onExcessProperty: "error" });

export const readNativeThread = Effect.fn("cli.thread.readNativeThread")(function* (id: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<NativeThreadRow>`
    SELECT t.archived_at AS archivedAt, t.project_id AS projectId, t.provider_instance_id AS instanceId,
      COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd,
      json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS sessionFile,
      t.runtime_mode AS runtimeMode, t.interaction_mode AS interactionMode,
      (json_type(t.payload_json, '$.linkOrigin') IS NOT NULL AND
        json_extract(t.payload_json, '$.linkOrigin.access') IS NOT 'full-access') AS fenced,
      (EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
        AND r.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.thread_id = t.thread_id
          AND e.status IN ('pending', 'running'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_session_bindings b
          JOIN orchestration_v2_projection_provider_sessions s USING (provider_session_id)
          WHERE b.thread_id = t.thread_id AND s.status NOT IN ('stopped', 'error'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads other
          WHERE other.thread_id = t.thread_id AND (other.status = 'active'
            OR json_array_length(other.payload_json, '$.pendingBackgroundTasks') > 0))
      ) AS busy
    FROM orchestration_v2_projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
    LEFT JOIN orchestration_v2_projection_provider_threads pt
      ON pt.provider_thread_id = t.active_provider_thread_id AND pt.thread_id = t.thread_id
      AND pt.provider_instance_id = t.provider_instance_id AND pt.owner_node_id IS NULL
      AND pt.provider_instance_id = json_extract(t.payload_json, '$.modelSelection.instanceId')
      AND pt.driver = 'omp' AND json_extract(pt.payload_json, '$.nativeThreadRef.driver') = 'omp'
      AND json_type(pt.payload_json, '$.nativeThreadRef.nativeId') = 'text'
      AND json_extract(pt.payload_json, '$.nativeThreadRef.strength') = 'strong'
    WHERE t.thread_id = ${id} AND t.deleted_at IS NULL
  `.pipe(
    Effect.mapError(
      () =>
        new ThreadUsageError({
          detail: "Cannot read this local T3 database. Check --base-dir and update T3 Code.",
        }),
    ),
  );
  if (!row) {
    return yield* new ThreadUsageError({
      detail: "No such thread in this local T3 home. Check the thread id and --base-dir.",
    });
  }
  if (row.archivedAt === null) {
    return yield* new ThreadUsageError({
      detail: "Finish the current turn and archive this thread in T3 before opening native OMP.",
    });
  }
  if (!row.sessionFile) {
    return yield* new ThreadUsageError({
      detail:
        "This thread has no current native OMP session. Local ACP and Pi threads are not native OMP sessions.",
    });
  }
  if (row.busy) {
    return yield* new ThreadUsageError({
      detail: "T3 is still using this thread. Wait for archiving and outstanding work to finish.",
    });
  }
  if (row.fenced || row.interactionMode !== "default" || !isRuntimeMode(row.runtimeMode)) {
    return yield* new ThreadUsageError({
      detail: "Native OMP cannot enforce this thread's access or interaction policy.",
    });
  }
  return {
    cwd: row.cwd,
    sessionFile: row.sessionFile,
    instanceId: row.instanceId,
    projectId: row.projectId,
  };
});

export const nativeOmpInstance = Effect.fn("cli.thread.nativeOmpInstance")(function* (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  target: { readonly instanceId: ProviderInstanceId; readonly projectId: ProjectId },
) {
  const instance = settings.providerInstances[target.instanceId];
  if (
    instance?.driver !== "omp" ||
    !resolveProjectProviderInstanceEnabled(settings, target.projectId, target.instanceId)
  ) {
    return yield* new ThreadUsageError({
      detail: "The saved native OMP instance is missing or disabled for this project.",
    });
  }
  const config = decodeOmpSettings(instance.config ?? {});
  const launch = Option.isSome(config) ? resolveOmpLaunchArgs(config.value.launchArgs) : undefined;
  if (
    Option.isNone(config) ||
    !launch?.ok ||
    launch.args.includes("--api-key") ||
    launch.args.includes("--profile") ||
    instance.environment?.some(
      (variable) =>
        variable.sensitive ||
        variable.valueRedacted ||
        typeof variable.value !== "string" ||
        /^(?:T3_|T3CODE_|PI_CONFIG_FILES$|NODE_OPTIONS$|BUN_OPTIONS$)/i.test(variable.name),
    )
  ) {
    return yield* new ThreadUsageError({
      detail:
        "Native entry cannot reproduce this instance's protected environment, credentials, or launch settings. Use T3 chat instead.",
    });
  }
  return {
    binaryPath: config.value.binaryPath,
    args: launch.args,
    environment: instance.environment,
  };
});

export const openNativeThread = Effect.fn("cli.thread.openNativeThread")(function* (
  id: ThreadId,
  flags: CliAuthLocationFlags,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return yield* new ThreadUsageError({
      detail: "Run t3 thread native from an interactive terminal.",
    });
  }
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
    quietLogs: true,
    useDevStateDirectory: Option.isSome(flags.devUrl ?? Option.none()),
  });
  const policyLayer = ManagedPolicy.layer.pipe(Layer.provideMerge(ServerConfig.layer(config)));
  const readTarget = readNativeThread(id).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: config.dbPath, readonly: true })),
    Effect.catchTags({
      SqlError: () =>
        Effect.fail(
          new ThreadUsageError({ detail: "Cannot open this local T3 database. Check --base-dir." }),
        ),
    }),
  );
  const target = yield* readTarget;
  const hostEnv = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const hostFingerprint = ompEnvironmentFingerprint(hostEnv, platform);
  const instance = yield* Effect.gen(function* () {
    const policy = yield* ManagedPolicy.ManagedPolicy;
    const live = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(live) || !live.value.ompEnvironmentFingerprint) {
      return yield* new ThreadUsageError({
        detail: "Start or update the local T3 server before opening its native OMP session.",
      });
    }
    if (hostFingerprint !== live.value.ompEnvironmentFingerprint) {
      return yield* new ThreadUsageError({
        detail:
          "This shell and the T3 server use different OMP environments. Open a terminal on the server with the same OMP configuration.",
      });
    }
    // A TUI can change permissions without consulting T3's administrator.
    if (policy.document !== undefined || live.value.managedPolicy !== null) {
      return yield* new ThreadUsageError({
        detail:
          "Native OMP entry is unavailable under a managed or unreported server policy. Use T3 chat instead.",
      });
    }
    return yield* nativeOmpInstance(yield* readServerSettingsFromDisk, target);
  }).pipe(Effect.provide(policyLayer), Effect.provideService(References.MinimumLogLevel, "Error"));
  const path = yield* Path.Path;
  if (!path.isAbsolute(target.cwd) || !path.isAbsolute(target.sessionFile)) {
    return yield* new ThreadUsageError({
      detail: "The saved OMP session or workspace has no absolute path.",
    });
  }
  const env = { ...(yield* mergeProviderInstanceEnvironment(instance.environment, hostEnv)) };
  if (ompEnvironmentFingerprint(env, platform) !== hostFingerprint || env.PI_CONFIG_FILES) {
    return yield* new ThreadUsageError({
      detail:
        "Native entry cannot reproduce this instance's OMP configuration overlay, profile, or ownership namespace.",
    });
  }
  for (const key of Object.keys(env)) {
    if (/^(T3_|T3CODE_)/i.test(key)) delete env[key];
  }
  const executable = yield* resolveCommandPath(instance.binaryPath, { env });
  if (!executable || !path.isAbsolute(executable)) {
    return yield* new ThreadUsageError({
      detail:
        "Cannot resolve the configured OMP executable. Set its absolute binary path or install omp on PATH.",
    });
  }
  const binary = yield* resolveSpawnCommand(executable, [], { env, bypassNpmShim: true });
  if (binary.shell) {
    return yield* new ThreadUsageError({
      detail: "Native OMP requires an executable, not a shell command or batch shim.",
    });
  }
  yield* requireOmpApprovalSupport(binary.command, env, target.cwd).pipe(
    Effect.mapError(
      () =>
        new ThreadUsageError({
          detail:
            "Cannot verify OMP's native approval support. Check the configured executable and update OMP.",
        }),
    ),
  );
  const guard = yield* prepareOmpResume(binary.command, env, target.cwd, target.sessionFile).pipe(
    Effect.mapError(
      (error) =>
        new ThreadUsageError({
          detail:
            error._tag === "PiRpcError" && error.detail
              ? error.detail
              : "Cannot verify the saved OMP session's workspace and ownership.",
        }),
    ),
  );
  // A help/lease probe spawns a process; don't use an archive or provider binding that changed during it.
  const current = yield* readTarget;
  if (
    current.sessionFile !== target.sessionFile ||
    current.cwd !== target.cwd ||
    current.instanceId !== target.instanceId ||
    current.projectId !== target.projectId
  ) {
    return yield* new ThreadUsageError({
      detail: "The thread's native session changed during launch. Run the command again.",
    });
  }
  yield* Console.log("Opening native OMP. Quit OMP before unarchiving this thread in T3.");
  const args = [
    ...binary.args,
    ...instance.args,
    "--resume",
    target.sessionFile,
    "--approval-mode",
    "always-ask",
    ...guard.args,
  ];
  const exitCode = yield* Effect.tryPromise({
    try: (signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      const child = NodeChildProcess.spawn(binary.command, args, {
        cwd: target.cwd,
        env,
        signal,
        shell: false,
        stdio: [interactiveStdin(), "inherit", "inherit"],
      });
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
      return promise;
    },
    catch: () =>
      new ThreadUsageError({
        detail: "Could not start native OMP. Check the configured executable and workspace.",
      }),
  });
  if (exitCode !== 0)
    return yield* new ThreadUsageError({ detail: `OMP exited with code ${exitCode}.` });
  yield* Console.log("OMP closed. Unarchive the original thread in T3 to continue.");
}, Effect.scoped);
