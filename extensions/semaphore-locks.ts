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
): Promise<{ code: number; stdout: string; stderr: string }> {
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

  pi.on("agent_start", async (_event, ctx) => {
    const result = await runSemaphore(pi, ["agent-start"]);
    const text = resultText(result.stdout, result.stderr);
    if (result.code === 0) {
      const match = text.match(/Locked:\s+(.+)/);
      currentLockName = match?.[1]?.trim() || null;
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

      const result = await runSemaphore(pi, ["wait", "--timeout", String(timeoutSeconds), ...safeNames], signal);
      const text = resultText(result.stdout, result.stderr);
      const found = result.code === 0;

      if (result.code !== 0 && result.code !== 124) {
        return {
          content: [{ type: "text", text: text }],
          details: { names: safeNames, found, code: result.code, timeoutSeconds },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { names: safeNames, found, code: result.code, timeoutSeconds },
      };
    },
  });
}
