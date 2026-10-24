/**
 * Minimal child-side RPC client: the documented Pi RPC protocol
 * (`pi --mode rpc`) over strict JSONL on stdin/stdout.
 *
 * Why not `RpcClient` from the host package: it correlates commands and events
 * but exposes no way to answer `extension_ui_request` dialogs. A child that
 * opens a confirmation dialog would then block forever — the exact freeze this
 * extension exists to prevent. This client adds that response path, hard
 * deadlines on every command, and a guaranteed kill on `stop()`.
 *
 * Only documented protocol surface is used: see docs/rpc.md and
 * docs/rpc-commands.md in the host package.
 */

import { type ChildProcess, spawn } from "node:child_process";

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
}

export type RpcEvent = Record<string, unknown> & { type: string };
export type RpcEventHandler = (event: RpcEvent) => void;
export type RpcExitHandler = (code: number | null, signal: string | null) => void;

interface Pending {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface ChildRpcOptions {
	/** Deadline for one command's response. Default 30s. */
	commandTimeoutMs?: number;
}

/** A rejected command, whether the child said no or stopped answering. */
export class RpcCommandError extends Error {
	readonly command: string;
	readonly stderr?: string;

	constructor(message: string, command: string, stderr?: string) {
		super(message);
		this.name = "RpcCommandError";
		this.command = command;
		this.stderr = stderr;
	}
}

export class ChildRpc {
	private child: ChildProcess | null = null;
	private buffer = "";
	private nextId = 0;
	private pending = new Map<string, Pending>();
	private handlers = new Set<RpcEventHandler>();
	private exitHandlers = new Set<RpcExitHandler>();
	private stderrText = "";
	private exited = false;
	private readonly spec: SpawnSpec;
	private readonly commandTimeoutMs: number;

	constructor(spec: SpawnSpec, options: ChildRpcOptions = {}) {
		this.spec = spec;
		this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get hasExited(): boolean {
		return this.exited;
	}

	/**
	 * Start the child and prove it speaks RPC by asking for its state. Throws if
	 * the process is missing its CLI, crashes on startup, or never answers.
	 * Returns the state so callers need no second `get_state` round trip.
	 */
	async start(timeoutMs = 20_000): Promise<unknown> {
		if (this.child) throw new Error("child already started");

		const child = spawn(this.spec.command, this.spec.args, {
			cwd: this.spec.cwd,
			env: this.spec.env as NodeJS.ProcessEnv,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		this.child = child;

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr?.on("data", (chunk: string | Buffer) => {
			this.stderrText += chunk.toString();
			// Diagnostics only: keep a bounded tail so long noisy runs cannot grow memory.
			if (this.stderrText.length > 16_384) this.stderrText = this.stderrText.slice(-8_192);
		});

		child.on("error", (error) => {
			this.failAll(new Error(`subagent process error: ${error.message}`));
			this.markExit(null, null);
		});
		child.on("exit", (code, signal) => {
			this.markExit(code, signal);
		});
		// A closed stdin means the child can never be told anything again.
		child.stdin?.on("error", (error) => {
			this.failAll(new Error(`subagent stdin error: ${error.message}`));
		});

		return await this.send({ type: "get_state" }, timeoutMs);
	}

	onEvent(handler: RpcEventHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	onExit(handler: RpcExitHandler): () => void {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	/** Send one command and resolve with its `data` payload. */
	send(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<unknown> {
		const timeout = timeoutMs ?? this.commandTimeoutMs;
		if (this.exited || !this.child) {
			return Promise.reject(this.exitError(command.type));
		}

		const id = `r${++this.nextId}`;
		const line = `${JSON.stringify({ ...command, id })}\n`;

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new RpcCommandError(
						`no response to "${command.type}" within ${Math.round(timeout / 1000)}s`,
						command.type,
						this.stderrText,
					),
				);
			}, timeout);
			// Do not hold the host process open for a watchdog timer.
			if (typeof timer === "object" && "unref" in timer) timer.unref();

			this.pending.set(id, { resolve, reject, timer });

			const stdin = this.child?.stdin;
			if (!stdin || !stdin.writable) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(this.exitError(command.type));
				return;
			}
			stdin.write(line);
		});
	}

	/** Answer a dialog the child opened through `ctx.ui`. */
	respondToUI(requestId: string, response: Record<string, unknown>): void {
		const stdin = this.child?.stdin;
		if (!stdin || !stdin.writable) return;
		stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: requestId, ...response })}\n`);
	}

	/** Terminate the child: SIGTERM, then SIGKILL if it lingers. Always resolves. */
	async stop(graceMs = 5_000): Promise<void> {
		const child = this.child;
		if (!child || this.exited) return;

		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(killTimer);
				clearTimeout(sigkillTimer);
				resolve();
			};

			child.once("exit", finish);
			if (child.exitCode !== null || child.signalCode !== null) {
				finish();
				return;
			}

			try {
				child.kill("SIGTERM");
			} catch {
				finish();
				return;
			}

			const killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, graceMs);
			const sigkillTimer = setTimeout(finish, graceMs + 2_000);
			if (typeof killTimer === "object" && "unref" in killTimer) killTimer.unref();
			if (typeof sigkillTimer === "object" && "unref" in sigkillTimer) sigkillTimer.unref();
		});

		this.markExit(child.exitCode ?? null, (child.signalCode ?? null) as NodeJS.Signals | null);
	}

	get stderr(): string {
		return this.stderrText;
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim()) this.onLine(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Non-protocol noise on stdout: keep it as diagnostic text, never fatal.
			this.stderrText += `${line}\n`;
			return;
		}

		const id = typeof record.id === "string" ? record.id : undefined;
		if (record.type === "response" && id) {
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				clearTimeout(pending.timer);
				if (record.success === false) {
					pending.reject(
						new RpcCommandError(
							typeof record.error === "string" ? record.error : "command failed",
							typeof record.command === "string" ? record.command : "unknown",
							this.stderrText,
						),
					);
				} else {
					pending.resolve(record.data);
				}
			}
			return;
		}

		if (typeof record.type !== "string") return;
		const event = record as RpcEvent;
		for (const handler of [...this.handlers]) handler(event);
	}

	private markExit(code: number | null, signal: string | null): void {
		if (this.exited) return;
		this.exited = true;
		this.failAll(this.exitError("process", code, signal));
		for (const handler of [...this.exitHandlers]) handler(code, signal);
		this.exitHandlers.clear();
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private exitError(
		command: string,
		code: number | null = this.child?.exitCode ?? null,
		signal: string | null = null,
	): Error {
		const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
		const stderr = this.stderrText.trim();
		const tail = stderr ? `: ${stderr.split("\n").slice(-5).join(" | ")}` : "";
		return new RpcCommandError(`subagent process ended (${reason})${tail}`, command, this.stderrText);
	}
}
