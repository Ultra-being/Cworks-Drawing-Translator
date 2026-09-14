import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { nativeDxfFailureKind, NativeDxfProcessError, runNativeDxfProcess } from "./native-dxf-process";
import type { CpuAwareProcess } from "./native-dxf-cpu-supervisor";
import { logger } from "../lib/logger";

class ClosingCpuChild extends EventEmitter implements CpuAwareProcess {
  pid: number | undefined = 998_877;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean { return true; }
  fail(code: number, stderr: string) {
    this.stderr.end(stderr);
    this.emit("close", code, null);
  }
  terminate(signal: NodeJS.Signals) {
    this.emit("close", null, signal);
  }
}

test("native DXF failures distinguish limits, validation and termination without claiming every kill is OOM", () => {
  assert.equal(nativeDxfFailureKind({ killed: true, signal: "SIGTERM" }, 1200, 1000), "timeout");
  assert.equal(nativeDxfFailureKind({ code: "ETIMEDOUT" }, 0, 1000), "timeout");
  assert.equal(nativeDxfFailureKind({ signal: "SIGKILL" }, 1200, 1000), "terminated");
  assert.equal(nativeDxfFailureKind({ stderr: "MemoryError" }, 0, 1000), "memory");
  assert.equal(nativeDxfFailureKind({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, 0, 1000), "output_limit");
  assert.equal(nativeDxfFailureKind({ code: "ENOENT" }, 0, 1000), "unavailable");
  assert.equal(nativeDxfFailureKind({ stderr: "DXF_REJECTED: confidential source text" }, 0, 1000), "rejected");
  assert.equal(nativeDxfFailureKind(new Error("secret command"), 0, 1000), "process_error");
  assert.equal(nativeDxfFailureKind(null, 0, 1000), "process_error");
});

test("user-facing DXF failure identifies stage without exposing source data", () => {
  const error = new NativeDxfProcessError("patch", "rejected");
  assert.match(error.message, /DXF patch/);
  assert.match(error.message, /original is unchanged/);
  assert.doesNotMatch(error.message, /confidential/);
});

test("native invocation keeps bounded execution and logs safe structured failure details", async (t) => {
  const events: unknown[] = [];
  t.mock.method(logger, "info", (...args: unknown[]) => events.push(args));
  t.mock.method(logger, "error", (...args: unknown[]) => events.push(args));
  await runNativeDxfProcess("/private/processor.py", "inspect", ["/private/input"], {
    jobId: "test", timeoutMs: 1000,
  }, async (_command, args, options) => {
    assert.deepEqual(args, ["/private/processor.py", "inspect", "/private/input"]);
    assert.equal(options.timeout, 1000);
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
  });
  await assert.rejects(runNativeDxfProcess("/private/processor.py", "patch", [], {
    jobId: "test", timeoutMs: 1000,
  }, async () => {
    throw Object.assign(new Error("secret command with source text"), {
      code: 2,
      stderr: [
        "DXF_REJECTED: post_patch_preservation_invariant",
        JSON.stringify({
          kind: "native_dxf_rejected",
          reason: "post_patch_preservation_invariant",
          privateText: "confidential source text",
        }),
      ].join("\n"),
    });
  }), (error: unknown) => error instanceof NativeDxfProcessError
    && error.stage === "patch" && error.kind === "rejected");
  const logs = JSON.stringify(events);
  assert.match(logs, /"exitCode":2/);
  assert.match(logs, /"stage":"patch"/);
  assert.match(logs, /"reason":"post_patch_preservation_invariant"/);
  assert.doesNotMatch(logs, /private|secret|confidential/);
});

test("CPU-aware natural exits retain bounded metadata for native classification", async () => {
  const rejected = new ClosingCpuChild();
  const rejection = runNativeDxfProcess("/private/processor.py", "patch", [], {
    jobId: "test",
    timeoutMs: 1,
    cpuAware: {
      cpuBudgetMs: 10_000,
      noCpuProgressTimeoutMs: 10_000,
      readCpuMs: async () => 0,
      spawnProcess: () => rejected,
    },
  });
  rejected.fail(2, `DXF_REJECTED: post_patch_preservation_invariant
${JSON.stringify({ kind: "native_dxf_rejected", reason: "post_patch_preservation_invariant" })}`);
  await assert.rejects(rejection, (error: unknown) => error instanceof NativeDxfProcessError
    && error.kind === "rejected");

  const memory = new ClosingCpuChild();
  const exhausted = runNativeDxfProcess("/private/processor.py", "patch", [], {
    jobId: "test",
    timeoutMs: 1,
    cpuAware: {
      cpuBudgetMs: 10_000,
      noCpuProgressTimeoutMs: 10_000,
      readCpuMs: async () => 0,
      spawnProcess: () => memory,
    },
  });
  memory.fail(1, "MemoryError");
  await assert.rejects(exhausted, (error: unknown) => error instanceof NativeDxfProcessError
    && error.kind === "memory");

  const terminated = new ClosingCpuChild();
  const killed = runNativeDxfProcess("/private/processor.py", "patch", [], {
    jobId: "test",
    timeoutMs: 1,
    cpuAware: {
      cpuBudgetMs: 10_000,
      noCpuProgressTimeoutMs: 10_000,
      readCpuMs: async () => 0,
      spawnProcess: () => terminated,
    },
  });
  terminated.terminate("SIGKILL");
  await assert.rejects(killed, (error: unknown) => error instanceof NativeDxfProcessError
    && error.kind === "terminated");

  const unavailable = new ClosingCpuChild();
  unavailable.pid = undefined;
  const missingRuntime = runNativeDxfProcess("/private/processor.py", "patch", [], {
    jobId: "test",
    timeoutMs: 1,
    cpuAware: {
      cpuBudgetMs: 10_000,
      noCpuProgressTimeoutMs: 10_000,
      readCpuMs: async () => 0,
      spawnProcess: () => unavailable,
    },
  });
  unavailable.emit("error", Object.assign(new Error("redacted"), { code: "ENOENT" }));
  await assert.rejects(missingRuntime, (error: unknown) => error instanceof NativeDxfProcessError
    && error.kind === "unavailable");
});

const architectureCheckpointPath = "/tmp/architecture-final-patch-checkpoint.csv";
const architectureSourcePath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../../attached_assets/0_Architecture_1788835080215.dxf",
);
const nativeProcessorPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "dxf_processor.py",
);
const canReplayArchitecture = process.platform === "linux"
  && existsSync(architectureCheckpointPath)
  && existsSync(architectureSourcePath)
  && existsSync(nativeProcessorPath);

test("CPU-aware executor replays saved Architecture pre-patch payload without AI", {
  skip: !canReplayArchitecture,
}, async () => {
  const csv = await fs.readFile(architectureCheckpointPath, "utf8");
  const encodedCheckpoint = csv.slice(csv.indexOf("\n") + 1).trim();
  const checkpoint = JSON.parse(encodedCheckpoint.slice(1, -1).replace(/""/g, "\"")) as {
    stage: string;
    sourceSha256: string;
    targetLanguage: string;
    translations: Record<string, string>;
  };
  assert.equal(checkpoint.stage, "pre_patch");
  assert.equal(checkpoint.targetLanguage, "en");
  assert.equal(createHash("sha256").update(await fs.readFile(architectureSourcePath)).digest("hex"),
    checkpoint.sourceSha256, "the saved payload must be bound to the local source");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-dxf-cpu-replay-"));
  const inventoryPath = path.join(dir, "inventory.json");
  const translationsPath = path.join(dir, "translations.json");
  const outputPath = path.join(dir, "translated.dxf");
  const reportPath = path.join(dir, "patch-report.json");
  const cpuAware = {
    cpuBudgetMs: 30 * 60_000,
    noCpuProgressTimeoutMs: 10 * 60_000,
    pollIntervalMs: 100,
  };
  try {
    // This calls the new spawn + /proc supervisor, not the legacy injected
    // execFile executor. No translator or auditor is invoked in this replay.
    await runNativeDxfProcess(nativeProcessorPath, "inspect", [architectureSourcePath, inventoryPath], {
      jobId: "architecture-saved-payload-replay",
      timeoutMs: 1,
      cpuAware,
    });
    const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8")) as {
      textEntries: Array<{ targetId: string; patchableInDxf: boolean }>;
    };
    const patchableIds = new Set(inventory.textEntries
      .filter((entry) => entry.patchableInDxf)
      .map((entry) => entry.targetId));
    const translations = Object.entries(checkpoint.translations)
      .filter(([targetId]) => patchableIds.has(targetId))
      .map(([targetId, translation]) => ({ targetId, translation }));
    assert.ok(translations.length > 0, "saved payload must contain source-patchable translations");
    await fs.writeFile(translationsPath, JSON.stringify({
      targetLanguage: checkpoint.targetLanguage,
      translations,
    }));
    await runNativeDxfProcess(nativeProcessorPath, "patch", [
      architectureSourcePath, translationsPath, outputPath, reportPath,
    ], {
      jobId: "architecture-saved-payload-replay",
      timeoutMs: 1,
      cpuAware,
    });
    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
      sourceSha256: string; outputSha256: string; approvedChanges: unknown[];
    };
    assert.equal(report.sourceSha256, checkpoint.sourceSha256);
    assert.equal(createHash("sha256").update(await fs.readFile(outputPath)).digest("hex"), report.outputSha256);
    assert.ok(report.approvedChanges.length > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});