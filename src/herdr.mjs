import { execFileSync as nodeExecFileSync } from "node:child_process";
import path from "node:path";

const HERDR_COMMAND = "herdr";
const HERDR_OPT_IN = "AGENT_SANDBOX_HERDR";
const HERDR_PANE_ID = "HERDR_PANE_ID";
const HERDR_TIMEOUT_MS = 1500;

function hostEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment ?? process.env).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function validPaneId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/\s/u.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

function warning(output, message) {
  output?.(`warning: Herdr integration unavailable; ${message}`);
}

function displayName(tool, worktree) {
  const directory = path.basename(
    worktree?.canonicalWorktree ?? worktree?.root ?? "worktree",
  );
  return `Agents Sandbox · ${tool} · ${directory}`;
}

function reportAgentArgs({
  paneId,
  source,
  agent,
  state,
  sessionId,
  message = undefined,
}) {
  const args = [
    "pane",
    "report-agent",
    paneId,
    "--source",
    source,
    "--agent",
    agent,
    "--state",
    state,
    "--agent-session-id",
    sessionId,
  ];
  if (message) args.push("--message", message);
  return args;
}

/**
 * Create an optional host-side Herdr reporter. It never enters the Docker
 * container and never mounts or forwards the Herdr socket.
 *
 * @param {object} options
 * @param {string} options.tool
 * @param {object} options.worktree
 * @param {object} options.state
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(file: string, args?: string[], options?: object) => unknown} [options.execFileSyncImpl]
 */
export function createHerdrReporter({
  tool,
  worktree,
  state,
  env = process.env,
  execFileSyncImpl = nodeExecFileSync,
}) {
  if (env?.[HERDR_OPT_IN] !== "1") return null;

  const paneId = env?.[HERDR_PANE_ID];
  if (!validPaneId(paneId)) {
    return {
      enabled: false,
      start(output = console.error) {
        warning(
          output,
          `${HERDR_PANE_ID} is required and must be a non-empty pane identifier`,
        );
      },
      finish() {},
    };
  }

  const source = `agents-sandbox:${tool}:${state.id}`;
  const agent = displayName(tool, worktree);
  const hostEnv = hostEnvironment(env);
  let available = true;
  let warned = false;

  function invoke(args, output) {
    if (!available) return false;
    try {
      execFileSyncImpl(HERDR_COMMAND, args, {
        env: hostEnv,
        shell: false,
        stdio: "ignore",
        timeout: HERDR_TIMEOUT_MS,
      });
      return true;
    } catch {
      available = false;
      if (!warned) {
        warned = true;
        warning(
          output,
          "the host `herdr` command is unavailable or rejected the report; continuing without Herdr",
        );
      }
      return false;
    }
  }

  return {
    enabled: true,
    start(output = console.error) {
      invoke(
        [
          "pane",
          "report-metadata",
          paneId,
          "--source",
          source,
          "--display-agent",
          agent,
        ],
        output,
      );
      invoke(
        reportAgentArgs({
          paneId,
          source,
          agent,
          state: "working",
          sessionId: state.id,
        }),
        output,
      );
    },
    /** @param {number | undefined} exitCode */
    finish(exitCode, output = console.error) {
      const status = exitCode === 0 ? "idle" : "unknown";
      const message =
        exitCode === 0
          ? "Docker sandbox finished"
          : `Docker sandbox exited with code ${String(exitCode ?? "unknown")}`;
      invoke(
        reportAgentArgs({
          paneId,
          source,
          agent,
          state: status,
          sessionId: state.id,
          message,
        }),
        output,
      );
    },
  };
}

export const herdrEnvironmentNames = Object.freeze({
  optIn: HERDR_OPT_IN,
  paneId: HERDR_PANE_ID,
});
