/**
 * Profile-level persistence: per-id task files plus a capped history file.
 *
 * Ported from pi-kimi-cron's per-id JSON store (tmp+fsync+rename atomic
 * writes), retargeted from per-session directories to one profile-level
 * directory (ADR 0001). Fire records ride inside their task file, capped with
 * oldest eviction; ended tasks move to _history.json with their fire trail.
 *
 * @module dsh-cron/store
 */

import { mkdir, readdir, readFile, rename, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CRON_ID_REGEX, isValidCronTask, type CronTask, type HistoryEntry } from './types.ts';

const HISTORY_FILE = '_history.json';

async function atomicWrite(target: string, content: string): Promise<void> {
	const tmpPath = `${target}.${process.pid}.tmp`;
	const fd = await open(tmpPath, 'w');
	try {
		await fd.writeFile(content, 'utf-8');
		await fd.sync();
	} finally {
		await fd.close();
	}
	await rename(tmpPath, target);
}

export interface TaskStore {
	write(task: CronTask): Promise<void>;
	remove(id: string): Promise<void>;
	list(): Promise<CronTask[]>;
	dir(): string;
}

export function createTaskStore(dir: string): TaskStore {
	async function ensureDir(): Promise<void> {
		await mkdir(dir, { recursive: true });
	}

	return {
		async write(task: CronTask): Promise<void> {
			if (!CRON_ID_REGEX.test(task.id)) throw new Error(`Invalid cron task id: ${task.id}`);
			await ensureDir();
			await atomicWrite(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n');
		},

		async remove(id: string): Promise<void> {
			if (!CRON_ID_REGEX.test(id)) return;
			try {
				await unlink(join(dir, `${id}.json`));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			}
		},

		async list(): Promise<CronTask[]> {
			let entries: string[];
			try {
				entries = await readdir(dir);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
				throw err;
			}
			const tasks: CronTask[] = [];
			for (const entry of entries) {
				if (!entry.endsWith('.json') || entry === HISTORY_FILE) continue;
				try {
					const parsed: unknown = JSON.parse(await readFile(join(dir, entry), 'utf-8'));
					if (isValidCronTask(parsed)) tasks.push(parsed);
				} catch {
					// skip corrupt files; a torn tmp file must never wedge the scheduler
				}
			}
			return tasks;
		},

		dir: () => dir,
	};
}

export interface HistoryStore {
	archive(entry: HistoryEntry): Promise<void>;
	list(limit?: number): Promise<HistoryEntry[]>;
	get(id: string): Promise<HistoryEntry | undefined>;
	filePath(): string;
}

export function createHistoryStore(dir: string, limit: number): HistoryStore {
	const file = join(dir, HISTORY_FILE);

	async function readAll(): Promise<HistoryEntry[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
			return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw err;
		}
	}

	return {
		async archive(entry: HistoryEntry): Promise<void> {
			const entries = await readAll();
			entries.push(entry);
			while (entries.length > limit) entries.shift();
			await mkdir(dir, { recursive: true });
			await atomicWrite(file, JSON.stringify(entries, null, 2) + '\n');
		},

		async list(limit_ = 10): Promise<HistoryEntry[]> {
			return (await readAll()).slice(-limit_).reverse();
		},

		async get(id: string): Promise<HistoryEntry | undefined> {
			return (await readAll()).find((e) => e.id === id);
		},

		filePath: () => file,
	};
}

/** Append a fire record with oldest eviction; returns the updated task copy. */
export function withFire(task: CronTask, record: CronTask['fires'][number], limit: number): CronTask {
	const fires = [...task.fires, record];
	while (fires.length > limit) fires.shift();
	return { ...task, fires };
}

export { HISTORY_FILE };
