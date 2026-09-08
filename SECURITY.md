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
