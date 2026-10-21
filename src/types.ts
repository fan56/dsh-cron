/**
 * dsh-cron data model: bounded cron tasks, fire records, history.
 *
 * Every recurring task carries a mandatory validity window capped at one year
 * (ADR 0006) — there is no infinite cron. Every task is anchored to exactly
 * one session (ADR 0010) — there is no global delivery: fires land only in
 * the task's own session, and the store merely persists that binding at
 * profile level so it survives restarts.
 *
 * @module dsh-cron/types
 */

/** A schedule rule: exactly one of a 5-field calendar expression or an interval. */
export type ScheduleSelector =
	| { kind: 'cron'; cron: string }
	| { kind: 'every'; everySeconds: number };

/**
 * How a task's session is chosen at creation (ADR 0010). `creator` binds the
 * session that ran cron_create; `new` binds a dedicated session the plugin
 * opens for the task at creation time.
 */
export type AttachMode = 'creator' | 'new';

/** How fires land in the target conversation (ADR 0003). */
export type DeliveryPolicy = 'followup' | 'steer';

/** Who works on a fire's prompt (ADR 0005). */
export type ExecutionMode = 'self' | 'sub-agent';

/** Lifecycle status of one delivered fire. */
export type FireStatus = 'delivered' | 'completed' | 'failed' | 'expired';

/** Audit entry for one delivered fire. Every fire produces exactly one. */
export interface FireRecord {
	fireId: string; // 8-hex, unique per fire
	dueAt: number; // epoch ms of the occurrence that came due
	deliveredAt: number; // epoch ms when the framing was submitted
	policy: DeliveryPolicy;
	executionMode: ExecutionMode;
	coalescedCount: number; // occurrences collapsed into this fire (>= 1)
	status: FireStatus;
	summary?: string; // from cron_report
	error?: string; // from cron_report
}

/** Terminal status of an archived (ended) task. */
export type HistoryStatus = 'done' | 'failed' | 'cancelled' | 'missed' | 'expired';

/** A recurring or one-shot scheduled task, bound to exactly one session. */
export interface CronTask {
	id: string; // 8-hex
	selector: ScheduleSelector;
	prompt: string;
	recurring: boolean; // false = one-shot (fires once, then archives)
	attach: AttachMode; // how the bound session was chosen (ADR 0010)
	sessionId: string; // the one session every fire is delivered to (ADR 0010)
	deliveryPolicy: DeliveryPolicy;
	executionMode: ExecutionMode;
	createdAt: number; // epoch ms
	startAt: number; // epoch ms; first anchor of the schedule (default: createdAt)
	windowEnd: number | null; // epoch ms; mandatory for recurring (ADR 0006)
	cursorAt: number; // scheduling cursor: occurrences <= cursorAt are settled
	lastFiredAt: number; // epoch ms of the last actual fire (0 = never; audit only)
	createdBy: string; // agent id that created the task
	fires: FireRecord[]; // capped, oldest-evicted (default 7)
}

/** An archived task with its full fire trail. */
export interface HistoryEntry {
	id: string;
	selector: ScheduleSelector;
	prompt: string;
	recurring: boolean;
	attach?: AttachMode; // absent in pre-0010 archive rows
	sessionId?: string; // absent in pre-0010 archive rows
	createdBy: string;
	createdAt: number;
	endedAt: number;
	status: HistoryStatus;
	fires: FireRecord[];
}

/** Resolved plugin settings (the `dsh-cron` profile entry config). */
export interface CronConfig {
	/** Per-task fire-record retention; oldest evicted. Default 7. */
	fireHistoryLimit: number;
	/** Archived-task FIFO cap for _history.json. Default 50. */
	historyLimit: number;
	/** Tick loop period in ms. Default 15000. */
	tickIntervalMs: number;
	/** Storage directory override; empty = <dsh home>/storages/cron. */
	storageDir: string;
}

/** Clock seam so the scheduler is testable (fixed/offset clocks). */
export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(ms: number): Clock {
	return { now: () => ms };
}

export function offsetClock(offsetMs: number): Clock {
	return { now: () => Date.now() + offsetMs };
}

export const CRON_ID_REGEX = /^[0-9a-f]{8}$/;

const ATTACH_MODES: readonly AttachMode[] = ['creator', 'new'];

export function generateId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Lenient decode-side guard: pre-0010 task files carry no attach/sessionId
 * and must still load (the engine archives them as cancelled at rehydrate,
 * see `isUnboundTask`), so only present fields are shape-checked here.
 */
export function isValidCronTask(value: unknown): value is CronTask {
	if (typeof value !== 'object' || value === null) return false;
	const o = value as Record<string, unknown>;
	return (
		typeof o.id === 'string' &&
		CRON_ID_REGEX.test(o.id) &&
		typeof o.prompt === 'string' &&
		typeof o.recurring === 'boolean' &&
		(o.attach === undefined || (typeof o.attach === 'string' && ATTACH_MODES.includes(o.attach as AttachMode))) &&
		(o.sessionId === undefined || (typeof o.sessionId === 'string' && o.sessionId.length > 0)) &&
		typeof o.createdAt === 'number' &&
		typeof o.startAt === 'number' &&
		typeof o.cursorAt === 'number' &&
		typeof o.lastFiredAt === 'number' &&
		typeof o.createdBy === 'string' &&
		typeof o.fires === 'object' &&
		o.fires !== null
	);
}

/**
 * A task from before ADR 0010: no session binding, therefore undeliverable
 * under the no-global-delivery rule. The engine archives these as cancelled.
 */
export function isUnboundTask(
	task: Pick<CronTask, 'sessionId'>,
): boolean {
	return typeof task.sessionId !== 'string' || task.sessionId.length === 0;
}
