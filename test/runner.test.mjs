import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { checkDocker, runDocker } from "../src/docker-runner.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.kills = [];
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal) {
    this.kills.push(signal);
  }
}

class FakeSignals extends EventEmitter {}

test("runs Docker with an argv array, inherited stdio, and propagates exit status", async () => {
  const child = new FakeChild();
  const signalSource = new FakeSignals();
  let invocation;
  const promise = runDocker(["run", "--rm", "image", "--resume"], {
    checkDockerImpl: async () => {},
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("exit", 17, null));
      return child;
    },
    env: { PATH: "/host/path" },
    signalSource,
  });
  assert.equal(await promise, 17);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args, ["run", "--rm", "image", "--resume"]);
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.DOCKER_HOST, undefined);
});

test("forwards termination signals to Docker", async () => {
  const child = new FakeChild();
  const signalSource = new FakeSignals();
  const promise = runDocker(["run"], {
    checkDockerImpl: async () => {},
    spawnImpl() {
      return child;
    },
    signalSource,
  });
  await new Promise((resolve) => setImmediate(resolve));
  signalSource.emit("SIGINT");
  child.emit("exit", null, "SIGINT");
  assert.equal(await promise, 130);
  assert.deepEqual(child.kills, ["SIGINT"]);
});

test("reports Docker unavailable without a shell fallback", async () => {
  await assert.rejects(
    runDocker(["run"], {
      dockerPreflight: false,
      spawnImpl() {
        const child = new FakeChild();
        queueMicrotask(() =>
          child.emit(
            "error",
            Object.assign(new Error("missing"), { code: "ENOENT" }),
          ),
        );
        return child;
      },
      signalSource: new FakeSignals(),
    }),
    (error) =>
      error.code === "DOCKER_UNAVAILABLE" &&
      /Docker is unavailable/.test(error.message),
  );
});

test("reports a missing Docker CLI during health check", async () => {
  await assert.rejects(
    checkDocker({
      spawnImpl() {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    }),
    (error) =>
      error.code === "DOCKER_UNAVAILABLE" &&
      /Docker is unavailable/.test(error.message),
  );
});

test("reports a stopped Docker daemon clearly", async () => {
  const child = new FakeChild();
  const promise = checkDocker({
    spawnImpl(command, args, options) {
      assert.equal(command, "docker");
      assert.deepEqual(args, ["info", "--format", "{{.ServerVersion}}"]);
      assert.equal(options.shell, false);
      queueMicrotask(() => {
        child.stderr.emit(
          "data",
          Buffer.from("Cannot connect to the Docker daemon"),
        );
        child.emit("exit", 1, null);
      });
      return child;
    },
    env: { DOCKER_HOST: "ignored" },
  });
  await assert.rejects(
    promise,
    (error) =>
      error.code === "DOCKER_DAEMON_UNAVAILABLE" &&
      /daemon is unavailable/.test(error.message),
  );
});
