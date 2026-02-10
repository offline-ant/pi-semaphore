/**
 * Semaphore Locks Extension
 *
 * Creates auto-locks while the agent is running and exposes /lock, /release,
 * /wait, and /lock-list commands for cross-instance coordination.
 *
 * Also registers tools so the LLM can wait for locks programmatically.
 */

import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const LOCK_DIR = "/tmp/pi-semaphores";
const IDLE_PREFIX = "idle:";

export function sanitizeName(name: string): string {
	return name.trim().replace(/[\\/]/g, "-").replace(/\s+/g, "-");
}

function getDefaultName(ctx: ExtensionContext): string {
	// Prefer explicit lock name from env (set by tmux-bash when spawning pi)
	if (process.env.PI_LOCK_NAME) {
		const safe = sanitizeName(process.env.PI_LOCK_NAME);
		if (safe.length > 0) {
			return safe;
		}
	}
	// Fall back to directory basename
	const base = path.basename(ctx.cwd || process.cwd());
	const safe = sanitizeName(base || "session");
	return safe.length > 0 ? safe : "session";
}

async function ensureLockDir(): Promise<void> {
	await fsp.mkdir(LOCK_DIR, { recursive: true, mode: 0o777 });
	try {
		await fsp.chmod(LOCK_DIR, 0o777);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "EPERM") {
			throw error;
		}
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fsp.access(filePath, fs.constants.F_OK);
		return true;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fsp.unlink(filePath);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw error;
		}
	}
}

/**
 * Find a unique name by appending -2, -3, etc. if the base name is taken.
 */
async function findUniqueName(baseName: string): Promise<string> {
	await ensureLockDir();
	const basePath = path.join(LOCK_DIR, baseName);

	if (!(await fileExists(basePath))) {
		return baseName;
	}

	// Base name is taken, find a unique suffix
	let n = 2;
	while (n < 1000) {
		const candidateName = `${baseName}-${n}`;
		const candidatePath = path.join(LOCK_DIR, candidateName);
		if (!(await fileExists(candidatePath))) {
			return candidateName;
		}
		n++;
	}
	// Fallback: use PID to guarantee uniqueness
	return `${baseName}-${process.pid}`;
}

function getIdleMarkerPath(name: string): string {
	return path.join(LOCK_DIR, `${IDLE_PREFIX}${name}`);
}

function getLockPath(name: string): string {
	return path.join(LOCK_DIR, name);
}

async function clearIdleMarkers(): Promise<void> {
	await ensureLockDir();
	let entries: string[] = [];
	try {
		entries = await fsp.readdir(LOCK_DIR);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return;
		}
		throw error;
	}

	await Promise.all(
		entries
			.filter((entry) => entry.startsWith(IDLE_PREFIX))
			.map((entry) => unlinkIfExists(path.join(LOCK_DIR, entry))),
	);
}

async function createIdleMarker(name: string): Promise<void> {
	await ensureLockDir();
	const markerPath = getIdleMarkerPath(name);
	await fsp.writeFile(markerPath, `${name}\n`, { mode: 0o666 });
}

/**
 * Create a simple named lock with automatic deduplication.
 * If the name is taken, appends -2, -3, etc. to find a unique name.
 * Returns { name, path } with the actual name used, or null on failure.
 * Use releaseLock() to release it.
 */
export async function createLock(name: string): Promise<{ name: string; path: string } | null> {
	await ensureLockDir();
	const safeName = sanitizeName(name);
	const uniqueName = await findUniqueName(safeName);
	const lockPath = getLockPath(uniqueName);
	try {
		await fsp.writeFile(lockPath, `${uniqueName}\n`, { mode: 0o666, flag: "wx" });
		return { name: uniqueName, path: lockPath };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "EEXIST") {
			return null;
		}
		throw error;
	}
}

/**
 * Release a named lock. Returns true if released, false if not found.
 */
export async function releaseLock(name: string): Promise<boolean> {
	await ensureLockDir();
	const safeName = sanitizeName(name);
	const lockPath = getLockPath(safeName);
	if (!(await fileExists(lockPath))) {
		return false;
	}
	await unlinkIfExists(lockPath);
	return true;
}

async function waitForAnyDeletion(targets: Array<{ name: string; lockPath: string }>): Promise<string> {
	const pathsByBasename = new Map<string, { name: string; lockPath: string }>();
	for (const target of targets) {
		pathsByBasename.set(path.basename(target.lockPath), target);
	}

	// Check if any already deleted
	for (const target of targets) {
		if (!(await fileExists(target.lockPath))) {
			return target.name;
		}
	}

	return new Promise<string>((resolve, reject) => {
		const watcher = fs.watch(LOCK_DIR, (_eventType, filename) => {
			if (!filename) {
				return;
			}
			const target = pathsByBasename.get(filename);
			if (!target) {
				return;
			}
			void fileExists(target.lockPath)
				.then((stillExists) => {
					if (!stillExists) {
						watcher.close();
						resolve(target.name);
					}
				})
				.catch((error) => {
					watcher.close();
					reject(error);
				});
		});

		watcher.on("error", (error) => {
			watcher.close();
			reject(error);
		});

		// Double-check after watcher is set up
		void Promise.all(targets.map((target) => fileExists(target.lockPath)))
			.then((results) => {
				const missingIndex = results.findIndex((exists) => !exists);
				if (missingIndex >= 0) {
					watcher.close();
					resolve(targets[missingIndex].name);
				}
			})
			.catch((error) => {
				watcher.close();
				reject(error);
			});
	});
}

async function waitForAnyDeletionWithSignal(
	targets: Array<{ name: string; lockPath: string }>,
	signal?: AbortSignal,
): Promise<{ releasedName?: string; cancelled: boolean }> {
	if (signal?.aborted) {
		return { cancelled: true };
	}

	const pathsByBasename = new Map<string, { name: string; lockPath: string }>();
	for (const target of targets) {
		pathsByBasename.set(path.basename(target.lockPath), target);
	}

	// Check if any already deleted
	for (const target of targets) {
		if (!(await fileExists(target.lockPath))) {
			return { releasedName: target.name, cancelled: false };
		}
	}

	return new Promise<{ releasedName?: string; cancelled: boolean }>((resolve, reject) => {
		let watcher: fs.FSWatcher | null = null;
		const abortHandler = () => {
			watcher?.close();
			resolve({ cancelled: true });
		};

		signal?.addEventListener("abort", abortHandler, { once: true });

		watcher = fs.watch(LOCK_DIR, (_eventType, filename) => {
			if (!filename) {
				return;
			}
			const target = pathsByBasename.get(filename);
			if (!target) {
				return;
			}
			void fileExists(target.lockPath)
				.then((stillExists) => {
					if (!stillExists) {
						watcher?.close();
						signal?.removeEventListener("abort", abortHandler);
						resolve({ releasedName: target.name, cancelled: false });
					}
				})
				.catch((error) => {
					watcher?.close();
					signal?.removeEventListener("abort", abortHandler);
					reject(error);
				});
		});

		watcher.on("error", (error) => {
			watcher?.close();
			signal?.removeEventListener("abort", abortHandler);
			reject(error);
		});

		// Double-check after watcher is set up
		void Promise.all(targets.map((target) => fileExists(target.lockPath)))
			.then((results) => {
				const missingIndex = results.findIndex((exists) => !exists);
				if (missingIndex >= 0) {
					watcher?.close();
					signal?.removeEventListener("abort", abortHandler);
					resolve({ releasedName: targets[missingIndex].name, cancelled: false });
				}
			})
			.catch((error) => {
				watcher?.close();
				signal?.removeEventListener("abort", abortHandler);
				reject(error);
			});
	});
}

function parseName(args: string | undefined, fallback: string): string {
	const name = args?.trim();
	if (!name) {
		return fallback;
	}
	return sanitizeName(name);
}

function parseNames(args: string | undefined): string[] {
	const raw = args?.trim();
	if (!raw) {
		return [];
	}
	return raw
		.split(/\s+/)
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
		.map((name) => sanitizeName(name));
}

async function showLockList(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	await ensureLockDir();
	let entries: string[] = [];
	try {
		entries = await fsp.readdir(LOCK_DIR);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			ctx.ui.notify("No locks found.", "info");
			return;
		}
		throw error;
	}

	entries.sort();
	if (entries.length === 0) {
		ctx.ui.notify("No locks found.", "info");
		return;
	}

	ctx.ui.notify(`Locks:\n${entries.join("\n")}`, "info");
}

export default function semaphoreLocksExtension(pi: ExtensionAPI) {
	let defaultName = "session";
	let currentLockName: string | null = null;

	async function acquireLock(name: string): Promise<void> {
		await ensureLockDir();
		await clearIdleMarkers();
		const lockPath = getLockPath(name);
		try {
			await fsp.writeFile(lockPath, `${name}\n`, { mode: 0o666, flag: "wx" });
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "EEXIST") {
				// Overwrite if we own it (same name)
				await fsp.writeFile(lockPath, `${name}\n`, { mode: 0o666 });
			} else {
				throw error;
			}
		}
		currentLockName = name;
	}

	async function releaseCurrentLock(): Promise<void> {
		if (!currentLockName) {
			return;
		}
		const name = currentLockName;
		currentLockName = null;
		await unlinkIfExists(getLockPath(name));
		await createIdleMarker(name);
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureLockDir();
		const baseName = getDefaultName(ctx);
		defaultName = await findUniqueName(baseName);
	});

	pi.on("session_switch", async (_event, ctx) => {
		const baseName = getDefaultName(ctx);
		defaultName = await findUniqueName(baseName);
	});

	pi.on("session_fork", async (_event, ctx) => {
		const baseName = getDefaultName(ctx);
		defaultName = await findUniqueName(baseName);
	});

	pi.on("agent_start", async (_event, ctx) => {
		await releaseCurrentLock();
		await acquireLock(defaultName);
		if (ctx.hasUI) {
			ctx.ui.setStatus("locks", `Locked: ${defaultName}`);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		await releaseCurrentLock();
		if (ctx.hasUI) {
			ctx.ui.setStatus("locks", undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await releaseCurrentLock();
		await clearIdleMarkers();
		if (ctx.hasUI) {
			ctx.ui.setStatus("locks", undefined);
		}
	});

	pi.registerCommand("lock", {
		description: "Create a named lock in /tmp/pi-semaphores",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			const name = parseName(args, defaultName);
			const result = await createLock(name);
			if (result) {
				ctx.ui.notify(`Lock created: ${result.name}`, "info");
			} else {
				ctx.ui.notify(`Lock already exists: ${name}`, "warning");
			}
		},
	});

	pi.registerCommand("release", {
		description: "Release a named lock in /tmp/pi-semaphores",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			const name = parseName(args, defaultName);
			const released = await releaseLock(name);
			if (released) {
				ctx.ui.notify(`Lock released: ${name}`, "info");
			} else {
				ctx.ui.notify(`Lock not found: ${name}`, "warning");
			}
		},
	});

	pi.registerCommand("lock-list", {
		description: "List locks in /tmp/pi-semaphores",
		handler: async (_args, ctx) => {
			await showLockList(ctx);
		},
	});

	pi.registerTool({
		name: "semaphore_wait",
		label: "Wait for Locks",
		description:
			"Wait for one of many semaphore locks to be released. Use this to coordinate with other pi instances. " +
			"IMPORTANT: This call BLOCKS until a lock is released — you cannot do any other work while waiting. " +
			"Finish all independent tasks BEFORE calling this. " +
			"Lock names are typically the directory basenames where other pi instances are running. " +
			"For example, if another pi is working in /tmp/my-project, the lock name would be 'my-project'. " +
			"For agents spawned via tmux-coding-agent, wait on the window name (e.g., 'worker'), NOT 'tmux:worker'. " +
			"To list current locks before waiting, use bash('ls /tmp/pi-semaphores').",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Name of the lock to wait for" })),
			names: Type.Optional(Type.Array(Type.String({ description: "Names of the locks to wait for" }))),
			timeoutSeconds: Type.Optional(
				Type.Number({ description: "Timeout in seconds before cancelling the wait (default: 120)" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawNames = params.names && params.names.length > 0 ? params.names : params.name ? [params.name] : [];
			const safeNames = rawNames.map((name) => sanitizeName(name)).filter((name) => name.length > 0);
			const timeoutSeconds =
				typeof params.timeoutSeconds === "number" && params.timeoutSeconds > 0 ? params.timeoutSeconds : 120;

			if (safeNames.length === 0) {
				return {
					content: [{ type: "text", text: "No lock names provided." }],
					details: { found: false, names: [] },
				};
			}

			const targets: Array<{ name: string; lockPath: string }> = [];
			const missing: string[] = [];

			for (const name of safeNames) {
				const lockPath = getLockPath(name);
				if (await fileExists(lockPath)) {
					targets.push({ name, lockPath });
				} else {
					missing.push(name);
				}
			}

			// If any requested lock doesn't exist, it's already "released" —
			// return immediately since we wait for ANY lock to be released.
			if (missing.length > 0) {
				const releasedName = missing[0];
				const msg =
					targets.length > 0
						? `Lock '${releasedName}' already released (not found). Still active: ${targets.map((t) => t.name).join(", ")}.`
						: `Lock '${releasedName}' already released (not found).`;
				return {
					content: [{ type: "text", text: msg }],
					details: { found: false, names: safeNames, missing, released: true, releasedName },
				};
			}

			const waitNames = targets.map((t) => t.name);
			onUpdate?.({
				content: [{ type: "text", text: `Waiting for any lock: ${waitNames.join(", ")}...` }],
				details: { waiting: true, names: waitNames },
			});

			// Create a combined abort controller that fires on either:
			// 1. The tool's signal (Ctrl+C abort)
			// 2. A new user message (steering) arriving
			const combinedController = new AbortController();
			const combinedSignal = combinedController.signal;

			// Forward the tool's abort signal
			if (signal?.aborted) {
				combinedController.abort();
			} else {
				signal?.addEventListener("abort", () => combinedController.abort(), { once: true });
			}

			// Poll for pending steering messages
			const pollInterval = setInterval(() => {
				if (ctx.hasPendingMessages()) {
					combinedController.abort();
				}
			}, 200);

			let timeoutTriggered = false;
			const timeoutHandle = setTimeout(() => {
				timeoutTriggered = true;
				combinedController.abort();
			}, Math.max(0, Math.round(timeoutSeconds * 1000)));

			let result: { releasedName?: string; cancelled: boolean };
			try {
				result = await waitForAnyDeletionWithSignal(targets, combinedSignal);
			} finally {
				clearInterval(pollInterval);
				clearTimeout(timeoutHandle);
			}

			if (result.cancelled) {
				const reason = timeoutTriggered
					? `Timed out after ${timeoutSeconds}s.`
					: ctx.hasPendingMessages()
						? "New user message received while waiting."
						: "Wait was cancelled.";
				return {
					content: [
						{
							type: "text",
							text: `Finished: ${reason} Waiting for locks '${waitNames.join(", ")}' cancelled.`,
						},
					],
					details: { found: true, names: waitNames, missing, cancelled: true, reason },
				};
			}

			const releasedName = result.releasedName ?? waitNames[0];
			const releasedMessage = missing.length
				? `Lock '${releasedName}' released. Missing: ${missing.join(", ")}.`
				: `Lock '${releasedName}' released.`;

			return {
				content: [{ type: "text", text: releasedMessage }],
				details: { found: true, names: waitNames, missing, released: true, releasedName },
			};
		},
	});
}
