# pi-semaphore

Semaphore locks for [pi](https://github.com/badlogic/pi-mono) to coordinate multiple pi instances.

## Installation

```bash
pi install git:github.com/offline-ant/pi-semaphore
```

Or try without installing:

```bash
pi -e git:github.com/offline-ant/pi-semaphore
```

## How It Works

While the agent is processing, a lock file exists at:

`/tmp/pi-semaphores/<name>`

Default `<name>`:
1. `PI_LOCK_NAME` (if set)
2. Otherwise, project directory basename

If the same name is already taken, a suffix is appended (`-2`, `-3`, ...).

When processing finishes, the lock is removed and an idle marker is created:

`/tmp/pi-semaphores/idle:<name>`

With tmux integration, lock file content is the pane id (for example `%42`), so other tools can resolve lock name -> pane.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_LOCK_NAME` | Override the default lock name |

## Commands

| Command | Description |
|---------|-------------|
| `/lock [name]` | Create a named lock (auto-deduplicates) |
| `/release [name]` | Release a named lock |
| `/wait <name> [name...]` | Wait for any named lock to be released |
| `/lock-list` | List all lock files in `/tmp/pi-semaphores/` |

## Example

Terminal 1:
```
> Do long task
```

Terminal 2:
```
> /wait my-project
Waiting for any lock: my-project
# ... blocks ...
Lock released: my-project
```

## Agent Supervisor Pattern

Use with `pi-tmux`:

1. Wait for worker step completion via `semaphore_wait`
2. Capture worker pane by lock name via `tmux-capture`
3. Send next instruction via `tmux-send`

Because lock files contain pane ids, supervisors can control worker panes by lock name without spawning them.

## License

MIT
