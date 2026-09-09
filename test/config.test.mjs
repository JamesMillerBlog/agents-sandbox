import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import {
  assertNoSocketDescendants,
  expandPath,
  loadConfig,
  parseConfig,
  validateMount,
} from "../src/config.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agents-sandbox-config-"));
}

test("parses security, state scope, and default read-only mounts", () => {
  const config = parseConfig(`
    version = 1
    [project]
    state_scope = "repository"
    [security]
    git_write = false
    network = "none"
    [[mounts]]
    source = "$SAFE_DIR"
    target = "/mnt/safe"
  `);
  assert.equal(config.project.state_scope, "repository");
  assert.equal(config.security.network, "none");
  assert.equal(config.mounts[0].mode, "ro");
});

test("expands home and braced/unbraced variables", () => {
  assert.equal(
    expandPath("~/docs", { home: "/tmp/home", env: {} }),
    "/tmp/home/docs",
  );
  assert.equal(
    expandPath("$ROOT/${NAME}", {
      env: { ROOT: "/tmp", NAME: "thing" },
      home: "/unused",
    }),
    "/tmp/thing",
  );
  assert.throws(
    () => expandPath("$MISSING", { env: {}, home: "/tmp/home" }),
    /MISSING/,
  );
});

test("validates and canonicalizes a safe mount", () => {
  const root = tempDir();
  const home = path.join(root, "home");
  const source = path.join(home, "source");
  fs.mkdirSync(source, { recursive: true });
  const result = validateMount(
    { source: "$SOURCE", target: "/mnt/source" },
    { env: { SOURCE: source }, home },
  );
  assert.equal(result.source, fs.realpathSync(source));
  assert.equal(result.mode, "ro");
  assert.equal(result.target, "/mnt/source");
});

test("rejects missing, dangerous, and traversal mounts", () => {
  const root = tempDir();
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  assert.throws(
    () =>
      validateMount(
        { source: path.join(home, "missing"), target: "/mnt/x" },
        { home },
      ),
    /does not exist/,
  );
  assert.throws(
    () => validateMount({ source: "/", target: "/mnt/x" }, { home }),
    /dangerous/,
  );
  assert.throws(
    () =>
      validateMount(
        { source: "${HOME}/..", target: "/mnt/home-parent" },
        { home, env: { HOME: home } },
      ),
    /home ancestor|dangerous/,
  );
  assert.throws(
    () =>
      validateMount(
        { source: path.dirname(home), target: "/mnt/home-parent-2" },
        { home },
      ),
    /home ancestor|dangerous/,
  );
  for (const systemRoot of ["/Users", "/home"]) {
    const relativeHome = path.relative(systemRoot, os.homedir());
    const isHomeAncestor =
      fs.existsSync(systemRoot) &&
      relativeHome !== "" &&
      relativeHome !== ".." &&
      !relativeHome.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeHome);
    if (isHomeAncestor) {
      assert.throws(
        () =>
          validateMount(
            { source: systemRoot, target: "/mnt/system-home" },
            { home: os.homedir() },
          ),
        /home ancestor|dangerous/,
      );
    }
  }
  assert.throws(
    () => validateMount({ source: root, target: "/mnt/../etc" }, { home }),
    /\.\.|home ancestor/,
  );
  const ssh = path.join(home, ".ssh");
  fs.mkdirSync(ssh);
  assert.throws(
    () => validateMount({ source: ssh, target: "/mnt/ssh" }, { home }),
    /credential|private|dangerous/,
  );
  const credentials = path.join(home, "Credentials");
  fs.mkdirSync(credentials);
  assert.throws(
    () =>
      validateMount(
        { source: credentials, target: "/mnt/credentials" },
        { home },
      ),
    /credential|private|dangerous/,
  );
  const configDir = path.join(home, ".config", "gh");
  fs.mkdirSync(configDir, { recursive: true });
  assert.throws(
    () => validateMount({ source: configDir, target: "/mnt/gh" }, { home }),
    /broad .*config/,
  );
  const configFile = path.join(configDir, "hosts.yml");
  fs.writeFileSync(configFile, "hosts: []\n");
  assert.throws(
    () =>
      validateMount({ source: configFile, target: "/mnt/gh-hosts" }, { home }),
    /broad .*config/,
  );
  const claudeEnv = path.join(home, ".claude", ".env");
  fs.mkdirSync(path.dirname(claudeEnv), { recursive: true });
  fs.writeFileSync(claudeEnv, "TOKEN=not-a-real-token\n");
  assert.throws(
    () =>
      validateMount({ source: claudeEnv, target: "/mnt/claude-env" }, { home }),
    /credential|private|dangerous/,
  );
  const real = path.join(home, "real");
  const link = path.join(home, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  assert.throws(
    () => validateMount({ source: link, target: "/mnt/link" }, { home }),
    /symlink/,
  );
  for (const runtimePath of ["/var", "/var/run", "/private", "/private/var"]) {
    if (fs.existsSync(runtimePath)) {
      assert.throws(
        () =>
          validateMount(
            { source: runtimePath, target: "/mnt/runtime" },
            { home },
          ),
        /runtime|dangerous|home ancestor/,
      );
    }
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.throws(
      () =>
        validateMount(
          { source: home.toUpperCase(), target: "/mnt/home" },
          { home },
        ),
      /dangerous/,
    );
  }
});

test("rejects sibling home trees but allows the current home", () => {
  const root = tempDir();
  const home = path.join(root, "home");
  const sibling = path.join(root, "other-user");
  const project = path.join(home, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sibling);
  assert.doesNotThrow(() =>
    validateMount({ source: project, target: "/mnt/project" }, { home }),
  );
  assert.throws(
    () =>
      validateMount({ source: sibling, target: "/mnt/other-user" }, { home }),
    /another host-home tree/,
  );
  if (fs.existsSync("/root")) {
    assert.throws(
      () => validateMount({ source: "/root", target: "/mnt/root" }, { home }),
      /host-home|dangerous/,
    );
  }
});

test("rejects sensitive variables and expansion in mount paths", () => {
  const root = tempDir();
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  assert.throws(
    () =>
      validateMount(
        { source: "$GH_TOKEN", target: "/mnt/source" },
        { env: { GH_TOKEN: source }, home: path.dirname(root) },
      ),
    (error) =>
      /Sensitive environment variable/.test(error.message) &&
      !error.message.includes("topsecret"),
  );
  assert.throws(
    () =>
      validateMount(
        { source, target: "/mnt/$GH_TOKEN" },
        { env: { GH_TOKEN: "topsecret" }, home: path.dirname(root) },
      ),
    (error) =>
      /literal absolute paths/.test(error.message) &&
      !error.message.includes("topsecret"),
  );
});

test("rejects symlink mount roots with trailing path syntax", () => {
  const root = tempDir();
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, "dir");
  for (const source of [`${link}/`, `${link}/.`]) {
    assert.throws(
      () =>
        validateMount(
          { source, target: "/mnt/link" },
          { home: path.dirname(root) },
        ),
      /symlink/,
    );
  }
});

test("does not treat descendant ENOENT as an optional scan success", () => {
  const root = "/tmp/agents-sandbox-scan-root";
  const directory = { isDirectory: () => true, isSocket: () => false };
  const fileSystem = {
    lstatSync(source) {
      if (source === root) return directory;
      const error = new Error("gone");
      error.code = "ENOENT";
      throw error;
    },
    readdirSync: () => [{ name: "missing", isSymbolicLink: () => false }],
  };
  assert.throws(
    () =>
      assertNoSocketDescendants(root, {
        fsImpl: fileSystem,
        optional: true,
      }),
    /Unable to inspect mount source: .*missing/,
  );
});

test("rejects Unix sockets nested in directory mounts", async () => {
  if (process.platform === "win32") return;
  const root = tempDir();
  const mount = path.join(root, "mount");
  const socket = path.join(mount, "agent.sock");
  fs.mkdirSync(mount);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  try {
    assert.throws(
      () =>
        validateMount(
          { source: mount, target: "/mnt/mount" },
          { home: path.dirname(root) },
        ),
      /Unix socket/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socket, { force: true });
  }
});

test("allows explicit safe Pi settings but not broad Pi state", () => {
  const root = tempDir();
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  fs.mkdirSync(agent, { recursive: true });
  const settings = path.join(agent, "settings.json");
  fs.writeFileSync(settings, "{}");
  assert.equal(
    validateMount(
      { source: settings, target: "/home/sandbox/.pi/agent/settings.json" },
      { home },
    ).kind,
    "file",
  );
  assert.throws(
    () =>
      validateMount(
        { source: path.join(home, ".pi"), target: "/mnt/pi" },
        { home },
      ),
    /broad .*pi/,
  );
});

test("missing default config is safe and explicit missing config fails", () => {
  const root = tempDir();
  const missing = path.join(root, ".agent-sandbox.toml");
  assert.equal(loadConfig(missing).present, false);
  assert.throws(() => loadConfig(missing, { optional: false }), /not found/);
});
