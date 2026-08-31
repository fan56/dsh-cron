/**
 * Schedule-rule and validity-window helpers shared by tools and scheduler.
 *
 * Rules: exactly one of a calendar (cron) or interval (every_seconds)
 * selector. Windows: recurring tasks carry exactly one of maxDurationSeconds
 * or endAt, capped at one year; startAt defaults to creation time (ADR 0007).
 * Interval occurrences are anchored at startAt with the first occurrence one
 * full interval in (k >= 1), matching dsh-schedule's creation-aligned
 * fixed-rate shape.
 *
 * @module dsh-cron/rule
 */

import { computeNextCronRun, countCronRunsBetween, cronToHuman, parseCronExpression } from './cron-expr.ts';
import type { CronTask, ScheduleSelector } from './types.ts';

/** One year, generous to leap days. */
export const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
/** Interval floor: cron's own granularity is one minute. */
export const MIN_EVERY_SECONDS = 60;

export class RuleInputError extends Error {}

export function parseSelector(input: { cron?: unknown; every_seconds?: unknown }): ScheduleSelector {
	const given = Number(input.cron !== undefined) + Number(input.every_seconds !== undefined);
	if (given !== 1) {
		throw new RuleInputError('exactly one of cron or every_seconds is required.');
	}
	if (input.cron !== undefined) {
		if (typeof input.cron !== 'string') throw new RuleInputError('cron must be a string.');
		try {
			parseCronExpression(input.cron);
		} catch (error) {
			throw new RuleInputError((error as Error).message);
		}
		return { kind: 'cron', cron: input.cron };
	}
	const s = input.every_seconds;
	if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < MIN_EVERY_SECONDS) {
		throw new RuleInputError(`every_seconds must be a safe integer >= ${MIN_EVERY_SECONDS}.`);
	}
	return { kind: 'every', everySeconds: s };
}

/** Validate and resolve the window from raw tool input; recurring tasks need exactly one bound. */
export function resolveWindow(
	input: { max_duration_seconds?: unknown; end_at?: unknown; start_at?: unknown },
	recurring: boolean,
	now: number,
): { startAt: number; windowEnd: number | null } {
	const bounds = Number(input.max_duration_seconds !== undefined) + Number(input.end_at !== undefined);
	if (recurring && bounds !== 1) {
		throw new RuleInputError('recurring tasks require exactly one of max_duration_seconds or end_at (no infinite cron).');
	}
	if (!recurring && bounds > 0) {
		throw new RuleInputError('one-shot tasks are bounded by their single fire; omit max_duration_seconds and end_at.');
	}

	let startAt = now;
	if (input.start_at !== undefined) {
		startAt = parseAbsolute(input.start_at, 'start_at');
		if (startAt <= now) throw new RuleInputError('start_at must be in the future.');
	}

	let windowEnd: number | null = null;
	if (input.max_duration_seconds !== undefined) {
		const s = input.max_duration_seconds;
		if (typeof s !== 'number' || !Number.isSafeInteger(s) || s <= 0 || s * 1000 > MAX_WINDOW_MS) {
			throw new RuleInputError('max_duration_seconds must be a positive safe integer <= one year.');
		}
		windowEnd = startAt + s * 1000;
	} else if (input.end_at !== undefined) {
		const end = parseAbsolute(input.end_at, 'end_at');
		if (end <= now) throw new RuleInputError('end_at must be in the future.');
		if (end > now + MAX_WINDOW_MS) throw new RuleInputError('end_at must be within one year.');
		windowEnd = end;
	}

	if (windowEnd !== null && windowEnd <= startAt) {
		throw new RuleInputError('the validity window ends before it starts.');
	}
	return { startAt, windowEnd };
}

/**
 * Absolute-time input: a strict RFC 3339 string with offset (or Z), or epoch
 * milliseconds. Naive local strings are accepted and read host-local once
 * (ADR 0007/0009); the plugin, not the model, owns the clock.
 */
export function parseAbsolute(value: unknown, field: string): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || value.trim() === '') {
		throw new RuleInputError(`${field} must be an RFC 3339 string or epoch ms.`);
	}
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new RuleInputError(`${field} is not a parseable timestamp: ${value}`);
	return ms;
}

/** First occurrence strictly after `afterMs` under this task's rule, or null. */
export function nextOccurrence(task: Pick<CronTask, 'selector' | 'startAt'>, afterMs: number): number | null {
	if (task.selector.kind === 'every') {
		const { everySeconds } = task.selector;
		const k = Math.floor(Math.max(afterMs - task.startAt, 0) / (everySeconds * 1000)) + 1;
		return task.startAt + k * everySeconds * 1000;
	}
	const parsed = parseCronExpression(task.selector.cron);
	return computeNextCronRun(parsed, Math.max(afterMs, task.startAt - 1));
}

/**
 * Count due-but-settled occurrences in (fromMs, toMs] for skip accounting,
 * bounded so a months-long outage cannot spin.
 */
export function countOccurrencesBetween(
	task: Pick<CronTask, 'selector' | 'startAt'>,
	fromMs: number,
	toMs: number,
	cap = 1000,
): number {
	if (task.selector.kind === 'every') {
		const lastK = Math.floor((toMs - task.startAt) / (task.selector.everySeconds * 1000));
		const firstK = Math.max(Math.floor((fromMs - task.startAt) / (task.selector.everySeconds * 1000)) + 1, 1);
		if (lastK < firstK) return 0;
		return Math.min(lastK - firstK + 1, cap);
	}
	const parsed = parseCronExpression(task.selector.cron);
	return countCronRunsBetween(parsed, Math.max(fromMs, task.startAt - 1), toMs, cap);
}

/** Human string for the rule, for list output and framing. */
export function ruleToHuman(selector: ScheduleSelector): string {
	return selector.kind === 'every' ? `every ${selector.everySeconds}s` : cronToHuman(selector.cron);
}
