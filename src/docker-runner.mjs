import { spawn as nodeSpawn } from "node:child_process";
import {
  DockerDaemonUnavailableError,
  DockerUnavailableError,
  SandboxError,
} from "./errors.mjs";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
const DAEMON_OVERRIDE_VARIABLES = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
];

export function sanitizeDockerEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const name of DAEMON_OVERRIDE_VARIABLES) delete sanitized[name];
  return sanitized;
}

function signalExitCode(signal) {
  const values = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 };
  return 128 + (values[signal] ?? 1);
}

function diagnosticText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Confirm both the Docker CLI and its daemon are usable before a run.
 * @param {any} [options]
 */
export function checkDocker(options = {}) {
  const {
    spawnImpl = nodeSpawn,
    env = process.env,
    cwd,
    timeoutMs = 5000,
  } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl("docker", ["info", "--format", "{{.ServerVersion}}"], {
        cwd,
        env: sanitizeDockerEnvironment(env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        reject(new DockerUnavailableError(error));
      else
        reject(
          new SandboxError(`Unable to start Docker: ${errorMessage(error)}`, {
            code: "DOCKER_START",
            cause: error,
          }),
        );
      return;
    }

    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill?.("SIGTERM");
      } catch {
        // The check process may have exited between the timeout and kill.
      }
      finish(() =>
        reject(new DockerDaemonUnavailableError("Docker info timed out")),
      );
    }, timeoutMs);
    timer.unref?.();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stderr?.on?.("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once?.("error", (error) =>
      finish(() => {
        if (errorCode(error) === "ENOENT")
          reject(new DockerUnavailableError(error));
        else
          reject(
            new SandboxError(
              `Docker health check failed: ${errorMessage(error)}`,
              { code: "DOCKER_START", cause: error },
            ),
          );
      }),
    );
    const onExit = (code, signal) =>
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail =
          diagnosticText(stderr) ||
          (signal ? `process terminated by ${signal}` : `exit code ${code}`);
        reject(new DockerDaemonUnavailableError(detail));
      });
    child.once?.("exit", onExit);
    child.once?.("close", onExit);
  });
}

/**
 * Run Docker without a shell. The inherited stdio keeps interactive agents
 * usable, while forwarding termination signals preserves Ctrl-C behaviour.
 * @param {string[]} args
 * @param {any} [options]
 */
export async function runDocker(args, options = {}) {
  const {
    spawnImpl = nodeSpawn,
    checkDockerImpl = checkDocker,
    dockerPreflight = true,
    env = process.env,
    cwd,
    stdio = "inherit",
    signalSource = process,
    forwardSignals = true,
  } = options;
  if (
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string")
  ) {
    throw new TypeError("Docker arguments must be an array of strings.");
  }
  if (dockerPreflight) await checkDockerImpl({ spawnImpl, env, cwd });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl("docker", args, {
        cwd,
        env: sanitizeDockerEnvironment(env),
        stdio,
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        reject(new DockerUnavailableError(error));
      else
        reject(
          new SandboxError(`Unable to start Docker: ${errorMessage(error)}`, {
            code: "DOCKER_START",
            cause: error,
          }),
        );
      return;
    }
    let settled = false;
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers)
        signalSource.off?.(signal, handler);
      handlers.clear();
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    if (
      forwardSignals &&
      signalSource?.on &&
      typeof child.kill === "function"
    ) {
      for (const signal of SIGNALS) {
        const handler = () => {
          try {
            child.kill(/** @type {any} */ (signal));
          } catch {
            // The child may have exited between the signal and kill call.
          }
        };
        handlers.set(signal, handler);
        signalSource.on(signal, handler);
      }
    }
    child.once?.("error", (error) => {
      finish(() => {
        if (errorCode(error) === "ENOENT")
          reject(new DockerUnavailableError(error));
        else
          reject(
            new SandboxError(`Docker failed to start: ${errorMessage(error)}`, {
              code: "DOCKER_START",
              cause: error,
            }),
          );
      });
    });
    const onExit = (code, signal) => {
      finish(() => resolve(code ?? signalExitCode(signal)));
    };
    child.once?.("exit", onExit);
    child.once?.("close", onExit);
    if (!child.once) {
      reject(
        new SandboxError("Docker runner received an invalid child process.", {
          code: "DOCKER_START",
        }),
      );
    }
  });
}

export const runDockerCommand = runDocker;
