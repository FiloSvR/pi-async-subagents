import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Isolate config/registry/agent discovery from the real ~/.pi.
const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-ext-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
fs.mkdirSync(path.join(AGENT_DIR, "agents"), { recursive: true });
fs.writeFileSync(
	path.join(AGENT_DIR, "agents", "worker.md"),
	"---\nname: worker\ndescription: Test worker\ntools: read\n---\nYou are a worker.\n",
);
// Keep abort grace short so tests that cancel a stalled child finish quickly.
fs.mkdirSync(path.join(AGENT_DIR, "subagents"), { recursive: true });
fs.writeFileSync(
	path.join(AGENT_DIR, "subagents", "config.json"),
	JSON.stringify({
		settleGraceSeconds: 0.4,
		finishedVisibleSeconds: 1,
		stallSeconds: 1,
		abortAfterSeconds: 2,
		maxRunMinutes: 1,
	}),
);

// The extension spawns process.argv[1]; point it at the scripted fake.
process.argv[1] = path.join(import.meta.dirname, "fake-pi.mjs");

const { default: subagentsExtension } = await import("../index.ts");

interface SentMessage {
	customType: string;
	content: Array<{ type: string; text: string }>;
	options?: Record<string, unknown>;
}

interface RegisteredTool {
	name: string;
	description: string;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

function makeHarness(cwd = process.cwd()) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sent: SentMessage[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const messageRenderers = new Map<
		string,
		(message: { content: Array<{ type: string; text: string }>; details?: unknown }, options: { expanded: boolean; outputPad: number }, theme: unknown) => unknown
	>();

	const ui = {
		confirm: async () => true,
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notifications.push({ message, type });
		},
		setStatus: () => undefined,
		setWidget: (key: string, content: unknown) => {
			widgetCalls.push({ key, content });
		},
	};

	const ctx = {
		cwd,
		hasUI: false,
		ui,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/tmp/test-session.jsonl",
		},
		isProjectTrusted: () => true,
		model: { provider: "test", id: "test-model" },
		thinkingLevel: "low" as const,
	};

	const api = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options);
		},
		sendMessage: (message: { customType: string; content: Array<{ type: string; text: string }> }, options?: Record<string, unknown>) => {
			sent.push({ ...message, options });
		},
		registerShortcut: () => undefined,
		registerToolRenderer: () => undefined,
		registerMessageRenderer: (customType: string, renderer: (typeof messageRenderers) extends Map<string, infer R> ? R : never) => {
			messageRenderers.set(customType, renderer);
		},
	};

	return { api, ctx, tools, commands, events, sent, notifications, widgetCalls, messageRenderers };
}

async function fire(events: Map<string, Array<(e: unknown, c: unknown) => unknown>>, name: string, ctx: unknown) {
	for (const handler of events.get(name) ?? []) {
		await handler({ type: name }, ctx);
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("registers its tools and command", async () => {
	const { api, tools, commands } = makeHarness();
	subagentsExtension(api as never);
	assert.deepEqual([...tools.keys()].sort(), [
		"subagent",
		"subagent_cancel",
		"subagent_cleanup",
		"subagent_message",
		"subagents_list",
	]);
	assert.ok(commands.has("subagents"));
	for (const tool of tools.values()) assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
});

test("subagent execute returns before the child finishes and delivers a result later", async () => {
	const { api, ctx, tools, events, sent } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	const subagent = tools.get("subagent");
	assert.ok(subagent);

	const started = Date.now();
	const result = await subagent.execute("call-1", { agent: "worker", task: "do a thing", name: "w1" }, undefined, undefined, ctx);
	const elapsed = Date.now() - started;

	assert.ok(elapsed < 2_000, `execute should return fast, took ${elapsed}ms`);
	assert.match(result.content[0]?.text ?? "", /Started subagent "w1"/);
	assert.equal(result.details?.name, "w1");

	// The child finishes in the background and its result arrives as a message.
	await waitFor(() => sent.some((m) => m.customType === "subagent_result"));
	const delivered = sent.find((m) => m.customType === "subagent_result");
	assert.equal(delivered?.options?.triggerTurn, true);
	assert.equal(delivered?.options?.deliverAs, "followUp");
	assert.match(delivered?.content[0]?.text ?? "", /w1/);
});

test("subagent_message steers a running subagent and resumes a finished one", async () => {
	const { api, ctx, tools, events, sent } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	const subagent = tools.get("subagent");
	const message = tools.get("subagent_message");
	assert.ok(subagent && message);

	// The fake stays silent in "stall" mode, so the child is still running when we steer.
	process.env.FAKE_PI_SCENARIO = "stall";
	const started = await subagent.execute("c1", { agent: "worker", task: "wait", name: "w2" }, undefined, undefined, ctx);
	assert.match(started.content[0]?.text ?? "", /Started/);

	const steered = await message.execute("c2", { name: "w2", message: "also do X" }, undefined, undefined, ctx);
	assert.match(steered.content[0]?.text ?? "", /Message .*w2/);

	// Cancel, wait for the run to settle, then resume its remembered session.
	const cancel = tools.get("subagent_cancel")!;
	await cancel.execute("c3", { name: "w2" }, undefined, undefined, ctx);
	await waitFor(() => sent.some((m) => m.customType === "subagent_result" && /w2/.test(m.content[0]?.text ?? "")));
	process.env.FAKE_PI_SCENARIO = "ok";
	const resumed = await message.execute("c4", { name: "w2", message: "continue" }, undefined, undefined, ctx);
	assert.match(resumed.content[0]?.text ?? "", /Resumed "w2"/);
});

test("subagents_list reports running runs and agent definitions", async () => {
	const { api, ctx, tools, events } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	const list = tools.get("subagents_list");
	assert.ok(list);
	const result = await list.execute("c1", {}, undefined, undefined, ctx);
	const text = result.content[0]?.text ?? "";
	assert.match(text, /Agents:/);
	assert.match(text, /worker \(user\): Test worker/);
});

test("subagent_cancel stops a run", async () => {
	const { api, ctx, tools, events } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	const subagent = tools.get("subagent");
	const cancel = tools.get("subagent_cancel");
	assert.ok(subagent && cancel);

	await subagent.execute("c1", { agent: "worker", task: "wait", name: "w3" }, undefined, undefined, ctx);
	const cancelled = await cancel.execute("c2", { name: "w3", reason: "testing" }, undefined, undefined, ctx);
	assert.match(cancelled.content[0]?.text ?? "", /Stopping "w3"/);
});

test("an unknown agent is reported with the available list", async () => {
	const { api, ctx, tools, events } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	const subagent = tools.get("subagent");
	const result = await subagent!.execute("c1", { agent: "nope", task: "x" }, undefined, undefined, ctx);
	assert.match(result.content[0]?.text ?? "", /Unknown agent "nope"/);
	assert.match(result.content[0]?.text ?? "", /worker/);
});

test("/subagents command reports when nothing is running", async () => {
	const { api, ctx, commands, events, notifications } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	const command = commands.get("subagents");
	assert.ok(command);
	await command.handler("", ctx);
	assert.ok(notifications.some((n) => /No subagents running/.test(n.message)));
});

test("worktree: true gives the run its own checkout and removes it when unchanged", async (t) => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-ext-git-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	git(["init", "-b", "main"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	git(["commit", "--allow-empty", "-m", "init"]);

	const { api, ctx, tools, events, sent } = makeHarness(repo);
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	process.env.FAKE_PI_SCENARIO = "ok";
	const result = await tools.get("subagent")!.execute(
		"c1",
		{ agent: "worker", task: "do a thing", name: "wt1", worktree: true, branch: "issue-1", worktreeBase: "main" },
		undefined,
		undefined,
		ctx,
	);

	const text = result.content[0]?.text ?? "";
	assert.match(text, /worktree .*issue-1/);
	const worktreePath = path.join(fs.realpathSync(repo), ".pi", "worktrees", "issue-1");
	assert.equal(fs.existsSync(worktreePath), true);

	await waitFor(() => sent.some((message) => message.customType === "subagent_result"));
	const delivered = sent.find((message) => message.customType === "subagent_result");
	assert.match(delivered?.content[0]?.text ?? "", /Worktree: removed after the run/);
	assert.equal(fs.existsSync(worktreePath), false);
});

test("worktree: true and cwd are mutually exclusive", async () => {
	const { api, ctx, tools, events } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	const result = await tools.get("subagent")!.execute(
		"c1",
		{ agent: "worker", task: "x", worktree: true, cwd: "." },
		undefined,
		undefined,
		ctx,
	);
	assert.match(result.content[0]?.text ?? "", /mutually exclusive/);
});

test("a delivered result collapses to one line and expands on demand", () => {
	const { api, messageRenderers } = makeHarness();
	subagentsExtension(api as never);
	const renderer = messageRenderers.get("subagent_result");
	assert.ok(renderer, "the result message needs a renderer");

	const message = {
		content: [{ type: "text", text: "**w1** (worker) finished after 2s\n\nAll done.\n\nResume or steer..." }],
		details: {
			name: "w1",
			agent: "worker",
			status: "finished",
			startedAt: Date.now() - 2_000,
			endedAt: Date.now(),
			usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.0042, contextTokens: 0, turns: 1 },
		},
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const collapsed = renderer!(message, { expanded: false, outputPad: 1 }, theme) as { render: (width: number) => string[] };
	const lines = collapsed.render(120).join("\n");
	assert.match(lines, /\[subagent\] w1/);
	assert.match(lines, /finished/);
	assert.match(lines, /Ctrl\+O to expand/);
	assert.doesNotMatch(lines, /All done/);
	assert.equal(renderer!(message, { expanded: true, outputPad: 1 }, theme), undefined);
});

function widgetLines(widgetCalls: Array<{ key: string; content: unknown }>, name: string): string[] {
	return widgetCalls
		.filter((call) => call.key === "subagents" && Array.isArray(call.content))
		.flatMap((call) => (call.content as unknown[]).map(String))
		.filter((line) => line.includes(name));
}

test("a running subagent appears in the widget, shows briefly when finished, then clears", async () => {
	const { api, ctx, tools, events, sent, widgetCalls } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	// "stall" keeps the run alive long enough for the throttled widget to render it.
	process.env.FAKE_PI_SCENARIO = "stall";
	await tools.get("subagent")!.execute("c1", { agent: "worker", task: "wait", name: "w4" }, undefined, undefined, ctx);
	await waitFor(() => widgetLines(widgetCalls, "w4").length > 0);

	await tools.get("subagent_cancel")!.execute("c2", { name: "w4" }, undefined, undefined, ctx);
	await waitFor(() => sent.some((message) => message.customType === "subagent_result"));
	assert.ok(
		widgetLines(widgetCalls, "w4").some((line) => line.includes("cancelled")),
		"a finished run should stay in the widget for its visible window",
	);
	await waitFor(() => {
		const widget = [...widgetCalls].reverse().find((call) => call.key === "subagents");
		return widget?.content === undefined;
	});
	process.env.FAKE_PI_SCENARIO = "ok";
});

test("a finished widget entry shows context token usage", async () => {
	const { api, ctx, tools, events, sent, widgetCalls } = makeHarness();
	subagentsExtension(api as never);
	await fire(events, "session_start", ctx);

	process.env.FAKE_PI_SCENARIO = "ok";
	await tools.get("subagent")!.execute("c1", { agent: "worker", task: "done", name: "w5" }, undefined, undefined, ctx);
	await waitFor(() => sent.some((message) => message.customType === "subagent_result"));
	assert.ok(
		widgetLines(widgetCalls, "w5").some((line) => line.includes("ctx 1.1k")),
		"the widget entry should show the child's context token count",
	);
	assert.ok(
		widgetLines(widgetCalls, "w5").some((line) => line.includes("test/test-model")),
		"the widget entry should show the child's model",
	);
});

test("a nested subagent context gets no spawn tools or command", () => {
	const { api, tools, commands } = makeHarness();
	const previous = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1";
	try {
		subagentsExtension(api as never);
		assert.equal(tools.size, 0, "children must not be able to spawn grandchildren");
		assert.equal(commands.size, 0, "children do not need /subagents");
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previous;
	}
});
