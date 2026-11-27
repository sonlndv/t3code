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
import { useGT } from "gt-react-native";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { waitForThreadShell } from "./threadForkNavigation";

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
    setBusy(true);
    try {
      const result = await fork({
        environmentId: props.environmentId,
        input: { ...props.input, creationSource: "mobile" },
      });
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Could not open thread"),
          error instanceof Error ? error.message : undefined,
        );
        return;
      }
      if (
        await waitForThreadShell(scopeThreadRef(props.environmentId, props.input.targetThreadId))
      ) {
        props.onOpen(props.input.targetThreadId);
      } else {
        Dialog.alert(
          gt("Fork created"),
          gt(
            "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="compact"
      label={gt("Continue in chat")}
      loading={busy}
      onPress={() => void open()}
    />
  );
}
