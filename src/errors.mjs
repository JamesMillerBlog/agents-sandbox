export class SandboxError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, cause?: unknown}} [options]
   */
  constructor(message, { code = "SANDBOX_ERROR", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SandboxError";
    this.code = code;
  }
}

export class DockerUnavailableError extends SandboxError {
  constructor(cause) {
    super("Docker is unavailable. Install Docker and ensure it is on PATH.", {
      code: "DOCKER_UNAVAILABLE",
      cause,
    });
    this.name = "DockerUnavailableError";
  }
}

export class DockerDaemonUnavailableError extends SandboxError {
  constructor(detail, cause) {
    const suffix = detail ? `: ${detail}` : "";
    super(
      `Docker is installed but the daemon is unavailable${suffix}. Start Docker and try again.`,
      {
        code: "DOCKER_DAEMON_UNAVAILABLE",
        cause,
      },
    );
    this.name = "DockerDaemonUnavailableError";
  }
}

export class ProcessExitError extends SandboxError {
  constructor(message, code, signal) {
    super(message, { code: "PROCESS_EXIT" });
    this.name = "ProcessExitError";
    this.exitCode = code;
    this.signal = signal;
  }
}

export function usageError(message) {
  return new SandboxError(message, { code: "USAGE" });
}
