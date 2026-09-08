import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();

function parseJson(value, label, fallback) {
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error(`Unable to parse ${label}: ${error.message}`);
    process.exitCode = 1;
    return fallback;
  }
}

const packageJson = parseJson(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
  "package.json",
  {},
);

const expectedFiles = new Set([
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "bin/sandbox.mjs",
  "docker/Dockerfile.claude",
  "docker/Dockerfile.pi",
  "package.json",
  "scripts/check-syntax.mjs",
  "scripts/check-package.mjs",
  "src/cli.mjs",
  "src/config.mjs",
  "src/docker-runner.mjs",
  "src/docker-spec.mjs",
  "src/errors.mjs",
  "src/git-worktree.mjs",
  "src/herdr.mjs",
  "src/state.mjs",
]);

const packageReport = parseJson(
  execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
  "npm pack report",
  [],
);
const packedFiles = new Set(
  packageReport.flatMap((entry) => entry.files ?? []).map((file) => file.path),
);

const unexpectedFiles = [...packedFiles].filter(
  (file) => !expectedFiles.has(file),
);
const missingFiles = [...expectedFiles].filter(
  (file) => !packedFiles.has(file),
);
if (unexpectedFiles.length > 0 || missingFiles.length > 0) {
  if (unexpectedFiles.length > 0)
    console.error(`Unexpected package files:\n${unexpectedFiles.join("\n")}`);
  if (missingFiles.length > 0)
    console.error(`Missing package files:\n${missingFiles.join("\n")}`);
  process.exitCode = 1;
}

const userPathSegment = ["User", "s"].join("");
const homePathSegment = ["hom", "e"].join("");
const privateKeyKinds = ["RSA", "OPENSSH", "EC", "DSA", "PRIVATE"].join("|");
const credentialPrefixes = [
  ["gh", "p_"].join(""),
  ["github", "_pat_"].join(""),
  ["xox", "[baprs]-"].join(""),
  "sk-",
].join("|");
const forbiddenContent = [
  new RegExp(
    `/${userPathSegment}/[A-Za-z0-9._-]+(?:/|$)`,
    "u",
  ),
  new RegExp(
    `/${homePathSegment}/(?!sandbox(?:/|$))[A-Za-z0-9._-]+(?:/|$)`,
    "u",
  ),
  new RegExp(`-----BEGIN (?:${privateKeyKinds}) KEY-----`, "u"),
  new RegExp(`\\b(?:${credentialPrefixes})[A-Za-z0-9]{20,}`, "u"),
];
for (const file of packedFiles) {
  const content = fs.readFileSync(path.join(root, file), "utf8");
  for (const pattern of forbiddenContent) {
    if (pattern.test(content)) {
      console.error(`Forbidden private or credential-like content in ${file}`);
      process.exitCode = 1;
      break;
    }
  }
}

if (packageJson.name !== "agents-sandbox") {
  console.error(`Unexpected package name: ${packageJson.name}`);
  process.exitCode = 1;
}
if (packageJson.license !== "AGPL-3.0-only") {
  console.error(`Unexpected package license: ${packageJson.license}`);
  process.exitCode = 1;
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`Package check passed: ${packedFiles.size} files, no private content.`);
