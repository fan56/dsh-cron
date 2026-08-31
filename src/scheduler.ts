/**
 * Tick-loop scheduling engine — the dsh-free core.
 *
 * dsh runtime specifics enter only through injected seams (`clock`,
 * `targets`, `deliver`, `framing`, `logger`), so the whole delivery state
 * machine runs in plain unit tests with fake agents and fixed clocks.
 *
 * Semantics (see docs/adr/):
 * - Skip missed occurrences (ADR 0002): a due occurrence that cannot be
 *   delivered now — no live target, or downtime discovered at rehydrate — is
 *   logged and settled, never delivered late.
 * - Busy coalescing (ADR 0003): `followup` fires claim the true idle phase
 *   via the host's maintenance gate; a synchronous rejection means the
 *   target is busy and the occurrence stays due, to be delivered as one fire
 *   (with the collapsed count) at the first idle tick. `steer` fires submit
 *   directly — dsh consumes them at the nearest step boundary.
 * - Bounded tasks (ADR 0006): crossing `windowEnd` delivers one terminal
 *   `expired` fire (best-effort) and archives the task.
 *
 * @module dsh-cron/scheduler
 */

import { renderExpiryFraming, renderFireFraming } from './framing.ts';
import { countOccurrencesBetween, nextOccurrence, parseSelector, resolveWindow, RuleInputError } from './rule.ts';
import { withFire, type HistoryStore, type TaskStore } from './store.ts';
import {
	generateId,
	type Clock,
	type CronConfig,
	type CronTask,
	type FireRecord,
	type HistoryEntry,
	type HistoryStatus,
} from './types.ts';

/** The slice of a live dsh agent the engine touches. */
export interface AgentLike {
	id: string;
}

/** Delivery outcome for one submit attempt. */
export type DeliveryOutcome = 'delivered' | 'busy';

export interface FramingHooks {
	fire(task: CronTask, fire: FireRecord, occurrenceAt: string): string;
	expiry(task: CronTask, fire: FireRecord): string;
}

export interface EngineOptions {
	clock: Clock;
	store: TaskStore;
	historyStore: HistoryStore;
	config: Pick<CronConfig, 'fireHistoryLimit'>;
	logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
	/** Live root agents in creation order; empty array = no target (ADR 0002). */
	targets: () => AgentLike[];
	/**
	 * Submit one fire framing. `followup` implementors gate on the idle phase
	 * and return 'busy' when the target is mid-turn; `steer` implementors
	 * submit unconditionally and always return 'delivered'.
	 */
	deliver: (agent: AgentLike, text: string, policy: 'followup' | 'steer') => Promise<DeliveryOutcome>;
	/** Override the framing text (tests); defaults to the dsh-schedule-style renderer. */
	framing?: FramingHooks;
}

export interface CreateTaskInput {
	cron?: unknown;
	every_seconds?: unknown;
	prompt?: unknown;
	recurring?: unknown;
	delivery_policy?: unknown;
	execution_mode?: unknown;
	max_duration_seconds?: unknown;
	end_at?: unknown;
	start_at?: unknown;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new RuleInputError(`${field} must be one of ${allowed.join(', ')}.`);
	}
	return value as T;
}

export class CronEngine {
	private readonly tasks = new Map<string, CronTask>();
	private readonly opts: EngineOptions;

	constructor(options: EngineOptions) {
		this.opts = options;
	}

	listTasks(): CronTask[] {
		return [...this.tasks.values()];
	}

	getTask(id: string): CronTask | undefined {
		return this.tasks.get(id);
	}

	get size(): number {
		return this.tasks.size;
	}

	/**
	 * Resume from disk. Occurrences that came due while the profile was down
	 * are skipped and logged (ADR 0002); one-shots missed in downtime are
	 * archived as `missed`.
	 */
	async rehydrate(): Promise<{ skipped: number; missed: number }> {
		const now = this.opts.clock.now();
		let skipped = 0;
		let missed = 0;
		for (const task of await this.opts.store.list()) {
			this.tasks.set(task.id, task);
			const next = nextOccurrence(task, task.cursorAt);
			if (next === null || next > now) continue;
			if (task.recurring) {
				const count = countOccurrencesBetween(task, task.cursorAt, now);
				skipped += count;
				this.opts.logger.warn(
					`cron: skipped ${count} occurrence(s) missed while offline for task ${task.id} (${task.prompt.slice(0, 60)}); window continues`,
				);
				await this.settleCursor(task.id, now);
			} else {
				missed += 1;
				this.opts.logger.warn(
					`cron: one-shot task ${task.id} came due while offline; archived as missed, never executed (ADR 0002)`,
				);
				await this.archive(task.id, 'missed');
			}
		}
		return { skipped, missed };
	}

	/** Validate raw tool input and create a task. Throws RuleInputError on bad input. */
	async createTask(input: CreateTaskInput, createdBy: string): Promise<CronTask> {
		const now = this.opts.clock.now();
		if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
			throw new RuleInputError('prompt must be a non-empty string.');
		}
		const selector = parseSelector(input);
		if (input.recurring !== undefined && typeof input.recurring !== 'boolean') {
			throw new RuleInputError('recurring must be a boolean.');
		}
		const recurring = input.recurring === undefined ? true : input.recurring === true;
		const policy = normalizeEnum(input.delivery_policy, ['followup', 'steer'] as const, 'delivery_policy') ?? 'followup';
		const mode = normalizeEnum(input.execution_mode, ['self', 'sub-agent'] as const, 'execution_mode') ?? 'sub-agent';
		const { startAt, windowEnd } = resolveWindow(input, recurring, now);

		const task: CronTask = {
			id: generateId(),
			selector,
			prompt: input.prompt,
			recurring,
			deliveryPolicy: policy,
			executionMode: mode,
			createdAt: now,
			startAt,
			windowEnd,
			cursorAt: now,
			lastFiredAt: 0,
			createdBy,
			fires: [],
		};
		this.tasks.set(task.id, task);
		await this.persist(task);
		return task;
	}

	/** Remove and archive a task. Returns the removed task, if any. */
	async deleteTask(id: string, status: HistoryStatus = 'cancelled'): Promise<CronTask | undefined> {
		const task = this.tasks.get(id);
		if (!task) return undefined;
		await this.archive(id, status);
		return task;
	}

	/** Backfill a fire record from cron_report. */
	async report(
		taskId: string,
		fireId: string,
		patch: { status: 'completed' | 'failed'; summary?: string; error?: string },
	): Promise<{ ok: boolean; archived: boolean; error?: string }> {
		const task = this.tasks.get(taskId);
		if (!task) return { ok: false, archived: false, error: `task ${taskId} not found (may have been deleted).` };
		const fire = task.fires.find((f) => f.fireId === fireId);
		if (!fire) return { ok: false, archived: false, error: `fire ${fireId} not found in task ${taskId}.` };
		fire.status = patch.status;
		fire.summary = patch.summary;
		fire.error = patch.error;
		await this.persist(task);
		let archived = false;
		if (!task.recurring) {
			await this.archive(taskId, patch.status === 'completed' ? 'done' : 'failed');
			archived = true;
		}
		return { ok: true, archived };
	}

	/** One scheduling pass. Awaiting it in tests keeps ordering deterministic. */
	async tick(): Promise<void> {
		const now = this.opts.clock.now();
		for (const task of [...this.tasks.values()]) {
			try {
				await this.processTask(task, now);
			} catch (error) {
				this.opts.logger.warn(`cron: task ${task.id} tick error: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private async processTask(task: CronTask, now: number): Promise<void> {
		if (task.windowEnd !== null && now >= task.windowEnd) {
			await this.expire(task, now);
			return;
		}
		const due = nextOccurrence(task, task.cursorAt);
		if (due === null || due > now) return;

		const target = this.opts.targets()[0];
		if (!target) {
			// Missed Occurrence (ADR 0002): profile alive, no live agent.
			this.opts.logger.warn(
				`cron: no live agent for task ${task.id} occurrence at ${new Date(due).toISOString()}; skipped, never delivered late`,
			);
			await this.settleCursor(task.id, now);
			if (!task.recurring) await this.archive(task.id, 'missed');
			return;
		}

		const collapsed = Math.max(1, countOccurrencesBetween(task, task.cursorAt, now));
		const fire: FireRecord = {
			fireId: generateId(),
			dueAt: due,
			deliveredAt: now,
			policy: task.deliveryPolicy,
			executionMode: task.executionMode,
			coalescedCount: collapsed,
			status: 'delivered',
		};
		const text = renderFireFraming(task, fire, new Date(due).toISOString());
		const outcome = await this.opts.deliver(target, text, task.deliveryPolicy);
		if (outcome === 'busy') {
			// Busy target under the followup policy: the occurrence stays due
			// and coalesces into the first idle-tick delivery (ADR 0003).
			this.opts.logger.info(`cron: target busy for task ${task.id}; fire coalesces until idle`);
			return;
		}
		await this.commitFire(task.id, fire, now);
	}

	private async expire(task: CronTask, now: number): Promise<void> {
		const fire: FireRecord = {
			fireId: generateId(),
			dueAt: task.windowEnd ?? now,
			deliveredAt: now,
			policy: task.deliveryPolicy,
			executionMode: task.executionMode,
			coalescedCount: 1,
			status: 'expired',
		};
		const target = this.opts.targets()[0];
		if (target) {
			// The notice is one-shot and queue-safe by construction, so both
			// policies submit directly; a busy target still receives it at the
			// next boundary or idle turn.
			await this.opts.deliver(target, renderExpiryFraming(task, fire), task.deliveryPolicy);
		} else {
			this.opts.logger.warn(`cron: task ${task.id} expired with no live agent; expiry notice undeliverable`);
		}
		this.opts.logger.warn(`cron: task ${task.id} validity window closed; archived as expired (ADR 0006)`);
		await this.archiveWithFire(task.id, fire, now, 'expired');
	}

	private async commitFire(id: string, fire: FireRecord, now: number): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) return;
		const updated = withFire({ ...task, cursorAt: now, lastFiredAt: now }, fire, this.opts.config.fireHistoryLimit);
		this.tasks.set(id, updated);
		await this.persist(updated);
	}

	private async settleCursor(id: string, now: number): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) return;
		const updated = { ...task, cursorAt: now };
		this.tasks.set(id, updated);
		await this.persist(updated);
	}

	private async archiveWithFire(id: string, fire: FireRecord, now: number, status: HistoryStatus): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) return;
		const updated = withFire(task, fire, this.opts.config.fireHistoryLimit);
		await this.writeHistory(updated, status, now);
		this.tasks.delete(id);
		await this.opts.store.remove(id);
	}

	private async archive(id: string, status: HistoryStatus): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) return;
		await this.writeHistory(task, status, this.opts.clock.now());
		this.tasks.delete(id);
		await this.opts.store.remove(id);
	}

	private async writeHistory(task: CronTask, status: HistoryStatus, endedAt: number): Promise<void> {
		const entry: HistoryEntry = {
			id: task.id,
			selector: task.selector,
			prompt: task.prompt,
			recurring: task.recurring,
			createdBy: task.createdBy,
			createdAt: task.createdAt,
			endedAt,
			status,
			fires: task.fires,
		};
		try {
			await this.opts.historyStore.archive(entry);
		} catch (error) {
			this.opts.logger.warn(`cron: history archive failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async persist(task: CronTask): Promise<void> {
		try {
			await this.opts.store.write(task);
		} catch (error) {
			this.opts.logger.warn(`cron: persist failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
