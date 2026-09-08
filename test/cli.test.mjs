import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { main, parseCli } from "../src/cli.mjs";
import { DockerUnavailableError } from "../src/errors.mjs";
import { detectWorktree } from "../src/git-worktree.mjs";
import { stateLayout } from "../src/state.mjs";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-docker-agent-cli-"));
  execFileSync("git", ["init", "-q", root]);
  return root;
}

test("parses direct commands and preserves all agent arguments", () => {
  assert.deepEqual(parseCli(["pi", "--", "--resume", "--session-id", "s"]), {
    help: false,
    tool: "pi",
    agentArgs: ["--resume", "--session-id", "s"],
    profile: null,
    configPath: null,
    separator: true,
  });
  assert.deepEqual(parseCli(["pi", "--resume", "--session", "s"]).agentArgs, [
    "--resume",
    "--session",
    "s",
  ]);
  assert.deepEqual(parseCli(["claude", "--resume"]).agentArgs, ["--resume"]);
});

test("main forwards resume/session flags to an injected Docker runner", async () => {
  const cwd = repo();
  const calls = [];
  const errors = [];
  const code = await main(
    [
      "pi",
      "--",
      "--resume",
      "--continue",
      "--session",
      "abc",
      "--session-id",
      "xyz",
    ],
    {
      cwd,
      home: path.dirname(cwd),
      env: {
        ...process.env,
        PATH: "/host",
        DOCKER_HOST: "should-not-enter-container",
      },
      runDocker: async (argv) => {
        calls.push(argv);
        return 0;
      },
      errorOutput: (line) => errors.push(line),
    },
  );
  assert.equal(code, 0);
  const argv = calls[0];
  const imageIndex = argv.findIndex((entry) =>
    entry.startsWith("pi-docker-agent:"),
  );
  assert.deepEqual(argv.slice(imageIndex + 1), [
    "--resume",
    "--continue",
    "--session",
    "abc",
    "--session-id",
    "xyz",
  ]);
  assert.ok(errors.some((line) => line.startsWith("Mounts (pi")));
});

test("main forwards direct Claude resume without a separator", async () => {
  const cwd = repo();
  const calls = [];
  const code = await main(["claude", "--resume"], {
    cwd,
    home: path.dirname(cwd),
    runDocker: async (argv) => {
      calls.push(argv);
      return 0;
    },
    errorOutput: () => {},
  });
  assert.equal(code, 0);
  const imageIndex = calls[0].findIndex((entry) =>
    entry.startsWith("pi-docker-agent:"),
  );
  assert.deepEqual(calls[0].slice(imageIndex + 1), ["--resume"]);
});

test("Git writes require both config policy and environment opt-in", async () => {
  const envOnly = await main(["pi", "--", "--help"], {
    cwd: repo(),
    env: { ...process.env, AGENT_SANDBOX_GIT_WRITE: "1" },
    runDocker: async () => 0,
    errorOutput: () => {},
  });
  assert.equal(envOnly, 1);

  const cwd = repo();
  fs.writeFileSync(
    path.join(cwd, ".agent-sandbox.toml"),
    "[security]\ngit_write = true\n",
  );
  const noOptIn = await main(["pi", "--", "--help"], {
    cwd,
    home: path.dirname(cwd),
    env: { ...process.env, AGENT_SANDBOX_GIT_WRITE: undefined },
    runDocker: async () => 0,
    errorOutput: () => {},
  });
  assert.equal(noOptIn, 1);
  let spec;
  const optIn = await main(["pi", "--", "--help"], {
    cwd,
    home: path.dirname(cwd),
    env: { ...process.env, AGENT_SANDBOX_GIT_WRITE: "1" },
    runDocker: async (argv) => {
      spec = argv;
      return 0;
    },
    errorOutput: () => {},
  });
  assert.equal(optIn, 0);
  assert.ok(
    spec.includes("--env") && spec.includes("AGENT_SANDBOX_GIT_WRITE=1"),
  );
});

test("main returns a clear failure when Docker is unavailable", async () => {
  const cwd = repo();
  const output = [];
  const code = await main(["claude", "--", "--help"], {
    cwd,
    home: path.dirname(cwd),
    runDocker: async () => {
      throw new DockerUnavailableError();
    },
    errorOutput: (line) => output.push(line),
  });
  assert.equal(code, 1);
  assert.ok(output.some((line) => /Docker is unavailable/.test(line)));
});

test("repo-local config is found from a nested worktree directory", async () => {
  const root = repo();
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  fs.writeFileSync(
    path.join(root, ".agent-sandbox.toml"),
    '[security]\nnetwork = "none"\n',
  );
  let argv;
  const code = await main(["pi", "--", "--help"], {
    cwd: nested,
    home: path.dirname(root),
    runDocker: async (dockerArgv) => {
      argv = dockerArgv;
      return 0;
    },
    errorOutput: () => {},
  });
  assert.equal(code, 0);
  const networkIndex = argv.indexOf("--network");
  assert.equal(argv[networkIndex + 1], "none");
});

test("state layout used by main is worktree scoped", () => {
  const cwd = repo();
  const worktree = detectWorktree({ cwd });
  const one = stateLayout({
    engine: "pi",
    profile: "default",
    worktree,
    home: path.dirname(cwd),
  });
  const two = stateLayout({
    engine: "pi",
    profile: "default",
    worktree,
    home: path.dirname(cwd),
  });
  assert.equal(one.id, two.id);
});
