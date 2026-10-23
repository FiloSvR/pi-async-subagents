/**
 * One subagent run: a Pi child process spoken to over RPC, with liveness
 * tracking so a wedged child can never wedge the parent.
 *
 * Guarantees, in order of importance:
 *
 * 1. `start()` returns as soon as the child accepted the prompt. The parent
 *    turn is never waiting on model work.
 * 2. Completion, failure, cancellation and stall all end in exactly one
 *    `onDone` call carrying a summary.
 * 3. No run can hang forever: `stallMs` marks it stalled, `abortAfterMs`
 *    aborts it, `maxRunMs` caps it, and `onExit` catches a crashed child.
 */

import { type ChildRpc, RpcCommandError, type RpcEvent } from "./rpc.ts";

export type RunStatus = "starting" | "running" | "stalled" | "finished" | "failed" | "cancelled" | "timeout";

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["finished", "failed", "cancelled", "timeout"]);

export function isTerminalStatus(status: RunStatus): boolean {
	return TERMINAL.has(status);
}

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): RunUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export interface RunConfig {
	name: string;
	agent: string;
	task: string;
	cwd: string;
	rpc: ChildRpc;
	model?: string;
	/** Report the run as stalled after this much silence. */
	stallMs: number;
	/** Abort the run after this much silence. */
	abortAfterMs: number;
	/** Hard cap on one run. */
	maxRunMs: number;
	/** How to answer child dialogs (`ctx.ui.confirm` and friends). */
	uiPolicy: "deny" | "allow";
	/** How long to wait for `agent_settled` after an abort before killing the child. */
	settleGraceMs?: number;
	onUpdate?: (run: SubagentRun) => void;
	onDone?: (run: SubagentRun) => void;
}

export interface RunSnapshot {
	name: string;
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	status: RunStatus;
	activity: string;
	startedAt: number;
	lastActivityAt: number;
	endedAt?: number;
	turns: number;
	usage: RunUsage;
	sessionId?: string;
	sessionFile?: string;
	finalText: string;
	error?: string;
	deniedDialogs: string[];
}

const WATCHDOG_MS = 1_000;

export class SubagentRun {
	readonly name: string;
	readonly agent: string;
	readonly task: string;
	readonly cwd: string;
	readonly model?: string;
	readonly startedAt = Date.now();

	status: RunStatus = "starting";
	activity = "starting";
	lastActivityAt = Date.now();
	endedAt?: number;
	turns = 0;
	usage: RunUsage = emptyUsage();
	sessionId?: string;
	sessionFile?: string;
	finalText = "";
	error?: string;
	deniedDialogs: string[] = [];
	stopReason?: string;

	private readonly config: RunConfig;
	private readonly rpc: ChildRpc;
	private watchdog: ReturnType<typeof setInterval> | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingOutcome: { status: RunStatus; error?: string } | null = null;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeExit: (() => void) | null = null;
	private done = false;
	private readonly settled: Promise<void>;
	private resolveSettled: () => void = () => undefined;
	private readonly ready: Promise<void>;
	private resolveReady: () => void = () => undefined;
	private stopping = false;

	constructor(config: RunConfig) {
		this.config = config;
		this.rpc = config.rpc;
		this.name = config.name;
		this.agent = config.agent;
		this.task = config.task;
		this.cwd = config.cwd;
		this.model = config.model;
		this.settled = new Promise((resolve) => {
			this.resolveSettled = resolve;
		});
		this.ready = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
	}

	get isTerminal(): boolean {
		return isTerminalStatus(this.status);
	}

	/** PID of the child process, for diagnostics and tests. */
	get childPid(): number | undefined {
		return this.rpc.pid;
	}

	/** Start the child, send the task, and return. Never waits for model work. */
	async start(): Promise<void> {
		this.unsubscribeExit = this.rpc.onExit((code, signal) => {
			if (this.isTerminal) return;
			const outcome = this.pendingOutcome ?? {
				status: "failed" as RunStatus,
				error: `subagent exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}) without finishing`,
			};
			this.finalize(outcome.status, outcome.error);
		});

		try {
			await this.rpc.start();
		} catch (error) {
			this.finalize("failed", describe(error));
			return;
		}

		this.status = "running";
		this.touch("thinking");
		this.watchdog = setInterval(() => this.tick(), WATCHDOG_MS);
		if (typeof this.watchdog === "object" && "unref" in this.watchdog) this.watchdog.unref();

		this.unsubscribe = this.rpc.onEvent((event) => this.onEvent(event));

		try {
			const state = (await this.rpc.send({ type: "get_state" }, 15_000)) as {
				sessionId?: string;
				sessionFile?: string;
			} | null;
			if (state?.sessionId) this.sessionId = state.sessionId;
			if (state?.sessionFile) this.sessionFile = state.sessionFile;
		} catch {
			// State is a nicety (resume, widget); the run can proceed without it.
		}

		try {
			const data = (await this.rpc.send({ type: "prompt", message: this.task }, 60_000)) as {
				disposition?: string;
			} | null;
			if (data?.disposition === "handled") {
				// An extension command consumed the prompt; no model run will follow.
				this.finalize("finished");
			}
			this.resolveReady();
		} catch (error) {
			this.finalize(this.pendingOutcome?.status ?? "failed", this.pendingOutcome?.error ?? describe(error));
		}
	}

	/** Interrupt the child mid-turn with new instructions. */
	async steer(message: string): Promise<string> {
		await this.ready;
		if (this.isTerminal) throw new Error("subagent is no longer running");
		const data = (await this.rpc.send({ type: "steer", message }, 15_000)) as { disposition?: string } | null;
		if (!this.isTerminal) this.touch("steering");
		return data?.disposition ?? "queued";
	}

	/** Queue work for after the child's current turn. */
	async followUp(message: string): Promise<string> {
		await this.ready;
		if (this.isTerminal) throw new Error("subagent is no longer running");
		const data = (await this.rpc.send({ type: "follow_up", message }, 15_000)) as { disposition?: string } | null;
		if (!this.isTerminal) this.touch("queued follow-up");
		return data?.disposition ?? "queued";
	}

	/** Stop the run on purpose; resolves once the run is terminal. */
	async cancel(reason: string, immediate = false): Promise<void> {
		if (this.isTerminal) return;
		this.pendingOutcome = { status: "cancelled", error: reason };
		this.stopReason = reason;
		await this.abortChild(reason, immediate);
	}

	snapshot(): RunSnapshot {
		return {
			name: this.name,
			agent: this.agent,
			task: this.task,
			cwd: this.cwd,
			model: this.model,
			status: this.status,
			activity: this.activity,
			startedAt: this.startedAt,
			lastActivityAt: this.lastActivityAt,
			endedAt: this.endedAt,
			turns: this.turns,
			usage: { ...this.usage },
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			finalText: this.finalText,
			error: this.error,
			deniedDialogs: [...this.deniedDialogs],
		};
	}

	private onEvent(event: RpcEvent): void {
		switch (event.type) {
			case "message_start": {
				const role = (event.message as { role?: string } | undefined)?.role;
				if (role === "assistant") this.touch("writing");
				else this.touch("thinking");
				break;
			}
			case "message_end": {
				const message = event.message as
					| { role?: string; usage?: Record<string, any>; content?: unknown }
					| undefined;
				if (message?.role === "assistant") {
					this.turns += 1;
					this.addUsage(message.usage);
					const text = textOf(message.content);
					if (text) this.finalText = text;
					this.touch("thinking");
				}
				break;
			}
			case "tool_execution_start": {
				const tool = typeof event.toolName === "string" ? event.toolName : "tool";
				this.touch(tool);
				break;
			}
			case "tool_execution_end": {
				this.touch("thinking");
				break;
			}
			case "bash_execution_update":
			case "turn_start":
			case "turn_end":
			case "agent_start":
			case "agent_end":
			case "retry_start":
			case "compaction_start":
			case "compaction_end": {
				this.touch(this.activity);
				break;
			}
			case "agent_settled": {
				const aborted = event.aborted === true;
				void this.settle(aborted);
				break;
			}
			case "extension_ui_request": {
				void this.onUIRequest(event);
				break;
			}
			default:
				break;
		}
	}

	private async onUIRequest(event: RpcEvent): Promise<void> {
		const id = typeof event.id === "string" ? event.id : undefined;
		const method = typeof event.method === "string" ? event.method : undefined;
		if (!id || !method) return;

		const isDialog = method === "select" || method === "confirm" || method === "input" || method === "editor";
		if (!isDialog) {
			// Fire-and-forget notifications: nothing to answer.
			this.touch(this.activity);
			return;
		}

		const title = typeof event.title === "string" ? event.title : method;
		if (this.config.uiPolicy === "allow") {
			// Answer without asking the parent. Documented response shapes:
			// confirm -> { confirmed }, select/input/editor -> { value }.
			const options = Array.isArray(event.options) ? event.options : [];
			const first = options[0];
			const optionValue =
				typeof first === "string"
					? first
					: typeof first === "object" && first !== null
						? ((first as { value?: unknown }).value ?? (first as { label?: unknown }).label)
						: undefined;
			const response =
				method === "confirm"
					? { confirmed: true }
					: method === "select"
						? typeof optionValue === "string"
							? { value: optionValue }
							: { cancelled: true }
						: { value: "" };
			this.rpc.respondToUI(id, response);
			this.touch("answered dialog");
			return;
		}

		this.deniedDialogs.push(title);
		this.rpc.respondToUI(id, { cancelled: true });
		this.touch("declined dialog");
	}

	private async settle(aborted: boolean): Promise<void> {
		if (this.isTerminal) return;
		if (!this.finalText) {
			try {
				const text = (await this.rpc.send({ type: "get_last_assistant_text" }, 5_000)) as string | null;
				if (typeof text === "string") this.finalText = text;
			} catch {
				/* keep whatever streamed */
			}
		}
		const outcome =
			this.pendingOutcome ?? (aborted ? { status: "cancelled" as RunStatus, error: "child aborted the run" } : { status: "finished" as RunStatus });
		this.finalize(outcome.status, outcome.error);
	}

	private tick(): void {
		if (this.isTerminal || this.stopping) return;
		const now = Date.now();
		const idle = now - this.lastActivityAt;
		const runMs = now - this.startedAt;

		if (runMs >= this.config.maxRunMs) {
			this.pendingOutcome = { status: "timeout", error: `exceeded the ${formatDuration(this.config.maxRunMs)} runtime cap` };
			this.stopReason = "runtime cap";
			void this.abortChild("runtime cap");
			return;
		}

		if (idle >= this.config.abortAfterMs) {
			this.pendingOutcome = { status: "timeout", error: `no activity for ${formatDuration(idle)}` };
			this.stopReason = "stalled";
			void this.abortChild(`no activity for ${formatDuration(idle)}`);
			return;
		}

		if (idle >= this.config.stallMs && this.status === "running") {
			this.status = "stalled";
			this.emitUpdate();
			return;
		}

		if (idle < this.config.stallMs && this.status === "stalled") {
			this.status = "running";
			this.emitUpdate();
		}
	}

	/** Abort, then guarantee the child dies even if it ignores the abort. */
	private async abortChild(reason: string, immediate = false): Promise<void> {
		if (this.isTerminal) return;
		if (this.stopping) {
			await this.settled;
			return;
		}
		this.stopping = true;
		this.activity = `stopping (${reason})`;
		this.emitUpdate();

		try {
			await this.rpc.send({ type: "abort" }, 10_000);
		} catch {
			/* the process is already going away */
		}

		const outcome = this.pendingOutcome ?? { status: "cancelled" as RunStatus, error: reason };

		if (immediate) {
			await this.rpc.stop(1_500);
			this.finalize(outcome.status, outcome.error);
			return;
		}

		// Give the child a moment to report its own settlement (and keep the text it wrote),
		// but do not trust it to do so: the timer resolves the run either way.
		const graceMs = this.config.settleGraceMs ?? 15_000;
		const graceElapsed = new Promise<void>((resolve) => {
			this.settleTimer = setTimeout(resolve, graceMs);
			if (typeof this.settleTimer === "object" && "unref" in this.settleTimer) this.settleTimer.unref();
		});
		await Promise.race([this.settled, graceElapsed]);
		if (this.isTerminal) return;

		await this.rpc.stop(5_000);
		this.finalize(outcome.status, outcome.error);
	}

	private finalize(status: RunStatus, error?: string): void {
		if (this.done) return;
		this.done = true;
		this.resolveSettled();

		this.status = status;
		this.error = error;
		this.endedAt = Date.now();
		this.resolveReady();
		this.stopWatchdog();
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unsubscribeExit?.();
		this.unsubscribeExit = null;

		// Kill a child that outlived its own settlement (or never got one).
		void this.rpc.stop(2_000);
		this.emitUpdate();
		try {
			this.config.onDone?.(this);
		} catch {
			// Reporting trouble must not turn a finished run into a rejection.
		}
	}

	private stopWatchdog(): void {
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = null;
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = null;
	}

	private touch(activity: string): void {
		this.activity = activity;
		this.lastActivityAt = Date.now();
		if (this.status === "stalled") {
			this.status = "running";
			this.emitUpdate();
		}
	}

	private addUsage(usage: Record<string, any> | undefined): void {
		if (!usage) return;
		this.usage.input += numberOr(usage.input);
		this.usage.output += numberOr(usage.output);
		this.usage.cacheRead += numberOr(usage.cacheRead);
		this.usage.cacheWrite += numberOr(usage.cacheWrite);
		this.usage.cost += numberOr(usage.cost?.total);
		const contextTokens = numberOr(usage.totalTokens);
		if (contextTokens) this.usage.contextTokens = contextTokens;
		this.usage.turns = this.turns;
	}

	private emitUpdate(): void {
		try {
			this.config.onUpdate?.(this);
		} catch {
			// UI and registry updates are best effort and never fail a run.
		}
	}
}

function numberOr(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Assistant message content to text; tolerates strings and content blocks. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			return (
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			);
		})
		.map((block) => block.text)
		.join("")
		.trim();
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

export function usageLine(usage: RunUsage): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(2)}`);
	return parts.join(" ");
}

function describe(error: unknown): string {
	if (error instanceof RpcCommandError) return error.message;
	return error instanceof Error ? error.message : String(error);
}
