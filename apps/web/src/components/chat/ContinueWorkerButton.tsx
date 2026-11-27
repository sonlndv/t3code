import type { completedWorkerForkInput } from "@t3tools/client-runtime/state/subagent-display";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGT } from "gt-react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { waitForThreadShell } from "../../state/entities";

export function ContinueWorkerButton(props: {
  readonly environmentId: EnvironmentId;
  readonly input: NonNullable<ReturnType<typeof completedWorkerForkInput>>;
  readonly onOpen: (id: ThreadId) => void;
}) {
  const gt = useGT();
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const fork = useAtomCommand(threadEnvironment.forkFromRun);
  const [busy, setBusy] = useState(false);
  if (!canOperate) return null;

  const open = async () => {
    const result = await fork({ environmentId: props.environmentId, input: props.input });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not open thread"),
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    if (await waitForThreadShell(scopeThreadRef(props.environmentId, props.input.targetThreadId))) {
      props.onOpen(props.input.targetThreadId);
    } else {
      toastManager.add({
        type: "warning",
        title: gt(
          "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
        ),
      });
    }
  };

  const handleOpen = () => {
    setBusy(true);
    void open().finally(() => setBusy(false));
  };

  return (
    <Button size="xs" variant="outline" disabled={busy} onClick={handleOpen}>
      {gt("Continue in chat")}
    </Button>
  );
}
