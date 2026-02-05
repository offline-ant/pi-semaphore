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
| `/wait <name>` | Wait for a lock to be released |
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

## License

MIT
