// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verify and snapshot the same open journal descriptor.
import * as NodeFSP from "node:fs/promises";
import type * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.StructWithRest(
      Schema.Struct({
        type: Schema.Literal("session"),
        id: Schema.String,
        cwd: Schema.String,
        parentSession: Schema.String,
        timestamp: Schema.String,
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
);

async function readHeader(handle: NodeFSP.FileHandle) {
  const bytes = Buffer.alloc(64 * 1024);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  const data = bytes.subarray(0, bytesRead);
  let start = 0;
  for (let i = 0; i < 2; i++) {
    const end = data.indexOf(10, start);
    if (end < 0) break;
    const line = data.toString("utf8", start, end);
    const header = Option.getOrUndefined(decodeHeader(line));
    if (header) return { header, end, prefix: data.subarray(0, start) };
    start = end + 1;
  }
  throw new Error("Cannot read the OMP worker session header.");
}

async function withWorker<T>(
  path: Path.Path,
  parentFile: string,
  taskId: string,
  cwd: string,
  run: (
    handle: NodeFSP.FileHandle,
    file: string,
    record: Awaited<ReturnType<typeof readHeader>>,
  ) => Promise<T>,
) {
  if (
    !path.isAbsolute(parentFile) ||
    !parentFile.endsWith(".jsonl") ||
    !taskId ||
    /[\\/\0]/.test(taskId) ||
    taskId === "." ||
    taskId === ".."
  )
    throw new Error("Invalid OMP worker session reference.");
  const parent = await NodeFSP.realpath(parentFile);
  const file = path.join(parent.slice(0, -6), taskId + ".jsonl");
  if ((await NodeFSP.realpath(file)) !== file) throw new Error("The OMP worker journal moved.");
  const handle = await NodeFSP.open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Invalid OMP worker journal.");
    const record = await readHeader(handle);
    if (record.header.parentSession !== parentFile && record.header.parentSession !== parent)
      throw new Error("OMP worker belongs to a different parent session.");
    if ((await NodeFSP.realpath(record.header.cwd)) !== (await NodeFSP.realpath(cwd)))
      throw new Error("OMP worker belongs to a different workspace.");
    return await run(handle, file, record);
  } finally {
    await handle.close();
  }
}

export function ompWorkerSessionId(path: Path.Path, parent: string, taskId: string, cwd: string) {
  return withWorker(path, parent, taskId, cwd, async (_handle, _file, { header }) => header.id);
}

export function forkOmpWorkerSession(
  path: Path.Path,
  input: {
    parent: string;
    taskId: string;
    cwd: string;
    sessionId: string;
    targetThread: string;
  },
) {
  return withWorker(path, input.parent, input.taskId, input.cwd, async (handle, source, record) => {
    if (record.header.id !== input.sessionId)
      throw new Error("The OMP worker session was replaced.");
    // A retry after the file is installed but before the dispatch commits must reopen the same copy.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([input.targetThread, input.sessionId])),
    );
    const hash = Buffer.from(digest).toString("hex");
    const id = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      "4" + hash.slice(13, 16),
      "8" + hash.slice(17, 20),
      hash.slice(20, 32),
    ].join("-");
    const name =
      DateTime.formatIso(DateTime.makeUnsafe(record.header.timestamp)).replaceAll(":", "-") +
      "_" +
      id +
      ".jsonl";
    const destination = path.join(path.dirname(input.parent), name);
    const scratch = await NodeFSP.mkdtemp(destination + ".tmp-");
    const temp = path.join(scratch, "journal");
    const output = await NodeFSP.open(temp, "wx", 0o600);
    try {
      const before = await handle.stat({ bigint: true });
      const header = { ...record.header, id, parentSession: source };
      await output.writeFile(
        Buffer.concat([record.prefix, Buffer.from(JSON.stringify(header) + "\n")]),
      );
      const buffer = Buffer.alloc(128 * 1024);
      let offset = record.end + 1;
      while (offset < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) throw new Error("The OMP worker journal was truncated.");
        await output.writeFile(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (before.ctimeNs !== after.ctimeNs || before.size !== after.size)
        throw new Error(
          "The worker transcript changed while opening it. Try again once it is idle.",
        );
      await output.sync();
      try {
        await NodeFSP.link(temp, destination);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const existing = await NodeFSP.open(destination, "r");
        try {
          const { header: installed } = await readHeader(existing);
          if (installed.id !== id || installed.parentSession !== source) throw error;
        } finally {
          await existing.close();
        }
      }
      return destination;
    } finally {
      await output.close();
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  });
}
