/**
 * Agent discovery and configuration.
 *
 * Agent definitions are Markdown files with YAML frontmatter plus a body that
 * becomes the child's system prompt:
 *
 *     ---
 *     name: scout
 *     description: Fast read-only recon
 *     tools: read, grep, find, ls
 *     model: openrouter/z-ai/glm-5.3
 *     thinking: low
 *     max-minutes: 10
 *     system-prompt: append
 *     ---
 *     You are a scout...
 *
 * Discovery order matches Pi's own subagent example: user agents come from
 * `~/.pi/agent/agents`, project agents from the nearest `.pi/agents`, and a
 * project file overrides a user file with the same name in `both` scope.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";
export type PromptMode = "append" | "replace" | "prepend";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	/** Default working directory for runs of this agent. Relative paths resolve against the caller's cwd. */
	cwd?: string;
	/** Hard runtime cap for one run of this agent, in minutes. */
	maxMinutes?: number;
	/** Run this agent in its own git worktree by default. */
	worktree?: boolean;
	promptMode: PromptMode;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	cwd?: unknown;
	"max-minutes"?: unknown;
	worktree?: unknown;
	"system-prompt"?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names. Both
 * `tools: read, bash` and `tools: [read, bash]` are accepted; anything else
 * yields no allowlist rather than throwing, so one malformed file cannot take
 * down the whole directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parsePromptMode(value: unknown): PromptMode {
	if (value === "replace" || value === "prepend") return value;
	return "append";
}

function parseBoolean(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

function parseMaxMinutes(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			cwd: typeof frontmatter.cwd === "string" ? frontmatter.cwd : undefined,
			maxMinutes: parseMaxMinutes(frontmatter["max-minutes"]),
			worktree: parseBoolean(frontmatter.worktree),
			promptMode: parsePromptMode(frontmatter["system-prompt"]),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Project agents win over user agents with the same name.
	const byName = new Map<string, AgentConfig>();
	for (const agent of userAgents) byName.set(agent.name, agent);
	for (const agent of projectAgents) byName.set(agent.name, agent);

	return { agents: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems = 50): string {
	if (agents.length === 0) return "none";
	return agents
		.slice(0, maxItems)
		.map((a) => `${a.name} (${a.source}): ${a.description}`)
		.join("\n");
}
