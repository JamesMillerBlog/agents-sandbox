import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrReporter } from "../src/herdr.mjs";

const context = {
  tool: "pi",
  worktree: { canonicalWorktree: "/work/agents-sandbox" },
  state: { id: "pi-default-1234567890abcdef" },
};

test("Herdr integration is disabled by default", () => {
  assert.equal(
    createHerdrReporter({
      ...context,
      env: { HERDR_PANE_ID: "1-1" },
    }),
    null,
  );
});

test("opt-in Herdr reporter uses fixed host-side commands", () => {
  const calls = [];
  const reporter = createHerdrReporter({
    ...context,
    env: {
      AGENT_SANDBOX_HERDR: "1",
      HERDR_PANE_ID: "1-1",
      HERDR_SOCKET_PATH: "/private/herdr.sock",
    },
    execFileSyncImpl: (file, args, options) => {
      calls.push({ file, args, options });
    },
  });

  assert.equal(reporter.enabled, true);
  reporter.start(() => {});
  reporter.finish(0, () => {});

  assert.deepEqual(
    calls.map(({ file, args }) => ({ file, args })),
    [
      {
        file: "herdr",
        args: [
          "pane",
          "report-metadata",
          "1-1",
          "--source",
          "agents-sandbox:pi:pi-default-1234567890abcdef",
          "--display-agent",
          "Agents Sandbox · pi · agents-sandbox",
        ],
      },
      {
        file: "herdr",
        args: [
          "pane",
          "report-agent",
          "1-1",
          "--source",
          "agents-sandbox:pi:pi-default-1234567890abcdef",
          "--agent",
          "Agents Sandbox · pi · agents-sandbox",
          "--state",
          "working",
          "--agent-session-id",
          "pi-default-1234567890abcdef",
        ],
      },
      {
        file: "herdr",
        args: [
          "pane",
          "report-agent",
          "1-1",
          "--source",
          "agents-sandbox:pi:pi-default-1234567890abcdef",
          "--agent",
          "Agents Sandbox · pi · agents-sandbox",
          "--state",
          "idle",
          "--agent-session-id",
          "pi-default-1234567890abcdef",
          "--message",
          "Docker sandbox finished",
        ],
      },
    ],
  );
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.timeout, 1500);
  assert.equal(calls[0].options.env.HERDR_SOCKET_PATH, "/private/herdr.sock");
});

test("invalid pane identifier disables integration without throwing", () => {
  const warnings = [];
  const reporter = createHerdrReporter({
    ...context,
    env: { AGENT_SANDBOX_HERDR: "1", HERDR_PANE_ID: "pane id" },
    execFileSyncImpl: () => {
      throw new Error("must not run");
    },
  });

  assert.equal(reporter.enabled, false);
  reporter.start((message) => warnings.push(message));
  reporter.finish(1, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HERDR_PANE_ID/);
});

test("missing pane identifier keeps sandbox usable", () => {
  const warnings = [];
  const reporter = createHerdrReporter({
    ...context,
    env: { AGENT_SANDBOX_HERDR: "1" },
  });

  reporter.start((message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /required/);
});

test("Herdr command failure becomes a warning and does not affect run", () => {
  const calls = [];
  const warnings = [];
  const reporter = createHerdrReporter({
    ...context,
    env: { AGENT_SANDBOX_HERDR: "1", HERDR_PANE_ID: "1-1" },
    execFileSyncImpl: (...args) => {
      calls.push(args);
      throw new Error("herdr unavailable");
    },
  });

  reporter.start((message) => warnings.push(message));
  reporter.finish(1, (message) => warnings.push(message));
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /continuing/);
});

test("nonzero or exceptional completion reports unknown state", () => {
  const calls = [];
  const reporter = createHerdrReporter({
    ...context,
    env: { AGENT_SANDBOX_HERDR: "1", HERDR_PANE_ID: "1-1" },
    execFileSyncImpl: (file, args) => calls.push({ file, args }),
  });

  reporter.finish(7, () => {});
  reporter.finish(undefined, () => {});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.at(-5), "unknown");
  assert.deepEqual(calls[0].args.slice(-2), [
    "--message",
    "Docker sandbox exited with code 7",
  ]);
  assert.deepEqual(calls[1].args.slice(-2), [
    "--message",
    "Docker sandbox exited with code unknown",
  ]);
});
