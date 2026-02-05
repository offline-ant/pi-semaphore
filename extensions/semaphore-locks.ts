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

const LOCK_DIR = "/tmp/pi-locks";

interface AutoLock {
	name: string;
	cmdIndex: number;
	pid: number;
	filePath: string;
	indexLinkPath: string;
	nameLinkPath: string;
}

function sanitizeName(name: string): string {
	return name.trim().replace(/[\\/]/g, "-").replace(/\s+/g, "-");
}

function getDefaultName(ctx: ExtensionContext): string {
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

async function lstatMaybe(filePath: string): Promise<fs.Stats | null> {
	try {
		return await fsp.lstat(filePath);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return null;
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

async function replaceSymlink(targetPath: string, linkPath: string): Promise<void> {
	const existing = await lstatMaybe(linkPath);
	if (existing) {
		if (!existing.isSymbolicLink()) {
			return;
		}
		await unlinkIfExists(linkPath);
	}
	await fsp.symlink(targetPath, linkPath);
}

async function removeSymlinkIfTarget(linkPath: string, targetPath: string): Promise<void> {
	const existing = await lstatMaybe(linkPath);
	if (!existing?.isSymbolicLink()) {
		return;
	}
	const linkTarget = await fsp.readlink(linkPath);
	const resolved = path.resolve(path.dirname(linkPath), linkTarget);
	if (resolved === targetPath) {
		await unlinkIfExists(linkPath);
	}
}

async function createAutoLock(name: string, cmdIndex: number): Promise<AutoLock> {
	await ensureLockDir();
	const pid = process.pid;
	const fileName = `${name}.${cmdIndex}.${pid}`;
	const filePath = path.join(LOCK_DIR, fileName);
	const indexLinkPath = path.join(LOCK_DIR, `${name}.${cmdIndex}`);
	const nameLinkPath = path.join(LOCK_DIR, name);

	try {
		await fsp.writeFile(filePath, `${fileName}\n`, { mode: 0o666, flag: "wx" });
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "EEXIST") {
			await fsp.writeFile(filePath, `${fileName}\n`, { mode: 0o666 });
		} else {
			throw error;
		}
	}

	await replaceSymlink(filePath, indexLinkPath);
	await replaceSymlink(filePath, nameLinkPath);

	return {
		name,
		cmdIndex,
		pid,
		filePath,
		indexLinkPath,
		nameLinkPath,
	};
}

async function clearAutoLock(lock: AutoLock): Promise<void> {
	await unlinkIfExists(lock.filePath);
	await unlinkIfExists(lock.indexLinkPath);
	await removeSymlinkIfTarget(lock.nameLinkPath, lock.filePath);
}

async function resolveLockTarget(name: string): Promise<string | null> {
	await ensureLockDir();
	const lockPath = path.join(LOCK_DIR, name);
	const info = await lstatMaybe(lockPath);
	if (!info) {
		return null;
	}
	if (info.isSymbolicLink()) {
		try {
			return await fsp.realpath(lockPath);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}
	return lockPath;
}

async function exists(filePath: string): Promise<boolean> {
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

async function waitForDeletion(targetPath: string): Promise<void> {
	if (!(await exists(targetPath))) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const watcher = fs.watch(LOCK_DIR, (_eventType, filename) => {
			if (!filename || filename !== path.basename(targetPath)) {
				return;
			}
			void exists(targetPath)
				.then((stillExists) => {
					if (!stillExists) {
						watcher.close();
						resolve();
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

		void exists(targetPath)
			.then((stillExists) => {
				if (!stillExists) {
					watcher.close();
					resolve();
				}
			})
			.catch((error) => {
				watcher.close();
				reject(error);
			});
	});
}

async function waitForDeletionWithSignal(targetPath: string, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) {
		return false;
	}

	if (!(await exists(targetPath))) {
		return true;
	}

	return new Promise<boolean>((resolve, reject) => {
		let watcher: fs.FSWatcher | null = null;
		const abortHandler = () => {
			watcher?.close();
			resolve(false);
		};

		signal?.addEventListener("abort", abortHandler, { once: true });

		watcher = fs.watch(LOCK_DIR, (_eventType, filename) => {
			if (!filename || filename !== path.basename(targetPath)) {
				return;
			}
			void exists(targetPath)
				.then((stillExists) => {
					if (!stillExists) {
						watcher.close();
						signal?.removeEventListener("abort", abortHandler);
						resolve(true);
					}
				})
				.catch((error) => {
					watcher.close();
					signal?.removeEventListener("abort", abortHandler);
					reject(error);
				});
		});

		watcher.on("error", (error) => {
			watcher.close();
			signal?.removeEventListener("abort", abortHandler);
			reject(error);
		});

		void exists(targetPath)
			.then((stillExists) => {
				if (!stillExists) {
					watcher.close();
					signal?.removeEventListener("abort", abortHandler);
					resolve(true);
				}
			})
			.catch((error) => {
				watcher.close();
				signal?.removeEventListener("abort", abortHandler);
				reject(error);
			});
	});
}

async function waitForAnyDeletion(targets: Array<{ name: string; targetPath: string }>): Promise<string> {
	const targetsByBasename = new Map<string, { name: string; targetPath: string }>();
	for (const target of targets) {
		targetsByBasename.set(path.basename(target.targetPath), target);
	}

	for (const target of targets) {
		if (!(await exists(target.targetPath))) {
			return target.name;
		}
	}

	return new Promise<string>((resolve, reject) => {
		const watcher = fs.watch(LOCK_DIR, (_eventType, filename) => {
			if (!filename) {
				return;
			}
			const target = targetsByBasename.get(filename);
			if (!target) {
				return;
			}
			void exists(target.targetPath)
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

		void Promise.all(targets.map((target) => exists(target.targetPath)))
			.then((results) => {
				const missingIndex = results.findIndex((result) => !result);
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
	targets: Array<{ name: string; targetPath: string }>,
	signal?: AbortSignal,
): Promise<{ releasedName?: string; cancelled: boolean }> {
	if (signal?.aborted) {
		return { cancelled: true };
	}

	const targetsByBasename = new Map<string, { name: string; targetPath: string }>();
	for (const target of targets) {
		targetsByBasename.set(path.basename(target.targetPath), target);
	}

	for (const target of targets) {
		if (!(await exists(target.targetPath))) {
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
			const target = targetsByBasename.get(filename);
			if (!target) {
				return;
			}
			void exists(target.targetPath)
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

		void Promise.all(targets.map((target) => exists(target.targetPath)))
			.then((results) => {
				const missingIndex = results.findIndex((result) => !result);
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
	const lines: string[] = [];

	for (const entry of entries) {
		const entryPath = path.join(LOCK_DIR, entry);
		const info = await lstatMaybe(entryPath);
		if (!info) {
			continue;
		}
		if (info.isSymbolicLink()) {
			const target = await fsp.readlink(entryPath);
			const resolved = path.resolve(path.dirname(entryPath), target);
			lines.push(`${entry} -> ${resolved}`);
		} else {
			lines.push(entry);
		}
	}

	if (lines.length === 0) {
		ctx.ui.notify("No locks found.", "info");
		return;
	}

	ctx.ui.notify(`Locks:\n${lines.join("\n")}`, "info");
}

export default function semaphoreLocksExtension(pi: ExtensionAPI) {
	let defaultName = "session";
	let cmdIndex = 0;
	let autoLock: AutoLock | null = null;

	async function releaseAutoLock(): Promise<void> {
		if (!autoLock) {
			return;
		}
		const current = autoLock;
		autoLock = null;
		await clearAutoLock(current);
	}

	pi.on("session_start", async (_event, ctx) => {
		defaultName = getDefaultName(ctx);
		cmdIndex = 0;
		await ensureLockDir();
	});

	pi.on("session_switch", async (_event, ctx) => {
		defaultName = getDefaultName(ctx);
		cmdIndex = 0;
	});

	pi.on("session_fork", async (_event, ctx) => {
		defaultName = getDefaultName(ctx);
		cmdIndex = 0;
	});

	pi.on("agent_start", async (_event, ctx) => {
		await releaseAutoLock();
		cmdIndex += 1;
		const name = parseName(undefined, defaultName);
		autoLock = await createAutoLock(name, cmdIndex);
		if (ctx.hasUI) {
			ctx.ui.setStatus("locks", `Locked: ${name}.${cmdIndex}.${autoLock.pid}`);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		await releaseAutoLock();
		if (ctx.hasUI) {
			ctx.ui.setStatus("locks", undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await releaseAutoLock();
		if (ctx.hasUI) {
			ctx.ui.setStatus("locks", undefined);
		}
	});

	pi.registerCommand("lock", {
		description: "Create a named lock in /tmp/pi-locks",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			await ensureLockDir();
			const name = parseName(args, defaultName);
			const lockPath = path.join(LOCK_DIR, name);
			const existing = await lstatMaybe(lockPath);
			if (existing) {
				ctx.ui.notify(`Lock already exists: ${name}`, "warning");
				return;
			}
			try {
				await fsp.writeFile(lockPath, `${name}\n`, { mode: 0o666, flag: "wx" });
				ctx.ui.notify(`Lock created: ${name}`, "info");
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code === "EEXIST") {
					ctx.ui.notify(`Lock already exists: ${name}`, "warning");
					return;
				}
				throw error;
			}
		},
	});

	pi.registerCommand("release", {
		description: "Release a named lock in /tmp/pi-locks",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			await ensureLockDir();
			const name = parseName(args, defaultName);
			const lockPath = path.join(LOCK_DIR, name);
			const existing = await lstatMaybe(lockPath);
			if (!existing) {
				ctx.ui.notify(`Lock not found: ${name}`, "warning");
				return;
			}
			if (existing.isSymbolicLink()) {
				ctx.ui.notify(`Refusing to release auto lock: ${name}`, "warning");
				return;
			}
			await unlinkIfExists(lockPath);
			ctx.ui.notify(`Lock released: ${name}`, "info");
		},
	});

	pi.registerCommand("wait", {
		description: "Wait for any of the named locks to be released",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			const names = parseNames(args);
			if (names.length === 0) {
				ctx.ui.notify("Usage: /wait <name> [name...]", "warning");
				return;
			}

			const entries = await Promise.all(
				names.map(async (name) => ({
					name,
					targetPath: await resolveLockTarget(name),
				})),
			);

			const missing = entries.filter((entry) => !entry.targetPath).map((entry) => entry.name);
			if (missing.length > 0) {
				ctx.ui.notify(`Lock not found: ${missing.join(", ")}`, "warning");
			}

			const targets = entries.filter(
				(entry): entry is { name: string; targetPath: string } => Boolean(entry.targetPath),
			);
			if (targets.length === 0) {
				return;
			}

			const waitNames = targets.map((entry) => entry.name);
			ctx.ui.notify(`Waiting for any lock: ${waitNames.join(", ")}`, "info");
			const releasedName = await waitForAnyDeletion(targets);
			ctx.ui.notify(`Lock released: ${releasedName}`, "info");
		},
	});

	pi.registerCommand("lock-list", {
		description: "List locks in /tmp/pi-locks",
		handler: async (_args, ctx) => {
			await showLockList(ctx);
		},
	});

	// Note: User bash commands (! and !!) don't create auto-locks because
	// there's no "user_bash_end" event to release them. The lock would persist
	// until the next agent prompt, which could cause issues.

	// Register tools so the LLM can use them programmatically
	pi.registerTool({
		name: "semaphore_wait",
		label: "Wait for Locks",
		description:
			"Wait for one of many semaphore locks to be released. Use this to coordinate with other pi instances. " +
			"Lock names are typically the directory basenames where other pi instances are running. " +
			"For example, if another pi is working in /tmp/my-project, the lock name would be 'my-project'.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Name of the lock to wait for" })),
			names: Type.Optional(Type.Array(Type.String({ description: "Names of the locks to wait for" }))),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const rawNames = params.names && params.names.length > 0 ? params.names : params.name ? [params.name] : [];
			const safeNames = rawNames.map((name) => sanitizeName(name)).filter((name) => name.length > 0);

			if (safeNames.length === 0) {
				return {
					content: [{ type: "text", text: "No lock names provided." }],
					details: { found: false, names: [] },
				};
			}

			const entries = await Promise.all(
				safeNames.map(async (name) => ({
					name,
					targetPath: await resolveLockTarget(name),
				})),
			);

			const missing = entries.filter((entry) => !entry.targetPath).map((entry) => entry.name);
			const targets = entries.filter(
				(entry): entry is { name: string; targetPath: string } => Boolean(entry.targetPath),
			);

			if (targets.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Locks not found: ${missing.join(", ")}. They may have already been released.`,
						},
					],
					details: { found: false, names: safeNames, missing },
				};
			}

			const waitNames = targets.map((entry) => entry.name);
			onUpdate?.({
				content: [{ type: "text", text: `Waiting for any lock: ${waitNames.join(", ")}...` }],
			});

			const result = await waitForAnyDeletionWithSignal(targets, signal);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: `Wait for locks '${waitNames.join(", ")}' was cancelled.` }],
					details: { found: true, names: waitNames, missing, cancelled: true },
				};
			}

			const releasedName = result.releasedName ?? waitNames[0];
			const releasedMessage = missing.length
				? `Lock released: ${releasedName}. Missing: ${missing.join(", ")}.`
				: `Lock released: ${releasedName}.`;

			return {
				content: [{ type: "text", text: releasedMessage }],
				details: { found: true, names: waitNames, missing, released: true, releasedName },
			};
		},
	});

	pi.registerTool({
		name: "semaphore_list",
		label: "List Locks",
		description: "List all semaphore locks currently held in /tmp/pi-locks.",
		parameters: Type.Object({}),
		async execute() {
			await ensureLockDir();
			let entries: string[] = [];
			try {
				entries = await fsp.readdir(LOCK_DIR);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code === "ENOENT") {
					return {
						content: [{ type: "text", text: "No locks found." }],
						details: { locks: [] },
					};
				}
				throw error;
			}

			entries.sort();
			const locks: Array<{ name: string; target?: string }> = [];

			for (const entry of entries) {
				const entryPath = path.join(LOCK_DIR, entry);
				const info = await lstatMaybe(entryPath);
				if (!info) {
					continue;
				}
				if (info.isSymbolicLink()) {
					const target = await fsp.readlink(entryPath);
					const resolved = path.resolve(path.dirname(entryPath), target);
					locks.push({ name: entry, target: resolved });
				} else {
					locks.push({ name: entry });
				}
			}

			if (locks.length === 0) {
				return {
					content: [{ type: "text", text: "No locks found." }],
					details: { locks: [] },
				};
			}

			const lines = locks.map((l) => (l.target ? `${l.name} -> ${l.target}` : l.name));
			return {
				content: [{ type: "text", text: `Locks:\n${lines.join("\n")}` }],
				details: { locks },
			};
		},
	});
}
