/**
 * Model-facing cron tools over the engine, registered on every runtime agent
 * (ADR 0006): cron_create / cron_list / cron_delete / cron_report.
 *
 * Parameter schemas stay loose here; rich validation lives in rule.ts and
 * the engine so tests cover it without a host, and failures render as stable
 * `{ ok: false, error }` values rather than throws.
 *
 * @module dsh-cron/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
// Type only: dsh-session 0.1.2-alpha.3 stopped re-exporting JsonValue; the
// canonical definition moved to the dsh-util-values split package.
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { MIN_EVERY_SECONDS, ruleToHuman } from './rule.ts';
import { nextOccurrence } from './rule.ts';
import type { CronEngine } from './scheduler.ts';
import type { CronTask } from './types.ts';

/** Minimal slice of the agent context needed to register tools. */
export interface ToolRegistrarContext {
	tools: { register(definition: ToolDefinition): () => void };
}

/** Minimal slice of the live agent handed to tool execute. */
export interface ToolAgent {
	readonly id: string;
}

const renderJson = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }];

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function nextFireOf(task: CronTask): number | null {
	return nextOccurrence(task, task.cursorAt);
}

function taskView(task: CronTask): Record<string, JsonValue> {
	const next = nextFireOf(task);
	return {
		id: task.id,
		rule: task.selector.kind === 'cron' ? task.selector.cron : { every_seconds: task.selector.everySeconds },
		rule_human: ruleToHuman(task.selector),
		prompt: task.prompt,
		recurring: task.recurring,
		delivery_policy: task.deliveryPolicy,
		execution_mode: task.executionMode,
		created_by: task.createdBy,
		created_at: iso(task.createdAt),
		start_at: iso(task.startAt),
		window_end: task.windowEnd === null ? null : iso(task.windowEnd),
		next_fire: next === null ? null : iso(next),
		last_fired_at: task.lastFiredAt === 0 ? null : iso(task.lastFiredAt),
		fires: task.fires.map((f) => ({
			fire_id: f.fireId,
			due_at: iso(f.dueAt),
			status: f.status,
			coalesced_count: f.coalescedCount,
			summary: f.summary ?? null,
			error: f.error ?? null,
		})),
	};
}

const CREATE_DESCRIPTION = `Create a bounded scheduled task (no infinite cron). Supply exactly one rule: cron (5-field expression, host-local time) or every_seconds (interval, >= ${MIN_EVERY_SECONDS}, first fire one full interval after start). Recurring tasks additionally require exactly one window bound: max_duration_seconds or end_at (absolute RFC 3339 or epoch ms), capped at one year; one-shot tasks (recurring=false) must omit the window and self-archive after their single fire. Optional start_at schedules the first anchor in the future. delivery_policy: followup (default; new turn when the agent is idle, busy waits and coalesces) or steer (lands at the next step boundary, for watchdogs). execution_mode: sub-agent (default; the prompt is worked by an isolated background sub-agent, then cron_report backfills the result) or self (handled in this conversation). The tool result echoes absolute ISO times including next_fire — never compute times yourself.`;

const DELETE_DESCRIPTION =
	'Delete one active cron task by its id and archive it to history as cancelled. Unknown ids return deleted: false. To end a monitor after a terminal observation, delete the task after calling cron_report.';

const LIST_DESCRIPTION =
	'List every active cron task with rule, window, next fire time, and the retained fire records (most recent first-capped). Times are absolute ISO strings.';

const REPORT_DESCRIPTION =
	'Report the outcome of one cron fire after the work completes: status and a one-line summary including the task id for traceability. Required after a cron-fired sub-agent finishes. One-shot tasks archive automatically on report.';

/** Register the four cron tools on one agent's tool context. */
export function registerCronTools(toolCtx: ToolRegistrarContext, agent: ToolAgent, engine: CronEngine): () => void {
	const disposers: Array<() => void> = [];

	disposers.push(
		toolCtx.tools.register(
			defineTool({
				name: 'cron_create',
				description: CREATE_DESCRIPTION,
				parameters: {
					prompt: { type: 'string', required: true, description: 'Untrusted prompt text delivered when a fire is due.' },
					cron: { type: 'string', description: '5-field cron expression, e.g. "*/10 * * * *" or "0 9 * * 1-5" (host-local time).' },
					every_seconds: { type: 'number', description: `Interval rule in seconds, >= ${MIN_EVERY_SECONDS}; first fire one interval after start_at.` },
					recurring: { type: 'boolean', description: 'Repeat after firing (default true). false = one-shot; must omit window bounds.' },
					max_duration_seconds: { type: 'number', description: 'Validity window length in seconds (recurring tasks: required unless end_at). Max one year.' },
					end_at: {
						oneOf: [{ type: 'string' }, { type: 'number' }],
						description: 'Absolute window end as RFC 3339 string (with offset) or epoch ms (recurring tasks: required unless max_duration_seconds).',
					},
					start_at: {
						oneOf: [{ type: 'string' }, { type: 'number' }],
						description: 'Optional first anchor as RFC 3339 string (with offset) or epoch ms; must be in the future.',
					},
					delivery_policy: { type: 'string', description: '"followup" (default) waits for idle and coalesces; "steer" lands at the next step boundary mid-turn.' },
					execution_mode: { type: 'string', description: '"sub-agent" (default) spawns an isolated worker; "self" handles the prompt in the target conversation.' },
				},
				output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
				async execute(args, exec) {
					const out: Record<string, JsonValue> = { ok: false, id: '', error: 'stale tool registration' };
					if (exec.agent !== agent) return out;
					try {
						const task = await engine.createTask(args as Record<string, unknown>, agent.id);
						const view = taskView(task);
						return {
							ok: true,
							id: task.id,
							rule_human: ruleToHuman(task.selector),
							start_at: iso(task.startAt),
							window_end: task.windowEnd === null ? null : iso(task.windowEnd),
							next_fire: view.next_fire,
							created_by: task.createdBy,
							error: null,
						};
					} catch (error) {
						return { ok: false, id: '', error: error instanceof Error ? error.message : String(error) };
					}
				},
			}),
		),
	);

	disposers.push(
		toolCtx.tools.register(
			defineTool({
				name: 'cron_list',
				description: LIST_DESCRIPTION,
				parameters: {},
				output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
				async execute(_args, exec) {
					if (exec.agent !== agent) return { ok: false, tasks: [], error: 'stale tool registration' };
					return { ok: true, tasks: engine.listTasks().map(taskView), error: null };
				},
			}),
		),
	);

	disposers.push(
		toolCtx.tools.register(
			defineTool({
				name: 'cron_delete',
				description: DELETE_DESCRIPTION,
				parameters: {
					id: { type: 'string', required: true, description: 'The 8-character hex id returned by cron_create.' },
				},
				output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
				async execute(args, exec) {
					if (exec.agent !== agent) return { ok: false, id: args.id, deleted: false, error: 'stale tool registration' };
					const removed = await engine.deleteTask(args.id as string);
					return { ok: true, id: args.id, deleted: removed !== undefined, error: null };
				},
			}),
		),
	);

	disposers.push(
		toolCtx.tools.register(
			defineTool({
				name: 'cron_report',
				description: REPORT_DESCRIPTION,
				parameters: {
					task_id: { type: 'string', required: true, description: 'Cron task id from the [CRON FIRE] framing.' },
					fire_id: { type: 'string', required: true, description: 'Fire id from the [CRON FIRE] framing.' },
					status: { type: 'string', required: true, description: '"completed" or "failed".' },
					summary: { type: 'string', required: true, description: 'One-line result; include the task id for traceability.' },
					error: { type: 'string', description: 'Error detail when status is failed.' },
				},
				output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
				async execute(args, exec) {
					if (exec.agent !== agent) return { ok: false, archived: false, error: 'stale tool registration' };
					const status = args.status as unknown;
					if (status !== 'completed' && status !== 'failed') {
						return { ok: false, archived: false, error: 'status must be "completed" or "failed".' };
					}
					const result = await engine.report(args.task_id as string, args.fire_id as string, {
						status,
						summary: args.summary as string | undefined,
						error: args.error as string | undefined,
					});
					return { ok: result.ok, archived: result.archived, error: result.error ?? null };
				},
			}),
		),
	);

	return () => {
		for (const dispose of disposers) dispose();
	};
}
