import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PiSettings } from "../settings.ts";
import { PI_ARGUMENTS_WITH_VALUES, resolvePiLaunchArgs } from "./mcpInjection.ts";
import { PI_FLAVOR, type PiFlavor } from "./flavor.ts";

const PiScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  ompTitle: Schema.mutableKey(Schema.optional(Schema.Boolean)),
});
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Identity = {
  id: Schema.NonEmptyString,
  timestamp: Schema.String,
  runtime: Schema.optional(Schema.Struct({ version: Schema.String })),
};
const Model = { provider: Schema.NonEmptyString, model: Schema.NonEmptyString };
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("title"), v: Schema.Literal(1) }),
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Union([
      Schema.Struct({
        ...Model,
        role: Schema.Literal("assistant"),
        responseModel: Schema.optional(Schema.NonEmptyString),
        usage: Usage,
      }),
      Schema.Struct({ role: Schema.Literal("toolResult"), usage: Usage }),
    ]),
  }),
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("usage"), usage: Usage }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literals(["compaction", "branch_summary"]),
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(
  flavor: PiFlavor,
  parsed: unknown,
  state: typeof PiScanState.Type,
): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "title") {
    state.ompTitle = true;
    return [];
  }
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  // Both CLIs honor PI_CODING_AGENT_DIR. Only OMP writes the title preamble and runtime stamp.
  if ((state.ompTitle === true || entry.runtime !== undefined) !== (flavor.binaryName === "omp"))
    return [];
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const usage = source.usage;
  // Auxiliary tool/summary records lack model attribution; match Pi's breakdown.
  const rateModel =
    "model" in source
      ? "responseModel" in source
        ? (source.responseModel ?? source.model)
        : source.model
      : undefined;
  const model = "provider" in source ? `${source.provider}/${rateModel}` : "Tools/summaries";
  const outputTokens = tokenCount(usage.output);
  const totals = {
    // Pi's input/cache counters are already disjoint.
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning)),
  };
  const cost = usage.cost?.total;
  // Omitted Pi rates default to zero; use shared estimates without positive transcript cost.
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: flavor.usageProvider,
      timestampMs,
      model,
      ...(rateModel === undefined ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Forks preserve IDs/timestamps; short random IDs need timestamp/model to avoid cross-session collisions.
      dedupeKey: JSON.stringify([flavor.usageProvider, entry.id, entry.timestamp, model]),
    },
  ];
}

function makePiUsageFormat(flavor: PiFlavor): TranscriptUsageFormat<typeof PiScanState.Type> {
  return {
    selectFields: {
      type: true,
      id: true,
      timestamp: true,
      v: true,
      runtime: { version: true },
      provider: true,
      model: true,
      usage: true,
      message: { role: true, provider: true, model: true, responseModel: true, usage: true },
    },
    usageMarkers: ['"usage"', '"session"', '"title"'],
    parseLine: (line, state) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      return parseRecord(flavor, parsed, state);
    },
    parseProjected: (projected, state) => parseRecord(flavor, projected, state),
    state: { initial: () => ({ sessionId: "" }), schema: PiScanState },
  };
}

export const piUsageFormat = makePiUsageFormat(PI_FLAVOR);

export function makePiUsageReader(
  flavor: PiFlavor,
): ProviderUsageReader<PiSettings, Path.Path | FileSystem.FileSystem> {
  return {
    kind: "transcripts",
    provider: flavor.usageProvider,
    format: flavor.binaryName === "pi" ? piUsageFormat : makePiUsageFormat(flavor),
    // Pi model IDs are `<provider>/<rate model>`.
    rateModel: (model) => model.slice(model.indexOf("/") + 1),
    directories: Effect.fn(`${flavor.displayName}UsageReader.directories`)(function* ({
      config,
      environment,
    }) {
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const platform = yield* HostProcess.Platform;
      const launchHome = piHome(environment, home, platform);
      const resolved = resolvePiLaunchArgs(config?.launchArgs ?? "", flavor);
      const args = resolved.ok ? resolved.args : [];
      const isOmp = flavor.binaryName === "omp";
      const sessionDirArg = isOmp ? ompLaunchArg(args, "--session-dir") : piLaunchSessionDir(args);
      const launchDir =
        sessionDirArg === undefined || isOmp
          ? sessionDirArg
          : expandHomePath(sessionDirArg, launchHome);
      if (isOmp) {
        const defaultProfile = environment.OMP_PROFILE ?? environment.PI_PROFILE;
        const launchProfile = ompLaunchArg(args, "--profile");
        const profiles =
          launchProfile === undefined || launchProfile === defaultProfile
            ? [defaultProfile]
            : [defaultProfile, launchProfile];
        const dirs = new Set<string>();
        if (launchDir && path.isAbsolute(launchDir)) dirs.add(path.resolve(launchDir));
        // Relative OMP overrides resolve against each session's cwd, not the T3 server's.
        const sessionOverride = environment.PI_CODING_AGENT_SESSION_DIR;
        if (sessionOverride) {
          if (path.isAbsolute(sessionOverride)) dirs.add(path.resolve(sessionOverride));
          return [...dirs].map((dir) => ({ dir }));
        }
        for (const profile of profiles) {
          const name = profile?.trim();
          const named = name !== undefined && name !== "" && name !== "default";
          if (named && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) continue;
          const profileSegments = named ? ["profiles", name] : [];
          const defaultDir = path.join(
            launchHome,
            environment.PI_CONFIG_DIR || flavor.defaultAgentDirSegments[0],
            ...profileSegments,
            "agent",
          );
          const override = named ? undefined : environment.PI_CODING_AGENT_DIR;
          if (override && !path.isAbsolute(override)) continue;
          const agentDir = override ? path.resolve(override) : defaultDir;
          const xdgRoot = environment.XDG_DATA_HOME;
          if (
            agentDir === defaultDir &&
            xdgRoot &&
            (platform === "linux" || platform === "darwin")
          ) {
            // OMP uses XDG only after migration creates the profile's directory there.
            const xdgDir = path.join(xdgRoot, "omp", ...profileSegments);
            const fs = yield* FileSystem.FileSystem;
            if (yield* fs.exists(xdgDir).pipe(Effect.orElseSucceed(() => false))) {
              dirs.add(path.join(xdgDir, "sessions"));
              continue;
            }
          }
          dirs.add(path.join(agentDir, "sessions"));
        }
        return [...dirs].map((dir) => ({ dir }));
      }
      // --session-dir moves only T3-launched sessions; terminal sessions stay in Pi's own directory.
      return [
        ...(launchDir !== undefined && path.isAbsolute(launchDir)
          ? [{ dir: path.resolve(launchDir) }]
          : []),
        { dir: resolvePiSessionsDir(environment, launchHome, path) },
      ];
    }),
  };
}

// OMP's validated arguments never have flag-shaped values.
export function ompLaunchArg(
  args: ReadonlyArray<string>,
  option: "--session-dir" | "--profile",
): string | undefined {
  const index = args.lastIndexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function piLaunchSessionDir(args: ReadonlyArray<string>): string | undefined {
  let sessionDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !PI_ARGUMENTS_WITH_VALUES.has(arg)) continue;
    index += 1;
    if (arg === "--session-dir") sessionDir = args[index] || undefined;
  }
  return sessionDir;
}

/** The home Pi resolves `~` against: the instance's HOME (USERPROFILE on Windows), else the host's. */
export function piHome(
  environment: NodeJS.ProcessEnv,
  hostHome: string,
  platform: NodeJS.Platform,
): string {
  return (platform === "win32" ? environment.USERPROFILE : environment.HOME) || hostHome;
}

/** Where Pi stores session JSONL files for a provider environment, matching Pi's own lookup. */
export function resolvePiSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
): string {
  const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return path.resolve(expandHomePath(sessionDir, home));
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
  return path.resolve(
    agentDir
      ? expandHomePath(agentDir, home)
      : path.join(home, ...PI_FLAVOR.defaultAgentDirSegments),
    "sessions",
  );
}
