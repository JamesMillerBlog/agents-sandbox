# Security model

This package treats Docker as the process boundary. It is not a replacement for
reviewing an agent's prompts, dependencies, or requested host mounts. Docker
access is privileged on most hosts: a user who can control the Docker daemon
can generally control the host. Do not expose `/var/run/docker.sock` to an
agent container.

Every run defaults to:

- a read-only container root filesystem and a small `/tmp` tmpfs;
- all Linux capabilities dropped and `no-new-privileges` enabled;
- the host uid/gid, not root, as the container user;
- `bridge` networking (or explicitly configured `none`), never host networking;
- an active-worktree bind mount plus narrowly scoped state/config mounts;
- no host home, SSH, GPG, Docker socket, or complete environment mount;
- Git metadata read-only unless both `security.git_write=true` and
  `AGENT_SANDBOX_GIT_WRITE=1` are set; the builder enforces both checks.

The worktree is intentionally read/write because editing is the package's
purpose. A configured `rw` additional mount grants the same deletion/write
power to that host path. Prefer `ro`, review the printed mount summary, and
keep persistent Pi/Claude state treated as sensitive because it can contain
provider credentials or session data.

Image tags are deployment policy. Use digest-pinned images in production and
verify the included Dockerfiles and agent package versions before publishing.
The launcher never builds or pulls images, passes `--pull=never` to Docker, and
never falls back to a host-installed agent.

The linked-worktree common Git directory is exposed at its original path so
Git's absolute `.git` pointers continue to resolve. This is why metadata
writes are opt-in and why an agent should not be granted Git write access just
to edit files. Additional writable mounts cannot overlap or re-expose Git
metadata.

## Pi OAuth bootstrap

Pi's file-based OAuth state is the one intentional credential exception. When
`~/.pi/agent/auth.json` exists and has no group/world permissions, the launcher
bind-mounts that exact file read-only at `/run/agents-sandbox/pi-auth.json`.
The Pi image entrypoint seeds `/home/sandbox/.pi/agent/auth.json` in the
worktree/profile state volume once per volume, recording a non-secret marker.
This migrates stale pre-bootstrap placeholders while allowing Pi to refresh
credentials in persistent state without the host file being writable or
re-copied on later launches.

The implementation does not mount `~/.pi`, the complete agent directory, or
any Claude credential path. It rejects missing/insecure/symlinked auth sources,
keeps the path out of mount summaries, and does not expose auth contents in
logs. User-configured mounts still pass through the normal dangerous-path
rejection rules.

## Optional Herdr integration

Herdr integration is host-side and disabled unless `AGENT_SANDBOX_HERDR=1` is
set. With a valid `HERDR_PANE_ID`, the launcher invokes the fixed `herdr` CLI
with `shell=false` to report display metadata and coarse lifecycle state. The
Herdr Unix socket is never mounted, and `HERDR_*` variables are not included in
the container environment. If Herdr is missing or rejects a report, the
launcher warns and continues without integration.
