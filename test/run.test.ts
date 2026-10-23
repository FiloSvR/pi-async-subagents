import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildRpc } from "../rpc.ts";
import { type RunConfig, SubagentRun } from "../run.ts";
import { fakeSpec, isAlive, readLog, tempLogFile, waitFor } from "./helpers.ts";

interface Harness {
	run: SubagentRun;
	rpc: ChildRpc;
	done: Promise<SubagentRun>;
}

function makeRun(t: { after(fn: () => unknown): void }, scenario: string, overrides: Partial<RunConfig> = {}): Harness {
	const rpc = new ChildRpc(fakeSpec(scenario));
	let resolveDone: (run: SubagentRun) => void = () => {};
	const done = new Promise<SubagentRun>((resolve) => {
		resolveDone = resolve;
	});

	const run = new SubagentRun({
		name: "test-run",
		agent: "fake",
		task: "do the thing",
		cwd: process.cwd(),
		rpc,
		stallMs: 60_000,
		abortAfterMs: 120_000,
		maxRunMs: 10 * 60_000,
		uiPolicy: "deny",
		settleGraceMs: 300,
		onDone: (finished) => resolveDone(finished),
		...overrides,
	});

	t.after(async () => {
		await rpc.stop();
	});

	return { run, rpc, done };
}

test("start() returns while the child is still working", async (t) => {
	const { run } = makeRun(t, "stall");
	await run.start();
	assert.equal(run.isTerminal, false, "start() must not wait for the child to finish");
	assert.equal(run.status, "running");
});

test("a completed run reports text, usage and turns, and its process is gone", async (t) => {
	const { run, done } = makeRun(t, "ok");
	await run.start();
	const pid = run.childPid;
	const finished = await done;

	assert.equal(finished.status, "finished");
	assert.equal(finished.isTerminal, true);
	assert.equal(finished.finalText, "fake result");
	assert.equal(finished.turns, 1);
	assert.equal(finished.usage.input, 1000);
	assert.equal(finished.usage.output, 100);
	assert.equal(finished.sessionId, "fake-session");
	assert.ok(finished.endedAt);
	assert.ok(pid, "expected a child pid");
	await waitFor(() => !isAlive(pid), 3_000);
});

test("a child that dies without settling fails the run instead of hanging", async (t) => {
	const { run, done } = makeRun(t, "crash");
	await run.start();
	const finished = await done;
	assert.equal(finished.status, "failed");
	assert.match(finished.error ?? "", /without finishing|ended/);
});

test("silence marks the run stalled, and the caller can still cancel it", async (t) => {
	const { run, rpc } = makeRun(t, "stall", { stallMs: 150 });
	await run.start();
	const pid = run.childPid;
	await waitFor(() => run.status === "stalled", 4_000);
	assert.equal(run.status, "stalled");

	await run.cancel("test cancel");
	assert.equal(run.isTerminal, true);
	assert.equal(run.status, "cancelled");
	assert.equal(run.stopReason, "test cancel");
	await waitFor(() => !isAlive(pid), 4_000);
	assert.equal(rpc.hasExited, true);
});

test("a run that never settles is killed and reported as a timeout", async (t) => {
	const { run, done } = makeRun(t, "stall", { stallMs: 100, abortAfterMs: 250 });
	await run.start();
	const pid = run.childPid;
	const finished = await done;
	assert.equal(finished.status, "timeout");
	assert.match(finished.error ?? "", /no activity/);
	await waitFor(() => !isAlive(pid), 4_000);
});

test("the runtime cap stops a run even when it stays chatty", async (t) => {
	const { run, done } = makeRun(t, "stall", { maxRunMs: 200, abortAfterMs: 60_000 });
	await run.start();
	const finished = await done;
	assert.equal(finished.status, "timeout");
	assert.match(finished.error ?? "", /runtime cap/);
});

test("denied dialogs are recorded and do not block the run", async (t) => {
	const { run, done } = makeRun(t, "ui", { uiPolicy: "deny" });
	await run.start();
	const finished = await done;
	assert.equal(finished.status, "finished");
	assert.equal(finished.finalText, "denied");
	assert.deepEqual(finished.deniedDialogs, ["Allow dangerous command?"]);
});

test("uiPolicy=allow answers child dialogs so the child proceeds", async (t) => {
	const file = tempLogFile();
	const rpc = new ChildRpc(fakeSpec("ui", file));
	let resolveDone: (run: SubagentRun) => void = () => {};
	const done = new Promise<SubagentRun>((resolve) => {
		resolveDone = resolve;
	});
	const run = new SubagentRun({
		name: "allowed",
		agent: "fake",
		task: "ask away",
		cwd: process.cwd(),
		rpc,
		stallMs: 60_000,
		abortAfterMs: 120_000,
		maxRunMs: 60_000,
		uiPolicy: "allow",
		onDone: (finished) => resolveDone(finished),
	});
	t.after(() => rpc.stop());

	await run.start();
	const finished = await done;
	assert.equal(finished.status, "finished");
	assert.equal(finished.finalText, "allowed");
	assert.deepEqual(finished.deniedDialogs, []);
	const responses = readLog(file).filter((entry) => entry.type === "ui_response");
	assert.equal(responses[0]?.response?.confirmed, true);
});

test("steer() reports the disposition from the child", async (t) => {
	const { run } = makeRun(t, "stall");
	await run.start();
	const before = run.lastActivityAt;
	assert.equal(await run.steer("new instructions"), "queued");
	assert.ok(run.lastActivityAt >= before, "steering should count as activity");
});

test("cancel() on an already finished run is a no-op", async (t) => {
	const { run, done } = makeRun(t, "ok");
	await run.start();
	await done;
	await run.cancel("too late");
	assert.equal(run.status, "finished");
});
