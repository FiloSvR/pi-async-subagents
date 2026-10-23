/**
 * Name allocation and the on-disk record of subagent runs.
 *
 * Names are the handle you address subagents by, and they stay addressable
 * after a run finishes so `subagent_message` can resume its session. Records
 * live in one small JSON file per parent session, so they survive a Pi
 * restart and never collide across sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RunStatus } from "./run.ts";

export interface RunRecord {
	name: string;
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	sessionId?: string;
	sessionFile?: string;
	/** Worktree this run used, if any. */
	worktreePath?: string;
	worktreeRepoRoot?: string;
	worktreeBranch?: string;
	worktreeBase?: string;
	/** True when this run created the branch (and may delete it on cleanup). */
	worktreeCreatedBranch?: boolean;
	/** True when the worktree was removed after an unchanged run. */
	worktreeRemoved?: boolean;
	createdAt: number;
	updatedAt: number;
	status: RunStatus;
}

/** Keep names usable as `subagent_message({ name })` handles. */
export function sanitizeName(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return cleaned || "subagent";
}

/** `scout`, `scout-2`, `scout-3`, … — never reuses a live or remembered name. */
export function allocateName(taken: Iterable<string>, base: string): string {
	const used = new Set(taken);
	const root = sanitizeName(base);
	if (!used.has(root)) return root;
	for (let i = 2; i < 10_000; i++) {
		const candidate = `${root}-${i}`;
		if (!used.has(candidate)) return candidate;
	}
	return `${root}-${Date.now()}`;
}

/** Registry file for one parent session, or `null` when the parent has no session id. */
export function registryPath(dir: string, parentSessionId: string | undefined | null): string | null {
	if (!parentSessionId) return null;
	return path.join(dir, `${sanitizeName(parentSessionId)}.json`);
}

export class SubagentRegistry {
	private records = new Map<string, RunRecord>();
	private readonly file: string | null;

	constructor(file: string | null, records: RunRecord[] = []) {
		this.file = file;
		for (const record of records) this.records.set(record.name, record);
	}

	static load(file: string | null): SubagentRegistry {
		if (!file) return new SubagentRegistry(null);
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
			const records = Array.isArray(raw) ? (raw as RunRecord[]) : [];
			return new SubagentRegistry(
				file,
				records.filter(
					(record): record is RunRecord =>
						typeof record === "object" && record !== null && typeof (record as RunRecord).name === "string",
				),
			);
		} catch {
			return new SubagentRegistry(file);
		}
	}

	get filePath(): string | null {
		return this.file;
	}

	get(name: string): RunRecord | undefined {
		return this.records.get(name);
	}

	list(): RunRecord[] {
		return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	names(): string[] {
		return [...this.records.keys()];
	}

	allocate(base: string): string {
		return allocateName(this.records.keys(), base);
	}

	put(record: RunRecord): void {
		this.records.set(record.name, record);
		this.save();
	}

	update(name: string, patch: Partial<RunRecord>): RunRecord | undefined {
		const existing = this.records.get(name);
		if (!existing) return undefined;
		const next = { ...existing, ...patch, updatedAt: Date.now() };
		this.records.set(name, next);
		this.save();
		return next;
	}

	private save(): void {
		const file = this.file;
		if (!file) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(this.list(), null, "\t"), { encoding: "utf-8", mode: 0o600 });
			fs.renameSync(tmp, file);
		} catch {
			// Losing the registry costs resume-by-name, never a running subagent.
		}
	}
}
