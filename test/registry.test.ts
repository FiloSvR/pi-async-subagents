import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { allocateName, registryPath, sanitizeName, SubagentRegistry } from "../registry.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "subagent-registry-"));
}

test("sanitizeName keeps handles addressable", () => {
	assert.equal(sanitizeName("scout"), "scout");
	assert.equal(sanitizeName("  my agent! "), "my-agent");
	assert.equal(sanitizeName("a/b\\c"), "a-b-c");
	assert.equal(sanitizeName("---"), "subagent");
	assert.equal(sanitizeName("x".repeat(100)).length, 60);
});

test("allocateName avoids collisions", () => {
	assert.equal(allocateName([], "scout"), "scout");
	assert.equal(allocateName(["scout"], "scout"), "scout-2");
	assert.equal(allocateName(["scout", "scout-2"], "scout"), "scout-3");
	assert.equal(allocateName(["scout"], "reviewer"), "reviewer");
});

test("registryPath is null without a session id", () => {
	assert.equal(registryPath("/tmp", undefined), null);
	assert.equal(registryPath("/tmp", null), null);
	assert.ok(registryPath("/tmp", "abc/def")?.endsWith("abc-def.json"));
});

test("records survive a reload", () => {
	const dir = tempDir();
	const file = path.join(dir, "registry.json");
	const registry = SubagentRegistry.load(file);
	registry.put({
		name: "scout",
		agent: "scout",
		task: "look around",
		cwd: dir,
		sessionId: "sa-1",
		createdAt: 1,
		updatedAt: 1,
		status: "finished",
	});
	registry.put({
		name: "worker",
		agent: "worker",
		task: "build it",
		cwd: dir,
		createdAt: 2,
		updatedAt: 2,
		status: "running",
	});

	const reloaded = SubagentRegistry.load(file);
	assert.deepEqual(reloaded.names().sort(), ["scout", "worker"]);
	assert.equal(reloaded.get("scout")?.sessionId, "sa-1");
	assert.equal(reloaded.get("worker")?.status, "running");
	assert.equal(reloaded.allocate("scout"), "scout-2");
});

test("a corrupt registry degrades to empty instead of throwing", () => {
	const dir = tempDir();
	const file = path.join(dir, "registry.json");
	fs.writeFileSync(file, "{not json");
	const registry = SubagentRegistry.load(file);
	assert.deepEqual(registry.names(), []);
	registry.put({
		name: "scout",
		agent: "scout",
		task: "t",
		cwd: dir,
		createdAt: 1,
		updatedAt: 1,
		status: "running",
	});
	assert.equal(SubagentRegistry.load(file).get("scout")?.name, "scout");
});

test("update() changes a record and returns undefined for unknown names", () => {
	const dir = tempDir();
	const file = path.join(dir, "registry.json");
	const registry = SubagentRegistry.load(file);
	registry.put({
		name: "scout",
		agent: "scout",
		task: "t",
		cwd: dir,
		createdAt: 1,
		updatedAt: 1,
		status: "running",
	});
	const updated = registry.update("scout", { status: "finished", finalText: "done" });
	assert.equal(updated?.status, "finished");
	assert.ok((updated?.updatedAt ?? 0) > 0);
	assert.equal(registry.update("nope", { status: "finished" }), undefined);
});
