# Pi

Run your existing [Pi](https://pi.dev) (**0.84.3+**, Node.js **22.19+**) installation in T3 Code while keeping Pi's models, auth, extensions, skills, and native session history.

## Oh My Pi (OMP)

Install `omp` on the T3 server and sign in with `omp login`. Choose **OMP** in the model picker for a new thread. If OMP isn't listed, enable it in **Settings → Providers** and check the binary path.

Choose a skill with `$` or type `/skill:<name>`. To delegate to OMP workers, ask OMP to use its native `task` tool. OMP uses its own model and role settings. Switching to a different T3 provider doesn't move running workers.

### Use OMP's own interface in the same conversation

1. Finish the current turn and background work, then archive the thread. Archiving closes its T3 terminals.
2. In **Settings → Archive**, choose **Open OMP**. Use `/model`, extension menus, and keyboard shortcuts as you would in a terminal. On the server machine, `t3 thread native <thread-id>` opens the same interface.
3. Quit OMP, then unarchive the thread to continue in chat.

Both interfaces use the same saved OMP conversation. Terminal-only turns stay in native history. Starting another session inside OMP does not redirect the T3 thread.

Native OMP uses its own permissions. Use T3 chat for managed environments, restricted linked threads, plan mode, or instances that rely on secrets stored by T3.

## Set up Pi

1. Install Pi on the server machine (via Pi's installer or `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`).
2. Run `pi` and `/login` in a terminal on the server (over SSH for remote hosts, or set your model provider's API key in the Pi instance's environment variables).
3. Open **Settings → Providers**, enable **Pi**, and refresh. Set **Binary path** if `pi` isn't on `PATH`.

- In **Launch arguments**, `--provider` must be paired with `--model`. Flags that alter Pi's execution mode or session selection are rejected because T3 Code manages them.
- Update installer-managed Pi with `pi update`, or via your package manager (e.g. `nix profile upgrade pi`).

## Features and extensions

- **Models, thinking & speed**: Discovers Pi models, thinking levels, and `serviceTiers` (exposed as a speed picker).
- **Native sessions**: Resume, rollback, and same-instance forks use Pi's native session files; switching providers uses a [portable handoff](./portable-handoffs.md).
- **Skills & extensions**: Pi user and trusted project skills appear in `$`. Extension `select`, `confirm`, `input`, and `editor` dialogs render in the composer, notifications appear in the activity log, and status text appears near the composer.
- **Subagents**: T3 Code's `delegate_task` creates full child threads; Pi's example `subagent` extension also displays task progress/results (read-only).

## Permission modes

- **Supervised**: Asks before commands, file edits, and extension tools (reads proceed).
- **Auto-accept edits**: Allows Pi's edit/write tools; asks for commands and extension tools.
- **Full access**: Allows all tool calls without prompts.

**Auto** is not supported (behaves as Supervised). Changing modes restarts the Pi session and resumes the same conversation. Note that permissions govern Pi tool calls—not an OS sandbox.

## Troubleshooting

- **Untrusted project folder**: If Pi skips project extensions/skills/MCP, run `pi` in that folder on the server (with the same `PI_CODING_AGENT_DIR` if set), run `/trust`, and start a new thread in that worktree. Add `--no-approve` to launch arguments to keep project files disabled without the notice.
- **Discovery fails**: T3 Code keeps Pi usable with `Pi default` so an interactive session can handle startup prompts.
- **Context window**: Enable **Settings → Appearance → Thread details → Context window** (some model providers report usage only after the first reply completes).
