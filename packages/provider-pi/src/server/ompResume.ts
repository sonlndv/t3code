import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.stat does not preserve nanosecond ctime for the child’s identity check.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { piRecordString, PiRpcError } from "./rpc.ts";

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeLease = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ held: Schema.Array(Schema.String), unknown: Schema.Array(Schema.String) }),
  ),
);
const flag = "t3-exact-resume";
const refused = (detail: string) => new PiRpcError({ operation: "resume", detail });

// OMP 19.2.1 opens before it claims. Its first competing write silently creates a
// continuation. Take its own process-shared claim before AgentSession starts, then
// transfer the claim to the actual manager once its identity is known. Registering
// the CLI flag last makes extension load errors fatal, even under --no-extensions.
function resumeExtension(file: string, id: string, stamp: string) {
  return `import { statSync, writeSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
const file = ${JSON.stringify(file)};
const id = ${JSON.stringify(id)};
const flag = ${JSON.stringify(flag)};
const key = Symbol.for(${JSON.stringify(`t3-exact-resume:${file}`)});
function refuse(message) {
  writeSync(2, "T3 Code refused to resume this OMP session: " + message + "\\n");
  process.exit(1);
}
export default function (api) {
  if (!isMainThread || !process.argv.includes("--" + flag)) return;
  // OMP also binds this factory to subagents and rebinds it after /reload.
  if (!globalThis[key]) {
    const sdk = api.pi;
    const named = sdk.parseSessionFileName(file);
    if (named && named.id !== id) refuse("the file no longer holds the session named by its path.");
    const storage = new sdk.FileSessionStorage();
    const release = storage.claimSession(id, file);
    if (!release || sdk.isSessionLeaseHeld(id) !== true || storage.isSessionOwnedElsewhere(file)) {
      refuse("another process owns it or ownership is unavailable.");
    }
    const s = statSync(file, { bigint: true });
    if ([s.dev, s.ino, s.size, s.ctimeNs].join("/") !== ${JSON.stringify(stamp)}) refuse("the transcript changed while opening it. Retry when the other writer has stopped.");
    globalThis[key] = { release };
  }
  api.on("session_start", (_event, ctx) => {
    const claim = globalThis[key];
    if (ctx.agent?.kind === "sub" || !claim.release) return;
    try {
      const manager = ctx.sessionManager;
      if (manager.getSessionFile() !== file || manager.getSessionId() !== id) refuse("OMP opened a different conversation.");
      if (manager.isOwnedElsewhere?.() !== false) refuse("could not claim the saved conversation.");
      manager.onPersistenceNotice(({ from }) => {
        if (from === file) refuse("OMP cannot continue writing the original transcript.");
      });
      claim.release();
      claim.release = null;
    } catch {
      // OMP normally reports an extension handler error and keeps running.
      refuse("the configured OMP cannot verify exclusive ownership.");
    }
  });
  api.registerFlag(flag, { type: "boolean" });
}
`;
}

/** Prepare a fail-closed native resume. Keep the scope through the child process's exit. */
export const prepareOmpResume = Effect.fn("Omp.prepareResume")(function* (
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  sessionFile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.resolve(cwd, sessionFile);
  const info = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(file, { bigint: true }),
    catch: () => refused("Cannot read the saved OMP session."),
  });
  if (!info.isFile()) return yield* refused("The saved OMP session is not a regular file.");
  // Native journals start with an optional fixed-width title slot before the session header.
  const header = yield* fs.stream(file, { bytesToRead: 1024 * 1024 }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.take(2),
    Stream.map((line) => Option.getOrUndefined(decodeRecord(line))),
    Stream.filter((record) => piRecordString(record, "type") !== "title"),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );
  const recorded = piRecordString(header, "cwd");
  const sessionId = piRecordString(header, "id");
  if (
    piRecordString(header, "type") !== "session" ||
    !sessionId ||
    !recorded ||
    !path.isAbsolute(recorded)
  ) {
    return yield* refused("Cannot read a valid workspace header from the saved OMP session.");
  }
  if (recorded !== cwd && (yield* fs.realPath(recorded)) !== (yield* fs.realPath(cwd))) {
    return yield* refused("Cannot resume an OMP session in a different workspace.");
  }
  const command = yield* resolveSpawnCommand(
    binary,
    ["session", "lease", "--json", "--", sessionId],
    { env },
  );
  const probe = yield* spawnAndCollect(
    binary,
    ChildProcess.make(command.command, command.args, {
      cwd,
      env,
      extendEnv: false,
      shell: command.shell,
    }),
  ).pipe(Effect.timeout("10 seconds"));
  const lease = Option.getOrUndefined(decodeLease(probe.stdout));
  if (probe.code !== 0 || lease === undefined || lease.unknown.length > 0) {
    return yield* refused(
      "Cannot verify ownership of the saved OMP session. Update the configured OMP executable.",
    );
  }
  if (lease.held.length > 0) {
    return yield* refused(
      "Another OMP process owns this conversation. Close it before resuming here.",
    );
  }
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-resume-" });
  const extensionPath = path.join(dir, "guard.js");
  const stamp = [info.dev, info.ino, info.size, info.ctimeNs].join("/");
  yield* fs.writeFileString(extensionPath, resumeExtension(file, sessionId, stamp));
  return { sessionId, extensionPath, args: ["--extension", extensionPath, `--${flag}`] };
});
