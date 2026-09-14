import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../lib/logger";
import {
  CpuAwareProcessError,
  superviseCpuAwareProcess,
  type CpuAwareProcessSupervisorOptions,
} from "./native-dxf-cpu-supervisor";

const execute = promisify(execFile);
export type NativeDxfProcessorStage = "inspect" | "patch" | "preview";
export type NativeDxfFailureKind =
  | "timeout" | "memory" | "terminated" | "rejected" | "output_limit"
  | "unavailable" | "process_error" | "cpu_budget_exhausted"
  | "no_cpu_progress" | "metrics_unavailable" | "aborted";
type FailureKind = NativeDxfFailureKind;
type ProcessorFailure = Error & {
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};
export type NativeDxfProcessorFailureDiagnostic = {
  jobId: string;
  stage: NativeDxfProcessorStage;
  exitCode: string | number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  deterministic: boolean;
  reason: string;
};

function boundedDiagnosticText(value: unknown, maxLength = 8_192): string {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  return text.replace(/\0/g, "").slice(-maxLength);
}

const ALLOWED_NATIVE_DXF_REJECTION_REASONS = new Set([
  "post_patch_preservation_invariant",
  "invalid_translation_document",
  "processor_io_failure",
  "document_rejected",
]);

export function nativeDxfRejectionReason(stderr: unknown): string | null {
  const text = boundedDiagnosticText(stderr);
  for (const line of text.trim().split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.kind === "native_dxf_rejected"
        && typeof parsed.reason === "string"
        && ALLOWED_NATIVE_DXF_REJECTION_REASONS.has(parsed.reason)) {
        return parsed.reason;
      }
    } catch {
      // Raw subprocess text is deliberately not copied into native diagnostics.
    }
  }
  return null;
}

export function nativeDxfFailureKind(error: unknown, elapsedMs: number, timeoutMs: number): FailureKind {
  const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
  // Never log raw command errors or stderr: these can contain drawing text,
  // private file paths, or provider credentials.
  const stderr = boundedDiagnosticText(failure?.stderr);
  // A supervision limit is definitive.  A natural non-zero process exit,
  // however, retains bounded stderr/code/signal and must go through the
  // established allowlisted rejection/memory/termination classification.
  if (error instanceof CpuAwareProcessError && error.reason !== "process_error") {
    return error.reason;
  }
  if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit";
  if (failure?.code === "ETIMEDOUT"
    || (failure?.killed && elapsedMs >= timeoutMs && failure?.signal === "SIGTERM")) return "timeout";
  if (/\bMemoryError\b|Cannot allocate memory|Out of memory/i.test(stderr)) return "memory";
  if (failure?.signal) return "terminated"; // SIGKILL alone does not prove OOM.
  if (failure?.code === "ENOENT") return "unavailable";
  if (/DXF_REJECTED:/.test(stderr)) return "rejected";
  return "process_error";
}

export function describeNativeDxfProcessorFailure(
  caught: unknown,
  jobId: string,
  stage: NativeDxfProcessorStage,
): NativeDxfProcessorFailureDiagnostic {
  const error = caught as ProcessorFailure;
  const supervisedReason = caught instanceof CpuAwareProcessError && caught.reason !== "process_error"
    ? caught.reason
    : null;
  const exitCode = error?.code ?? null;
  const signal = error?.signal ?? null;
  const killed = error?.killed === true;
  const timedOut = exitCode === "ETIMEDOUT" || (killed && signal === "SIGTERM");
  const rejectedReason = nativeDxfRejectionReason(error?.stderr);
  return {
    jobId,
    stage,
    exitCode,
    signal,
    killed,
    timedOut,
    deterministic: rejectedReason !== null,
    // Supervision reason codes are a closed, source-data-free vocabulary.
    reason: supervisedReason || (timedOut
      ? "timeout"
      : rejectedReason || (signal ? "subprocess_terminated" : "subprocess_failed")),
  };
}

export class NativeDxfProcessError extends Error {
  constructor(readonly stage: NativeDxfProcessorStage, readonly kind: FailureKind) {
    const descriptions: Record<FailureKind, string> = {
      timeout: "exceeded its processing time limit",
      memory: "ran out of memory",
      terminated: "was terminated before completing",
      rejected: "rejected the file or replacement data during validation",
      output_limit: "exceeded its diagnostic output limit",
      unavailable: "could not start the drawing processor",
      process_error: "failed while processing the drawing",
      cpu_budget_exhausted: "exceeded its CPU work budget",
      no_cpu_progress: "stopped making CPU progress",
      metrics_unavailable: "could not be safely supervised because CPU metrics are unavailable",
      aborted: "was cancelled before completing",
    };
    super(`Native DXF ${stage} ${descriptions[kind]}. The original is unchanged; no partial output was released.`);
    this.name = "NativeDxfProcessError";
  }
}

export async function runNativeDxfProcess(
  processor: string,
  stage: NativeDxfProcessorStage,
  args: string[],
  options: {
    jobId: string;
    timeoutMs: number;
    /**
     * Opt-in only.  Legacy callers retain execFile's bounded wall deadline.
     * Native DXF stages can provide this to use CPU work/stall supervision.
     */
    cpuAware?: Omit<CpuAwareProcessSupervisorOptions, "signal"> & { signal?: AbortSignal };
  },
  executor: (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<unknown> = execute,
): Promise<void> {
  const start = Date.now();
  logger.info({
    jobId: options.jobId, stage, timeoutMs: options.timeoutMs,
    supervision: options.cpuAware ? "cpu_aware" : "wall_deadline",
  }, "Native DXF processor started");
  try {
    if (options.cpuAware) {
      await superviseCpuAwareProcess(
        process.env.PYTHON_BIN || "python3",
        [processor, stage, ...args],
        options.cpuAware,
      );
    } else {
      await executor(process.env.PYTHON_BIN || "python3", [processor, stage, ...args], {
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    logger.info({ jobId: options.jobId, stage, elapsedMs: Date.now() - start }, "Native DXF processor completed");
  } catch (error) {
    const elapsedMs = Date.now() - start;
    const kind = nativeDxfFailureKind(error, elapsedMs, options.timeoutMs);
    const failure = error as { code?: unknown; signal?: unknown; killed?: boolean };
    const reason = kind === "rejected"
      ? nativeDxfRejectionReason((error as ProcessorFailure)?.stderr)
      : error instanceof CpuAwareProcessError && error.reason !== "process_error"
        ? error.reason
        : null;
    logger.error({
      jobId: options.jobId, stage, kind, elapsedMs, timeoutMs: options.timeoutMs,
      reason,
      exitCode: typeof failure?.code === "number" ? failure.code : null,
      signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(String(failure?.signal))
        ? failure.signal : null,
      killed: failure?.killed === true,
    }, "Native DXF processor failed");
    throw new NativeDxfProcessError(stage, kind);
  }
}