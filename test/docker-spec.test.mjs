import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { buildDockerSpec, hostUser } from "../src/docker-spec.mjs";
import { detectWorktree } from "../src/git-worktree.mjs";
import { stateLayout } from "../src/state.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-sandbox-spec-"));
  execFileSync("git", ["init", "-q", root]);
  const worktree = detectWorktree({ cwd: root });
  const state = stateLayout({
    engine: "pi",
    profile: "test",
    worktree,
    home: root,
  });
  return { root, worktree, state };
}

function linkedFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agents-sandbox-linked-"),
  );
  const common = path.join(root, "common.git");
  const linkedGitDir = path.join(common, "worktrees", "feature");
  const gitPointer = path.join(root, ".git");
  const extra = path.join(root, "extra");
  fs.mkdirSync(linkedGitDir, { recursive: true });
  fs.mkdirSync(extra);
  fs.writeFileSync(gitPointer, `gitdir: ${linkedGitDir}\n`);
  const worktree = {
    canonicalWorktree: root,
    gitDir: linkedGitDir,
    gitCommonDir: common,
    commonDir: common,
    gitPointer,
    linked: true,
  };
  const state = stateLayout({
    engine: "pi",
    profile: "test",
    worktree,
    home: root,
  });
  return { root, common, extra, worktree, state };
}

test("builds secure Docker argv and preserves agent argument order", () => {
  const { worktree, state } = fixture();
  const argv = buildDockerSpec({
    tool: "pi",
    agentArgs: [
      "--resume",
      "--session",
      "abc",
      "--session-id",
      "def",
      "--continue",
    ],
    worktree,
    state,
    hostEnv: {
      PATH: "/host/path",
      HOME: "/host/home",
      DOCKER_HOST: "unix:///bad",
      GH_TOKEN: "token",
    },
    uid: 501,
    gid: 20,
    tty: false,
    home: os.homedir(),
  });
  assert.ok(argv.argv.includes("--read-only"));
  assert.ok(argv.argv.includes("--pull=never"));
  assert.ok(argv.argv.includes("--cap-drop=ALL"));
  assert.ok(argv.argv.includes("--security-opt=no-new-privileges"));
  assert.ok(argv.argv.includes("--network") && argv.argv.includes("bridge"));
  assert.ok(argv.argv.includes("--user") && argv.argv.includes("501:20"));
  assert.ok(
    argv.argv.some((entry) =>
      entry.includes(`source=${worktree.canonicalWorktree},target=/workspace`),
    ),
  );
  assert.ok(
    argv.argv.some(
      (entry) =>
        entry.includes("target=/workspace/.git") && entry.includes("readonly"),
    ),
  );
  assert.equal(argv.environment.HOME, "/home/sandbox");
  assert.equal(
    argv.environment.PATH,
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  );
  assert.equal(argv.environment.DOCKER_HOST, undefined);
  assert.equal(argv.environment.GH_TOKEN, "token");
  assert.ok(argv.argv.includes("GH_TOKEN"));
  assert.ok(!argv.argv.some((entry) => entry.includes("GH_TOKEN=token")));
  assert.equal(argv.environment.OPENAI_API_KEY, undefined);
  const imageIndex = argv.argv.indexOf(argv.image);
  const pullIndex = argv.argv.indexOf("--pull=never");
  assert.ok(pullIndex >= 0 && pullIndex < imageIndex);
  assert.deepEqual(argv.argv.slice(imageIndex + 1), [
    "--resume",
    "--session",
    "abc",
    "--session-id",
    "def",
    "--continue",
  ]);
});

test("keeps engine-specific credentials isolated", () => {
  const { worktree, state } = fixture();
  const claude = buildDockerSpec({
    tool: "claude",
    worktree,
    state,
    hostEnv: {
      ANTHROPIC_API_KEY: "anthropic",
      OPENAI_API_KEY: "openai",
      AWS_SECRET_ACCESS_KEY: "aws",
    },
    tty: false,
  });
  assert.equal(claude.environment.ANTHROPIC_API_KEY, "anthropic");
  assert.equal(claude.environment.AWS_SECRET_ACCESS_KEY, "aws");
  assert.equal(claude.environment.OPENAI_API_KEY, undefined);

  const pi = buildDockerSpec({
    tool: "pi",
    worktree,
    state,
    hostEnv: {
      ANTHROPIC_API_KEY: "anthropic",
      OPENAI_API_KEY: "openai",
      AWS_SECRET_ACCESS_KEY: "aws",
    },
    tty: false,
  });
  assert.equal(pi.environment.OPENAI_API_KEY, "openai");
  assert.equal(pi.environment.AWS_SECRET_ACCESS_KEY, undefined);
});

test("supports offline mode and rejects host networking", () => {
  const { worktree, state } = fixture();
  assert.equal(
    buildDockerSpec({
      tool: "claude",
      worktree,
      state,
      network: "none",
      tty: false,
    }).network,
    "none",
  );
  assert.throws(
    () => buildDockerSpec({ tool: "claude", worktree, state, network: "host" }),
    /host is never permitted/,
  );
});

test("never accepts a uid spelling that Docker would interpret as root", () => {
  assert.throws(() => hostUser({ uid: "00", gid: "20" }), /root/);
  assert.equal(hostUser({ uid: "1000", gid: "000" }), "1000:000");
});

test("Git metadata becomes writable only with the explicit option", () => {
  const { worktree, state } = fixture();
  const readOnly = buildDockerSpec({
    tool: "pi",
    worktree,
    state,
    gitWrite: false,
    tty: false,
  });
  const writable = buildDockerSpec({
    tool: "pi",
    worktree,
    state,
    config: { security: { git_write: true } },
    hostEnv: { AGENT_SANDBOX_GIT_WRITE: "1" },
    gitWrite: true,
    tty: false,
  });
  assert.ok(
    readOnly.argv.some((value) =>
      value.includes("target=/workspace/.git,readonly"),
    ),
  );
  assert.ok(
    writable.argv.some(
      (value) =>
        value.includes("target=/workspace/.git") &&
        !value.endsWith(",readonly"),
    ),
  );
  assert.equal(writable.environment.AGENT_SANDBOX_GIT_WRITE, "1");
  const envOptIn = buildDockerSpec({
    tool: "pi",
    worktree,
    state,
    config: { security: { git_write: true } },
    hostEnv: { AGENT_SANDBOX_GIT_WRITE: "1" },
    tty: false,
  });
  assert.ok(
    envOptIn.argv.some(
      (value) =>
        value.includes("target=/workspace/.git") &&
        !value.endsWith(",readonly"),
    ),
  );
  assert.throws(
    () =>
      buildDockerSpec({
        tool: "pi",
        worktree,
        state,
        config: { security: { git_write: true } },
        gitWrite: true,
        tty: false,
      }),
    /security.git_write=true/,
  );
});

test("rejects worktrees rooted at home, its parent, or the filesystem root", () => {
  const { root, worktree, state } = fixture();
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  for (const source of [home, path.dirname(home), path.parse(home).root]) {
    assert.throws(
      () =>
        buildDockerSpec({
          tool: "pi",
          worktree: { ...worktree, canonicalWorktree: source },
          state,
          home,
          hostEnv: { HOME: home },
          tty: false,
        }),
      /unsafe active worktree source|home ancestor/,
    );
  }
});

test("rejects Unix sockets nested in the active worktree", async () => {
  if (process.platform === "win32") return;
  const { root, worktree, state } = fixture();
  const socket = path.join(root, "agent.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  try {
    assert.throws(
      () =>
        buildDockerSpec({
          tool: "pi",
          worktree,
          state,
          home: path.dirname(root),
          hostEnv: { HOME: path.dirname(root) },
          tty: false,
        }),
      /Unix socket/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socket, { force: true });
  }
});

test("rejects a symlinked Pi sessions bind root", () => {
  const { worktree, state } = fixture();
  const parent = state.piSessionHome;
  const target = path.join(parent, "session-target");
  const link = path.join(parent, "session-link");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, "dir");
  const linkedState = {
    ...state,
    piSessionRoot: link,
    piSessionDir: path.join(link, state.id),
  };
  assert.throws(
    () =>
      buildDockerSpec({
        tool: "pi",
        worktree,
        state: linkedState,
        tty: false,
      }),
    /symlinked Pi sessions root/,
  );
});

test("allows an ordinary worktree below the host home", () => {
  const { root, worktree, state } = fixture();
  const home = path.dirname(root);
  assert.doesNotThrow(() =>
    buildDockerSpec({
      tool: "pi",
      worktree,
      state,
      home,
      hostEnv: { HOME: home },
      tty: false,
    }),
  );
});

test("rejects unsafe implicit Git metadata sources", () => {
  const { worktree, state } = fixture();
  const linked = (common) => ({
    ...worktree,
    linked: true,
    gitCommonDir: common,
    commonDir: common,
    gitDir: path.join(common, "worktrees", "feature"),
    gitPointer: null,
  });
  for (const common of [os.homedir(), "/var"]) {
    if (common === "/var" && !fs.existsSync(common)) continue;
    assert.throws(
      () =>
        buildDockerSpec({
          tool: "pi",
          worktree: linked(common),
          state,
          home: os.homedir(),
          hostEnv: { HOME: os.homedir() },
          tty: false,
        }),
      /dangerous|host-home ancestor|protected runtime/,
    );
  }
});

test("allows safe Git metadata beneath an ordinary repository", () => {
  const { root, worktree, state } = fixture();
  const common = path.join(root, "safe-common");
  fs.mkdirSync(path.join(common, "worktrees", "feature"), {
    recursive: true,
  });
  const linked = {
    ...worktree,
    linked: true,
    gitCommonDir: common,
    commonDir: common,
    gitDir: path.join(common, "worktrees", "feature"),
    gitPointer: null,
  };
  assert.doesNotThrow(() =>
    buildDockerSpec({
      tool: "pi",
      worktree: linked,
      state,
      home: path.dirname(root),
      hostEnv: { HOME: path.dirname(root) },
      tty: false,
    }),
  );
});

test("rejects writable mounts of Git metadata sources", () => {
  const { worktree, state } = fixture();
  for (const source of [worktree.gitDir, worktree.canonicalWorktree]) {
    assert.throws(
      () =>
        buildDockerSpec({
          tool: "pi",
          worktree,
          state,
          configMounts: [{ source, target: "/mnt/git", mode: "rw" }],
          tty: false,
        }),
      /overlaps Git metadata/,
    );
  }
});

test("rejects symlinked linked-worktree pointer mounts", () => {
  const { common, worktree, state } = linkedFixture();
  fs.unlinkSync(worktree.gitPointer);
  fs.symlinkSync(common, worktree.gitPointer, "dir");
  assert.throws(
    () =>
      buildDockerSpec({
        tool: "pi",
        worktree,
        state,
        tty: false,
      }),
    /symlinked Git pointer/,
  );
});

test("linked worktree metadata cannot be overlaid by an extra mount", () => {
  const { common, extra, worktree, state } = linkedFixture();
  assert.throws(
    () =>
      buildDockerSpec({
        tool: "pi",
        worktree,
        state,
        configMounts: [
          {
            source: extra,
            target: path.join(common, "worktrees", "feature"),
            mode: "rw",
          },
        ],
        tty: false,
      }),
    /protected target/,
  );
});

test("explicit safe configuration mount is included and defaults to read-only", () => {
  const { root, worktree, state } = fixture();
  const settings = path.join(root, "settings.json");
  fs.writeFileSync(settings, "{}");
  const spec = buildDockerSpec({
    tool: "pi",
    worktree,
    state,
    configMounts: [
      { source: settings, target: "/home/sandbox/.pi/agent/settings.json" },
    ],
    home: os.homedir(),
    tty: false,
  });
  assert.ok(
    spec.argv.some((value) =>
      value.includes(
        `source=${fs.realpathSync(settings)},target=/home/sandbox/.pi/agent/settings.json,readonly`,
      ),
    ),
  );
});
