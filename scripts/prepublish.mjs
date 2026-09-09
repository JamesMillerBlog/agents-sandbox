import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
let packageJson;
try {
  packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
} catch (error) {
  process.stderr.write(
    `Release check failed: unable to read package.json: ${error.message}\n`,
  );
  process.exit(1);
}

/** @param {string[]} args @returns {string} */
function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** @param {string} message */
function fail(message) {
  throw new Error(`Release check failed: ${message}`);
}

/** @param {string} label @param {string} command @param {string[]} args */
function run(label, command, args) {
  process.stdout.write(`→ ${label}\n`);
  execFileSync(command, args, {
    cwd: root,
    shell: false,
    stdio: "inherit",
  });
}

function assertCleanSynchronizedMain() {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail("Git worktree is not clean.");

  const branch = git(["branch", "--show-current"]);
  if (branch !== "main")
    fail(`publication must run from main, not ${branch || "detached HEAD"}.`);

  let upstream;
  try {
    upstream = git([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
  } catch {
    fail("main has no configured upstream.");
  }

  const head = git(["rev-parse", "HEAD"]);
  const upstreamHead = git(["rev-parse", upstream]);
  if (head !== upstreamHead)
    fail(
      `HEAD is not synchronized with ${upstream}; pull or push before publishing.`,
    );
}

function assertPackageIdentity() {
  if (packageJson.name !== "agents-sandbox")
    fail(`unexpected package name: ${packageJson.name}`);
  if (packageJson.license !== "AGPL-3.0-only")
    fail(`unexpected package license: ${packageJson.license}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version))
    fail(`invalid package version: ${packageJson.version}`);
}

try {
  assertCleanSynchronizedMain();
  assertPackageIdentity();
  run("Run tests", "npm", ["test"]);
  run("Type check", "npm", ["run", "typecheck"]);
  run("Lint", "npm", ["run", "lint"]);
  run("Syntax check", "npm", ["run", "check:syntax"]);
  run("Package allowlist and privacy check", "npm", ["run", "check:package"]);
  run("Dependency audit", "npm", ["audit", "--audit-level=high"]);
  process.stdout.write(
    `Release check passed for ${packageJson.name}@${packageJson.version}.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
