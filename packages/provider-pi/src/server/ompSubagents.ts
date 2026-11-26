import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import {
  piRecordField as field,
  piRecordNumber as number,
  piRecordString as string,
} from "./rpc.ts";

export type SubagentCard = {
  readonly agent: string;
  readonly task: string;
  readonly model: string | null;
  readonly status: OrchestrationV2Subagent["status"];
  readonly progress?: string | undefined;
  readonly result: string | null;
};

const MAX_RESULT = 10_000;

export function ompWorkerStatus(status: unknown) {
  switch (status) {
    case "started":
    case "running":
      return "running";
    case "pending":
    case "completed":
    case "failed":
      return status;
    case "aborted":
      return "interrupted";
    default:
      return undefined;
  }
}

export function ompWorkerCard(id: string, role: string, snapshot: unknown): SubagentCard {
  return {
    agent: role === id ? id : `${id} (${role})`,
    task: string(snapshot, "assignment") ?? string(snapshot, "task") ?? "",
    model: string(snapshot, "resolvedModel") ?? null,
    status: "running",
    result: null,
  };
}

export function ompWorkerProgress(progress: unknown) {
  const recent = field(progress, "recentOutput");
  const text =
    string(progress, "stage") ??
    string(progress, "currentToolIntent") ??
    string(progress, "currentTool") ??
    string(progress, "lastIntent") ??
    (Array.isArray(recent) && typeof recent[0] === "string" ? recent[0] : undefined);
  return text?.slice(0, 200);
}

// 19.2.1 flushes final progress before lifecycle, which carries neither output nor model.
// recentOutput is a bounded assistant-text tail, newest line first; description is a task label.
export function ompWorkerResultPreview(progress: unknown, bounded: (value: unknown) => boolean) {
  const error = string(field(progress, "retryFailure"), "errorMessage");
  if (error) return error.slice(0, MAX_RESULT);
  const yields = field(field(progress, "extractedToolData"), "yield");
  const last = Array.isArray(yields) ? yields.at(-1) : undefined;
  const abort = string(last, "error");
  if (abort && field(last, "status") === "aborted") return abort.slice(0, MAX_RESULT);
  const data = field(last, "data");
  if (data !== undefined && !Array.isArray(field(last, "type"))) {
    if (typeof data === "string") return data.slice(0, MAX_RESULT);
    if (bounded(data)) return JSON.stringify(data).slice(0, MAX_RESULT);
  }
  const recent = field(progress, "recentOutput");
  if (!Array.isArray(recent)) return null;
  return (
    recent
      .slice(0, 8)
      .reverse()
      .filter((line): line is string => typeof line === "string")
      .map((line) => line.slice(0, MAX_RESULT))
      .join("\n")
      .slice(0, MAX_RESULT) || null
  );
}

export function ompWorkerToolResult(result: unknown) {
  const id = string(result, "id");
  const role = string(result, "agent");
  const code = number(result, "exitCode");
  if (!id || !role || code === undefined) return undefined;
  const error = string(result, "error") || string(result, "stderr");
  const aborted = field(result, "aborted") === true;
  const failed = code !== 0 || Boolean(string(result, "error"));
  const output =
    (aborted && string(result, "abortReason")) || (failed && error) || string(result, "output");
  const card: SubagentCard = {
    ...ompWorkerCard(id, role, result),
    status: aborted ? "interrupted" : failed ? "failed" : "completed",
    result: output?.slice(0, MAX_RESULT) || null,
  };
  return { id, card };
}
