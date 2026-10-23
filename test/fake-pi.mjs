#!/usr/bin/env node
/**
 * A scripted stand-in for `pi --mode rpc`, used by the unit tests.
 *
 * Usage: node fake-pi.mjs <scenario>
 *   ok      one assistant turn, then agent_settled
 *   crash   exit(3) as soon as the prompt arrives
 *   stall   one message_start, then silence (ignores abort)
 *   ui      opens a confirm dialog, reports how it was answered, then settles
 *   handled the prompt is reported as handled and nothing runs
 *   noisy   writes non-protocol lines, then behaves like ok
 *
 * Set FAKE_PI_LOG to a file path to record received commands and UI answers.
 */

import * as fs from "node:fs";

const scenario = process.env.FAKE_PI_SCENARIO ?? process.argv[2] ?? "ok";
const logFile = process.env.FAKE_PI_LOG;
let buffer = "";
let settled = false;

function log(entry) {
	if (!logFile) return;
	fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function write(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command, data, id) {
	write({ type: "response", id, command, success: true, data });
}

function assistantMessage(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0.0042 } },
		stopReason: "stop",
	};
}

function settle() {
	if (settled) return;
	settled = true;
	write({ type: "agent_settled", aborted: false });
}

function runScenario() {
	log({ type: "scenario", scenario });
	switch (scenario) {
		case "ok":
			setTimeout(() => {
				write({ type: "message_start", message: { role: "assistant" } });
				write({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "true" } });
				write({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false });
				write({ type: "message_end", message: assistantMessage("fake result") });
				settle();
			}, 20);
			return;
		case "crash":
			process.exit(3);
			return;
		case "stall":
			write({ type: "message_start", message: { role: "assistant" } });
			return;
		case "ui":
			write({
				type: "extension_ui_request",
				id: "ui-1",
				method: "confirm",
				title: "Allow dangerous command?",
			});
			return;
		case "handled":
			// Nothing runs: the prompt response says so, which the caller handles.
			return;
		case "noisy":
			process.stdout.write("this is not json\n");
			process.stderr.write("diagnostic noise\n");
			setTimeout(() => {
				write({ type: "message_end", message: assistantMessage("noisy result") });
				settle();
			}, 20);
			return;
		default:
			setTimeout(settle, 20);
	}
}

process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (line.trim()) handle(line);
		newline = buffer.indexOf("\n");
	}
});

process.stdin.on("end", () => {
	log({ type: "stdin_end" });
	process.exit(0);
});

function handle(line) {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}

	if (command.type === "extension_ui_response") {
		log({ type: "ui_response", response: command });
		const cancelled = command.cancelled === true;
		write({ type: "message_end", message: assistantMessage(cancelled ? "denied" : "allowed") });
		settle();
		return;
	}

	log({ type: command.type, command });

	switch (command.type) {
		case "get_state":
			respond("get_state", { sessionId: "fake-session", sessionFile: "/tmp/fake-session.jsonl" }, command.id);
			return;
		case "get_last_assistant_text":
			respond("get_last_assistant_text", "last text", command.id);
			return;
		case "prompt":
			if (scenario === "handled") {
				respond("prompt", { disposition: "handled" }, command.id);
				return;
			}
			respond("prompt", { disposition: "started" }, command.id);
			runScenario();
			return;
		case "steer":
			respond("steer", { disposition: "queued" }, command.id);
			return;
		case "follow_up":
			respond("follow_up", { disposition: "queued" }, command.id);
			return;
		case "abort":
			respond("abort", {}, command.id);
			if (scenario !== "stall") settle();
			return;
		case "compact":
			// Deliberately unanswered: the deadline test needs silence.
			return;
		default:
			write({ type: "response", id: command.id, command: command.type, success: false, error: "unknown command" });
	}
}
