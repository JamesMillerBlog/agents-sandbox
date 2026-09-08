# Agents Sandbox

`agents-sandbox` provides one explicit Docker-backed CLI for running Pi or Claude Code inside the current Git worktree. It never replaces or shadows the native `pi` or `claude` commands.

## Install

From npm:

```sh
npm install --global agents-sandbox
```

From a local checkout while developing the package:

```sh
npm install --global /path/to/agents-sandbox
# or, from the package checkout:
npm link --global
```

A local project can also depend on the checkout with `npm install /path/to/agents-sandbox`; use the installed `sandbox` binary from that project or `npx --package agents-sandbox sandbox`.

The host needs Node.js 20+, Git, and Docker. Docker must be running; Compose is not required for normal operation.

## Usage

The public interface is deliberately explicit:

```sh
sandbox pi
sandbox pi --resume
sandbox pi --continue
sandbox pi --session <id>
sandbox pi --session-id <id>

sandbox claude
sandbox claude --resume
sandbox claude --continue
```

All arguments after `pi` or `claude` are forwarded unchanged and in order. The optional `--` separator is only needed when an agent argument could be mistaken for a `sandbox` wrapper option:

```sh
sandbox pi -- --config ./agent-settings.json
```

Wrapper options must appear before `--`:

```sh
sandbox pi --profile review --resume
sandbox pi --config ./custom-agent-sandbox.toml --continue
```

## Optional Herdr integration

Herdr reporting is disabled by default. Opt in from a Herdr pane by setting the
pane identifier and enabling the host-side adapter:

```sh
herdr pane list
AGENT_SANDBOX_HERDR=1 HERDR_PANE_ID=1-1 sandbox pi
AGENT_SANDBOX_HERDR=1 HERDR_PANE_ID=1-1 sandbox claude
```

The adapter invokes the host `herdr` CLI with fixed arguments to report the
sandbox display name and coarse `working`/`idle`/`unknown` lifecycle. It does
not mount the Herdr socket, pass `HERDR_*` variables into Docker, or grant the
agent Herdr control. Missing or unavailable Herdr reporting emits a warning and
does not stop the sandbox run.

Agents Sandbox inherits exported shell variables. With `direnv`, put the opt-in
in a trusted `.envrc`:

```sh
export AGENT_SANDBOX_HERDR=1
export HERDR_PANE_ID=1-1
```

```sh
direnv allow
sandbox pi
```

A `.env` file is not parsed automatically. If using one, load it explicitly
from `.envrc` with `dotenv_if_exists .env`, or source a trusted file before
launching. Do not commit pane identifiers or credentials.

## Images

The launcher never builds or pulls images automatically. Build the included images locally:

```sh
docker build -f docker/Dockerfile.pi -t agents-sandbox:pi-0.84.4 .
docker build -f docker/Dockerfile.claude -t agents-sandbox:claude-2.1.150 .
```

The default image names are local and publisher-neutral. Use registry images explicitly when desired:

```sh
AGENT_SANDBOX_PI_IMAGE=registry.example/org/pi:tag sandbox pi
AGENT_SANDBOX_CLAUDE_IMAGE=registry.example/org/claude:tag sandbox claude
```

The images contain Node, Git, Python, GitHub CLI, shell utilities, and the relevant agent. They run as non-root users. Publish multi-architecture images if distributing them.

## Worktrees and state

The launcher resolves the active checkout with:

```text
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
```

The active worktree is mounted read/write at `/workspace`. Normal and linked worktrees are supported. Git metadata is mounted at the paths Git expects and is read-only by default. Enable Git metadata writes only when required. Both the project policy and environment confirmation are required:

```toml
[security]
git_write = true
```

```sh
AGENT_SANDBOX_GIT_WRITE=1 sandbox pi
```

State identity uses the canonical worktree path and a stable hash. Switching branches in one worktree keeps the same state; separate linked worktrees and repositories get separate state. State can also be separated intentionally with `--profile NAME` or `AGENT_SANDBOX_PROFILE`.

Pi and Claude use different persistence mechanisms:

- **Pi:** host sessions under `~/.pi/agent/sessions`, mounted into the container. Pi sessions can be resumed with `--resume`, `--continue`, `--session`, or `--session-id`. The complete sessions root is visible to the Pi container so existing sessions remain resumable; treat other sessions beneath it as sensitive.
- **Claude Code:** a named Docker volume scoped to the worktree/profile. `docker run --rm` removes only the container, not the volume. The `agents-sandbox` volume prefix is new; pre-release volumes are not reused automatically and remain untouched.

## Optional project configuration

Create `.agent-sandbox.toml` in the repository root, or pass `--config PATH`:

```toml
version = 1

[project]
state_scope = "worktree" # or "repository"

[security]
git_write = false
network = "bridge" # or "none"

[[mounts]]
source = "~/Documents/Second Brain"
target = "/mnt/second-brain"
mode = "ro"
```

For machine-specific paths, use an environment variable instead of committing a host path:

```toml
[[mounts]]
source = "${SECOND_BRAIN_DIR}"
target = "/mnt/second-brain"
mode = "rw"
```

```sh
export SECOND_BRAIN_DIR="$HOME/Documents/Second Brain"
sandbox pi
```

Mount rules:

- `~`, `$NAME`, and `${NAME}` are expanded only in host source paths; sensitive variable names are rejected.
- Resolved host sources must be absolute, existing regular files/directories, and contain no Unix sockets.
- Container targets must be literal absolute, non-protected paths; shell/environment expansion is rejected.
- Unspecified modes default to `ro`; valid modes are only `ro` and `rw`.
- `rw` means the agent can modify or delete files in that host directory.
- Root, home directories, Docker sockets, runtime/device paths, SSH/GPG files, credential stores, environment files, and broad Pi/Claude configuration directories are rejected.
- No arbitrary host directory is mounted automatically.
- The final mount summary is printed before Docker starts.

Only explicitly configured mounts are added. `.devcontainer/devcontainer.json`, Compose files, `.env` files, `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, and host agent settings are not blindly inherited as runtime or security policy. Select individual safe files/directories with explicit mounts when needed; sensitive paths fail closed.

## Security defaults

Every run uses Docker with:

- read-only container root filesystem;
- writable `/tmp` tmpfs only;
- all Linux capabilities dropped;
- `no-new-privileges`;
- a non-root container user;
- no Docker socket;
- no unrestricted host-home, SSH, GPG, or credential mounts;
- read-only Git metadata unless explicitly opted in;
- an explicit environment allowlist, separated by engine.

Docker is the only runtime backend. There is no native-host fallback and no bubblewrap path. If Docker or its daemon is unavailable, the launcher exits with a clear error.

## Licensing

Agents Sandbox is licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). Commercial licensing terms are not currently published; any proprietary exception requires a separate written agreement from the relevant copyright holders.

The AGPL covers this repository's code, not Claude Code, Pi, Node.js, Debian, or other third-party components used by the Dockerfiles. Do not assume this license permits redistribution or hosted commercial use of those components.

External contributions are not currently accepted under a dual-licensing arrangement. A contributor policy and rights agreement must be established before accepting contributions that need future commercial relicensing.

## Development

```sh
npm install
npm test
npm run typecheck
npm run lint
npm run check:package
npm run pack:check
```

Tests inject Git and Docker runners and do not require a Docker daemon. The package has no Compose dependency for basic operation; Compose may still be used separately for project services.

## Publishing

Publishing requires clean, synchronized `main`. Authenticate with npm first:

```sh
npm login
npm whoami
```

Run safe release validation without publishing:

```sh
pnpm run release:check
```

Preview the package, then publish it publicly:

```sh
pnpm publish --dry-run
pnpm publish
```

`pnpm publish` runs `prepublishOnly`, which invokes the release checks before
pnpm performs the actual npm publication. Publication is irreversible; this
command does not create Git tags or GitHub Releases. Tag the merged release
commit separately, for example `git tag -a v0.1.0 -m "Release v0.1.0"`.
