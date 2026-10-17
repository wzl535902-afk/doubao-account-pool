import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const buildDir = process.env.POOL_TEST_BUILD_DIR
  ? pathToFileURL(path.resolve(process.env.POOL_TEST_BUILD_DIR)).href
  : new URL("../dist-electron", import.meta.url).href;
const { RunRegistry, RunAbortedError } = await import(`${buildDir}/run-watchdog.js`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRegistry(overrides = {}) {
  const events = { heartbeats: 0, aborts: [] };
  const registry = new RunRegistry({
    heartbeatIntervalMs: 10,
    abortGraceMs: 40,
    stallLimitMs: () => 60,
    hardDeadlineMs: () => 10_000,
    onHeartbeat: () => {
      events.heartbeats += 1;
    },
    onAbort: (ctx, reason) => {
      events.aborts.push({ requestId: ctx.requestId, reason, submitted: ctx.submitted });
    },
    ...overrides
  });
  return { registry, events };
}

function fakeWindow(onDestroy = () => undefined) {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      onDestroy();
    }
  };
}

test("a normal run completes without abort and is unregistered", async () => {
  const { registry, events } = makeRegistry();
  let seen;
  await registry.run("r1", "generate", async () => {
    seen = registry.current()?.requestId;
    assert.equal(registry.isActive("r1"), true);
    for (let i = 0; i < 5; i += 1) {
      await sleep(10);
      registry.touch();
    }
  });
  assert.equal(seen, "r1");
  assert.equal(registry.isActive("r1"), false);
  assert.equal(registry.current(), undefined);
  assert.deepEqual(events.aborts, []);
  assert.ok(events.heartbeats >= 1);
});

test("a hung run is aborted as stalled, its window destroyed, and the slot released after the grace period", async () => {
  const { registry, events } = makeRegistry();
  const win = fakeWindow();
  const startedAt = Date.now();
  let lateTouchError = null;
  let hungWork;
  await registry.run("r2", "generate", async () => {
    registry.registerWindow(win);
    registry.markSubmitted();
    hungWork = new Promise(() => undefined); // 模拟 CDP sendCommand 永不返回
    setTimeout(() => {
      try {
        registry.touch();
      } catch (error) {
        lateTouchError = error;
      }
    }, 200);
    await hungWork;
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 60, `released too early: ${elapsed}ms`);
  assert.ok(elapsed < 1000, `released too late: ${elapsed}ms`);
  assert.equal(win.isDestroyed(), true);
  assert.deepEqual(events.aborts, [{ requestId: "r2", reason: "stalled", submitted: true }]);
  assert.equal(registry.isActive("r2"), false);
  await sleep(220);
  assert.ok(lateTouchError instanceof RunAbortedError, "stale flow must not be able to write progress");
});

test("abort(abandoned) finalizes once; a flow that fails because its window died does not wait for grace", async () => {
  const { registry, events } = makeRegistry({ abortGraceMs: 5_000 });
  let rejectPending;
  const win = fakeWindow(() => rejectPending(new Error("窗口已销毁")));
  const startedAt = Date.now();
  const running = registry.run("r3", "generate", async () => {
    registry.registerWindow(win);
    await new Promise((_, reject) => {
      rejectPending = reject;
    });
  });
  await sleep(15);
  assert.equal(registry.abort("r3", "abandoned"), true);
  assert.equal(registry.abort("r3", "stalled"), true, "second abort is a no-op but the run is still registered until it settles");
  await running;
  assert.ok(Date.now() - startedAt < 1000);
  assert.deepEqual(events.aborts, [{ requestId: "r3", reason: "abandoned", submitted: false }]);
  assert.equal(registry.abort("r3", "abandoned"), false);
});

test("regular progress keeps a long run alive", async () => {
  const { registry, events } = makeRegistry();
  await registry.run("r4", "generate", async () => {
    for (let i = 0; i < 12; i += 1) {
      await sleep(15);
      registry.touch();
    }
  });
  assert.deepEqual(events.aborts, []);
});

test("the hard deadline aborts a run that keeps reporting progress", async () => {
  const { registry, events } = makeRegistry({ hardDeadlineMs: () => 50 });
  await registry.run("r5", "recover", async () => {
    for (;;) {
      await sleep(10);
      registry.touch();
    }
  });
  assert.deepEqual(events.aborts, [{ requestId: "r5", reason: "deadline", submitted: false }]);
});

test("ordinary failures propagate and do not trigger onAbort", async () => {
  const { registry, events } = makeRegistry();
  await assert.rejects(
    registry.run("r6", "generate", async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.deepEqual(events.aborts, []);
  assert.equal(registry.isActive("r6"), false);
});

test("concurrent runs keep separate contexts", async () => {
  const { registry } = makeRegistry();
  const seen = [];
  await Promise.all(["a", "b"].map((id) =>
    registry.run(id, "generate", async () => {
      await sleep(id === "a" ? 20 : 5);
      seen.push([id, registry.current()?.requestId]);
    })
  ));
  assert.deepEqual(seen.sort(), [["a", "a"], ["b", "b"]]);
});

test("the same request cannot run twice at once", async () => {
  const { registry } = makeRegistry();
  let release;
  const first = registry.run("dup", "generate", () => new Promise((resolve) => {
    release = resolve;
  }));
  await assert.rejects(registry.run("dup", "generate", async () => undefined), /已在执行中/);
  release();
  await first;
});

test("windows registered after an abort are destroyed immediately", async () => {
  const { registry } = makeRegistry({ abortGraceMs: 30 });
  const late = fakeWindow();
  const running = registry.run("r7", "generate", async () => {
    await sleep(20);
    registry.registerWindow(late);
  });
  await sleep(5);
  registry.abort("r7", "abandoned");
  await running;
  assert.equal(late.isDestroyed(), true);
});
