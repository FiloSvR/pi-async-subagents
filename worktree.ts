/**
 * Git worktrees for parallel subagents.
 *
 * Two implementers cannot share one checkout: they would overwrite each other's
 * edits, index and HEAD. A worktree gives each run its own checkout, branch and
 * index while sharing the object database.
 *
 * The rules here:
 * - A worktree lives under `<repo>/.pi/worktrees/<slug>` and is excluded from
 *   the repo's git status (best effort appends to `.git/info/exclude`).
 * - The branch is created from `base` (default `main`) unless it already
 *   exists, in which case it is checked out as-is.
 * - A worktree is only removed automatically when *this* run created the
 *   branch and left it unchanged (no commits, no dirty files). Anything else
 *   is kept, because the work may be the point.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export class WorktreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeError";
	}
}

export interface WorktreeSpec {
	repoRoot: string;
	path: string;
	branch: string;
	base: string;
	/** True when this run created the branch (and may delete it on cleanup). */
	createdBranch: boolean;
}

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const failure = error as { stderr?: string | Buffer; message?: string };
		const stderr = failure.stderr ? failure.stderr.toString().trim() : "";
		throw new WorktreeError(stderr || failure.message || `git ${args[0]} failed`);
	}
}

export function sanitizeSlug(value: string): string {
	const cleaned = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 70);
	return cleaned || "worktree";
}

function hasBranch(repoRoot: string, branch: string): boolean {
	try {
		git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

/** Best-effort: keep the worktree root out of `git status`. */
export function excludeWorktreeRoot(repoRoot: string): void {
	try {
		const commonDir = git(repoRoot, ["rev-parse", "--git-common-dir"]).trim();
		const excludeFile = path.resolve(repoRoot, commonDir, "info", "exclude");
		let text = "";
		try {
			text = fs.readFileSync(excludeFile, "utf-8");
		} catch {
			/* no exclude file yet */
		}
		const entries = text.split("\n").map((line) => line.trim());
		if (entries.includes(".pi/worktrees/") || entries.includes(".pi/")) return;
		fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
		const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
		fs.appendFileSync(excludeFile, `${prefix}.pi/worktrees/\n`);
	} catch {
		// A visible worktree directory is untidy, not broken.
	}
}

export function findRepoRoot(cwd: string): string | null {
	try {
		const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
		return root || null;
	} catch {
		return null;
	}
}

export interface CreateWorktreeOptions {
	/** Directory inside the repository that hosts the worktree. */
	cwd: string;
	/** Run name, used for the default branch and directory. */
	name: string;
	/** Branch to create or check out. Default `subagent/<name>`. */
	branch?: string;
	/** Ref to branch from. Default `main`. */
	base?: string;
}

export function createWorktree(options: CreateWorktreeOptions): WorktreeSpec {
	const repoRoot = findRepoRoot(options.cwd);
	if (!repoRoot) throw new WorktreeError(`not inside a git repository: ${options.cwd}`);

	const base = options.base?.trim() || "main";
	const branch = (options.branch?.trim() || `subagent/${options.name}`).replace(/^\/+|\/+$/g, "");
	if (!branch) throw new WorktreeError("branch name is empty");
	if (branch.startsWith("-")) throw new WorktreeError(`invalid branch name: ${branch}`);

	// Fail early with a clear message if the base ref does not exist.
	git(repoRoot, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);

	const dir = path.join(repoRoot, ".pi", "worktrees", sanitizeSlug(branch));
	if (fs.existsSync(dir)) throw new WorktreeError(`worktree directory already exists: ${dir}`);

	const branchExists = hasBranch(repoRoot, branch);
	const args = branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base];
	git(repoRoot, args);
	excludeWorktreeRoot(repoRoot);

	return { repoRoot, path: dir, branch, base, createdBranch: !branchExists };
}

export interface WorktreeState {
	dirty: boolean;
	/** Commits on the worktree branch that are not on the base. */
	commits: number;
}

export function worktreeState(spec: WorktreeSpec): WorktreeState {
	const status = git(spec.path, ["status", "--porcelain"]).trim();
	let commits = 1;
	try {
		const count = git(spec.path, ["rev-list", "--count", `${spec.base}..HEAD`]).trim();
		const parsed = Number(count);
		commits = Number.isFinite(parsed) ? parsed : 1;
	} catch {
		// If the comparison itself fails, assume there is work to keep.
		commits = 1;
	}
	return { dirty: status.length > 0, commits };
}

/** Only a worktree this run created and left untouched may be deleted. */
export function isUnchanged(spec: WorktreeSpec): boolean {
	if (!spec.createdBranch) return false;
	const state = worktreeState(spec);
	return !state.dirty && state.commits === 0;
}

export function removeWorktree(spec: WorktreeSpec): void {
	git(spec.repoRoot, ["worktree", "remove", "--force", spec.path]);
	try {
		git(spec.repoRoot, ["branch", "-D", spec.branch]);
	} catch {
		// The branch may already be gone, or be checked out elsewhere.
	}
	try {
		git(spec.repoRoot, ["worktree", "prune"]);
	} catch {
		/* best effort */
	}
}

export interface ManagedWorktree {
	path: string;
	branch?: string;
}

/** Worktrees git knows about, parsed from `git worktree list --porcelain`. */
export function listWorktrees(repoRoot: string): ManagedWorktree[] {
	const output = git(repoRoot, ["worktree", "list", "--porcelain"]);
	const entries: ManagedWorktree[] = [];
	let current: ManagedWorktree | null = null;
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length) };
		} else if (line.startsWith("branch ") && current) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
	}
	if (current) entries.push(current);
	return entries;
}

function isMerged(repoRoot: string, branch: string, base: string): boolean {
	try {
		git(repoRoot, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, base]);
		return true;
	} catch {
		return false;
	}
}

export interface CleanupOptions {
	/** Directory inside the repository. */
	cwd: string;
	/** Base branch/ref to test merges against. Default `main`. */
	base?: string;
	/** Run `git fetch --prune` first, so a merged remote branch is visible. */
	fetch?: boolean;
	/** Report what would be removed without removing it. */
	dryRun?: boolean;
	/** Return true for worktrees an active run is still using. */
	isActive?: (worktreePath: string) => boolean;
}

export interface CleanupResult {
	removed: Array<{ path: string; branch: string }>;
	kept: Array<{ path: string; branch?: string; reason: string }>;
	dryRun: boolean;
}

/**
 * Remove managed worktrees that are safe to remove: branch merged into the
 * base, checkout clean, and no subagent still running there. Everything else
 * is kept and explained. Never touches worktrees outside `.pi/worktrees`.
 */
export function cleanupWorktrees(options: CleanupOptions): CleanupResult {
	const repoRoot = findRepoRoot(options.cwd);
	if (!repoRoot) throw new WorktreeError(`not inside a git repository: ${options.cwd}`);
	const base = options.base?.trim() || "main";
	const dryRun = options.dryRun === true;
	const result: CleanupResult = { removed: [], kept: [], dryRun };

	if (options.fetch) {
		try {
			git(repoRoot, ["fetch", "--prune"]);
		} catch {
			// Offline or no remote: the local base is still authoritative enough.
		}
	}

	// Accept the local base or its up-to-date remote counterpart.
	const bases = [base];
	try {
		git(repoRoot, ["rev-parse", "--verify", "--quiet", `origin/${base}^{commit}`]);
		if (!bases.includes(`origin/${base}`)) bases.push(`origin/${base}`);
	} catch {
		/* no remote base */
	}

	const managedRoot = `${path.join(repoRoot, ".pi", "worktrees")}${path.sep}`;
	for (const worktree of listWorktrees(repoRoot)) {
		if (!worktree.path.startsWith(managedRoot)) continue;
		if (options.isActive?.(worktree.path)) {
			result.kept.push({ path: worktree.path, branch: worktree.branch, reason: "a subagent is still running there" });
			continue;
		}
		if (!worktree.branch) {
			result.kept.push({ path: worktree.path, reason: "detached HEAD" });
			continue;
		}

		let status = "";
		try {
			status = git(worktree.path, ["status", "--porcelain"]).trim();
		} catch {
			result.kept.push({ path: worktree.path, branch: worktree.branch, reason: "checkout could not be read" });
			continue;
		}
		if (status.length > 0) {
			result.kept.push({ path: worktree.path, branch: worktree.branch, reason: "uncommitted changes" });
			continue;
		}

		if (!bases.some((candidate) => isMerged(repoRoot, worktree.branch as string, candidate))) {
			result.kept.push({ path: worktree.path, branch: worktree.branch, reason: `not merged into ${base}` });
			continue;
		}

		if (dryRun) {
			result.removed.push({ path: worktree.path, branch: worktree.branch });
			continue;
		}

		try {
			// No --force: the clean check above is the contract.
			git(repoRoot, ["worktree", "remove", worktree.path]);
			try {
				git(repoRoot, ["branch", "-d", worktree.branch]);
			} catch {
				// A branch checked out elsewhere stays; the worktree is gone.
			}
			result.removed.push({ path: worktree.path, branch: worktree.branch });
		} catch (error) {
			result.kept.push({
				path: worktree.path,
				branch: worktree.branch,
				reason: `remove failed: ${error instanceof WorktreeError ? error.message : String(error)}`,
			});
		}
	}

	return result;
}
