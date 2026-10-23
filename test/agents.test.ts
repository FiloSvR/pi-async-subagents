import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Set before importing the module under test: getAgentDir() reads the env var
// lazily on each call, but a stable temp dir keeps discovery deterministic.
const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-agents-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const { discoverAgents, formatAgentList } = await import("../agents.ts");

function writeAgent(dir: string, filename: string, frontmatter: Record<string, unknown>, body: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const yaml = Object.entries(frontmatter)
		.map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(", ")}]` : value}`)
		.join("\n");
	fs.writeFileSync(path.join(dir, filename), `---\n${yaml}\n---\n${body}\n`);
}

const USER_DIR = path.join(AGENT_DIR, "agents");
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-project-"));
const PROJECT_DIR = path.join(PROJECT_ROOT, ".pi", "agents");

test("frontmatter and body are parsed", () => {
	writeAgent(
		USER_DIR,
		"scout.md",
		{
			name: "scout",
			description: "Fast recon",
			tools: ["read", "grep", "find", "ls"],
			model: "openrouter/z-ai/glm-5.3",
			thinking: "low",
			"max-minutes": 10,
			"system-prompt": "append",
		},
		"You are a scout.",
	);

	const { agents } = discoverAgents(process.cwd(), "user");
	const scout = agents.find((agent) => agent.name === "scout");
	assert.ok(scout);
	assert.equal(scout.description, "Fast recon");
	assert.deepEqual(scout.tools, ["read", "grep", "find", "ls"]);
	assert.equal(scout.model, "openrouter/z-ai/glm-5.3");
	assert.equal(scout.thinking, "low");
	assert.equal(scout.maxMinutes, 10);
	assert.equal(scout.promptMode, "append");
	assert.equal(scout.systemPrompt.trim(), "You are a scout.");
	assert.equal(scout.source, "user");
});

test("a comma-separated tools string is accepted", () => {
	writeAgent(USER_DIR, "reviewer.md", { name: "reviewer", description: "Review", tools: "read, bash" }, "Review.");
	const { agents } = discoverAgents(process.cwd(), "user");
	assert.deepEqual(agents.find((agent) => agent.name === "reviewer")?.tools, ["read", "bash"]);
});

test("system-prompt: replace and prepend are recognised", () => {
	writeAgent(USER_DIR, "replace.md", { name: "replace", description: "R", "system-prompt": "replace" }, "R.");
	writeAgent(USER_DIR, "prepend.md", { name: "prepend", description: "P", "system-prompt": "prepend" }, "P.");
	const { agents } = discoverAgents(process.cwd(), "user");
	assert.equal(agents.find((agent) => agent.name === "replace")?.promptMode, "replace");
	assert.equal(agents.find((agent) => agent.name === "prepend")?.promptMode, "prepend");
});

test("worktree: true makes the agent run in its own checkout by default", () => {
	writeAgent(USER_DIR, "isolated.md", { name: "isolated", description: "I", worktree: true }, "I.");
	writeAgent(USER_DIR, "shared.md", { name: "shared", description: "S", worktree: false }, "S.");
	const { agents } = discoverAgents(process.cwd(), "user");
	assert.equal(agents.find((agent) => agent.name === "isolated")?.worktree, true);
	assert.equal(agents.find((agent) => agent.name === "shared")?.worktree, false);
});

test("files without name or description are skipped", () => {
	writeAgent(USER_DIR, "nameless.md", { description: "no name" }, "x");
	writeAgent(USER_DIR, "undescribed.md", { name: "undescribed" }, "x");
	const { agents } = discoverAgents(process.cwd(), "user");
	assert.equal(agents.some((agent) => agent.name === "undescribed"), false);
	assert.equal(agents.some((agent) => agent.description === "no name"), false);
});

test("project agents are discovered from the nearest ancestor", () => {
	writeAgent(PROJECT_DIR, "builder.md", { name: "builder", description: "Project builder" }, "Build.");
	const { agents, projectAgentsDir } = discoverAgents(PROJECT_ROOT, "project");
	assert.equal(projectAgentsDir, PROJECT_DIR);
	assert.ok(agents.some((agent) => agent.name === "builder" && agent.source === "project"));
});

test("scope controls which directories are read", () => {
	const user = discoverAgents(PROJECT_ROOT, "user");
	assert.ok(user.agents.every((agent) => agent.source === "user"));
	assert.equal(user.agents.some((agent) => agent.name === "builder"), false);

	const project = discoverAgents(PROJECT_ROOT, "project");
	assert.ok(project.agents.every((agent) => agent.source === "project"));

	const both = discoverAgents(PROJECT_ROOT, "both");
	assert.ok(both.agents.some((agent) => agent.name === "builder" && agent.source === "project"));
	assert.ok(both.agents.some((agent) => agent.name === "scout" && agent.source === "user"));
});

test("a project agent overrides a user agent with the same name", () => {
	writeAgent(PROJECT_DIR, "scout.md", { name: "scout", description: "Project scout" }, "Project scout.");
	const { agents } = discoverAgents(PROJECT_ROOT, "both");
	const scouts = agents.filter((agent) => agent.name === "scout");
	assert.equal(scouts.length, 1);
	assert.equal(scouts[0]?.description, "Project scout");
	assert.equal(scouts[0]?.source, "project");
});

test("formatAgentList summarises agents", () => {
	const { agents } = discoverAgents(PROJECT_ROOT, "both");
	const summary = formatAgentList(agents);
	assert.match(summary, /scout \(project\): Project scout/);
	assert.equal(formatAgentList([]), "none");
});
