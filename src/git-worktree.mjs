import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { SandboxError } from "./errors.mjs";

function defaultRunGit(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    throw new SandboxError(
      detail
        ? `Git could not resolve the active worktree: ${detail}`
        : "Git could not resolve the active worktree.",
      {
        code: error?.code === "ENOENT" ? "GIT_UNAVAILABLE" : "NOT_GIT_WORKTREE",
        cause: error,
      },
    );
  }
}

function canonicalExisting(value, base, label, fsImpl) {
  const candidate = path.isAbsolute(value) ? value : path.resolve(base, value);
  try {
    return fsImpl.realpathSync(candidate);
  } catch (error) {
    throw new SandboxError(`Git ${label} does not exist: ${candidate}`, {
      code: "GIT_METADATA_MISSING",
      cause: error,
    });
  }
}

/**
 * Resolve Git using Git itself rather than inspecting .git heuristically. This
 * works for normal repositories, linked worktrees, and repositories whose
 * metadata is stored outside the worktree.
 */
export function detectWorktree({
  cwd = process.cwd(),
  runGit = defaultRunGit,
  fsImpl = fs,
} = {}) {
  let requestedCwd;
  let worktreeRoot;
  try {
    requestedCwd = fsImpl.realpathSync(cwd);
  } catch (error) {
    throw new SandboxError(`Working directory does not exist: ${cwd}`, {
      code: "WORKTREE_MISSING",
      cause: error,
    });
  }
  const showTopLevel = runGit(requestedCwd, ["rev-parse", "--show-toplevel"]);
  worktreeRoot = canonicalExisting(
    showTopLevel,
    requestedCwd,
    "worktree root",
    fsImpl,
  );
  const gitDirRaw = runGit(requestedCwd, ["rev-parse", "--git-dir"]);
  const gitCommonDirRaw = runGit(requestedCwd, [
    "rev-parse",
    "--git-common-dir",
  ]);
  // Git emits relative --git-dir/--git-common-dir paths relative to the
  // directory from which rev-parse was run (not necessarily the repository
  // root), so resolve both against the original cwd.
  const gitDir = canonicalExisting(
    gitDirRaw,
    requestedCwd,
    "directory",
    fsImpl,
  );
  const gitCommonDir = canonicalExisting(
    gitCommonDirRaw,
    requestedCwd,
    "common directory",
    fsImpl,
  );
  const gitPointer = path.join(worktreeRoot, ".git");
  let linked = gitDir !== gitCommonDir;
  try {
    const pointerStat = fsImpl.lstatSync
      ? fsImpl.lstatSync(gitPointer)
      : fsImpl.statSync(gitPointer);
    if (pointerStat.isSymbolicLink?.()) {
      throw new SandboxError(`Refusing symlinked Git pointer: ${gitPointer}`, {
        code: "GIT_METADATA_DANGEROUS",
      });
    }
    linked = linked || pointerStat.isFile();
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    // A repository can use an unusual metadata layout; the rev-parse result is
    // still authoritative.
  }
  return {
    requestedCwd,
    root: worktreeRoot,
    canonicalWorktree: worktreeRoot,
    gitDir,
    gitCommonDir,
    commonDir: gitCommonDir,
    gitPointer: linked ? gitPointer : null,
    linked,
  };
}

export function gitMetadataMounts(
  worktree,
  { workspaceTarget = "/workspace", mode = "ro", fsImpl = fs } = {},
) {
  if (!worktree || typeof worktree !== "object") {
    throw new TypeError("gitMetadataMounts requires a worktree.");
  }
  if (mode !== "ro" && mode !== "rw")
    throw new TypeError(`Unsupported Git mount mode: ${mode}`);
  const mounts = [];
  if (worktree.linked) {
    // The linked .git file contains the host absolute gitdir path. Keeping the
    // common directory at that same path makes the pointer valid in Docker.
    mounts.push({
      type: "bind",
      source: worktree.gitCommonDir,
      target: worktree.gitCommonDir,
      mode,
      purpose: "git-common-directory",
    });
    if (worktree.gitPointer) {
      let pointerStat;
      try {
        pointerStat = fsImpl.lstatSync
          ? fsImpl.lstatSync(worktree.gitPointer)
          : fsImpl.statSync(worktree.gitPointer);
      } catch (error) {
        throw new SandboxError(
          `Git pointer does not exist: ${worktree.gitPointer}`,
          {
            code: "GIT_METADATA_MISSING",
            cause: error,
          },
        );
      }
      if (pointerStat.isSymbolicLink?.()) {
        throw new SandboxError(
          `Refusing symlinked Git pointer: ${worktree.gitPointer}`,
          {
            code: "GIT_METADATA_DANGEROUS",
          },
        );
      }
      if (!pointerStat.isFile()) {
        throw new SandboxError(
          `Git pointer is not a regular file: ${worktree.gitPointer}`,
          {
            code: "GIT_METADATA_DANGEROUS",
          },
        );
      }
      mounts.push({
        type: "bind",
        source: worktree.gitPointer,
        target: path.posix.join(workspaceTarget, ".git"),
        mode,
        purpose: "linked-git-pointer",
      });
    }
  } else {
    mounts.push({
      type: "bind",
      source: worktree.gitDir,
      target: path.posix.join(workspaceTarget, ".git"),
      mode,
      purpose: "git-directory",
    });
  }
  return mounts;
}

export function gitEnvironment(
  worktree,
  { workspaceTarget = "/workspace" } = {},
) {
  return {
    GIT_DIR: worktree.linked
      ? worktree.gitDir
      : path.posix.join(workspaceTarget, ".git"),
    GIT_COMMON_DIR: worktree.linked
      ? worktree.gitCommonDir
      : path.posix.join(workspaceTarget, ".git"),
    GIT_WORK_TREE: workspaceTarget,
  };
}
