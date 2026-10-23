import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	cleanupWorktrees,
	createWorktree,
	isUnchanged,
	removeWorktree,
	WorktreeError,
	worktreeState,
} from "../worktree.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-wt-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	git(dir, ["commit", "--allow-empty", "-m", "init"]);
	return dir;
}

function cleanup(repo: string): void {
	try {
		const list = git(repo, ["worktree", "list", "--porcelain"]).split("\n");
		for (const line of list) {
			if (line.startsWith("worktree ") && line !== `worktree ${repo}`) {
				const target = line.slice("worktree ".length);
				try {
					git(repo, ["worktree", "remove", "--force", target]);
				} catch {
					/* best effort */
				}
			}
		}
	} catch {
		/* not a repo anymore */
	}
	fs.rmSync(repo, { recursive: true, force: true });
}

test("creates a worktree on a new branch from the base", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));

	const spec = createWorktree({ cwd: repo, name: "impl", branch: "issue-42", base: "main" });
	assert.equal(spec.path, path.join(fs.realpathSync(repo), ".pi", "worktrees", "issue-42"));
	assert.equal(spec.createdBranch, true);
	assert.equal(fs.existsSync(spec.path), true);
	assert.equal(git(spec.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "issue-42");
});

test("keeps the worktree root out of git status", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));
	createWorktree({ cwd: repo, name: "impl", branch: "issue-1", base: "main" });
	const status = git(repo, ["status", "--porcelain"]).trim();
	assert.equal(status, "");
});

test("reuses an existing branch without claiming it as created", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));
	git(repo, ["branch", "existing", "main"]);

	const spec = createWorktree({ cwd: repo, name: "impl", branch: "existing", base: "main" });
	assert.equal(spec.createdBranch, false);
	assert.equal(git(spec.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "existing");
	// A reused branch is never auto-removed.
	assert.equal(isUnchanged(spec), false);
});

test("an untouched worktree is unchanged; edits or commits are not", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));
	const spec = createWorktree({ cwd: repo, name: "impl", branch: "issue-7", base: "main" });

	assert.deepEqual(worktreeState(spec), { dirty: false, commits: 0 });
	assert.equal(isUnchanged(spec), true);

	fs.writeFileSync(path.join(spec.path, "note.txt"), "work in progress");
	assert.equal(isUnchanged(spec), false);
	assert.equal(worktreeState(spec).dirty, true);

	git(spec.path, ["add", "-A"]);
	git(spec.path, ["commit", "-m", "wip"]);
	assert.equal(isUnchanged(spec), false);
	assert.equal(worktreeState(spec).commits, 1);
});

test("removing a worktree deletes its branch", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));
	const spec = createWorktree({ cwd: repo, name: "impl", branch: "issue-9", base: "main" });

	removeWorktree(spec);
	assert.equal(fs.existsSync(spec.path), false);
	const branches = git(repo, ["branch", "--list", "issue-9"]).trim();
	assert.equal(branches, "");
});

test("two worktrees in parallel do not interfere", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));

	const a = createWorktree({ cwd: repo, name: "a", branch: "issue-a", base: "main" });
	const b = createWorktree({ cwd: repo, name: "b", branch: "issue-b", base: "main" });

	fs.writeFileSync(path.join(a.path, "from-a.txt"), "a");
	fs.writeFileSync(path.join(b.path, "from-b.txt"), "b");

	assert.equal(fs.existsSync(path.join(a.path, "from-b.txt")), false);
	assert.equal(fs.existsSync(path.join(b.path, "from-a.txt")), false);
	assert.equal(worktreeState(a).dirty, true);
	assert.equal(worktreeState(b).dirty, true);
});

test("fails clearly outside a repository or with a missing base", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nogit-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	assert.throws(() => createWorktree({ cwd: dir, name: "x" }), WorktreeError);

	const repo = makeRepo();
	t.after(() => cleanup(repo));
	assert.throws(() => createWorktree({ cwd: repo, name: "x", base: "no-such-base" }), WorktreeError);
});

function mergedWorktree(repo: string, name: string, branch: string): ReturnType<typeof createWorktree> {
	const spec = createWorktree({ cwd: repo, name, branch, base: "main" });
	fs.writeFileSync(path.join(spec.path, `${name}.txt`), name);
	git(spec.path, ["add", "-A"]);
	git(spec.path, ["commit", "-m", name]);
	git(repo, ["merge", "--no-ff", "-m", `merge ${name}`, branch]);
	return spec;
}

test("cleanup removes only merged, clean managed worktrees", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));

	const merged = mergedWorktree(repo, "merged", "issue-m");

	const unmerged = createWorktree({ cwd: repo, name: "unmerged", branch: "issue-u", base: "main" });
	fs.writeFileSync(path.join(unmerged.path, "u.txt"), "u");
	git(unmerged.path, ["add", "-A"]);
	git(unmerged.path, ["commit", "-m", "u"]);

	const dirty = createWorktree({ cwd: repo, name: "dirty", branch: "issue-d", base: "main" });
	fs.writeFileSync(path.join(dirty.path, "scratch.txt"), "scratch");

	const result = cleanupWorktrees({ cwd: repo, base: "main" });

	assert.deepEqual(result.removed.map((entry) => entry.branch), ["issue-m"]);
	assert.equal(fs.existsSync(merged.path), false);
	assert.equal(fs.existsSync(unmerged.path), true);
	assert.equal(fs.existsSync(dirty.path), true);
	assert.ok(result.kept.some((entry) => /not merged into main/.test(entry.reason)));
	assert.ok(result.kept.some((entry) => /uncommitted changes/.test(entry.reason)));
	assert.equal(git(repo, ["branch", "--list", "issue-m"]).trim(), "");
});

test("dryRun reports without removing", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));
	const merged = mergedWorktree(repo, "merged", "issue-dry");

	const result = cleanupWorktrees({ cwd: repo, base: "main", dryRun: true });
	assert.equal(result.dryRun, true);
	assert.deepEqual(result.removed.map((entry) => entry.branch), ["issue-dry"]);
	assert.equal(fs.existsSync(merged.path), true);
});

test("cleanup keeps a worktree an active run is using", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));
	const merged = mergedWorktree(repo, "merged", "issue-live");

	const result = cleanupWorktrees({ cwd: repo, base: "main", isActive: (path) => path === merged.path });
	assert.equal(result.removed.length, 0);
	assert.equal(fs.existsSync(merged.path), true);
	assert.ok(result.kept.some((entry) => /still running/.test(entry.reason)));
});

test("cleanup never touches the main checkout", (t) => {
	const repo = makeRepo();
	t.after(() => cleanup(repo));
	mergedWorktree(repo, "merged", "issue-main");
	const result = cleanupWorktrees({ cwd: repo, base: "main" });
	assert.ok(result.removed.every((entry) => entry.path.startsWith(path.join(repo, ".pi", "worktrees"))));
	assert.equal(fs.existsSync(repo), true);
	assert.equal(fs.existsSync(path.join(repo, ".git")), true);
});
