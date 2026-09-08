import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalPathHash,
  ensurePiSessionDirectory,
  makeStateIdentity,
  stateLayout,
} from "../src/state.mjs";

test("state identity is stable across branches but separates worktrees and engines", () => {
  const first = makeStateIdentity({
    engine: "pi",
    profile: "default",
    canonicalWorktree: "/repo/worktree",
    canonicalRepository: "/repo/.git",
  });
  const same = makeStateIdentity({
    engine: "pi",
    profile: "default",
    canonicalWorktree: "/repo/worktree",
    canonicalRepository: "/repo/.git",
  });
  assert.equal(first, same);
  assert.notEqual(
    first,
    makeStateIdentity({
      engine: "claude",
      canonicalWorktree: "/repo/worktree",
      canonicalRepository: "/repo/.git",
    }),
  );
  assert.notEqual(
    first,
    makeStateIdentity({
      engine: "pi",
      canonicalWorktree: "/repo/other",
      canonicalRepository: "/repo/.git",
    }),
  );
  assert.notEqual(
    first,
    makeStateIdentity({
      engine: "pi",
      profile: "review",
      canonicalWorktree: "/repo/worktree",
      canonicalRepository: "/repo/.git",
    }),
  );
});

test("repository scope can intentionally share linked worktree state", () => {
  const common = "/repo/.git";
  const one = makeStateIdentity({
    engine: "pi",
    scope: "repository",
    canonicalWorktree: "/repo/one",
    canonicalRepository: common,
  });
  const two = makeStateIdentity({
    engine: "pi",
    scope: "repository",
    canonicalWorktree: "/repo/two",
    canonicalRepository: common,
  });
  assert.equal(one, two);
  assert.equal(canonicalPathHash("/repo/one").length, 16);
});

test("rejects a symlinked Pi state parent before creating the root", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-docker-agent-state-parent-"),
  );
  const target = path.join(parent, "elsewhere");
  const dotPi = path.join(parent, ".pi");
  fs.mkdirSync(target);
  fs.symlinkSync(target, dotPi, "dir");
  const layout = stateLayout({
    engine: "pi",
    profile: "default",
    worktree: {
      canonicalWorktree: "/repo/worktree",
      gitCommonDir: "/repo/.git",
    },
    home: parent,
    piSessionRoot: path.join(dotPi, "agent", "sessions"),
  });
  assert.throws(
    () => ensurePiSessionDirectory(layout),
    /symlinked Pi sessions path component/,
  );
});

test("rejects a symlinked Pi sessions root", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-docker-agent-state-link-"),
  );
  const target = path.join(parent, "target");
  const link = path.join(parent, "sessions");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, "dir");
  const layout = stateLayout({
    engine: "pi",
    profile: "default",
    worktree: {
      canonicalWorktree: "/repo/worktree",
      gitCommonDir: "/repo/.git",
    },
    home: parent,
    piSessionRoot: link,
  });
  assert.throws(
    () => ensurePiSessionDirectory(layout),
    /symlinked Pi sessions root/,
  );
});

test("layout scopes Pi sessions and uses persistent named volume identities", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-docker-agent-state-"));
  const layout = stateLayout({
    engine: "pi",
    profile: "default",
    worktree: {
      canonicalWorktree: "/repo/worktree",
      gitCommonDir: "/repo/.git",
    },
    home,
  });
  ensurePiSessionDirectory(layout);
  assert.ok(fs.statSync(layout.piSessionDir).isDirectory());
  assert.match(layout.piVolume, /^pi-docker-agent-pi-/u);
  assert.match(layout.claudeVolume, /^pi-docker-agent-pi-/u);
});
