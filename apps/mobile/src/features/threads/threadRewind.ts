import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { MessageId, OrchestrationV2Checkpoint } from "@t3tools/contracts";

export type MobileRewindTarget = Pick<OrchestrationV2Checkpoint, "id" | "scopeId">;

export function mobileRewindTargets(
  projection:
    | Pick<
        ThreadStructure,
        | "thread"
        | "providerThreads"
        | "providerSessions"
        | "runs"
        | "checkpoints"
        | "checkpointScopes"
      >
    | undefined,
): ReadonlyMap<MessageId, MobileRewindTarget> {
  const targets = new Map<MessageId, MobileRewindTarget>();
  if (!projection || projection.thread.archivedAt !== null) return targets;
  const active = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const session =
    active &&
    projection.providerSessions.find((session) => session.id === active.providerSessionId);
  if (
    !active ||
    active.providerInstanceId !== projection.thread.modelSelection.instanceId ||
    !session?.capabilities.threads.canRollbackThread ||
    !session.capabilities.checkpointing.providerRollbackReturnsSnapshot ||
    projection.runs.some((run) => run.completedAt === null && run.status !== "rolled_back")
  )
    return targets;

  const roots = new Set(
    projection.checkpointScopes
      .filter((scope) => scope.kind === "root_run" && scope.parentScopeId === null)
      .map((scope) => scope.id),
  );
  const checkpoints = new Map(
    projection.checkpoints
      .filter((checkpoint) => roots.has(checkpoint.scopeId) && checkpoint.status !== "stale")
      .map((checkpoint) => [checkpoint.id, checkpoint]),
  );
  const baseline = Array.from(checkpoints.values()).find(
    (checkpoint) => checkpoint.appRunOrdinal === null && checkpoint.ordinalWithinScope === 0,
  );
  let previous = baseline;
  let lastOrdinal = 0;
  for (const run of [...projection.runs].sort((a, b) => a.ordinal - b.ordinal)) {
    // A page gap or a switch of native conversation breaks the chain we can rewind.
    if (
      run.ordinal !== lastOrdinal + 1 ||
      (run.status !== "rolled_back" && run.providerThreadId !== active.id)
    ) {
      targets.clear();
      previous = undefined;
    }
    lastOrdinal = run.ordinal;
    if (run.status === "rolled_back" || run.providerThreadId !== active.id) continue;
    if (previous) targets.set(run.userMessageId, previous);
    previous = run.checkpointId === null ? undefined : checkpoints.get(run.checkpointId);
  }
  return targets;
}
