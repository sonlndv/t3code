import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mobileRewindTargets } from "./threadRewind";

type Fixture = NonNullable<Parameters<typeof mobileRewindTargets>[0]>;

function run(ordinal: number, status = "completed", providerThreadId = "active") {
  return {
    ordinal,
    userMessageId: `m${ordinal}`,
    providerThreadId,
    status,
    completedAt: status === "running" ? null : 1,
    checkpointId: `cp${ordinal}`,
  };
}

function fixture(runs: ReturnType<typeof run>[], stale: number[] = []): Fixture {
  return {
    thread: {
      activeProviderThreadId: "active",
      archivedAt: null,
      modelSelection: { instanceId: "omp" },
    },
    providerThreads: [{ id: "active", providerSessionId: "session", providerInstanceId: "omp" }],
    providerSessions: [
      {
        id: "session",
        capabilities: {
          threads: { canRollbackThread: true },
          checkpointing: { providerRollbackReturnsSnapshot: true },
        },
      },
    ],
    checkpointScopes: [{ id: "scope", kind: "root_run", parentScopeId: null }],
    checkpoints: [0, ...runs.map((r) => r.ordinal)].map((n) => ({
      id: `cp${n}`,
      scopeId: "scope",
      status: stale.includes(n) ? "stale" : "ready",
      appRunOrdinal: n || null,
      ordinalWithinScope: n,
    })),
    runs,
  } as unknown as Fixture;
}

function boundaries(projection: Fixture) {
  return Array.from(mobileRewindTargets(projection), ([id, target]) => [id, target.id]);
}

describe("mobile conversation rewind", () => {
  it("keeps the previous surviving turn across a recorded rewind", () => {
    expect(boundaries(fixture([run(1), run(2, "rolled_back"), run(3)]))).toEqual([
      ["m1", "cp0"],
      ["m3", "cp1"],
    ]);
  });
  it("only offers provable boundaries in the latest page and provider conversation", () => {
    expect(
      boundaries(fixture([run(1), run(3), run(4), run(5, "completed", "other"), run(6), run(7)])),
    ).toEqual([["m7", "cp6"]]);
    expect(boundaries(fixture([run(1), run(3), run(4)]))).toEqual([["m4", "cp3"]]);
  });
  it("hides stale positions, busy sessions, and providers without rewind", () => {
    const projection = fixture([run(1), run(2)], [1]);
    expect(mobileRewindTargets(projection).has(MessageId.make("m2"))).toBe(false);
    expect(boundaries(fixture([run(1), run(2, "running")]))).toEqual([]);
    expect(boundaries({ ...projection, providerSessions: [] })).toEqual([]);
  });
});
