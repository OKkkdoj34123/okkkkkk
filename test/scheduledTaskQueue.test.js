import assert from "node:assert/strict";
import { test } from "node:test";
import { ScheduledTaskQueue } from "../src/utils/scheduledTaskQueue.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("queued tasks run one at a time in FIFO order", async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  const queue = new ScheduledTaskQueue(async (task) => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push("start:" + task.id);
    await tick();
    order.push("end:" + task.id);
    active--;
  });

  queue.enqueue({ id: "a", name: "A" });
  queue.enqueue({ id: "b", name: "B" });
  queue.enqueue({ id: "c", name: "C" });

  // 等待队列跑空
  while (queue.busy || queue.size > 0) await tick();

  assert.equal(maxActive, 1, "never run two tasks concurrently");
  assert.deepEqual(order, [
    "start:a", "end:a",
    "start:b", "end:b",
    "start:c", "end:c",
  ]);
});

test("duplicate enqueue of same task id is ignored", async () => {
  let runs = 0;
  const queue = new ScheduledTaskQueue(async () => {
    runs++;
    await tick();
  });

  const first = queue.enqueue({ id: "dup", name: "D" });
  const second = queue.enqueue({ id: "dup", name: "D" });
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.match(second.reason, /队列中|执行中/);

  while (queue.busy || queue.size > 0) await tick();
  assert.equal(runs, 1);
});

test("has() reflects queued and running tasks", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const queue = new ScheduledTaskQueue(async () => {
    await gate;
  });

  queue.enqueue({ id: "x", name: "X" });
  await tick();
  assert.equal(queue.has("x"), true, "running task is tracked");
  queue.enqueue({ id: "y", name: "Y" });
  assert.equal(queue.has("y"), true, "queued task is tracked");
  assert.equal(queue.has("z"), false);

  release();
  while (queue.busy || queue.size > 0) await tick();
  assert.equal(queue.has("x"), false);
});

test("clear removes pending tasks but keeps the running one", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const queue = new ScheduledTaskQueue(async (task) => {
    order.push("start:" + task.id);
    if (task.id === "run") await gate;
    order.push("end:" + task.id);
  });

  queue.enqueue({ id: "run", name: "Run" });
  await tick();
  queue.enqueue({ id: "wait1", name: "W1" });
  queue.enqueue({ id: "wait2", name: "W2" });
  assert.equal(queue.size, 2);

  const removed = queue.clear();
  assert.equal(removed, 2);
  assert.equal(queue.size, 0);
  assert.equal(queue.currentTask.id, "run");

  release();
  while (queue.busy || queue.size > 0) await tick();
  assert.deepEqual(order, ["start:run", "end:run"], "cleared tasks never ran");
});

test("a failing task does not block the queue", async () => {
  const order = [];
  const events = [];
  const queue = new ScheduledTaskQueue(async (task) => {
    order.push(task.id);
    if (task.id === "bad") throw new Error("boom");
  });
  queue.onChange((event, detail) => events.push(event));

  queue.enqueue({ id: "bad" });
  queue.enqueue({ id: "good" });
  while (queue.busy || queue.size > 0) await tick();

  assert.deepEqual(order, ["bad", "good"]);
  assert.ok(events.includes("failed"), "failure event emitted");
  assert.ok(events.includes("completed"), "later task still completes");
});
