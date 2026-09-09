import os from "node:os";
import path from "node:path";
import { loadConfig, validateMounts } from "./config.mjs";
import { buildDockerSpec, formatMountSummary } from "./docker-spec.mjs";
import { runDocker, sanitizeDockerEnvironment } from "./docker-runner.mjs";
import { detectWorktree } from "./git-worktree.mjs";
import { ensurePiSessionDirectory, stateLayout } from "./state.mjs";
import { createHerdrReporter } from "./herdr.mjs";
import { SandboxError, usageError } from "./errors.mjs";

export const USAGE = `Usage:
  sandbox pi [pi arguments...]
  sandbox claude [claude arguments...]

Examples:
  sandbox pi --resume
  sandbox pi --session SESSION_ID
  sandbox claude --resume

The optional -- separator disambiguates wrapper options from agent options.
Wrapper options must come before it:
  --profile NAME       isolate persistent state by profile
  --config PATH        use a specific .agent-sandbox.toml
`;

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value === "--" || value.startsWith("--")) {
    throw usageError(`${option} requires a value.\n\n${USAGE}`);
  }
  return value;
}

/**
 * Parse only wrapper options; everything after -- is untouched agent input.
 * @param {string[]} argv
 */
export function parseCli(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array.");
  let tool;
  let index = 0;
  if (!tool) {
    tool = argv[index];
    index += 1;
  }
  if (tool === "--help" || tool === "-h" || tool === undefined) {
    return {
      help: true,
      tool: null,
      agentArgs: [],
      profile: null,
      configPath: null,
    };
  }
  if (tool !== "pi" && tool !== "claude") {
    throw usageError(`Unknown agent ${tool}.\n\n${USAGE}`);
  }
  let profile = null;
  let configPath = null;
  let separator = false;
  const agentArgs = [];
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === "--") {
      separator = true;
      agentArgs.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--profile" || argument.startsWith("--profile=")) {
      if (profile !== null) throw usageError("Duplicate --profile.");
      if (argument.includes("="))
        profile = argument.slice(argument.indexOf("=") + 1);
      else profile = optionValue(argv, index++, "--profile");
      if (!profile) throw usageError("--profile cannot be empty.");
      index += 1;
      continue;
    }
    if (argument === "--config" || argument.startsWith("--config=")) {
      if (configPath !== null) throw usageError("Duplicate --config.");
      if (argument.includes("="))
        configPath = argument.slice(argument.indexOf("=") + 1);
      else configPath = optionValue(argv, index++, "--config");
      if (!configPath) throw usageError("--config cannot be empty.");
      index += 1;
      continue;
    }
    // Without a separator, do not interpret any agent argument. This keeps
    // --resume/--continue/--session/--session-id byte-for-byte intact. The
    // explicit separator is still the documented form when wrapper options
    // might be ambiguous.
    agentArgs.push(...argv.slice(index));
    break;
  }
  return { help: false, tool, agentArgs, profile, configPath, separator };
}

function profileFrom(parsed, env) {
  const profile = parsed.profile ?? env.AGENT_SANDBOX_PROFILE ?? "default";
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(profile)) {
    throw new SandboxError(
      "Profile must contain only letters, numbers, dot, underscore, or hyphen.",
      {
        code: "PROFILE_INVALID",
      },
    );
  }
  return profile;
}

function effectiveGitWrite(config, env) {
  const requested = env.AGENT_SANDBOX_GIT_WRITE === "1";
  const policyEnabled = config.security?.git_write === true;
  if (policyEnabled !== requested) {
    throw new SandboxError(
      policyEnabled
        ? "security.git_write=true requires AGENT_SANDBOX_GIT_WRITE=1 as a second explicit opt-in."
        : "AGENT_SANDBOX_GIT_WRITE=1 requires security.git_write=true in project configuration.",
      {
        code: "GIT_WRITE_CONFIRMATION",
      },
    );
  }
  return policyEnabled && requested;
}

function printMountSummary(spec, output = console.error) {
  output(`Mounts (${spec.tool}, state ${spec.state.id}):`);
  for (const line of formatMountSummary(spec.mounts)) output(`  ${line}`);
}

export function printHelp(output = console.log) {
  output(USAGE);
}

/**
 * Main entry point. Dependencies are injectable so all security and argument
 * construction tests can run without a Docker daemon.
 * @param {string[]} argv
 * @param {any} [options]
 */
export async function main(argv, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    home = os.homedir(),
    runGit,
    runDocker: runDockerImpl = runDocker,
    loadConfig: loadConfigImpl = loadConfig,
    detectWorktree: detectWorktreeImpl = detectWorktree,
    buildDockerSpec: buildDockerSpecImpl = buildDockerSpec,
    ensurePiSessionDirectory: ensureSessionImpl = ensurePiSessionDirectory,
    herdrExecFileSync,
    output = console.log,
    errorOutput = console.error,
    uid = typeof process.getuid === "function" ? process.getuid() : 1000,
    gid = typeof process.getgid === "function" ? process.getgid() : 1000,
    tty = Boolean(process.stdin?.isTTY && process.stdout?.isTTY),
  } = options;
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      printHelp(output);
      return 0;
    }
    const worktree = detectWorktreeImpl({ cwd, runGit });
    const configFile =
      parsed.configPath === null
        ? path.join(
            worktree.root ?? worktree.canonicalWorktree ?? cwd,
            ".agent-sandbox.toml",
          )
        : path.resolve(cwd, parsed.configPath);
    const config = loadConfigImpl(configFile, {
      optional: parsed.configPath === null,
    });
    const profile = profileFrom(parsed, env);
    const gitWrite = effectiveGitWrite(config, env);
    const state = stateLayout({
      engine: parsed.tool,
      profile,
      worktree,
      scope: config.project?.state_scope ?? "worktree",
      home,
    });
    // Validate before creating state or starting Docker, so unsafe paths fail
    // closed without leaving package-managed directories behind.
    validateMounts(config.mounts, { env, home });
    if (parsed.tool === "pi") ensureSessionImpl(state);
    const spec = buildDockerSpecImpl({
      tool: parsed.tool,
      agentArgs: parsed.agentArgs,
      worktree,
      state,
      config,
      hostEnv: env,
      gitWrite,
      network: config.security?.network ?? "bridge",
      uid,
      gid,
      tty,
      home,
    });
    printMountSummary(spec, errorOutput);
    const herdrReporter = createHerdrReporter({
      tool: parsed.tool,
      worktree,
      state,
      env,
      execFileSyncImpl: herdrExecFileSync,
    });
    herdrReporter?.start(errorOutput);
    let exitCode;
    try {
      const result = await runDockerImpl(spec.argv, {
        cwd,
        env: sanitizeDockerEnvironment(env),
      });
      exitCode = typeof result === "number" ? result : 0;
      return exitCode;
    } finally {
      herdrReporter?.finish(exitCode, errorOutput);
    }
  } catch (error) {
    const message =
      error instanceof SandboxError
        ? error.message
        : (error?.message ?? String(error));
    errorOutput(`error: ${message}`);
    return error?.code === "USAGE" ? 2 : 1;
  }
}
