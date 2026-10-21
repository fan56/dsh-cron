/**
 * Host-side session-binding glue (ADR 0010): resolving a task's bound session
 * to a live agent (live lookup, cold resume, subagent refusal), opening
 * dedicated sessions for `attach: 'new'` tasks, pruning tasks whose session
 * no longer exists, and cancelling a session's tasks when the session stops.
 *
 * Everything here takes the host's services through structural slices, so the
 * module unit-tests with fakes and the plugin keeps zero runtime npm
 * dependencies.
 *
 * @module dsh-cron/attach
 */

import { randomUUID } from 'node:crypto';
import type { AgentLike } from './scheduler.ts';
import type { CronTask } from './types.ts';

/**
 * Minimal structural slice of a live dsh agent used for binding decisions.
 * The depth formula mirrors dsh-subagent's `delegationDepthOf`: a delegated
 * child is one whose durable header depth or runtime depth is above zero.
 */
export interface BindableAgent extends AgentLike {
	session?: { header?: { delegationDepth?: number; cwd?: string } };
	options?: { subagentDepth?: number };
}

/** `delegationDepthOf` from @deepseek-ai/dsh-subagent, inlined (zero-dep policy). */
export function delegationDepthOf(agent: BindableAgent): number {
	const runtime = agent.options?.subagentDepth;
	return Math.max(agent.session?.header?.delegationDepth ?? 0, runtime ?? 0);
}

/** Result shape of the host's `sessionController.resolveAgent` (stable errors, no throws). */
export type ResolvedSessionAgent =
	| { agent: BindableAgent }
	| { error: { code: string } };

export interface TargetResolverDeps {
	/** Live agent lookup: `ctx.agents.get(sessionId)`. */
	getAgent(id: string): BindableAgent | undefined;
	/**
	 * Cold-session resume: `ctx.sessionController.resolveAgent(sessionId)`.
	 * Optional — hosts without the controller only ever deliver to live
	 * sessions, and unresolvable occurrences skip per ADR 0002.
	 */
	resolveSessionAgent?(id: string): Promise<ResolvedSessionAgent | undefined>;
}

/**
 * Resolve the one live target for a task's bound session. A delegated child
 * session never receives fires, mirroring dsh-schedule's delivery refusal.
 */
export function createTargetResolver(deps: TargetResolverDeps) {
	const eligible = (agent: BindableAgent | undefined): BindableAgent | undefined =>
		agent !== undefined && delegationDepthOf(agent) === 0 ? agent : undefined;

	return async (task: Pick<CronTask, 'sessionId'>): Promise<AgentLike | undefined> => {
		const live = eligible(deps.getAgent(task.sessionId));
		if (live !== undefined) return live;
		const resolved = (await deps.resolveSessionAgent?.(task.sessionId)) ?? undefined;
		if (resolved === undefined) return undefined;
		return 'agent' in resolved ? eligible(resolved.agent) : undefined;
	};
}

export interface DedicatedSessionDeps {
	/** `ctx.agents.create({ sessionId, meta })` — the caller's context owns the lifecycle. */
	createAgent(options: { sessionId: string; meta?: { cwd?: string } }): Promise<{ agent: BindableAgent }>;
	/** Working directory the dedicated session inherits from its creator. */
	cwdOf(createdBy: string): string | undefined;
}

/**
 * Factory for `attach: 'new'` tasks: each call opens one dedicated session
 * (host session-id convention: `session-<uuid>`) rooted in the creator's cwd.
 * The returned handle's teardown stays with the creating scope, so a plugin
 * unload stops the agent; the durable task then resumes it cold on demand.
 */
export function createDedicatedSessionFactory(deps: DedicatedSessionDeps) {
	return async (createdBy: string): Promise<AgentLike> => {
		const sessionId = `session-${randomUUID()}`;
		const cwd = deps.cwdOf(createdBy);
		const { agent } = await deps.createAgent({ sessionId, meta: cwd === undefined ? undefined : { cwd } });
		return agent;
	};
}

/** Engine slice pruneOrphanTasks and cancelTasksOfSession need. */
export interface TaskMutator {
	listTasks(): CronTask[];
	deleteTask(id: string, status?: string): Promise<CronTask | undefined>;
}

/**
 * Startup sweep: archive every active task whose bound session no longer
 * exists (not live, not persisted). Lifecycle afterwards is maintained by the
 * `workspace/session-stop` handler, so this runs once per boot. Returns the
 * number of archived tasks.
 */
export async function pruneOrphanTasks(
	engine: TaskMutator,
	sessionExists: (id: string) => Promise<boolean>,
): Promise<number> {
	let pruned = 0;
	for (const task of engine.listTasks()) {
		if (await sessionExists(task.sessionId)) continue;
		await engine.deleteTask(task.id, 'cancelled');
		pruned += 1;
	}
	return pruned;
}

/** Cancel every active task bound to one session (the session-stop path). */
export async function cancelTasksOfSession(engine: TaskMutator, sessionId: string): Promise<CronTask[]> {
	const cancelled: CronTask[] = [];
	for (const task of engine.listTasks()) {
		if (task.sessionId !== sessionId) continue;
		const removed = await engine.deleteTask(task.id, 'cancelled');
		if (removed !== undefined) cancelled.push(removed);
	}
	return cancelled;
}
