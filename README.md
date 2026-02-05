# pi-semaphore

Semaphore locks for [pi](https://github.com/badlogic/pi-mono) - coordinate multiple pi instances.

## Installation

```bash
pi install git:github.com/offline-ant/pi-semaphore
```

Or try without installing:

```bash
pi -e git:github.com/offline-ant/pi-semaphore
```

## How It Works

While the agent is processing a prompt, automatic locks are created in `/tmp/pi-locks/`:

- `<name>.<cmd-idx>.<pid>` - The actual lock file
- `<name>.<cmd-idx>` - Symlink to the lock file
- `<name>` - Symlink to the latest lock file

The default `<name>` is the project directory basename. The `<cmd-idx>` increments per user prompt. The `<pid>` is the process ID.

When the agent finishes, the lock files are removed.

## Commands

| Command | Description |
|---------|-------------|
| `/lock [name]` | Create a named lock (fails if exists) |
| `/release [name]` | Release a named lock |
| `/wait <name> [name...]` | Wait for any of the named locks to be released |
| `/lock-list` | List all locks in `/tmp/pi-locks/` |

## Example Usage

### Waiting for another pi instance

In terminal 1 (project directory `my-app`):
```
> Do some long running task
```

In terminal 2:
```
> /wait my-app
Waiting for lock: my-app
# ... blocks until terminal 1 finishes ...
Lock released: my-app
```

Waiting for multiple locks:
```
> /wait my-app deploy
Waiting for any lock: my-app, deploy
# ... blocks until one is released ...
Lock released: deploy
```

### Explicit locks

```
> /lock deploy
Lock created: deploy

# In another terminal:
> /wait deploy
Waiting for lock: deploy

# Back in first terminal:
> /release deploy
Lock released: deploy
```

### Listing locks

```
> /lock-list
Locks:
my-app -> /tmp/pi-locks/my-app.3.12345
my-app.3 -> /tmp/pi-locks/my-app.3.12345
my-app.3.12345
deploy
```

## Agent Supervisor Pattern

One pi instance can monitor and drive another pi instance. This requires:

1. **Semaphore extension** - to wait for the other agent's steps to complete
2. **Tmux extension** - to send commands and capture output from the other agent

The easiest setup is running both pi instances in the same tmux session (different windows). This gives the supervisor agent access to the worker's pane via tmux tools.

### Setup

Start tmux and open two windows:
```bash
tmux new-session -s work
# Window 0: worker agent
pi

# Ctrl+b c (new window)
# Window 1: supervisor agent  
pi
```

Both agents now share the tmux session. The supervisor (window 1) can:
- `tmux capture-pane -t %0 -p` - read the worker's screen
- `tmux send-keys -t %0 "command" Enter` - send input to the worker

### Supervisor Workflow

The supervisor monitors the worker and keeps it running:

```
1. semaphore_list - find the worker's active lock (e.g., my-app.5.12345)
2. semaphore_wait - block until the worker finishes its current step
3. tmux capture-pane -t %0 -p -S -50 - check output and context usage
4. Decide what to do:
   - If context > 70%: trigger state save and /compact
   - If idle but work remains: send "go" or next instruction
   - If done: stop
5. Repeat
```

### Use Cases

- **Long-running tasks**: Keep work going across context resets via periodic `/compact`
- **State persistence**: Instruct worker to save progress to files before compaction
- **Error recovery**: Detect failures and send corrective instructions
- **Orchestration**: Coordinate multiple workers on different parts of a task

### Example Supervisor Prompt

```
Monitor the pi instance in window 0. Check every step:
- If context reaches 70%, tell it to save state to todo.md, then /compact
- After compaction, tell it to read todo.md and continue
- If it stops and work remains, send "go"
- Continue until all tasks are marked done
```

## License

MIT
