import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { nativeOmpInstance, readNativeThread } from "./threadNative.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("omp_2");
const driver = ProviderDriverKind.make("omp");

it.effect("opens only the active native binding in the archived thread's workspace", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'test', '/project', '[]', 'now', 'now')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
       interaction_mode, active_provider_thread_id, created_at, updated_at, payload_json)
      VALUES (${threadId}, ${projectId}, 'test', ${instanceId}, ${instanceId}, 'approval-required',
       'default', 'current', 'now', 'now', '{"modelSelection":{"instanceId":"omp_2"},"worktreePath":"/work tree"}')`;
    const sessionFile = "/sessions/file with spaces;not a command.jsonl";
    for (const [id, nativeId] of [
      ["current", sessionFile],
      ["not-current", "/sessions/newer.jsonl"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, driver, provider_instance_id, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, ${instanceId}, 'omp', ${instanceId}, 'idle', 'now',
          json_object('nativeThreadRef', json_object('driver', 'omp', 'strength', 'strong', 'nativeId', ${nativeId})))`;
    }
    const open = readNativeThread(threadId);
    const refused = open.pipe(Effect.flip);
    assert.include((yield* refused).message, "archive this thread");
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = 'now'`;
    assert.deepEqual(yield* open, { cwd: "/work tree", instanceId, projectId, sessionFile });
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_remove(payload_json, '$.worktreePath')`;
    assert.equal((yield* open).cwd, "/project");

    // Archive commits the detached projection before the worker actually closes OMP.
    yield* sql`INSERT INTO orchestration_v2_effect_outbox
      (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
      VALUES ('e', 'archive', ${threadId}, 'provider-session.detach', '{}', 'running', 'now', 'now', 'now')`;
    assert.include((yield* refused).message, "still using");
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('r', ${threadId}, 1, ${instanceId}, 'waiting', 'now', '{}')`;
    assert.include((yield* refused).message, "still using");
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;

    yield* sql`UPDATE orchestration_v2_projection_threads SET interaction_mode = 'plan'`;
    assert.include((yield* refused).message, "policy");
    yield* sql`UPDATE orchestration_v2_projection_threads SET interaction_mode = 'default',
      payload_json = json_set(payload_json, '$.linkOrigin', json('{"access":"read-only"}'))`;
    assert.include((yield* refused).message, "policy");
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_remove(payload_json, '$.linkOrigin')`;
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET driver = 'acpRegistry'
      WHERE provider_thread_id = 'current'`;
    assert.include((yield* refused).message, "no current native OMP session");
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET driver = 'omp', provider_instance_id = 'different'
      WHERE provider_thread_id = 'current'`;
    assert.include((yield* refused).message, "no current native OMP session");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect(
  "uses the selected instance and project override without leaking configured secrets",
  () =>
    Effect.gen(function* () {
      const target = { instanceId, projectId };
      const binaryPath = "/bin/native omp";
      const instance = {
        driver,
        enabled: true,
        config: { binaryPath, launchArgs: '--offline --extension "/my extension.js"' },
        environment: [{ name: "LANG", value: "en_US.UTF-8", sensitive: false }],
      };
      const settings = {
        providerInstances: { [instanceId]: instance },
        projectSettingsOverrides: {},
      };
      assert.deepEqual(yield* nativeOmpInstance(settings, target), {
        binaryPath,
        args: ["--offline", "--extension", "/my extension.js"],
        environment: instance.environment,
      });
      const disabled = yield* nativeOmpInstance(
        {
          ...settings,
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
          },
        },
        target,
      ).pipe(Effect.flip);
      assert.include(disabled.message, "disabled");
      for (const incompatible of [
        { ...instance, config: { binaryPath, launchArgs: "--api-key fake-secret" } },
        { ...instance, config: { binaryPath, launchArgs: "--yolo" } },
        { ...instance, config: { binaryPath, launchArgs: "--resume wrong-session" } },
        {
          ...instance,
          environment: [{ name: "OMP_AUTH_BROKER_TOKEN", value: "fake-secret", sensitive: true }],
        },
        { ...instance, config: { binaryPath, unsupportedPolicy: "read-only" } },
      ]) {
        const error = yield* nativeOmpInstance(
          { ...settings, providerInstances: { [instanceId]: incompatible } },
          target,
        ).pipe(Effect.flip);
        assert.include(error.message, "cannot reproduce");
        assert.notInclude(error.message, "fake-secret");
      }
    }),
);
