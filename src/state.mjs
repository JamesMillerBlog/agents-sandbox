import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxError } from "./errors.mjs";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safePart(value) {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return normalized || "default";
}

export function canonicalPathHash(canonicalPath) {
  return digest(String(canonicalPath));
}

/**
 * State deliberately excludes branch names: changing branches in one
 * worktree should continue the same agent sessions. The canonical worktree
 * and repository paths keep separate worktrees and repositories isolated.
 */
export function makeStateIdentity({
  engine,
  profile = "default",
  canonicalWorktree,
  canonicalRepository = canonicalWorktree,
  scope = "worktree",
}) {
  if (!engine || !canonicalWorktree)
    throw new TypeError("engine and canonicalWorktree are required.");
  if (!["worktree", "repository"].includes(scope))
    throw new TypeError(`Unsupported state scope: ${scope}`);
  const identityPath =
    scope === "repository" ? canonicalRepository : canonicalWorktree;
  const identity = `${scope}\0${identityPath}\0${canonicalRepository}\0${profile}`;
  return `${safePart(engine)}-${safePart(profile)}-${digest(identity)}`;
}

export function stateLayout({
  engine,
  profile = "default",
  worktree,
  scope = "worktree",
  home = os.homedir(),
  piSessionRoot = undefined,
}) {
  const canonicalWorktree =
    typeof worktree === "string" ? worktree : worktree.canonicalWorktree;
  const canonicalRepository =
    typeof worktree === "string"
      ? worktree
      : (worktree.gitCommonDir ?? worktree.commonDir ?? canonicalWorktree);
  const id = makeStateIdentity({
    engine,
    profile,
    canonicalWorktree,
    canonicalRepository,
    scope,
  });
  const sessionHome = path.resolve(home);
  const sessionRoot = path.resolve(
    piSessionRoot ?? path.join(sessionHome, ".pi", "agent", "sessions"),
  );
  if (!isStrictlyUnder(sessionRoot, sessionHome)) {
    throw new SandboxError(
      `Refusing Pi sessions root outside the host home: ${sessionRoot}`,
      { code: "STATE_DANGEROUS" },
    );
  }
  return {
    id,
    engine,
    profile,
    scope,
    canonicalWorktree,
    canonicalRepository,
    piSessionHome: sessionHome,
    piSessionRoot: sessionRoot,
    piSessionDir: path.join(sessionRoot, id),
    piVolume: `agents-sandbox-${id}`,
    claudeVolume: `agents-sandbox-${id}`,
  };
}

function isStrictlyUnder(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function rejectSessionSymlinkComponents(layout, fsImpl) {
  const home = path.resolve(layout.piSessionHome);
  const root = path.resolve(layout.piSessionRoot);
  if (!isStrictlyUnder(root, home)) {
    throw new SandboxError(
      `Refusing Pi sessions root outside the host home: ${root}`,
      { code: "STATE_DANGEROUS" },
    );
  }
  let current = home;
  for (const segment of path.relative(home, root).split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink?.()) {
      throw new SandboxError(
        `Refusing symlinked Pi sessions path component: ${current}`,
        { code: "STATE_DANGEROUS" },
      );
    }
  }
}

function assertPiSessionRoot(layout, fsImpl) {
  let stat;
  try {
    stat = fsImpl.lstatSync(layout.piSessionRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      rejectSessionSymlinkComponents(layout, fsImpl);
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink?.()) {
    throw new SandboxError(
      `Refusing symlinked Pi sessions root: ${layout.piSessionRoot}`,
      { code: "STATE_DANGEROUS" },
    );
  }
  if (!stat.isDirectory()) {
    throw new SandboxError(
      `Pi sessions root is not a directory: ${layout.piSessionRoot}`,
      { code: "STATE_DANGEROUS" },
    );
  }
  rejectSessionSymlinkComponents(layout, fsImpl);
  let canonicalHome;
  let canonicalRoot;
  try {
    canonicalHome = fsImpl.realpathSync(layout.piSessionHome);
    canonicalRoot = fsImpl.realpathSync(layout.piSessionRoot);
  } catch (error) {
    throw new SandboxError("Unable to verify the Pi sessions root.", {
      code: "STATE_SCAN_FAILED",
      cause: error,
    });
  }
  if (!isStrictlyUnder(canonicalRoot, canonicalHome)) {
    throw new SandboxError(
      `Refusing Pi sessions root outside the host home: ${canonicalRoot}`,
      { code: "STATE_DANGEROUS" },
    );
  }
}

export function validatePiSessionRoot(layout, { fsImpl = fs } = {}) {
  if (!layout.piSessionHome) {
    throw new SandboxError("Pi state is missing its trusted host home.", {
      code: "STATE_INVALID",
    });
  }
  assertPiSessionRoot(layout, fsImpl);
  return layout.piSessionRoot;
}

export function ensurePiSessionDirectory(layout, { fsImpl = fs } = {}) {
  validatePiSessionRoot(layout, { fsImpl });
  fsImpl.mkdirSync(layout.piSessionDir, { recursive: true, mode: 0o700 });
  assertPiSessionRoot(layout, fsImpl);
  try {
    fsImpl.chmodSync(layout.piSessionDir, 0o700);
  } catch {
    // Some mounted filesystems do not support chmod; Docker will still report
    // a useful bind-mount error if permissions are unusable.
  }
  return layout.piSessionDir;
}

export function stateSummary(layout) {
  return {
    id: layout.id,
    profile: layout.profile,
    scope: layout.scope,
    piSessionDir: layout.piSessionDir,
    piVolume: layout.piVolume,
    claudeVolume: layout.claudeVolume,
  };
}
