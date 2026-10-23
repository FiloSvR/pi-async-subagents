/**
 * Async subagents for Pi.
 *
 * Spawning returns immediately: the parent turn keeps going while the child
 * works, and the result arrives later as a message that triggers a new turn.
 * A subagent can never freeze the session: silence is reported as `stalled`,
 * then aborted, then killed, and a crashed child fails the run rather than
 * hanging it.
 *
 * Tools: `subagent` (spawn), `subagent_message` (steer or resume),
 * `subagents_list`, `subagent_cancel`. Command: `/subagents`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import { SubagentRegistry, type RunRecord } from "./registry.ts";
import { ChildRpc, type SpawnSpec } from "./rpc.ts";
import {
	cleanupWorktrees,
	createWorktree,
	isUnchanged,
	removeWorktree,
	WorktreeError,
	type CleanupResult,
	type WorktreeSpec,
} from "./worktree.ts";
import { formatDuration, type RunStatus, SubagentRun, usageLine } from "./run.ts";

const RESULT_MESSAGE_TYPE = "subagent_result";
const WIDGET_KEY = "subagents";
const STATUS_KEY = "subagents";
const UI_THROTTLE_MS = 250;

interface SubagentConfig {
	stallSeconds: number;
	abortAfterSeconds: number;
	maxRunMinutes: number;
	/** How long an aborted child gets to report its own settlement before it is killed. */
	settleGraceSeconds: number;
	uiPolicy: "deny" | "allow";
	maxDepth: number;
	maxConcurrent: number;
}

const DEFAULT_CONFIG: SubagentConfig = {
	stallSeconds: 120,
	abortAfterSeconds: 600,
	maxRunMinutes: 60,
	settleGraceSeconds: 15,
	uiPolicy: "deny",
	maxDepth: 1,
	maxConcurrent: 6,
};

function loadConfig(): SubagentConfig {
	const file = path.join(getAgentDir(), "subagents", "config.json");
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SubagentConfig>;
		const positive = (value: unknown, fallback: number): number =>
			typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
		return {
			stallSeconds: positive(raw.stallSeconds, DEFAULT_CONFIG.stallSeconds),
			abortAfterSeconds: positive(raw.abortAfterSeconds, DEFAULT_CONFIG.abortAfterSeconds),
			maxRunMinutes: positive(raw.maxRunMinutes, DEFAULT_CONFIG.maxRunMinutes),
			settleGraceSeconds: positive(raw.settleGraceSeconds, DEFAULT_CONFIG.settleGraceSeconds),
			uiPolicy: raw.uiPolicy === "allow" ? "allow" : "deny",
			maxDepth: positive(raw.maxDepth, DEFAULT_CONFIG.maxDepth),
			maxConcurrent: positive(raw.maxConcurrent, DEFAULT_CONFIG.maxConcurrent),
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Depth of this process in a subagent tree; top level is 0. */
function currentDepth(): number {
	const raw = Number(process.env.PI_SUBAGENT_DEPTH ?? 0);
	return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Child environment: no parent-session identity, explicit subagent identity. */
function childEnv(depth: number, parentSessionId: string | undefined, name: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_CODING_AGENT_SESSION_DIR;
	env.PI_SUBAGENT_DEPTH = String(depth + 1);
	env.PI_SUBAGENT_NAME = name;
	if (parentSessionId) env.PI_SUBAGENT_PARENT_SESSION = parentSessionId;
	return env;
}

function writeSystemPrompt(dir: string, agent: AgentConfig): { dir: string; file: string } {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "system-prompt.md");
	fs.writeFileSync(file, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, file };
}

function makeSessionId(name: string): string {
	const slug = name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "subagent";
	return `sa-${Date.now().toString(36)}-${slug}`;
}

function resolveCwd(agent: AgentConfig, fallback: string): string {
	if (!agent.cwd) return fallback;
	const resolved = path.isAbsolute(agent.cwd) ? agent.cwd : path.resolve(fallback, agent.cwd);
	return fs.existsSync(resolved) ? resolved : fallback;
}

interface SpawnResult {
	spec: SpawnSpec;
	tmpDir: string | null;
	sessionId: string;
	/** Task after `system-prompt: prepend` handling. */
	task: string;
}

function buildSpawn(options: {
	agent: AgentConfig;
	task: string;
	name: string;
	cwd: string;
	depth: number;
	parentSessionId: string | undefined;
	model?: string;
	thinking?: string;
	/** Resume this existing session instead of starting a fresh one. */
	resume?: { sessionId?: string; sessionFile?: string };
}): SpawnResult {
	const { agent, name, depth, parentSessionId } = options;
	const args: string[] = ["--mode", "rpc"];
	const sessionsDir = path.join(getAgentDir(), "subagents", "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	args.push("--session-dir", sessionsDir);

	const sessionId = options.resume?.sessionId ?? makeSessionId(name);
	if (options.resume?.sessionFile && fs.existsSync(options.resume.sessionFile)) {
		args.push("--session", options.resume.sessionFile);
	} else if (options.resume?.sessionId) {
		// Resume the remembered session by id; --session-id would create a new one.
		args.push("--session", options.resume.sessionId);
	} else {
		args.push("--session-id", sessionId);
	}
	args.push("--name", `subagent:${name}`);

	const model = options.model ?? agent.model;
	if (model) args.push("--model", model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let task = options.task;
	if (agent.systemPrompt.trim()) {
		if (agent.promptMode === "prepend") {
			task = `${agent.systemPrompt.trim()}\n\n---\n\n${task}`;
		} else {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
			const prompt = writeSystemPrompt(tmpDir, agent);
			args.push(agent.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt", prompt.file);
		}
	}

	const invocation = getPiInvocation(args);
	const env = childEnv(depth, parentSessionId, name);
	// Keep the initial task out of argv: RPC takes prompts over stdin.
	return {
		spec: { command: invocation.command, args: invocation.args, cwd: options.cwd, env },
		tmpDir,
		sessionId,
		task,
	};
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const depth = currentDepth();
	const canSpawn = depth < config.maxDepth;
	const sessionsDir = path.join(getAgentDir(), "subagents");
	const runs = new Map<string, SubagentRun>();
	const completed: SubagentRun[] = [];
	let ctxRef: ExtensionContext | undefined;
	let registry: SubagentRegistry = new SubagentRegistry(null);
	let registrySessionId: string | undefined;
	let uiTimer: ReturnType<typeof setTimeout> | null = null;
	let shuttingDown = false;

	function rememberCtx(ctx: ExtensionContext): void {
		ctxRef = ctx;
		const sessionId = safeSessionId(ctx);
		if (sessionId && sessionId !== registrySessionId) {
			registrySessionId = sessionId;
			registry = SubagentRegistry.load(registryFor(sessionId));
		}
	}

	function registryFor(sessionId: string): string {
		return path.join(sessionsDir, "registry", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`);
	}

	function safeSessionId(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}

	function activeRuns(): SubagentRun[] {
		return [...runs.values()].filter((run) => !run.isTerminal);
	}

	function scheduleUi(): void {
		if (uiTimer) return;
		uiTimer = setTimeout(() => {
			uiTimer = null;
			renderUi();
		}, UI_THROTTLE_MS);
		if (typeof uiTimer === "object" && "unref" in uiTimer) uiTimer.unref();
	}

	function renderUi(): void {
		const ctx = ctxRef;
		if (!ctx) return;
		try {
			const active = activeRuns();
			const finished = completed.slice(-3).reverse();
			if (active.length === 0 && finished.length === 0) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			const lines: string[] = [];
			const header = active.length === 0 ? "Subagents" : `Subagents · ${active.length} running`;
			lines.push(header);
			for (const run of [...active, ...finished].slice(0, 8)) {
				const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
				const status = run.isTerminal ? run.status : run.status === "stalled" ? "stalled" : run.activity;
				const stall =
					run.isTerminal || run.status === "stalled"
						? ""
						: ` (idle ${formatDuration(Date.now() - run.lastActivityAt)})`;
				lines.push(`  ${elapsed.padStart(5)}  ${run.name}  ${status}${stall}`);
			}
			const hidden = active.length + finished.length - Math.min(8, active.length + finished.length);
			if (hidden > 0) lines.push(`  +${hidden} more`);

			ctx.ui.setWidget(WIDGET_KEY, lines);
			ctx.ui.setStatus(
				STATUS_KEY,
				active.length === 0 ? undefined : `${active.length} subagent${active.length === 1 ? "" : "s"}`,
			);
		} catch {
			// Rendering is best effort: never let UI trouble touch a run.
		}
	}

	function describeAgents(cwd: string, scope: AgentScope): { agents: AgentConfig[]; projectDir: string | null } {
		const discovery = discoverAgents(cwd, scope);
		return { agents: discovery.agents, projectDir: discovery.projectAgentsDir };
	}

	function runSummary(run: SubagentRun, record: RunRecord): string {
		const snapshot = run.snapshot();
		const elapsed = formatDuration((snapshot.endedAt ?? Date.now()) - snapshot.startedAt);
		const usage = usageLine(snapshot.usage);
		const head = `**${snapshot.name}** (${snapshot.agent}) ${statusVerb(snapshot.status)} after ${elapsed}${usage ? ` · ${usage}` : ""}`;
		const lines: string[] = [head];

		if (snapshot.error) lines.push(`Reason: ${snapshot.error}`);
		if (snapshot.status === "timeout" || snapshot.status === "failed") {
			lines.push(`Last activity: ${snapshot.activity}`);
		}
		if (snapshot.deniedDialogs.length > 0) {
			lines.push(
				`It asked for confirmation (${snapshot.deniedDialogs.join(", ")}) and was declined by policy (uiPolicy=${config.uiPolicy}).`,
			);
		}

		if (record.worktreePath) {
			lines.push(
				record.worktreeRemoved
					? "Worktree: removed after the run (no changes)."
					: `Worktree: ${record.worktreePath} (branch ${record.worktreeBranch ?? "?"}).`,
			);
		}

		const body = snapshot.finalText.trim();
		if (body) lines.push("", body);
		else if (snapshot.status === "finished") lines.push("", "(no output)");

		const resume = snapshot.sessionId
			? `Resume or steer it later with subagent_message({ name: "${snapshot.name}", message: "..." }).`
			: `Its session was not recorded, so it cannot be resumed.`;
		lines.push("", resume);
		return lines.join("\n");
	}

	function cleanupSummary(result: CleanupResult): string {
		if (result.removed.length === 0 && result.kept.length === 0) {
			return "No worktrees under .pi/worktrees.";
		}
		const lines: string[] = [];
		if (result.removed.length > 0) {
			lines.push(`${result.dryRun ? "Would remove" : "Removed"} ${result.removed.length}:`);
			for (const entry of result.removed) lines.push(`  ${entry.branch} (${entry.path})`);
		}
		if (result.kept.length > 0) {
			lines.push(`Kept ${result.kept.length}:`);
			for (const entry of result.kept) {
				lines.push(`  ${entry.branch ?? "?"} (${entry.path}): ${entry.reason}`);
			}
		}
		return lines.join("\n");
	}

	function statusVerb(status: RunStatus): string {
		switch (status) {
			case "finished":
				return "finished";
			case "failed":
				return "failed";
			case "cancelled":
				return "was cancelled";
			case "timeout":
				return "was stopped";
			default:
				return status;
		}
	}

	function settleRun(run: SubagentRun, record: RunRecord): void {
		runs.delete(run.name);
		completed.push(run);
		if (completed.length > 20) completed.splice(0, completed.length - 20);
		const snapshot = run.snapshot();

		if (record.worktreePath && record.worktreeBranch && record.worktreeBase && snapshot.status === "finished") {
			const spec: WorktreeSpec = {
				repoRoot: record.worktreeRepoRoot ?? path.dirname(path.dirname(path.dirname(record.worktreePath))),
				path: record.worktreePath,
				branch: record.worktreeBranch,
				base: record.worktreeBase,
				createdBranch: record.worktreeCreatedBranch === true,
			};
			try {
				if (isUnchanged(spec)) {
					removeWorktree(spec);
					record.worktreeRemoved = true;
				}
			} catch {
				// Keep the worktree; losing it is worse than leaving it.
				record.worktreeRemoved = false;
			}
		}

		registry.update(run.name, {
			status: snapshot.status,
			sessionId: snapshot.sessionId ?? record.sessionId,
			sessionFile: snapshot.sessionFile ?? record.sessionFile,
			model: snapshot.model ?? record.model,
			worktreePath: record.worktreePath,
			worktreeRepoRoot: record.worktreeRepoRoot,
			worktreeBranch: record.worktreeBranch,
			worktreeBase: record.worktreeBase,
			worktreeCreatedBranch: record.worktreeCreatedBranch,
			worktreeRemoved: record.worktreeRemoved,
		});
		renderUi();

		if (shuttingDown) return;
		try {
			pi.sendMessage(
				{
					customType: RESULT_MESSAGE_TYPE,
					content: [{ type: "text" as const, text: runSummary(run, record) }],
					display: true,
					details: { ...snapshot, agent: record.agent, worktree: record.worktreePath, worktreeBranch: record.worktreeBranch, worktreeRemoved: record.worktreeRemoved },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (error) {
			ctxRef?.ui.notify(`Could not deliver subagent result: ${String(error)}`, "error");
		}
	}

	function createRun(options: {
		agent: AgentConfig;
		task: string;
		name: string;
		cwd: string;
		model?: string;
		thinking?: string;
		resume?: { sessionId?: string; sessionFile?: string };
		worktree?: WorktreeSpec;
	}): SubagentRun {
		const { agent, task, name, cwd } = options;
		const spawned = buildSpawn({
			agent,
			task,
			name,
			cwd,
			depth,
			parentSessionId: registrySessionId,
			model: options.model,
			thinking: options.thinking,
			resume: options.resume,
		});
		const rpc = new ChildRpc(spawned.spec);

		const record: RunRecord = {
			name,
			agent: agent.name,
			task,
			cwd,
			model: options.model ?? agent.model,
			sessionId: spawned.sessionId,
			worktreePath: options.worktree?.path,
			worktreeRepoRoot: options.worktree?.repoRoot,
			worktreeBranch: options.worktree?.branch,
			worktreeBase: options.worktree?.base,
			worktreeCreatedBranch: options.worktree?.createdBranch,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "starting",
		};
		registry.put(record);

		const maxRunMinutes = agent.maxMinutes ?? config.maxRunMinutes;
		let lastPersistedStatus: RunStatus = "starting";
		const run = new SubagentRun({
			name,
			agent: agent.name,
			task: spawned.task,
			cwd,
			rpc,
			model: record.model,
			stallMs: config.stallSeconds * 1_000,
			abortAfterMs: config.abortAfterSeconds * 1_000,
			maxRunMs: maxRunMinutes * 60_000,
			uiPolicy: config.uiPolicy,
			settleGraceMs: config.settleGraceSeconds * 1_000,
			onUpdate: () => {
				if (run.isTerminal) return;
				if (run.status !== lastPersistedStatus) {
					lastPersistedStatus = run.status;
					registry.update(name, { status: run.status });
				}
				scheduleUi();
			},
			onDone: (done) => {
				if (spawned.tmpDir) {
					try {
						fs.rmSync(spawned.tmpDir, { recursive: true, force: true });
					} catch {
						/* best effort */
					}
				}
				settleRun(done, record);
			},
		});
		runs.set(name, run);
		scheduleUi();
		return run;
	}

	// ---------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		rememberCtx(ctx);
		renderUi();
	});

	pi.on("session_before_switch", async () => {
		await cancelAll("session switched");
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await cancelAll("session shut down");
	});

	async function cancelAll(reason: string): Promise<void> {
		const active = activeRuns();
		await Promise.all(active.map((run) => run.cancel(reason, true).catch(() => undefined)));
	}

	// ---------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------

	if (canSpawn) {
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Start a background subagent in its own process and return immediately. The subagent's result arrives later as a message that starts a new turn; do not wait for it. Use subagent_message to steer it while it runs or to continue its session once it has finished. Set worktree: true to give it its own git checkout for parallel work.",
			promptSnippet: "Start a background subagent; its result arrives later as a message",
			promptGuidelines: [
				"This tool returns immediately. The subagent's result is delivered later as a new message, so never wait for it: continue with other work, or end your turn if there is nothing else to do.",
				"Give each subagent a short, unique `name` so you can address it with subagent_message afterwards.",
				"Use subagents_list to see running and finished subagents, and subagent_message to correct a running subagent or continue a finished one.",
				"For parallel work in one repository, set `worktree: true` and give each subagent a unique `branch`. Each gets its own checkout under `.pi/worktrees`, so they cannot overwrite each other's files or index.",
				"After a pull request is merged, call subagent_cleanup. It removes worktrees whose branch is merged and whose checkout is clean, and keeps the rest with a reason.",
			],
			parameters: Type.Object({
				agent: Type.String({ description: "Name of the agent definition to run" }),
				task: Type.String({ description: "Task prompt for the subagent" }),
				name: Type.Optional(Type.String({ description: "Handle for this subagent (defaults to the agent name)" })),
				cwd: Type.Optional(Type.String({ description: "Working directory; overrides the agent's default" })),
				model: Type.Optional(Type.String({ description: "Model override, e.g. provider/model[:thinking]" })),
				thinking: Type.Optional(Type.String({ description: "Thinking level override: minimal, low, medium, high" })),
				agentScope: Type.Optional(
					Type.String({ description: 'Agent directories to use: "both" (default: user and project agents), "user", or "project"' }),
				),
				confirmProjectAgents: Type.Optional(
					Type.Boolean({ description: "Prompt before running project-local agents. Default: true" }),
				),
				worktree: Type.Optional(
					Type.Boolean({
						description:
							"Create a dedicated git worktree and run there (for parallel work in the same repository).",
					}),
				),
				branch: Type.Optional(
					Type.String({ description: "Branch to create or check out in the worktree. Default: subagent/<name>" }),
				),
				worktreeBase: Type.Optional(
					Type.String({ description: "Ref the worktree branch is created from. Default: main" }),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				rememberCtx(ctx);
				const scope: AgentScope = params.agentScope === "user" || params.agentScope === "project" ? params.agentScope : "both";
				const { agents, projectDir } = describeAgents(ctx.cwd, scope);
				const agent = agents.find((candidate) => candidate.name === params.agent);
				if (!agent) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Unknown agent "${params.agent}". Available agents:\n${formatAgentList(agents)}`,
							},
						],
					};
				}

				if (activeRuns().length >= config.maxConcurrent) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${config.maxConcurrent} subagents are already running. Wait for one to finish, or raise maxConcurrent in ~/.pi/agent/subagents/config.json.`,
							},
						],
					};
				}

				if (agent.source === "project" && params.confirmProjectAgents !== false && ctx.hasUI && !ctx.isProjectTrusted()) {
					const ok = await ctx.ui.confirm(
						"Run a project-local agent?",
						`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents come from the repository. Only continue for trusted code.`,
					);
					if (!ok) {
						return { content: [{ type: "text" as const, text: "Cancelled: project agent was not approved." }] };
					}
				}

				const name = registry.allocate(params.name?.trim() || agent.name);
				const useWorktree = params.worktree ?? agent.worktree ?? false;
				if (useWorktree && params.cwd) {
					return {
						content: [
							{
								type: "text" as const,
								text: "`worktree` and `cwd` are mutually exclusive: a worktree chooses its own directory.",
							},
						],
					};
				}

				let cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : resolveCwd(agent, ctx.cwd);
				let worktree: WorktreeSpec | undefined;
				if (useWorktree) {
					try {
						worktree = createWorktree({
							cwd: ctx.cwd,
							name,
							branch: params.branch,
							base: params.worktreeBase,
						});
						cwd = worktree.path;
					} catch (error) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Could not create a worktree: ${
										error instanceof WorktreeError ? error.message : String(error)
									}`,
								},
							],
						};
					}
				}
				if (!fs.existsSync(cwd)) {
					return { content: [{ type: "text" as const, text: `Working directory does not exist: ${cwd}` }] };
				}

				const model = params.model ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
				const thinking =
					params.thinking ?? agent.thinking ?? (params.model || agent.model ? undefined : ctx.thinkingLevel);

				let run: SubagentRun;
				try {
					run = createRun({ agent, task: params.task, name, cwd, model, thinking, worktree });
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Could not start subagent: ${String(error)}` }],
					};
				}

				// Fire and forget: the tool result is about acceptance, never about the work.
				void run.start();

				return {
					content: [
						{
							type: "text" as const,
							text: `Started subagent "${name}" (agent ${agent.name}, ${model ?? "default model"})${
								worktree ? ` in worktree ${worktree.path} on branch ${worktree.branch}` : ""
							} in the background. Its result will arrive as a new message; keep working or end your turn.`,
						},
					],
					details: {
						name,
						agent: agent.name,
						cwd,
						model,
						projectAgentsDir: projectDir,
						worktree: worktree?.path,
						worktreeBranch: worktree?.branch,
						worktreeBase: worktree?.base,
					},
				};
			},
		});

		pi.registerTool({
			name: "subagent_message",
			label: "Message subagent",
			description:
				"Send a message to a subagent by name. A running subagent is steered mid-run; a finished one is resumed with this message as its next task. Either way the reply arrives later as a message.",
			parameters: Type.Object({
				name: Type.String({ description: "Subagent name" }),
				message: Type.String({ description: "Message or follow-up task" }),
				mode: Type.Optional(
					Type.String({ description: 'For a running subagent: "steer" (default, interrupt) or "followUp" (after its turn)' }),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				rememberCtx(ctx);
				const run = runs.get(params.name);
				if (run && !run.isTerminal) {
					try {
						const disposition =
							params.mode === "followUp" ? await run.followUp(params.message) : await run.steer(params.message);
						return {
							content: [
								{
									type: "text" as const,
									text: `Message ${disposition === "queued" ? "queued for" : "delivered to"} "${params.name}". Its eventual result still arrives as a message.`,
								},
							],
						};
					} catch (error) {
						return { content: [{ type: "text" as const, text: `Could not reach "${params.name}": ${String(error)}` }] };
					}
				}

				const record = registry.get(params.name);
				if (!record) {
					const known = registry.names();
					return {
						content: [
							{
								type: "text" as const,
								text: `No subagent named "${params.name}".${known.length ? ` Known names: ${known.join(", ")}.` : ""} Start one with the subagent tool.`,
							},
						],
					};
				}

				const { agents } = describeAgents(ctx.cwd, "both");
				const agent = agents.find((candidate) => candidate.name === record.agent);
				if (!agent) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Agent definition "${record.agent}" is no longer available, so "${params.name}" cannot be resumed.`,
							},
						],
					};
				}

				const resumeCwd = fs.existsSync(record.cwd) ? record.cwd : ctx.cwd;
				const worktreeGone = Boolean(record.worktreePath) && !fs.existsSync(record.worktreePath);
				const resumed = createRun({
					agent,
					task: params.message,
					name: record.name,
					cwd: resumeCwd,
					model: record.model,
					resume: { sessionId: record.sessionId, sessionFile: record.sessionFile },
				});
				void resumed.start();
				return {
					content: [
						{
							type: "text" as const,
							text: `Resumed "${record.name}" with your message${
								worktreeGone ? " (its worktree is gone; continuing in the project checkout)" : ""
							}. Its reply will arrive as a new message.`,
						},
					],
				};
			},
		});

		pi.registerTool({
			name: "subagent_cancel",
			label: "Cancel subagent",
			description: "Stop a running subagent by name. Its partial output is still reported back.",
			parameters: Type.Object({
				name: Type.String({ description: "Subagent name" }),
				reason: Type.Optional(Type.String({ description: "Why it is being stopped" })),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				rememberCtx(ctx);
				const run = runs.get(params.name);
				if (!run || run.isTerminal) {
					return { content: [{ type: "text" as const, text: `"${params.name}" is not running.` }] };
				}
				void run.cancel(params.reason ?? "cancelled by the main agent");
				return {
					content: [{ type: "text" as const, text: `Stopping "${params.name}". Its partial result will arrive as a message.` }],
				};
			},
		});

		pi.registerTool({
			name: "subagent_cleanup",
			label: "Clean up worktrees",
			description:
				"Remove subagent worktrees whose branch is merged into the base and whose checkout is clean. Unmerged, dirty or in-use worktrees are kept and listed with the reason. Run this after merging a pull request.",
			parameters: Type.Object({
				base: Type.Optional(Type.String({ description: "Base ref to test merges against. Default: main" })),
				fetch: Type.Optional(Type.Boolean({ description: "Run git fetch --prune first, so a remote merge is visible." })),
				dryRun: Type.Optional(Type.Boolean({ description: "Report what would be removed without removing it." })),
				cwd: Type.Optional(Type.String({ description: "Repository directory. Default: the current working directory" })),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				rememberCtx(ctx);
				const repoCwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
				try {
					const result = cleanupWorktrees({
						cwd: repoCwd,
						base: params.base,
						fetch: params.fetch,
						dryRun: params.dryRun,
						isActive: (worktreePath) => activeRuns().some((run) => run.cwd === worktreePath),
					});
					return { content: [{ type: "text" as const, text: cleanupSummary(result) }], details: result };
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Cleanup failed: ${error instanceof WorktreeError ? error.message : String(error)}`,
							},
						],
					};
				}
			},
		});

	pi.registerTool({
		name: "subagents_list",
		label: "List subagents",
		description: "List running and remembered subagents, plus the agent definitions that can be spawned.",
		parameters: Type.Object({
			includeAgents: Type.Optional(Type.Boolean({ description: "Also list available agent definitions. Default: true" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberCtx(ctx);
			const lines: string[] = [];
			const active = activeRuns();
			if (active.length === 0) {
				lines.push("Running: none");
			} else {
				lines.push(`Running (${active.length}):`);
				for (const run of active) {
					const elapsed = formatDuration(Date.now() - run.startedAt);
					const idle = formatDuration(Date.now() - run.lastActivityAt);
					lines.push(`  ${run.name} (${run.agent}) ${run.status} · ${run.activity} · ${elapsed} · idle ${idle}`);
				}
			}

			const finished = registry.list().filter((record) => !runs.has(record.name));
			if (finished.length > 0) {
				lines.push("", `Remembered (${finished.length}):`);
				for (const record of finished.slice(0, 12)) {
					const worktree = record.worktreePath
						? record.worktreeRemoved
							? " · worktree removed"
							: ` · worktree ${record.worktreePath}`
						: "";
					lines.push(
						`  ${record.name} (${record.agent}) ${record.status}${record.sessionId ? " · resumable" : ""}${worktree} · ${record.task.replace(/\s+/g, " ").slice(0, 60)}`,
					);
				}
			}

			if (params.includeAgents !== false) {
				const { agents } = describeAgents(ctx.cwd, "both");
				lines.push("", "Agents:");
				for (const agent of agents) {
					const bits = [agent.model ?? "default model", agent.tools ? agent.tools.join(",") : "default tools"];
					lines.push(`  ${agent.name} (${agent.source}): ${agent.description} [${bits.join(" · ")}]`);
				}
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	});

	pi.registerCommand("subagents", {
		description: "List subagents, cancel one, or clean merged worktrees: /subagents [cancel <name>|cleanup [base]]",
		handler: async (args, ctx) => {
			rememberCtx(ctx);
			const trimmed = args.trim();
			if (trimmed === "cleanup" || trimmed.startsWith("cleanup ")) {
				const base = trimmed.replace(/^cleanup\s*/, "").trim() || undefined;
				try {
					const result = cleanupWorktrees({ cwd: ctx.cwd, base });
					ctx.ui.notify(cleanupSummary(result), "info");
				} catch (error) {
					ctx.ui.notify(`Cleanup failed: ${error instanceof WorktreeError ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (trimmed.startsWith("cancel")) {
				const name = trimmed.replace(/^cancel\s*/, "").trim();
				const run = name ? runs.get(name) : undefined;
				if (!run || run.isTerminal) {
					ctx.ui.notify(`No running subagent named "${name}".`, "warning");
					return;
				}
				void run.cancel("cancelled from /subagents");
				ctx.ui.notify(`Stopping "${name}".`, "info");
				return;
			}

			const active = activeRuns();
			if (active.length === 0) {
				ctx.ui.notify("No subagents running.", "info");
				return;
			}
			const lines = active.map((run) => {
				const elapsed = formatDuration(Date.now() - run.startedAt);
				return `${run.name} (${run.agent}) ${run.status} · ${run.activity} · ${elapsed}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	}
}
