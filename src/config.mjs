import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxError } from "./errors.mjs";

const CONFIG_VERSION = 1;
const SAFE_PI_PATHS = [
  [".pi", "agent", "settings.json"],
  [".pi", "agent", "extensions"],
  [".pi", "agent", "packages"],
  [".pi", "agent", "sessions"],
];
const SAFE_CLAUDE_PATHS = [
  [".claude", "settings.json"],
  [".claude", "CLAUDE.md"],
  [".claude", ".mcp.json"],
];
const SENSITIVE_VARIABLE_NAMES =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/iu;
const DANGEROUS_NAMES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  "credentials",
  "credentials.json",
  "auth.json",
  ".claude.json",
  "id_rsa",
  "id_ed25519",
  ".env",
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
]);
const RESERVED_TARGETS = new Set([
  "/",
  "/workspace",
  "/home",
  "/home/sandbox",
  "/home/sandbox/.pi",
  "/home/sandbox/.pi/agent",
  "/home/sandbox/.claude",
]);

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    project: { state_scope: "worktree" },
    security: { git_write: false, network: "bridge" },
    mounts: [],
    path: null,
    present: false,
  };
}

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && quote === null) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (character === "#" && quote === null) {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitAssignment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && quote === null) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (character === "=" && quote === null) {
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }
  }
  return null;
}

function parseValue(value, lineNumber) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new SandboxError(
        `Invalid quoted value on config line ${lineNumber}.`,
        {
          code: "CONFIG_INVALID",
          cause: error,
        },
      );
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    if (body === "") return [];
    return body.split(",").map((part) => parseValue(part.trim(), lineNumber));
  }
  throw new SandboxError(
    `Unsupported TOML value on config line ${lineNumber}.`,
    {
      code: "CONFIG_INVALID",
    },
  );
}

function setDotted(object, key, value) {
  const parts = key
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new SandboxError(`Invalid config key: ${key}`, {
      code: "CONFIG_INVALID",
    });
  }
  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === undefined) target[part] = {};
    if (typeof target[part] !== "object" || Array.isArray(target[part])) {
      throw new SandboxError(`Config key conflicts with a scalar: ${key}`, {
        code: "CONFIG_INVALID",
      });
    }
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

function validateParsedConfig(raw) {
  const config = defaultConfig();
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    throw new SandboxError(
      `Unsupported .agent-sandbox.toml version: ${raw.version}`,
      {
        code: "CONFIG_VERSION",
      },
    );
  }
  if (
    raw.project !== undefined &&
    (typeof raw.project !== "object" || Array.isArray(raw.project))
  ) {
    throw new SandboxError("Config [project] must be a table.", {
      code: "CONFIG_INVALID",
    });
  }
  if (
    raw.security !== undefined &&
    (typeof raw.security !== "object" || Array.isArray(raw.security))
  ) {
    throw new SandboxError("Config [security] must be a table.", {
      code: "CONFIG_INVALID",
    });
  }
  const requestedStateScope =
    raw.project?.state_scope ?? config.project.state_scope;
  const stateScope =
    requestedStateScope === "repo" ? "repository" : requestedStateScope;
  if (!["worktree", "repository"].includes(stateScope)) {
    throw new SandboxError(
      `Unsupported project.state_scope: ${requestedStateScope}`,
      {
        code: "CONFIG_INVALID",
      },
    );
  }
  const gitWrite = raw.security?.git_write ?? config.security.git_write;
  if (typeof gitWrite !== "boolean") {
    throw new SandboxError("security.git_write must be true or false.", {
      code: "CONFIG_INVALID",
    });
  }
  const network = raw.security?.network ?? config.security.network;
  if (!["bridge", "none"].includes(network)) {
    throw new SandboxError(
      `security.network must be "bridge" or "none" (not ${network}).`,
      {
        code: "CONFIG_INVALID",
      },
    );
  }
  const mounts = raw.mounts ?? [];
  if (!Array.isArray(mounts)) {
    throw new SandboxError("[[mounts]] entries must be an array of tables.", {
      code: "CONFIG_INVALID",
    });
  }
  config.version = raw.version ?? CONFIG_VERSION;
  config.project = { state_scope: stateScope };
  config.security = { git_write: gitWrite, network };
  config.mounts = mounts.map((mount, index) => {
    if (mount === null || typeof mount !== "object" || Array.isArray(mount)) {
      throw new SandboxError(`mount ${index + 1} must be a table.`, {
        code: "CONFIG_INVALID",
      });
    }
    const { source, target, mode = "ro" } = mount;
    if (typeof source !== "string" || typeof target !== "string") {
      throw new SandboxError(
        `mount ${index + 1} requires source and target strings.`,
        {
          code: "CONFIG_INVALID",
        },
      );
    }
    if (mode !== "ro" && mode !== "rw") {
      throw new SandboxError(`mount ${index + 1} mode must be ro or rw.`, {
        code: "CONFIG_INVALID",
      });
    }
    return { source, target, mode };
  });
  return config;
}

/** Parse the deliberately small, dependency-free TOML subset used by this package. */
export function parseConfig(text) {
  if (typeof text !== "string") {
    throw new TypeError("parseConfig expects a string.");
  }
  /** @type {Record<string, any>} */
  const raw = {};
  /** @type {Record<string, any>} */
  let table = raw;
  /** @type {Array<Record<string, any>> | null} */
  let mounts = null;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const name = line.slice(2, -2).trim();
      if (name !== "mounts") {
        throw new SandboxError(`Unsupported array table [[${name}]].`, {
          code: "CONFIG_INVALID",
        });
      }
      if (mounts === null) mounts = [];
      /** @type {Record<string, any>} */
      const entry = {};
      mounts.push(entry);
      table = entry;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (!["project", "security"].includes(name)) {
        throw new SandboxError(`Unsupported config table [${name}].`, {
          code: "CONFIG_INVALID",
        });
      }
      if (raw[name] === undefined) raw[name] = {};
      table = raw[name];
      continue;
    }
    const assignment = splitAssignment(line);
    if (assignment === null) {
      throw new SandboxError(
        `Expected key = value on config line ${lineNumber}.`,
        {
          code: "CONFIG_INVALID",
        },
      );
    }
    const [key, valueText] = assignment;
    const value = parseValue(valueText, lineNumber);
    setDotted(table, key, value);
  }
  if (mounts !== null) raw.mounts = mounts;
  return validateParsedConfig(raw);
}

function expandVariable(
  _match,
  name,
  env,
  { allowSensitiveVariables = true } = {},
) {
  if (!allowSensitiveVariables && SENSITIVE_VARIABLE_NAMES.test(name)) {
    throw new SandboxError(
      `Sensitive environment variable ${name} may not be used in a mount source.`,
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  if (!(name in env) || env[name] === undefined) {
    throw new SandboxError(
      `Environment variable ${name} is not set for a configured mount.`,
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  return String(env[name]);
}

export function expandPath(
  value,
  {
    env = process.env,
    home = os.homedir(),
    allowSensitiveVariables = true,
  } = {},
) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SandboxError(
      "Configured mount paths must be non-empty strings.",
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  let expanded = value;
  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(home, expanded.slice(2));
  } else if (expanded.startsWith("~")) {
    throw new SandboxError(`Only ~ and ~/ paths are supported: ${value}`, {
      code: "MOUNT_INVALID",
    });
  }
  expanded = expanded.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (match, braced, bare) =>
      expandVariable(match, braced ?? bare, env, {
        allowSensitiveVariables,
      }),
  );
  return expanded;
}

const CASE_INSENSITIVE_PATHS =
  process.platform === "darwin" || process.platform === "win32";
const PROTECTED_SOURCE_ROOTS = [
  "/run",
  "/var/run",
  "/private/run",
  "/private/var/run",
  "/dev",
  "/proc",
  "/sys",
];
const HOST_HOME_ROOTS =
  process.platform === "win32"
    ? [path.join(path.parse(os.homedir()).root, "Users")]
    : ["/home", "/Users", "/root", "/private/Users", "/private/var/root"];

function comparablePath(value) {
  const resolved = path.resolve(value);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

function samePath(first, second) {
  return comparablePath(first) === comparablePath(second);
}

function pathSegments(value) {
  return value.split(/[\\\\/]/u).filter(Boolean);
}

function isSafeKnownStatePath(source, home) {
  const relative = path.relative(comparablePath(home), comparablePath(source));
  return SAFE_PI_PATHS.concat(SAFE_CLAUDE_PATHS).some((parts) =>
    samePath(relative, path.join(...parts)),
  );
}

function isUnder(source, parent) {
  const relative = path.relative(
    comparablePath(parent),
    comparablePath(source),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Validate only host-boundary policy for an implicit or configured source.
 * @param {string} source
 * @param {any} [options]
 */
export function validateHostMountBoundary(
  source,
  {
    home = os.homedir(),
    additionalHomes = [],
    stat,
    label = "source path",
  } = {},
) {
  const resolved = path.resolve(source);
  const homes = [home, ...additionalHomes]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  const root = path.parse(resolved).root;
  if (
    samePath(resolved, root) ||
    homes.some((candidate) => samePath(resolved, candidate))
  ) {
    throw new SandboxError(
      `Refusing to mount dangerous ${label}: ${resolved}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (homes.some((candidate) => isUnder(candidate, resolved))) {
    throw new SandboxError(
      `Refusing to mount a host-home ancestor: ${resolved}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  const trustedHome = path.resolve(home);
  const trustedHomeParent = path.dirname(trustedHome);
  const homeTrees = [
    ...HOST_HOME_ROOTS,
    ...(samePath(trustedHomeParent, path.parse(trustedHomeParent).root)
      ? []
      : [trustedHomeParent]),
  ];
  if (
    homeTrees.some((candidate) => isUnder(resolved, candidate)) &&
    !isUnder(resolved, trustedHome)
  ) {
    throw new SandboxError(
      `Refusing to mount another host-home tree: ${resolved}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (
    PROTECTED_SOURCE_ROOTS.some(
      (candidate) =>
        isUnder(resolved, candidate) || isUnder(candidate, resolved),
    )
  ) {
    throw new SandboxError(
      `Refusing to mount protected runtime path: ${resolved}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (
    path.basename(resolved).toLowerCase() === "docker.sock" ||
    stat?.isSocket?.()
  ) {
    throw new SandboxError(`Refusing to mount Docker socket: ${resolved}`, {
      code: "MOUNT_DANGEROUS",
    });
  }
  return resolved;
}

/**
 * Reject Unix sockets below a bind source without following symlinks.
 * @param {string} source
 * @param {any} [options]
 */
export function assertNoSocketDescendants(
  source,
  { fsImpl = fs, label = "mount source", optional = false } = {},
) {
  const rootSource = path.resolve(source);
  const pending = [rootSource];
  while (pending.length > 0) {
    const current = pending.pop();
    let currentStat;
    try {
      currentStat = fsImpl.lstatSync(current);
    } catch (error) {
      if (optional && current === rootSource && error?.code === "ENOENT") {
        return;
      }
      throw new SandboxError(`Unable to inspect ${label}: ${current}`, {
        code: "MOUNT_SCAN_FAILED",
        cause: error,
      });
    }
    if (current === rootSource && currentStat.isSymbolicLink?.()) {
      throw new SandboxError(`Refusing symlinked mount source: ${current}`, {
        code: "MOUNT_DANGEROUS",
      });
    }
    if (currentStat.isSocket?.()) {
      throw new SandboxError(`Refusing to mount Unix socket: ${current}`, {
        code: "MOUNT_DANGEROUS",
      });
    }
    if (!currentStat.isDirectory?.()) continue;
    let entries;
    try {
      entries = fsImpl.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new SandboxError(`Unable to inspect ${label}: ${current}`, {
        code: "MOUNT_SCAN_FAILED",
        cause: error,
      });
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (
        entry.isSymbolicLink?.() &&
        entry.name.toLowerCase() === "docker.sock"
      ) {
        throw new SandboxError(`Refusing to mount Unix socket: ${child}`, {
          code: "MOUNT_DANGEROUS",
        });
      }
      if (!entry.isSymbolicLink?.()) pending.push(child);
    }
  }
}

function rejectDangerousSource(source, { home, stat, additionalHomes = [] }) {
  validateHostMountBoundary(source, {
    home,
    additionalHomes,
    stat,
  });
  const homes = [home, ...additionalHomes]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  if (homes.some((candidate) => isSafeKnownStatePath(source, candidate)))
    return;
  const homeRelative = homes
    .filter((candidate) => isUnder(source, candidate))
    .map((candidate) =>
      path.relative(comparablePath(candidate), comparablePath(source)),
    );
  const segments = pathSegments(source).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => DANGEROUS_NAMES.has(segment))) {
    throw new SandboxError(
      `Refusing to mount credential or private key path: ${source}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (
    homeRelative.some(
      (relative) => relative === ".pi" || relative.startsWith(`.pi${path.sep}`),
    )
  ) {
    throw new SandboxError(
      `Refusing broad ~/.pi mount; select an explicit safe file or directory: ${source}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (
    homeRelative.some(
      (relative) =>
        relative === ".config" || relative.startsWith(`.config${path.sep}`),
    )
  ) {
    throw new SandboxError(
      `Refusing broad ~/.config mount; select an explicit safe file: ${source}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (
    homeRelative.some(
      (relative) =>
        relative === ".claude" || relative.startsWith(`.claude${path.sep}`),
    )
  ) {
    throw new SandboxError(
      `Refusing broad ~/.claude mount; select an explicit safe file: ${source}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (
    segments.some((segment) => segment.toLowerCase().includes("credential"))
  ) {
    throw new SandboxError(`Refusing credential directory: ${source}`, {
      code: "MOUNT_DANGEROUS",
    });
  }
}

function validateTarget(target) {
  if (
    typeof target !== "string" ||
    target.includes("~") ||
    target.includes("$")
  ) {
    throw new SandboxError(
      `Mount targets must be literal absolute paths: ${target}`,
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  if (!path.isAbsolute(target)) {
    throw new SandboxError(`Mount target must be absolute: ${target}`, {
      code: "MOUNT_INVALID",
    });
  }
  const normalized = path.posix.normalize(target);
  const rawParts = target.split("/").filter(Boolean);
  if (rawParts.includes("..")) {
    throw new SandboxError(`Mount target may not contain ..: ${target}`, {
      code: "MOUNT_INVALID",
    });
  }
  if (RESERVED_TARGETS.has(normalized)) {
    throw new SandboxError(
      `Refusing to replace protected container path: ${normalized}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  if (
    normalized === "/proc" ||
    normalized === "/sys" ||
    normalized === "/dev" ||
    normalized === "/var/run" ||
    normalized === "/run" ||
    normalized === "/var/run/docker.sock" ||
    normalized === "/run/docker.sock" ||
    normalized.endsWith("/docker.sock")
  ) {
    throw new SandboxError(`Refusing mount target: ${normalized}`, {
      code: "MOUNT_DANGEROUS",
    });
  }
  if (target.includes(",")) {
    throw new SandboxError(
      "Mount paths containing commas are not supported by Docker --mount.",
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  return normalized;
}

/** Resolve and validate one user-configured bind mount. */
export function validateMount(
  mount,
  { env = process.env, home = os.homedir(), fsImpl = fs } = {},
) {
  if (mount === null || typeof mount !== "object") {
    throw new SandboxError("Configured mount must be a table.", {
      code: "MOUNT_INVALID",
    });
  }
  const mode = mount.mode ?? "ro";
  if (mode !== "ro" && mode !== "rw") {
    throw new SandboxError(`Mount mode must be ro or rw, not ${mode}.`, {
      code: "MOUNT_INVALID",
    });
  }
  const expandedSource = expandPath(mount.source, {
    env,
    home,
    allowSensitiveVariables: false,
  });
  if (expandedSource.includes(",")) {
    throw new SandboxError(
      "Mount paths containing commas are not supported by Docker --mount.",
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  if (!path.isAbsolute(expandedSource)) {
    throw new SandboxError(
      `Mount source must resolve to an absolute path: ${mount.source}`,
      {
        code: "MOUNT_INVALID",
      },
    );
  }
  const lexicalSource = path.resolve(expandedSource);
  // Reject obvious sensitive paths before touching the filesystem. This keeps
  // a missing ~/.ssh or Docker socket from being misreported as an ordinary
  // missing source.
  rejectDangerousSource(lexicalSource, {
    home: path.resolve(home),
    additionalHomes: env.HOME ? [env.HOME] : [],
    stat: { isSocket: () => false },
  });
  let source;
  let stat;
  try {
    const lexicalStat = fsImpl.lstatSync
      ? fsImpl.lstatSync(lexicalSource)
      : fsImpl.statSync(lexicalSource);
    if (lexicalStat.isSymbolicLink?.()) {
      throw new SandboxError(
        `Refusing symlink mount source; resolve it explicitly first: ${lexicalSource}`,
        {
          code: "MOUNT_DANGEROUS",
        },
      );
    }
    source = fsImpl.realpathSync(lexicalSource);
    stat = fsImpl.statSync(source);
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    throw new SandboxError(
      `Configured mount source does not exist: ${lexicalSource}`,
      {
        code: "MOUNT_MISSING",
        cause: error,
      },
    );
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new SandboxError(
      `Configured mount source must be a regular file or directory: ${source}`,
      {
        code: "MOUNT_DANGEROUS",
      },
    );
  }
  let canonicalHome;
  try {
    canonicalHome = fsImpl.realpathSync(home);
  } catch {
    canonicalHome = path.resolve(home);
  }
  rejectDangerousSource(source, {
    home: canonicalHome,
    additionalHomes: env.HOME ? [env.HOME] : [],
    stat,
  });
  assertNoSocketDescendants(source, {
    fsImpl,
    label: "configured mount source",
  });
  const target = validateTarget(mount.target);
  return {
    source,
    target,
    mode,
    kind: stat.isDirectory() ? "directory" : "file",
  };
}

export function validateMounts(mounts, options = {}) {
  return (mounts ?? []).map((mount) => validateMount(mount, options));
}

export function loadConfig(
  configPath = path.join(process.cwd(), ".agent-sandbox.toml"),
  { optional = true, fsImpl = fs } = {},
) {
  let text;
  try {
    text = fsImpl.readFileSync(configPath, "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return defaultConfig();
    if (error?.code === "ENOENT") {
      throw new SandboxError(`Config file not found: ${configPath}`, {
        code: "CONFIG_MISSING",
      });
    }
    throw new SandboxError(`Unable to read config file: ${configPath}`, {
      code: "CONFIG_READ",
      cause: error,
    });
  }
  const config = parseConfig(text);
  config.path = path.resolve(configPath);
  config.present = true;
  return config;
}

export function defaultSandboxConfig() {
  return defaultConfig();
}
