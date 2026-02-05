/**
 * Semaphore Locks Extension
 *
 * Creates auto-locks while the agent is running and exposes /lock, /release,
 * /wait, and /lock-list commands for cross-instance coordination.
 */

import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

function parseName(args: string | undefined, fallback: string): string {
	const name = args?.trim();
	if (!name) {
		return fallback;
	}
	return sanitizeName(name);
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
		description: "Wait for a named lock to be released",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			const name = args?.trim();
			if (!name) {
				ctx.ui.notify("Usage: /wait <name>", "warning");
				return;
			}
			const safeName = sanitizeName(name);
			const targetPath = await resolveLockTarget(safeName);
			if (!targetPath) {
				ctx.ui.notify(`Lock not found: ${safeName}`, "warning");
				return;
			}
			ctx.ui.notify(`Waiting for lock: ${safeName}`, "info");
			await waitForDeletion(targetPath);
			ctx.ui.notify(`Lock released: ${safeName}`, "info");
		},
	});

	pi.registerCommand("lock-list", {
		description: "List locks in /tmp/pi-locks",
		handler: async (_args, ctx) => {
			await showLockList(ctx);
		},
	});
}
