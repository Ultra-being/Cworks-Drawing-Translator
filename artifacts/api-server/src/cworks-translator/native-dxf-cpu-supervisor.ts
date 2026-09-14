import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type CpuAwareFailureReason =
  | "cpu_budget_exhausted"
  | "no_cpu_progress"
  | "metrics_unavailable"
  | "aborted"
  | "output_limit"
  | "process_error";

/**
 * Deliberately contains a reason code only.  Command lines, paths and child
 * stderr must stay out of process-supervision diagnostics.
 */
export class CpuAwareProcessError extends Error {
  readonly code: string | number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;

  constructor(
    readonly reason: CpuAwareFailureReason,
    metadata: Partial<{
      code: string | number | null;
      signal: NodeJS.Signals | null;
      stdout: Buffer;
      stderr: Buffer;
    }> = {},
  ) {
    super(`Native DXF subprocess supervision stopped: ${reason}`);
    this.name = "CpuAwareProcessError";
    // Bounded facts only. These retain compatibility with the existing
    // allowlisted classifier without exposing raw output in diagnostics.
    this.code = metadata.code ?? null;
    this.signal = metadata.signal ?? null;
    this.stdout = metadata.stdout ?? Buffer.alloc(0);
    this.stderr = metadata.stderr ?? Buffer.alloc(0);
  }
}

export type CpuAwareProcess = {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close" | "error", listener: (...args: any[]) => void): unknown;
  removeListener(event: "close" | "error", listener: (...args: any[]) => void): unknown;
};

export type CpuClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type CpuAwareProcessSupervisorOptions = {
  /** CPU budget for the spawned Python process and children it has reaped. */
  cpuBudgetMs: number;
  /** Wall time without any observed CPU advance before declaring a real stall. */
  noCpuProgressTimeoutMs: number;
  pollIntervalMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  clock?: CpuClock;
  readCpuMs?: (pid: number) => Promise<number>;
  spawnProcess?: (command: string, args: string[]) => CpuAwareProcess;
};

export type CpuAwareProcessResult = { stdout: Buffer; stderr: Buffer };

const systemClock: CpuClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_CPU_BUDGET_MS = 30 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * /proc/<pid>/stat has a parenthesised executable name which may itself
 * contain spaces or ')' characters.  Everything after the final ')' starts
 * at field 3.  utime and stime are fields 14 and 15, hence indexes 11 and 12.
 */
export type LinuxProcSample = {
  /** Root CPU plus CPU from children the root has already reaped. */
  cpuTicks: number;
  /** Linux stat field 22, used to reject PID reuse. */
  startTimeTicks: number;
};

class ProcessIdentityChangedError extends Error {
  constructor() {
    super("process_identity_changed");
    this.name = "ProcessIdentityChangedError";
  }
}

export function linuxProcSample(stat: string): LinuxProcSample {
  const closingName = stat.lastIndexOf(")");
  if (closingName < 0) throw new Error("invalid_proc_stat");
  const fields = stat.slice(closingName + 1).trim().split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const cutime = Number(fields[13]);
  const cstime = Number(fields[14]);
  const startTimeTicks = Number(fields[19]);
  if (!Number.isSafeInteger(utime) || utime < 0
    || !Number.isSafeInteger(stime) || stime < 0
    || !Number.isSafeInteger(cutime) || cutime < 0
    || !Number.isSafeInteger(cstime) || cstime < 0
    || !Number.isSafeInteger(startTimeTicks) || startTimeTicks < 0) {
    throw new Error("invalid_proc_cpu_ticks");
  }
  return { cpuTicks: utime + stime + cutime + cstime, startTimeTicks };
}

export function linuxProcCpuTicks(stat: string): number {
  return linuxProcSample(stat).cpuTicks;
}

async function clockTicksPerSecond(): Promise<number> {
  const { stdout } = await executeFile("getconf", ["CLK_TCK"], { timeout: 2_000 });
  const ticks = Number(String(stdout).trim());
  if (!Number.isSafeInteger(ticks) || ticks <= 0 || ticks > 1_000_000) {
    throw new Error("invalid_clk_tck");
  }
  return ticks;
}

/**
 * Samples exactly the spawned Python process. Its cutime/cstime account for
 * children it has reaped. We deliberately do not add a live descendant tree:
 * that would double-count a child when the parent subsequently reaps it and
 * cannot reliably charge a short-lived child that vanishes between /proc
 * reads. Process-group termination remains tree-wide on cancellation.
 *
 * The first stat starttime is pinned, so PID reuse cannot be treated as
 * progress or granted a fresh CPU budget.
 */
export function createLinuxProcCpuReader(
  options: {
    procRoot?: string;
    getClockTicks?: () => Promise<number>;
    readText?: (path: string) => Promise<string>;
  } = {},
): (pid: number) => Promise<number> {
  const procRoot = options.procRoot || "/proc";
  const getClockTicks = options.getClockTicks || clockTicksPerSecond;
  const readText = options.readText || ((path: string) => readFile(path, "utf8"));
  let ticksPromise: Promise<number> | undefined;
  let expectedPid: number | undefined;
  let expectedStartTimeTicks: number | undefined;

  return async (rootPid: number): Promise<number> => {
    if (process.platform !== "linux" && procRoot === "/proc") {
      throw new Error("linux_proc_metrics_unavailable");
    }
    const ticks = await (ticksPromise ||= getClockTicks());
    const sample = linuxProcSample(await readText(`${procRoot}/${rootPid}/stat`));
    if (expectedPid === undefined) {
      expectedPid = rootPid;
      expectedStartTimeTicks = sample.startTimeTicks;
    } else if (expectedPid !== rootPid || expectedStartTimeTicks !== sample.startTimeTicks) {
      throw new ProcessIdentityChangedError();
    }
    return sample.cpuTicks * 1_000 / ticks;
  };
}

function defaultSpawn(command: string, args: string[]): CpuAwareProcess {
  // A separate group lets abort/limit handling terminate grandchildren as
  // well.  The fallback child.kill below covers platforms without process
  // groups and test doubles.
  return spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
}

function terminateProcessTree(child: CpuAwareProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== "win32" && typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // It may have won the exit race, or may not have become a group leader.
    }
  }
  try { child.kill(signal); } catch { /* Process already exited. */ }
}

function boundedCollector(
  stream: NodeJS.ReadableStream | null | undefined,
  maxBytes: number,
  onLimit: () => void,
): { value: () => Buffer; dispose: () => void } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const onData = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - bytes;
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
    bytes += buffer.length;
    if (bytes > maxBytes) onLimit();
  };
  stream?.on("data", onData);
  return {
    value: () => Buffer.concat(chunks),
    dispose: () => stream?.removeListener("data", onData),
  };
}

/**
 * Spawn and supervise a native process with CPU, rather than wall-clock, work
 * limits.  There is intentionally no deadline derived from elapsed wall time:
 * a CPU-throttled but progressing CAD process remains healthy.  Metrics
 * failure is fail-closed, never a silent fallback to a fixed wall timeout.
 */
export function superviseCpuAwareProcess(
  command: string,
  args: string[],
  rawOptions: CpuAwareProcessSupervisorOptions,
): Promise<CpuAwareProcessResult> {
  const options = {
    cpuBudgetMs: rawOptions.cpuBudgetMs ?? DEFAULT_CPU_BUDGET_MS,
    noCpuProgressTimeoutMs: rawOptions.noCpuProgressTimeoutMs ?? DEFAULT_STALL_MS,
    pollIntervalMs: rawOptions.pollIntervalMs ?? DEFAULT_POLL_MS,
    killGraceMs: rawOptions.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    maxOutputBytes: rawOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
  if (!Number.isFinite(options.cpuBudgetMs) || options.cpuBudgetMs <= 0
    || !Number.isFinite(options.noCpuProgressTimeoutMs) || options.noCpuProgressTimeoutMs <= 0
    || !Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0
    || !Number.isFinite(options.killGraceMs) || options.killGraceMs <= 0
    || !Number.isFinite(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    return Promise.reject(new CpuAwareProcessError("metrics_unavailable"));
  }
  if (rawOptions.signal?.aborted) {
    return Promise.reject(new CpuAwareProcessError("aborted"));
  }

  const clock = rawOptions.clock || systemClock;
  const readCpuMs = rawOptions.readCpuMs || createLinuxProcCpuReader();
  const spawnProcess = rawOptions.spawnProcess || defaultSpawn;

  return new Promise((resolve, reject) => {
    let child: CpuAwareProcess;
    try {
      child = spawnProcess(command, args);
    } catch {
      reject(new CpuAwareProcessError("process_error"));
      return;
    }
    if (!child.pid || child.pid <= 0) {
      // spawn(ENOENT) reports failure asynchronously. Preserve only its
      // allowlisted code so the caller can distinguish an unavailable Python
      // runtime, while still never exposing its message or command line.
      let spawnSettled = false;
      const failSpawn = (error?: { code?: unknown }) => {
        if (spawnSettled) return;
        spawnSettled = true;
        const code = typeof error?.code === "string" || typeof error?.code === "number"
          ? error.code
          : null;
        reject(new CpuAwareProcessError("process_error", { code }));
      };
      child.once("error", failSpawn);
      child.once("close", () => failSpawn());
      return;
    }

    let settled = false;
    let stopping: CpuAwareFailureReason | undefined;
    let stopCode: string | number | null = null;
    let timer: unknown;
    let killTimer: unknown;
    let lastCpuMs = 0;
    let lastCpuProgressAt = clock.now();
    const stdout = boundedCollector(child.stdout, options.maxOutputBytes, () => stop("output_limit"));
    const stderr = boundedCollector(child.stderr, options.maxOutputBytes, () => stop("output_limit"));

    const cleanUp = () => {
      if (timer !== undefined) clock.clearTimeout(timer);
      if (killTimer !== undefined) clock.clearTimeout(killTimer);
      rawOptions.signal?.removeEventListener("abort", onAbort);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      stdout.dispose();
      stderr.dispose();
    };
    const metadata = (code: string | number | null, signal: NodeJS.Signals | null) => ({
      code: stopCode ?? code,
      signal,
      stdout: stdout.value(),
      stderr: stderr.value(),
    });
    const finish = (error?: CpuAwareProcessError) => {
      if (settled) return;
      settled = true;
      cleanUp();
      if (error) reject(error);
      else resolve({ stdout: stdout.value(), stderr: stderr.value() });
    };
    const stop = (reason: CpuAwareFailureReason, code: string | number | null = null) => {
      if (settled || stopping) return;
      stopping = reason;
      stopCode = code;
      if (timer !== undefined) clock.clearTimeout(timer);
      killTimer = clock.setTimeout(() => terminateProcessTree(child, "SIGKILL"), options.killGraceMs);
      // Install the grace timer first.  A synchronous close from a test
      // double (or an unusually fast real exit) must not leave one behind.
      terminateProcessTree(child, "SIGTERM");
    };
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (stopping) {
        finish(new CpuAwareProcessError(stopping, metadata(exitCode, signal)));
      } else if (exitCode === 0 && !signal) {
        finish();
      } else {
        finish(new CpuAwareProcessError("process_error", metadata(exitCode, signal)));
      }
    };
    const onError = (error?: { code?: unknown }) =>
      stop("process_error", typeof error?.code === "string" || typeof error?.code === "number"
        ? error.code : null);
    const onAbort = () => stop("aborted");
    const poll = async () => {
      if (settled || stopping) return;
      try {
        const cpuMs = await readCpuMs(child.pid!);
        if (settled || stopping) return; // Child exit can race /proc disappearance.
        if (!Number.isFinite(cpuMs) || cpuMs < lastCpuMs) throw new Error("invalid_cpu_sample");
        const now = clock.now();
        if (cpuMs > lastCpuMs) {
          lastCpuMs = cpuMs;
          lastCpuProgressAt = now;
        }
        if (cpuMs >= options.cpuBudgetMs) return stop("cpu_budget_exhausted");
        if (now - lastCpuProgressAt >= options.noCpuProgressTimeoutMs) {
          return stop("no_cpu_progress");
        }
        timer = clock.setTimeout(() => { void poll(); }, options.pollIntervalMs);
      } catch (error) {
        if (settled || stopping) return;
        // The original root is already gone if its PID now names a different
        // starttime. Never signal that reused PID/process group.
        if (error instanceof ProcessIdentityChangedError) {
          finish(new CpuAwareProcessError("metrics_unavailable"));
        } else {
          stop("metrics_unavailable");
        }
      }
    };

    child.once("close", onClose);
    child.once("error", onError);
    rawOptions.signal?.addEventListener("abort", onAbort, { once: true });
    // Poll immediately: an unavailable /proc implementation is an explicit,
    // actionable failure rather than an unbounded process.
    void poll();
  });
}