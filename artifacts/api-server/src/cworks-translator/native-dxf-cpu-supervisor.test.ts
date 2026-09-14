import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CpuAwareProcessError,
  createLinuxProcCpuReader,
  linuxProcCpuTicks,
  linuxProcSample,
  superviseCpuAwareProcess,
  type CpuAwareProcess,
  type CpuClock,
} from "./native-dxf-cpu-supervisor";

class FakeClock implements CpuClock {
  private current = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.current;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => this.timers.delete(handle as number);
  advance(ms: number) {
    const target = this.current + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.current = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.current = target;
  }
  count() { return this.timers.size; }
}

class FakeChild extends EventEmitter implements CpuAwareProcess {
  pid = 4321;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  closeOnTerm = true;

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.closeOnTerm) this.emit("close", null, signal);
    return true;
  }
  succeed() { this.emit("close", 0, null); }
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function fakeOptions(clock: FakeClock, child: FakeChild, readCpuMs: (pid: number) => Promise<number>) {
  return {
    clock,
    readCpuMs,
    spawnProcess: () => child,
    pollIntervalMs: 60_000,
    noCpuProgressTimeoutMs: 5 * 60_000,
    cpuBudgetMs: 10_000,
    killGraceMs: 10,
  };
}

test("CPU supervision allows throttled work past the former twelve-minute wall deadline", async () => {
  const clock = new FakeClock();
  const child = new FakeChild();
  const result = superviseCpuAwareProcess("python3", ["processor.py"], fakeOptions(
    clock, child, async () => Math.floor(clock.now() / 60_000) * 10,
  ));
  await flush();
  // 13 minutes elapsed, but low CPU advances each minute and is below budget.
  for (let minute = 0; minute < 13; minute++) {
    clock.advance(60_000);
    await flush();
  }
  assert.deepEqual(child.signals, []);
  child.succeed();
  await result;
});

test("CPU work budget and no-progress watchdog have distinct redacted reasons", async () => {
  const clock = new FakeClock();
  const exhausted = new FakeChild();
  const budget = superviseCpuAwareProcess("python3", ["processor.py"], fakeOptions(
    clock, exhausted, async () => clock.now() >= 60_000 ? 10_000 : 0,
  ));
  await flush();
  clock.advance(60_000);
  await flush();
  await assert.rejects(budget, (error: unknown) =>
    error instanceof CpuAwareProcessError && error.reason === "cpu_budget_exhausted");
  assert.deepEqual(exhausted.signals, ["SIGTERM"]);
  assert.equal(clock.count(), 0, "all watchdog and grace timers are cleaned up");

  const stalledClock = new FakeClock();
  const stalled = new FakeChild();
  const stall = superviseCpuAwareProcess("python3", ["processor.py"], fakeOptions(
    stalledClock, stalled, async () => 0,
  ));
  await flush();
  for (let minute = 0; minute < 5; minute++) {
    stalledClock.advance(60_000);
    await flush();
  }
  await assert.rejects(stall, (error: unknown) =>
    error instanceof CpuAwareProcessError && error.reason === "no_cpu_progress");
});

test("lease abort terminates the child group and waits for cleanup", async () => {
  const controller = new AbortController();
  const clock = new FakeClock();
  const child = new FakeChild();
  const pending = superviseCpuAwareProcess("python3", ["processor.py"], {
    ...fakeOptions(clock, child, async () => 0),
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof CpuAwareProcessError && error.reason === "aborted");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(clock.count(), 0);
});

test("abort reaps a detached root's background descendant", {
  skip: process.platform !== "linux",
}, async () => {
  const controller = new AbortController();
  let resolveDescendantPid!: (pid: number) => void;
  const descendantPid = new Promise<number>((resolve) => { resolveDescendantPid = resolve; });
  const pending = superviseCpuAwareProcess("/bin/sh", ["-c", "sleep 60 & echo $!; wait"], {
    cpuBudgetMs: 10_000,
    noCpuProgressTimeoutMs: 10_000,
    signal: controller.signal,
    readCpuMs: async () => 0,
    spawnProcess: (command, args) => {
      const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.once("data", (chunk: Buffer) => resolveDescendantPid(Number(String(chunk).trim())));
      return child;
    },
  });
  const pid = await descendantPid;
  assert.ok(Number.isInteger(pid) && pid > 0);
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof CpuAwareProcessError && error.reason === "aborted");
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error: any) {
      assert.equal(error?.code, "ESRCH");
      return;
    }
  }
  assert.fail("background descendant survived process-group abort");
});

test("metric failure fails closed and an exit race does not become a false metric failure", async () => {
  const clock = new FakeClock();
  const failed = new FakeChild();
  const metricFailure = superviseCpuAwareProcess("python3", ["processor.py"], fakeOptions(
    clock, failed, async () => { throw new Error("proc unavailable"); },
  ));
  await flush();
  await assert.rejects(metricFailure, (error: unknown) =>
    error instanceof CpuAwareProcessError && error.reason === "metrics_unavailable");
  assert.deepEqual(failed.signals, ["SIGTERM"]);

  let rejectMetric!: (error: Error) => void;
  const raceChild = new FakeChild();
  const race = superviseCpuAwareProcess("python3", ["processor.py"], fakeOptions(
    new FakeClock(), raceChild, () => new Promise<number>((_resolve, reject) => { rejectMetric = reject; }),
  ));
  raceChild.succeed();
  rejectMetric(new Error("the process already exited"));
  await race;
  assert.deepEqual(raceChild.signals, []);
});

test("output limit and asynchronous TERM-to-KILL cleanup are bounded", async () => {
  const outputClock = new FakeClock();
  const noisy = new FakeChild();
  const overflow = superviseCpuAwareProcess("python3", ["processor.py"], {
    ...fakeOptions(outputClock, noisy, async () => 0),
    maxOutputBytes: 3,
  });
  await flush();
  noisy.stderr.write(Buffer.from("four"));
  await assert.rejects(overflow, (error: unknown) =>
    error instanceof CpuAwareProcessError && error.reason === "output_limit"
      && error.stderr.byteLength === 3);
  assert.deepEqual(noisy.signals, ["SIGTERM"]);

  const killClock = new FakeClock();
  const ignoresTerm = new FakeChild();
  ignoresTerm.closeOnTerm = false;
  const eventualKill = superviseCpuAwareProcess("python3", ["processor.py"], fakeOptions(
    killClock, ignoresTerm, async () => { throw new Error("metrics broken"); },
  ));
  await flush();
  assert.deepEqual(ignoresTerm.signals, ["SIGTERM"]);
  killClock.advance(10);
  await assert.rejects(eventualKill, (error: unknown) =>
    error instanceof CpuAwareProcessError && error.reason === "metrics_unavailable");
  assert.deepEqual(ignoresTerm.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(killClock.count(), 0);
});

function stat({
  utime = 0, stime = 0, cutime = 0, cstime = 0, start = 99,
}: Partial<{ utime: number; stime: number; cutime: number; cstime: number; start: number }> = {}) {
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = "R";
  fields[11] = String(utime);
  fields[12] = String(stime);
  fields[13] = String(cutime);
  fields[14] = String(cstime);
  fields[19] = String(start);
  return `9 (cad worker) ${fields.join(" ")}`;
}

test("proc accounting includes reaped children once and pins root identity", async () => {
  const initial = stat({ utime: 12, stime: 8, cutime: 3, cstime: 4, start: 101 });
  assert.deepEqual(linuxProcSample(initial), { cpuTicks: 27, startTimeTicks: 101 });
  assert.equal(linuxProcCpuTicks(initial), 27);
  let current = initial;
  const readCpuMs = createLinuxProcCpuReader({
    procRoot: "/fake",
    getClockTicks: async () => 100,
    readText: async () => current,
  });
  assert.equal(await readCpuMs(42), 270);
  // The child has been reaped: cutime/cstime grows, with no separate child
  // sample to double count.
  current = stat({ utime: 13, stime: 9, cutime: 10, cstime: 5, start: 101 });
  assert.equal(await readCpuMs(42), 370);
  current = stat({ utime: 1, stime: 1, start: 102 });
  await assert.rejects(readCpuMs(42), /process_identity_changed/);
});

test("root exit cleans timers and ignores a late metrics result", async () => {
  let resolveMetric!: (cpu: number) => void;
  const clock = new FakeClock();
  const root = new FakeChild();
  const done = superviseCpuAwareProcess("python3", ["processor.py"], fakeOptions(
    clock, root, () => new Promise<number>((resolve) => { resolveMetric = resolve; }),
  ));
  root.succeed();
  resolveMetric(12);
  await done;
  assert.deepEqual(root.signals, []);
  assert.equal(clock.count(), 0);
});

test("invalid grace periods fail before spawning an unsupervised child", async () => {
  const child = new FakeChild();
  await assert.rejects(superviseCpuAwareProcess("python3", ["processor.py"], {
    ...fakeOptions(new FakeClock(), child, async () => 0),
    killGraceMs: 0,
  }), (error: unknown) => error instanceof CpuAwareProcessError
    && error.reason === "metrics_unavailable");
  assert.deepEqual(child.signals, []);
});