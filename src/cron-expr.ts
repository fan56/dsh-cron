/**
 * 5-field cron expression parser and next-fire computation.
 *
 * Ported from @aiwayds/pi-kimi-cron (itself ported from Kimi Code), with two
 * deviations recorded in ADR 0009: no jitter, and host-local evaluation.
 *
 * @module dsh-cron/cron-expr
 */

const FIELD_RANGES: [number, number][] = [
	[0, 59], // minute
	[0, 23], // hour
	[1, 31], // day of month
	[1, 12], // month
	[0, 6], // day of week (0 = Sunday)
];

const MONTH_NAMES: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
	sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export interface ParsedCron {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
}

function resolveName(token: string, fieldIndex: number): number {
	const lower = token.toLowerCase();
	if (fieldIndex === 3 && lower in MONTH_NAMES) return MONTH_NAMES[lower]!;
	if (fieldIndex === 4 && lower in DOW_NAMES) return DOW_NAMES[lower]!;
	return parseInt(token, 10);
}

/** Parse one cron field (lists, ranges, steps, month/day names). */
export function parseField(field: string, fieldIndex: number): Set<number> {
	const [lo, hi] = FIELD_RANGES[fieldIndex]!;
	const result = new Set<number>();

	for (const part of field.split(',')) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		const slashIdx = trimmed.indexOf('/');
		let base = trimmed;
		let step = 1;
		if (slashIdx !== -1) {
			base = trimmed.slice(0, slashIdx);
			step = parseInt(trimmed.slice(slashIdx + 1), 10);
			if (Number.isNaN(step) || step < 1) {
				throw new Error(`Invalid step in cron field: ${trimmed}`);
			}
		}

		let rangeLo: number;
		let rangeHi: number;
		if (base === '*') {
			rangeLo = lo;
			rangeHi = hi;
		} else if (base.includes('-')) {
			const [a, b] = base.split('-');
			rangeLo = resolveName(a!, fieldIndex);
			rangeHi = resolveName(b!, fieldIndex);
		} else {
			rangeLo = resolveName(base, fieldIndex);
			rangeHi = rangeLo;
		}

		if (Number.isNaN(rangeLo) || Number.isNaN(rangeHi)) {
			throw new Error(`Invalid cron field value: ${trimmed}`);
		}
		if (rangeLo < lo || rangeHi > hi || rangeLo > rangeHi) {
			throw new Error(`Cron field value out of range [${lo}-${hi}]: ${trimmed}`);
		}
		for (let v = rangeLo; v <= rangeHi; v += step) result.add(v);
	}

	if (result.size === 0) throw new Error(`Cron field produced no values: ${field}`);
	return result;
}

/** Parse a full 5-field expression. Throws with a stable message on bad input. */
export function parseCronExpression(expr: string): ParsedCron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`);
	}
	return {
		minutes: parseField(fields[0]!, 0),
		hours: parseField(fields[1]!, 1),
		daysOfMonth: parseField(fields[2]!, 2),
		months: parseField(fields[3]!, 3),
		daysOfWeek: parseField(fields[4]!, 4),
	};
}

/**
 * Next occurrence strictly after `afterMs`, or null within `maxYears`.
 * Evaluated in the host's local time zone (ADR 0009).
 */
export function computeNextCronRun(parsed: ParsedCron, afterMs: number, maxYears = 4): number | null {
	const maxMs = afterMs + maxYears * 366 * 24 * 60 * 60 * 1000;
	const d = new Date(afterMs);
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1);

	while (d.getTime() <= maxMs) {
		if (!parsed.months.has(d.getMonth() + 1)) {
			d.setMonth(d.getMonth() + 1, 1);
			d.setHours(0, 0, 0, 0);
			continue;
		}
		const domMatch = parsed.daysOfMonth.has(d.getDate());
		const dowMatch = parsed.daysOfWeek.has(d.getDay());
		if (!domMatch || !dowMatch) {
			d.setDate(d.getDate() + 1);
			d.setHours(0, 0, 0, 0);
			continue;
		}
		if (!parsed.hours.has(d.getHours())) {
			d.setHours(d.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (!parsed.minutes.has(d.getMinutes())) {
			d.setMinutes(d.getMinutes() + 1, 0, 0);
			continue;
		}
		return d.getTime();
	}
	return null;
}

/**
 * Count occurrences in (fromMs, toMs], bounded. Used for skip accounting
 * (ADR 0002): a huge backlog is reported as the cap, never enumerated.
 */
export function countCronRunsBetween(parsed: ParsedCron, fromMs: number, toMs: number, cap = 1000): number {
	let count = 0;
	let cursor = fromMs;
	while (count < cap) {
		const next = computeNextCronRun(parsed, cursor, 1);
		if (next === null || next > toMs) break;
		count += 1;
		cursor = next;
	}
	return count;
}

const DOW_HUMAN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Short human rendering of a cron expression for list output. */
export function cronToHuman(cron: string): string {
	const presets: Record<string, string> = {
		'* * * * *': 'every minute',
		'0 * * * *': 'every hour',
		'0 0 * * *': 'daily at midnight',
		'0 9 * * *': 'daily at 9:00 AM',
		'0 9 * * 1-5': 'weekdays at 9:00 AM',
		'0 0 * * 0': 'weekly on Sunday at midnight',
		'0 0 1 * *': 'monthly on the 1st at midnight',
	};
	const normalized = cron.trim().replace(/\s+/g, ' ');
	if (presets[normalized]) return presets[normalized]!;

	const fields = normalized.split(' ');
	if (fields.length !== 5) return cron;
	const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

	// "*/N * * * *" — the deployment-polling shape deserves a clean human string.
	if (/^\*\/\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
		return `every ${minute.slice(2)} minutes`;
	}

	const parts: string[] = [];
	if (minute !== '*') parts.push(`at minute ${minute}`);
	if (hour !== '*') parts.push(`hour ${hour}`);
	if (dom !== '*') parts.push(`on day ${dom}`);
	if (month !== '*') parts.push(`in month ${month}`);
	if (dow !== '*') {
		const names = dow.split(',').map((d) => {
			const n = parseInt(d, 10);
			return Number.isNaN(n) ? d : (DOW_HUMAN[n] ?? d);
		});
		parts.push(`on ${names.join(', ')}`);
	}
	return parts.length > 0 ? parts.join(', ') : cron;
}
