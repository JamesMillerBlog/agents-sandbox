import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  detectWorktree,
  gitEnvironment,
  gitMetadataMounts,
} from "../src/git-worktree.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

function repository() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agents-sandbox-git-"));
  const root = path.join(parent, "repo");
  fs.mkdirSync(root);
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "README.md"), "root\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "initial"]);
  return { parent, root };
}

test("detects a normal worktree and its common directory from a subdirectory", () => {
  const { root } = repository();
  const subdirectory = path.join(root, "src");
  fs.mkdirSync(subdirectory);
  const result = detectWorktree({ cwd: subdirectory });
  assert.equal(result.linked, false);
  assert.equal(result.root, fs.realpathSync(root));
  assert.equal(result.gitDir, result.gitCommonDir);
  assert.equal(gitMetadataMounts(result)[0].target, "/workspace/.git");
  assert.equal(gitEnvironment(result).GIT_WORK_TREE, "/workspace");
});

test("detects linked worktrees and preserves original common metadata path", () => {
  const { parent, root } = repository();
  const linked = path.join(parent, "linked");
  git(root, ["worktree", "add", "-q", "-b", "linked-test", linked, "HEAD"]);
  const result = detectWorktree({ cwd: linked });
  assert.equal(result.linked, true);
  assert.notEqual(result.gitDir, result.gitCommonDir);
  const mounts = gitMetadataMounts(result);
  assert.equal(mounts[0].source, result.gitCommonDir);
  assert.equal(mounts[0].target, result.gitCommonDir);
  assert.equal(mounts[1].target, "/workspace/.git");
  assert.equal(gitEnvironment(result).GIT_DIR, result.gitDir);
});

test("rejects a symlinked linked-worktree Git pointer", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "agents-sandbox-git-pointer-"),
  );
  const root = path.join(parent, "repo");
  const common = path.join(parent, "common.git");
  fs.mkdirSync(root);
  fs.mkdirSync(common);
  fs.symlinkSync(common, path.join(root, ".git"), "dir");
  const runGit = (_cwd, args) => {
    if (args.includes("--show-toplevel")) return root;
    return common;
  };
  assert.throws(
    () => detectWorktree({ cwd: root, runGit }),
    /symlinked Git pointer/,
  );
});

test("reports a clear error outside Git", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agents-sandbox-not-git-"),
  );
  assert.throws(
    () => detectWorktree({ cwd: directory }),
    /Git could not resolve|not a git repository/i,
  );
});
