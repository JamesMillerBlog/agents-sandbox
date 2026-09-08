import os from "node:os";
import path from "node:path";
import { gitEnvironment, gitMetadataMounts } from "./git-worktree.mjs";
import { validatePiSessionRoot } from "./state.mjs";
import {
  assertNoSocketDescendants,
  validateHostMountBoundary,
  validateMounts,
} from "./config.mjs";
import { SandboxError } from "./errors.mjs";

export const DEFAULT_IMAGES = Object.freeze({
  // Local image names keep the package publisher-neutral. Set
  // AGENT_SANDBOX_PI_IMAGE / AGENT_SANDBOX_CLAUDE_IMAGE for a registry image.
  pi: "pi-docker-agent:pi-0.84.4",
  claude: "pi-docker-agent:claude-2.1.150",
});

export const CONTAINER_PATHS = Object.freeze({
  home: "/home/sandbox",
  workspace: "/workspace",
  piAgent: "/home/sandbox/.pi/agent",
  piSessions: "/home/sandbox/.pi/agent/sessions",
});

// These are intentionally explicit allowlists, not filtered copies of
// process.env. Engine-specific credentials are never sent to the other
// runtime merely because both tools share one launcher.
const COMMON_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
]);

export const TOOL_ENVIRONMENT_ALLOWLIST = Object.freeze({
  pi: Object.freeze([
    ...COMMON_ENVIRONMENT_ALLOWLIST,
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
    "OPENCODE_GO_API_KEY",
    "XAI_API_KEY",
  ]),
  claude: Object.freeze([
    ...COMMON_ENVIRONMENT_ALLOWLIST,
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ]),
});

// Retain a union export for consumers that need to inspect the package policy.
export const ENVIRONMENT_ALLOWLIST = Object.freeze([
  ...new Set(Object.values(TOOL_ENVIRONMENT_ALLOWLIST).flat()),
]);

const SECRET_ENVIRONMENT_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_GO_API_KEY",
  "XAI_API_KEY",
]);

const STATIC_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function ensureTool(tool) {
  if (tool !== "pi" && tool !== "claude") {
    throw new SandboxError(`Unsupported agent: ${tool}`, { code: "USAGE" });
  }
}

function rejectUnsafeWorktreeSource(worktree, { home, hostEnv }) {
  validateHostMountBoundary(worktree.canonicalWorktree, {
    home,
    additionalHomes: hostEnv?.HOME ? [hostEnv.HOME] : [],
    label: "unsafe active worktree source",
  });
}

export function validateNetwork(network) {
  if (network !== "bridge" && network !== "none") {
    throw new SandboxError(
      `Unsupported network mode: ${network}. host is never permitted.`,
      {
        code: "NETWORK_INVALID",
      },
    );
  }
  return network;
}

function validateUserPart(value, label) {
  const normalized = String(value);
  if (!/^\d+$/u.test(normalized)) {
    throw new SandboxError(`${label} must be a numeric uid/gid.`, {
      code: "USER_INVALID",
    });
  }
  if (label === "uid" && /^0+$/u.test(normalized)) {
    throw new SandboxError("Refusing to run an agent container as root.", {
      code: "USER_INVALID",
    });
  }
  return normalized;
}

export function hostUser({
  uid = typeof process.getuid === "function" ? process.getuid() : 1000,
  gid = typeof process.getgid === "function" ? process.getgid() : 1000,
} = {}) {
  return `${validateUserPart(uid, "uid")}:${validateUserPart(gid, "gid")}`;
}

function mountValue(mount) {
  if (!mount.source || !mount.target)
    throw new SandboxError("A Docker mount needs source and target.", {
      code: "MOUNT_INVALID",
    });
  if (
    String(mount.source).includes(",") ||
    String(mount.target).includes(",")
  ) {
    throw new SandboxError(
      "Mount paths containing commas are not supported by Docker --mount.",
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  const fields = [
    `type=${mount.type ?? "bind"}`,
    `source=${mount.source}`,
    `target=${mount.target}`,
  ];
  if (mount.mode === "ro" || mount.readonly === true) fields.push("readonly");
  return fields.join(",");
}

export function dockerBindMount(mount) {
  return ["--mount", mountValue(mount)];
}

function dockerVolumeMount(source, target) {
  return ["--mount", `type=volume,source=${source},target=${target}`];
}

function overlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function comparableHostPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

function hostPathAtOrBelow(candidate, parent) {
  const relative = path.relative(
    comparableHostPath(parent),
    comparableHostPath(candidate),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function hostPathOverlap(first, second) {
  return hostPathAtOrBelow(first, second) || hostPathAtOrBelow(second, first);
}

function checkAdditionalMountSources(mounts, reservedSources) {
  for (const mount of mounts) {
    if (
      mount.mode === "rw" &&
      reservedSources.some(
        (source) => source && hostPathOverlap(mount.source, source),
      )
    ) {
      throw new SandboxError(
        `Configured writable mount source overlaps Git metadata: ${mount.source}`,
        { code: "MOUNT_DANGEROUS" },
      );
    }
  }
}

function checkAdditionalMounts(mounts, reservedTargets) {
  for (const mount of mounts) {
    if (reservedTargets.some((target) => overlap(mount.target, target))) {
      throw new SandboxError(
        `Configured mount target overlaps a protected target: ${mount.target}`,
        {
          code: "MOUNT_DANGEROUS",
        },
      );
    }
  }
  for (let first = 0; first < mounts.length; first += 1) {
    for (let second = first + 1; second < mounts.length; second += 1) {
      if (overlap(mounts[first].target, mounts[second].target)) {
        throw new SandboxError(
          `Configured mount targets overlap: ${mounts[first].target} and ${mounts[second].target}`,
          {
            code: "MOUNT_INVALID",
          },
        );
      }
    }
  }
}

function imageFor(tool, { image, hostEnv }) {
  const envName = `AGENT_SANDBOX_${tool.toUpperCase()}_IMAGE`;
  const selected = image ?? hostEnv?.[envName] ?? DEFAULT_IMAGES[tool];
  if (
    typeof selected !== "string" ||
    selected.length === 0 ||
    selected.startsWith("-")
  ) {
    throw new SandboxError(`Invalid Docker image for ${tool}.`, {
      code: "IMAGE_INVALID",
    });
  }
  return selected;
}

/**
 * @param {any} options
 */
export function collectContainerEnvironment(options) {
  const {
    tool,
    state,
    worktree,
    hostEnv = process.env,
    gitWrite = false,
  } = options;
  ensureTool(tool);
  /** @type {Record<string, string>} */
  const environment = {
    HOME: CONTAINER_PATHS.home,
    PATH: STATIC_PATH,
    XDG_CONFIG_HOME: `${CONTAINER_PATHS.home}/.config`,
    AGENT_SANDBOX_ENGINE: tool,
    AGENT_SANDBOX_STATE_ID: state.id,
    AGENT_SANDBOX_PROFILE: state.profile,
    AGENT_SANDBOX_GIT_WRITE: gitWrite ? "1" : "0",
    ...gitEnvironment(worktree, { workspaceTarget: CONTAINER_PATHS.workspace }),
  };
  if (tool === "pi") {
    environment.PI_CODING_AGENT_DIR = CONTAINER_PATHS.piAgent;
    environment.PI_CODING_AGENT_SESSION_DIR = `${CONTAINER_PATHS.piSessions}/${state.id}`;
  }
  for (const name of TOOL_ENVIRONMENT_ALLOWLIST[tool]) {
    if (hostEnv && hostEnv[name] !== undefined)
      environment[name] = String(hostEnv[name]);
  }
  // Explicitly never copy DOCKER_HOST, PATH, HOME, SSH_AUTH_SOCK, or arbitrary
  // host variables into the container.
  delete environment.DOCKER_HOST;
  return environment;
}

function environmentArgs(environment) {
  return Object.entries(environment).flatMap(([name, value]) => [
    "--env",
    SECRET_ENVIRONMENT_NAMES.has(name) ? name : `${name}=${value}`,
  ]);
}

function normalizeMetadataMounts(worktree, gitWrite, fsImpl) {
  return gitMetadataMounts(worktree, {
    workspaceTarget: CONTAINER_PATHS.workspace,
    mode: gitWrite ? "rw" : "ro",
    fsImpl,
  });
}

/**
 * Build a complete `docker run` argument vector without invoking Docker.
 * @param {any} options
 */
export function buildDockerSpec(options = {}) {
  const {
    tool,
    agentArgs = [],
    worktree,
    state,
    config = {},
    configMounts,
    hostEnv = process.env,
    gitWrite: requestedGitWrite = hostEnv?.AGENT_SANDBOX_GIT_WRITE === "1",
    network = config.security?.network ?? "bridge",
    uid = typeof process.getuid === "function" ? process.getuid() : 1000,
    gid = typeof process.getgid === "function" ? process.getgid() : 1000,
    tty = Boolean(process.stdin?.isTTY && process.stdout?.isTTY),
    interactive = true,
    image,
    fsImpl,
    home = os.homedir(),
  } = options;
  ensureTool(tool);
  if (!worktree || !state)
    throw new TypeError("worktree and state are required.");
  const policyGitWrite = config.security?.git_write === true;
  const environmentGitWrite = hostEnv?.AGENT_SANDBOX_GIT_WRITE === "1";
  if (requestedGitWrite && (!policyGitWrite || !environmentGitWrite)) {
    throw new SandboxError(
      "Git metadata writes require security.git_write=true and AGENT_SANDBOX_GIT_WRITE=1.",
      { code: "GIT_WRITE_CONFIRMATION" },
    );
  }
  const gitWrite =
    requestedGitWrite === true && policyGitWrite && environmentGitWrite;
  rejectUnsafeWorktreeSource(worktree, { home, hostEnv });
  assertNoSocketDescendants(worktree.canonicalWorktree, {
    fsImpl,
    label: "active worktree",
  });
  if (
    !Array.isArray(agentArgs) ||
    agentArgs.some((argument) => typeof argument !== "string")
  ) {
    throw new TypeError("agentArgs must be an array of strings.");
  }
  validateNetwork(network);
  const selectedImage = imageFor(tool, { image, hostEnv });
  const additional = configMounts ?? config.mounts ?? [];
  const validatedAdditional =
    additional.length > 0
      ? validateMounts(additional, { env: hostEnv, home, fsImpl })
      : [];
  const workspaceMount = {
    type: "bind",
    source: worktree.canonicalWorktree,
    target: CONTAINER_PATHS.workspace,
    mode: "rw",
    purpose: "active-worktree",
  };
  const metadataMounts = normalizeMetadataMounts(worktree, gitWrite, fsImpl);
  for (const mount of metadataMounts) {
    validateHostMountBoundary(mount.source, {
      home,
      additionalHomes: hostEnv?.HOME ? [hostEnv.HOME] : [],
      label: "unsafe Git metadata source",
    });
    assertNoSocketDescendants(mount.source, {
      fsImpl,
      label: "Git metadata source",
    });
  }
  checkAdditionalMountSources(validatedAdditional, [
    worktree.gitDir,
    worktree.gitCommonDir,
    worktree.gitPointer,
    ...metadataMounts.map((mount) => mount.source),
  ]);
  if (tool === "pi") validatePiSessionRoot(state, { fsImpl });
  const stateMounts =
    tool === "pi"
      ? [
          {
            type: "volume",
            source: state.piVolume,
            target: CONTAINER_PATHS.home,
            mode: "rw",
            purpose: "pi-state-volume",
          },
          {
            type: "bind",
            source: state.piSessionRoot,
            target: CONTAINER_PATHS.piSessions,
            mode: "rw",
            purpose: "pi-sessions-root",
          },
        ]
      : [
          {
            type: "volume",
            source: state.claudeVolume,
            target: CONTAINER_PATHS.home,
            mode: "rw",
            purpose: "claude-state-volume",
          },
        ];
  for (const mount of stateMounts.filter((entry) => entry.type === "bind")) {
    validateHostMountBoundary(mount.source, {
      home,
      additionalHomes: hostEnv?.HOME ? [hostEnv.HOME] : [],
      label: "state source",
    });
    assertNoSocketDescendants(mount.source, {
      fsImpl,
      label: "state source",
      optional: true,
    });
  }
  const explicitSessionMount = validatedAdditional.find(
    (mount) => mount.target === CONTAINER_PATHS.piSessions,
  );
  checkAdditionalMounts(validatedAdditional, [
    CONTAINER_PATHS.workspace,
    ...(explicitSessionMount ? [] : [CONTAINER_PATHS.piSessions]),
    ...metadataMounts.map((mount) => mount.target),
  ]);
  const effectiveStateMounts = explicitSessionMount
    ? stateMounts.filter(
        (mount) =>
          mount.type !== "bind" || mount.target !== CONTAINER_PATHS.piSessions,
      )
    : stateMounts;
  const allBindMounts = [
    workspaceMount,
    ...metadataMounts,
    ...validatedAdditional,
    ...effectiveStateMounts.filter((mount) => mount.type === "bind"),
  ];
  const argv = [
    "run",
    "--rm",
    "--pull=never",
    "--init",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev",
    "--network",
    network,
    "--user",
    hostUser({ uid, gid }),
    "--workdir",
    CONTAINER_PATHS.workspace,
  ];
  if (interactive) argv.push("--interactive");
  if (tty) argv.push("--tty");
  for (const mount of stateMounts.filter((entry) => entry.type === "volume"))
    argv.push(...dockerVolumeMount(mount.source, mount.target));
  for (const mount of allBindMounts) argv.push(...dockerBindMount(mount));
  const environment = collectContainerEnvironment({
    tool,
    state,
    worktree,
    hostEnv,
    gitWrite,
  });
  argv.push(...environmentArgs(environment), selectedImage, ...agentArgs);
  return {
    argv,
    image: selectedImage,
    tool,
    environment,
    network,
    user: hostUser({ uid, gid }),
    mounts: [
      ...effectiveStateMounts.filter((entry) => entry.type === "volume"),
      workspaceMount,
      ...metadataMounts,
      ...validatedAdditional,
      ...effectiveStateMounts.filter((entry) => entry.type === "bind"),
    ],
    state,
  };
}

export function buildDockerArgv(options) {
  return buildDockerSpec(options).argv;
}

export function formatMountSummary(mounts) {
  return mounts.map((mount) => {
    const mode = mount.mode ?? (mount.type === "volume" ? "rw" : "ro");
    return `${mode} ${mount.source} -> ${mount.target}`;
  });
}
