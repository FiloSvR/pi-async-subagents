import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildRpc, RpcCommandError } from "../rpc.ts";
import { isAlive, readLog, startFake, tempLogFile } from "./helpers.ts";

test("start() proves the child speaks RPC", async (t) => {
	const rpc = await startFake(t, "ok");
	const state = (await rpc.send({ type: "get_state" })) as { sessionId?: string };
	assert.equal(state.sessionId, "fake-session");
});

test("a failed command rejects with the child's error", async (t) => {
	const rpc = await startFake(t, "ok");
	await assert.rejects(rpc.send({ type: "no_such_command" }), (error: unknown) => {
		assert.ok(error instanceof RpcCommandError);
		assert.match(error.message, /unknown command/);
		assert.equal(error.command, "no_such_command");
		return true;
	});
});

test("stop() kills the child", async (t) => {
	const rpc = await startFake(t, "ok");
	const pid = rpc.pid;
	assert.ok(isAlive(pid));
	await rpc.stop();
	assert.equal(isAlive(pid), false);
	assert.equal(rpc.hasExited, true);
});

test("commands sent after exit reject instead of hanging", async (t) => {
	const rpc = await startFake(t, "ok");
	await rpc.stop();
	await assert.rejects(rpc.send({ type: "get_state" }), /subagent process ended/);
});

test("events are delivered and non-JSON stdout is tolerated", async (t) => {
	const rpc = await startFake(t, "noisy");

	const seen: string[] = [];
	const done = new Promise<void>((resolve) => {
		rpc.onEvent((event) => {
			seen.push(event.type);
			if (event.type === "agent_settled") resolve();
		});
	});

	await rpc.send({ type: "prompt", message: "hi" });
	await done;
	assert.ok(seen.includes("message_end"));
	assert.ok(seen.includes("agent_settled"));
	assert.match(rpc.stderr, /not json/);
	assert.match(rpc.stderr, /diagnostic noise/);
});

test("respondToUI answers a dialog and the child continues", async (t) => {
	const file = tempLogFile();
	const rpc = await startFake(t, "ui", file);

	const settled = new Promise<void>((resolve) => {
		rpc.onEvent((event) => {
			if (event.type === "extension_ui_request") {
				rpc.respondToUI(String(event.id), { cancelled: true });
			}
			if (event.type === "agent_settled") resolve();
		});
	});

	await rpc.send({ type: "prompt", message: "hi" });
	await settled;
	const responses = readLog(file).filter((entry) => entry.type === "ui_response");
	assert.equal(responses.length, 1);
	assert.equal(responses[0]?.response?.cancelled, true);
});

test("a command deadline rejects rather than waiting forever", async (t) => {
	const rpc = await startFake(t, "stall");
	await rpc.send({ type: "prompt", message: "hi" });
	// The fake never answers `compact`.
	await assert.rejects(rpc.send({ type: "compact" }, 100), /no response to "compact"/);
});

test("a child that dies mid-command rejects the command", async (t) => {
	const rpc = await startFake(t, "ok");
	const child = (rpc as unknown as { child: import("node:child_process").ChildProcess }).child;
	child.kill("SIGKILL");
	await assert.rejects(rpc.send({ type: "get_state" }, 2_000), /subagent process ended/);
});
