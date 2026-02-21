/**
 * Semaphore Locks Extension (script-backed)
 *
 * Delegates lock operations to ../bin/pi-semaphore.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SEMAPHORE_SCRIPT = path.resolve(__dirname, "../bin/pi-semaphore");

export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._:-]/g, "");
}

function parseNames(args: string | undefined): string[] {
  const raw = args?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/\s+/)
    .map((name) => sanitizeName(name))
    .filter((name) => name.length > 0);
}

async function runSemaphore(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  return pi.exec("bash", [SEMAPHORE_SCRIPT, ...args], { signal });
}

function resultText(stdout: string, stderr: string): string {
  const out = stdout.trim();
  const err = stderr.trim();

  if (out.length > 0 && err.length > 0) {
    return `${out}\n${err}`;
  }

  const text = out || err;
  return text.length > 0 ? text : "(no output)";
}

export default function semaphoreLocksExtension(pi: ExtensionAPI) {
  let currentLockName: string | null = null;

  // Context alert: release a <name>:context lock when context usage >= threshold.
  // Set from PI_CONTEXT_ALERT env var. The lock is created by tmux-coding-agent
  // before pi starts, so we only need to track and release it here.
  const contextAlertThreshold = (() => {
    const raw = parseInt(process.env.PI_CONTEXT_ALERT ?? "", 10);
    return !isNaN(raw) && raw > 0 && raw <= 100 ? raw : null;
  })();
  let contextAlertLockName: string | null = null;
  let contextAlertReleased = false;

  // Abort controller for the currently-running semaphore_wait tool.
  // Set when the tool starts, cleared when it finishes.
  // The input event handler aborts this so a user message interrupts the wait.
  let waitAbortController: AbortController | null = null;

  // When the user sends a message while semaphore_wait is blocking,
  // abort the wait subprocess so the steering message is delivered promptly.
  pi.on("input", async () => {
    if (waitAbortController) {
      waitAbortController.abort();
    }
    return { action: "continue" as const };
  });

  pi.on("agent_start", async (_event, ctx) => {
    const result = await runSemaphore(pi, ["agent-start"]);
    const text = resultText(result.stdout, result.stderr);
    if (result.code === 0) {
      const match = text.match(/Locked:\s+(.+)/);
      currentLockName = match?.[1]?.trim() || null;

      // Track context alert lock (created by tmux-coding-agent before pi started)
      if (contextAlertThreshold && currentLockName && !contextAlertLockName) {
        contextAlertLockName = `${currentLockName}:context`;
      }

      if (ctx.hasUI && currentLockName) {
        ctx.ui.setStatus("locks", `Locked: ${currentLockName}`);
      }
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(text, "error");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Check context alert before releasing the main lock
    if (contextAlertLockName && !contextAlertReleased && contextAlertThreshold) {
      const usage = ctx.getContextUsage();
      if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= contextAlertThreshold) {
        await runSemaphore(pi, ["release", contextAlertLockName]);
        contextAlertReleased = true;
      }
    }

    const args = currentLockName ? ["agent-end", currentLockName] : ["agent-end"];
    const result = await runSemaphore(pi, args);
    if (result.code !== 0 && ctx.hasUI) {
      ctx.ui.notify(resultText(result.stdout, result.stderr), "error");
    }
    currentLockName = null;
    if (ctx.hasUI) {
      ctx.ui.setStatus("locks", undefined);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clean up context alert lock if it was never released
    if (contextAlertLockName && !contextAlertReleased) {
      await runSemaphore(pi, ["release", contextAlertLockName]);
    }
    if (currentLockName) {
      await runSemaphore(pi, ["agent-end", currentLockName]);
    }
    currentLockName = null;
    if (ctx.hasUI) {
      ctx.ui.setStatus("locks", undefined);
    }
  });

  pi.registerCommand("lock", {
    description: "Create a named lock in /tmp/pi-semaphores",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      const result = await runSemaphore(pi, names.length > 0 ? ["lock", names[0]] : ["lock"]);
      if (ctx.hasUI) {
        ctx.ui.notify(resultText(result.stdout, result.stderr), result.code === 0 ? "info" : "warning");
      }
    },
  });

  pi.registerCommand("release", {
    description: "Release a named lock in /tmp/pi-semaphores",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      const result = await runSemaphore(pi, names.length > 0 ? ["release", names[0]] : ["release"]);
      if (ctx.hasUI) {
        ctx.ui.notify(resultText(result.stdout, result.stderr), result.code === 0 ? "info" : "warning");
      }
    },
  });

  pi.registerCommand("wait", {
    description: "Wait for any of the named locks to be released",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      if (names.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /wait <name> [name...]", "warning");
        }
        return;
      }
      const result = await runSemaphore(pi, ["wait", ...names]);
      if (ctx.hasUI) {
        ctx.ui.notify(resultText(result.stdout, result.stderr), result.code === 0 ? "info" : "warning");
      }
    },
  });

  pi.registerCommand("lock-list", {
    description: "List locks in /tmp/pi-semaphores",
    handler: async (_args, ctx) => {
      const result = await runSemaphore(pi, ["list"]);
      if (!ctx.hasUI) {
        return;
      }
      const text = result.stdout.trim();
      ctx.ui.notify(text.length > 0 ? `Locks:\n${text}` : "No locks found.", "info");
    },
  });

  pi.registerTool({
    name: "semaphore_wait",
    label: "Wait for Locks",
    description:
      "Wait for one of many semaphore locks to be released. Use this to coordinate with other pi instances. " +
      "IMPORTANT: This call BLOCKS until a lock is released — you cannot do any other work while waiting. " +
      "Finish all independent tasks BEFORE calling this. " +
      "For agents spawned via tmux-coding-agent, wait on the lock name (e.g., 'worker').",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Name of the lock to wait for" })),
      names: Type.Optional(Type.Array(Type.String({ description: "Names of the locks to wait for" }))),
      timeoutSeconds: Type.Optional(
        Type.Number({ description: "Timeout in seconds before cancelling the wait (default: 120)" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const rawNames = params.names && params.names.length > 0 ? params.names : params.name ? [params.name] : [];
      const safeNames = rawNames.map((name) => sanitizeName(name)).filter((name) => name.length > 0);
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && params.timeoutSeconds > 0 ? params.timeoutSeconds : 120;

      if (safeNames.length === 0) {
        return {
          content: [{ type: "text", text: "No lock names provided." }],
          details: { names: [] as string[], found: false, code: 1, timeoutSeconds },
          isError: true,
        };
      }

      // For watch locks (<parent>:watch, <parent>:watch-N), automatically monitor
      // the parent lock too. If the parent releases before the watch pattern fires,
      // we report a warning instead of waiting forever on an orphaned watcher.
      const watchParentMap = new Map<string, string>(); // parent lock name -> watch lock name
      const parentNames: string[] = [];
      for (const name of safeNames) {
        const watchMatch = name.match(/^(.+?):watch(?:-\d+)?$/);
        if (watchMatch) {
          const parent = watchMatch[1];
          // Only add if the parent isn't already in the explicit wait list
          if (!safeNames.includes(parent)) {
            watchParentMap.set(parent, name);
            parentNames.push(parent);
          }
        }
      }
      const allNames = [...safeNames, ...parentNames];

      // Create a local abort controller so user input can interrupt the wait.
      // Combine with the tool's signal (abort on Escape) by forwarding it.
      const localAbort = new AbortController();
      waitAbortController = localAbort;

      const onToolAbort = () => localAbort.abort();
      if (signal) {
        if (signal.aborted) {
          localAbort.abort();
        } else {
          signal.addEventListener("abort", onToolAbort, { once: true });
        }
      }

      try {
        const result = await runSemaphore(
          pi,
          ["wait", "--timeout", String(timeoutSeconds), ...allNames],
          localAbort.signal,
        );
        const text = resultText(result.stdout, result.stderr);
        const found = result.code === 0;

        // If killed by user input, report interruption (not an error to the LLM)
        if (result.killed && localAbort.signal.aborted && !(signal?.aborted)) {
          return {
            content: [{ type: "text", text: "Wait interrupted by user message." }],
            details: { names: safeNames, found: false, code: result.code, timeoutSeconds, interrupted: true },
          };
        }

        // Check if a parent lock released (rather than the watch lock itself).
        // cmd_wait outputs one of:
        //   "Lock released: <name>"         (polling loop)
        //   "Lock '<name>' already idle."   (early exit, process finished)
        //   "Lock '<name>' already released (not found)."  (early exit, gone)
        if (found && watchParentMap.size > 0) {
          let releasedParent: string | undefined;
          for (const parent of watchParentMap.keys()) {
            const escaped = parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (new RegExp(`Lock released:\\s+${escaped}\\b`).test(text)
              || new RegExp(`Lock '${escaped}' already (idle|released)`).test(text)) {
              releasedParent = parent;
              break;
            }
          }
          if (releasedParent) {
            const watchName = watchParentMap.get(releasedParent)!;
            // Clean up the orphaned watch lock
            await runSemaphore(pi, ["release", watchName]);
            const warning =
              `⚠️ Parent lock '${releasedParent}' released while waiting for watch '${watchName}'. ` +
              `The watched process has stopped.`;
            return {
              content: [{ type: "text", text: warning }],
              details: { names: safeNames, found: true, code: 0, timeoutSeconds, parentStopped: releasedParent, watchLock: watchName },
            };
          }
        }

        if (result.code !== 0 && result.code !== 124) {
          return {
            content: [{ type: "text", text }],
            details: { names: safeNames, found, code: result.code, timeoutSeconds },
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text }],
          details: { names: safeNames, found, code: result.code, timeoutSeconds },
        };
      } finally {
        waitAbortController = null;
        if (signal) {
          signal.removeEventListener("abort", onToolAbort);
        }
      }
    },
  });
}

