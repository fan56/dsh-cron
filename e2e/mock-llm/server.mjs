#!/usr/bin/env node
// Mock OpenAI-compatible LLM for the dsh-cron e2e suite.
//
// Speaks just enough of the Chat Completions wire protocol (streaming SSE
// with tool_calls, non-streaming JSON, GET /models) for the real dsh agent
// loop to drive a scripted scenario with zero credentials:
//
//   turn 1  TUI task prompt          -> tool_call cron_create (self or sub-agent
//                                       mode chosen by a keyword in the prompt)
//   fire    [CRON FIRE] framing      -> tool_call cron_report (self mode), or a
//                                       tool_call subagent whose prompt carries
//                                       the task/fire ids (sub-agent mode), or a
//                                       plain ack (expiry notice)
//   child   sub-agent prompt echo    -> tool_call cron_report (the backfill)
//   other   tool results / notices   -> plain text so the turn settles
//
// The [CRON FIRE] framing carries `task_id_json:` / `fire_id_json:` lines, so
// the ids flow back into cron_report without any server-side state. Requests
// are logged to stderr for post-mortem.

import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8899);
const MODEL = 'mock-flash';

let requestSeq = 0;
// One scripted task per mode per suite run. The TUI's runtime-context event
// rides along in every request, so branch on roles and these flags rather
// than on "does the history mention the create keyword".
let createdSelf = false;
let createdSubagent = false;

function textChunks(content) {
	return [
		{ delta: { role: 'assistant', content: '' } },
		{ delta: { content }, finish_reason: null },
		{ delta: {}, finish_reason: 'stop' },
	];
}

function toolCallChunks(calls) {
	const out = [{ delta: { role: 'assistant', content: '' } }];
	for (const [i, call] of calls.entries()) {
		out.push({
			delta: {
				tool_calls: [{
					index: i,
					id: `call_${requestSeq}_${i}`,
					type: 'function',
					function: { name: call.name, arguments: JSON.stringify(call.arguments) },
				}],
			},
		});
	}
	out.push({ delta: {}, finish_reason: 'tool_calls' });
	return out;
}

// The last non-assistant message decides the scripted reply; the framing text
// may be split across message parts, so match against its JSON string form.
function lastInputText(messages) {
	const last = [...messages].reverse().find((m) => m.role !== 'assistant');
	if (last == null) return '';
	return JSON.stringify(last.content ?? last);
}

function anyMessageText(messages) {
	return JSON.stringify(messages);
}

function parseIdLine(text, key) {
	const hit = text.match(new RegExp(`${key}:\\s*("([^"]+)"|'([^']+)')`));
	return hit?.[2] ?? hit?.[3] ?? null;
}

function decide(messages, hasTools) {
	// Tool results, subagent settle notices with a tool result attached:
	// always settle the turn as text.
	const lastMsg = messages.at(-1);
	if (lastMsg && /"role":"tool"/.test(JSON.stringify(lastMsg))) {
		console.error(`[mock-llm] tool-result: ${JSON.stringify(lastMsg.content ?? lastMsg).slice(0, 400)}`);
		return textChunks('e2e-ack: noted.');
	}

	// The last user-side message that is neither a tool result nor a runtime-
	// context snapshot. Earlier [CRON FIRE] framings stay in the history
	// forever, so the fire branch must key on the newest real message only.
	const isRt = (t) => t.includes('Current runtime context');
	const lastReal = [...messages].reverse()
		.map((m) => ({ role: m.role, text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? m) }))
		.find((m) => m.role !== 'assistant' && m.role !== 'tool' && !isRt(m.text));
	const last = lastReal?.text ?? '';
	const all = anyMessageText(messages);

	// Session-title and other auxiliary calls carry no tools array: answer
	// plain text so they never trip the scripted branches.
	if (!hasTools) {
		return textChunks('e2e: self-mode deploy check');
	}

	if (last.includes('[CRON FIRE]')) {
		const taskId = parseIdLine(last, 'task_id_json') ?? 'unknown-task';
		const fireId = parseIdLine(last, 'fire_id_json') ?? 'unknown-fire';

		if (last.includes('expiry notice')) {
			return textChunks(`e2e-ack: expiry notice received for task ${taskId}; nothing further to do.`);
		}
		if (last.includes('Sub-agent mode: spawn')) {
			// Proof that the framing carried the sub-agent instructions (that is
			// dsh-cron's responsibility). The actual delegation mechanism is a
			// deployment property — some harnesses disable the raw `subagent`
			// tool in favor of a registered-agents dispatch tool — so the
			// scripted model reports the outcome from this conversation, which
			// the cron_report tool accepts from any agent.
			console.error(`[mock-llm] sub-agent fire framing seen (task ${taskId} fire ${fireId})`);
			return toolCallChunks([{
				name: 'cron_report',
				arguments: {
					task_id: taskId,
					fire_id: fireId,
					status: 'completed',
					summary: `sub-agent done for task ${taskId}`,
				},
			}]);
		}
		return toolCallChunks([{
			name: 'cron_report',
			arguments: {
				task_id: taskId,
				fire_id: fireId,
				status: 'completed',
				summary: `self-mode work done for task ${taskId}`,
			},
		}]);
	}

	// Sub-agent child turn: the spawned prompt echoes the ids back, and the
	// child has no other scripted reason to run.
	const child = last.match(/task_id=([0-9a-f]{8})\s+fire_id=([0-9a-f]{8})/);
	if (child) {
		return toolCallChunks([{
			name: 'cron_report',
			arguments: {
				task_id: child[1],
				fire_id: child[2],
				status: 'completed',
				summary: `sub-agent done for task ${child[1]}`,
			},
		}]);
	}

	// First real user turn: create the scripted task. The scenario prompt
	// keyword picks the execution mode; end_at is tuned so S30's task expires
	// during the suite while later scenarios still run.
	if (!createdSubagent && all.toLowerCase().includes('cron e2e create subagent task')) {
		createdSubagent = true;
		return toolCallChunks([{
			name: 'cron_create',
			arguments: {
				name: 'e2e-subagent-pulse',
				prompt: 'e2e workload: pretend to verify the deployment.',
				every_seconds: 60,
				end_at: Date.now() + 240_000,
				execution_mode: 'sub-agent',
				delivery_policy: 'followup',
			},
		}]);
	}
	if (!createdSelf && all.toLowerCase().includes('cron e2e create task')) {
		createdSelf = true;
		return toolCallChunks([{
			name: 'cron_create',
			arguments: {
				name: 'e2e-self-pulse',
				prompt: 'e2e workload: pretend to check the deploy status.',
				every_seconds: 60,
				end_at: Date.now() + 170_000,
				execution_mode: 'self',
				delivery_policy: 'followup',
			},
		}]);
	}

	// Subagent settle notices and anything unscripted: settle the turn.
	console.error(`[mock-llm] fallback lastReal(${lastReal?.role}): ${last.slice(0, 250)}`);
	return textChunks('e2e-ack: noted.');
}

function completionId() {
	return `chatcmpl-e2e-${requestSeq}`;
}

function sseResponse(res, chunks) {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
	const id = completionId();
	const created = Math.floor(Date.now() / 1000);
	for (const chunk of chunks) {
		const body = {
			id,
			object: 'chat.completion.chunk',
			created,
			model: MODEL,
			choices: [{ index: 0, delta: chunk.delta, finish_reason: chunk.finish_reason ?? null }],
		};
		res.write(`data: ${JSON.stringify(body)}\n\n`);
	}
	res.write('data: [DONE]\n\n');
	res.end();
}

function jsonResponse(res, chunks) {
	const id = completionId();
	const created = Math.floor(Date.now() / 1000);
	let toolCalls;
	let content;
	let finish = 'stop';
	for (const chunk of chunks) {
		if (chunk.delta.tool_calls) toolCalls = chunk.delta.tool_calls.map((c) => ({
			id: c.id,
			type: 'function',
			function: c.function,
		}));
		if (chunk.delta.content) content = chunk.delta.content;
		if (chunk.finish_reason) finish = chunk.finish_reason;
	}
	const message = { role: 'assistant', content: content ?? null };
	if (toolCalls) message.tool_calls = toolCalls;
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		id,
		object: 'chat.completion',
		created,
		model: MODEL,
		choices: [{ index: 0, message, finish_reason: finish }],
		usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
	}));
}

const server = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (d) => { raw += d; });
	req.on('end', () => {
		if (req.method === 'GET' && req.url.includes('/models')) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'e2e' }] }));
			return;
		}
		if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'not found' } }));
			return;
		}
		requestSeq += 1;
		let body;
		try {
			body = JSON.parse(raw || '{}');
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'bad json' } }));
			return;
		}
		const messages = body.messages ?? [];
		const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
		const chunks = decide(messages, hasTools);
		const wantsStream = body.stream === true;
		const calls = chunks.flatMap((c) => c.delta.tool_calls ?? []).map((c) => c.function?.name ?? '?');
		console.error(`[mock-llm] req #${requestSeq} stream=${wantsStream} tools=${hasTools} -> ${calls.length ? `tools:${calls.join(',')}` : 'text'}`);
		if (wantsStream) sseResponse(res, chunks);
		else jsonResponse(res, chunks);
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.error(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1 (model ${MODEL})`);
});
