import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChildRpc, type SpawnSpec } from "../rpc.ts";

export const FAKE = path.join(import.meta.dirname, "fake-pi.mjs");

export function fakeSpec(scenario: string, logFile?: string): SpawnSpec {
	return {
		command: process.execPath,
		args: [FAKE, scenario],
		cwd: process.cwd(),
		env: { ...process.env, ...(logFile ? { FAKE_PI_LOG: logFile } : {}) },
	};
}

export function tempLogFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
	return path.join(dir, "commands.jsonl");
}

export function readLog(file: string): Array<Record<string, any>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, any>);
}

export function isAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Start a fake child and guarantee it dies when the test ends. */
export async function startFake(t: { after(fn: () => unknown): void }, scenario: string, log?: string) {
	const rpc = new ChildRpc(fakeSpec(scenario, log));
	t.after(() => rpc.stop());
	await rpc.start();
	return rpc;
}
