import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { NativeDxfProcessError, runNativeDxfProcess } from "./native-dxf-process";
import {
  encodeNativeDxfInspectionCache,
  MAX_NATIVE_DXF_INSPECTION_CACHE_BYTES,
  nativeDxfInspectionCacheKey,
  nativeDxfProcessorFingerprint,
  readNativeDxfInspectionCache,
} from "./native-dxf-inspection-cache";
export {
  describeNativeDxfProcessorFailure,
  type NativeDxfProcessorFailureDiagnostic,
} from "./native-dxf-process";
import {
  buildNativeDxfCheckpoint,
  isNativeDxfCheckpointResumeEligible,
  nativeDxfMethodologyHash,
  nativeDxfCheckpointResumeEligibility,
  type NativeDxfCheckpoint,
  type NativeDxfCheckpointBinding,
} from "./native-dxf-checkpoints";
import {
  hasNativeDxfTargetedCorrectionKind,
  isNativeDxfTargetedCorrectionBrief,
  nativeDxfTargetedCorrectionTargetIds,
  NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND,
} from "./native-dxf-targeted-correction";
import {
  describeNativeDxfError,
  type NativeDxfDiagnosticContext,
} from "./native-dxf-diagnostics";
import { logger } from "../lib/logger";
import { db } from "../../db";
import {
  cworksTranslationCheckpoints,
  cworksTranslationCleanup,
  cworksTranslationJobs,
  cworksTranslationPages,
  cworksTranslationRenderCheckpoints,
  cworksTranslationTouchups,
} from "@workspace/db/schema";
import { and, asc, eq, gt, inArray, lt, lte, ne, or } from "drizzle-orm";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { askClaude } from "../ai-services";
import {
  deleteFromObjectStorageStrict,
  getObjectStorageMetadata,
  readFileFromObjectStorage,
  writeFileToObjectStorage,
} from "../object-storage-helper";

const apiServerRoot = path.basename(process.cwd()) === "api-server"
  ? process.cwd()
  : path.join(process.cwd(), "artifacts/api-server");
const PROCESSOR = path.join(apiServerRoot, "src/cworks-translator/processor.py");
const DXF_PROCESSOR = path.join(apiServerRoot, "src/cworks-translator/dxf_processor.py");
const SKILL_PATH = path.join(apiServerRoot, "src/cworks-translator/SKILL.md");
const LEASE_MS = 20 * 60_000;
const POLL_MS = 10_000;
const MAX_CONCURRENT = 1;
const EXTRACTION_TIMEOUT_MS = 20 * 60_000;
const PAGE_RENDER_TIMEOUT_MS = 12 * 60_000;
const MERGE_TIMEOUT_MS = 12 * 60_000;
// Native DXF subprocesses are supervised by observed CPU work rather than
// elapsed time.  A throttled but still progressing CAD process must not be
// terminated by the shorter legacy wall-clock stage limits above.
const NATIVE_DXF_CPU_BUDGET_MS = 30 * 60_000;
const NATIVE_DXF_NO_CPU_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const NATIVE_DXF_CPU_POLL_INTERVAL_MS = 5_000;
const EXTRACTION_ATTEMPTS = 2;
const PROVIDER_TIMEOUT_MS = 3 * 60_000;
const PROVIDER_ATTEMPTS = 2;
const PROVIDER_RETRY_DELAY_MS = 1_500;
const PROVIDER_ABORT_GRACE_MS = 5_000;
const TRANSLATION_METHODOLOGY_VERSION = 12;
const VISUAL_RECOVERY_METHODOLOGY_VERSION = 5;
const RENDER_LAYOUT_VERSION = 12;
const MACHINE_AUDIT_METHODOLOGY_VERSION = 1;
const MACHINE_AUDIT_MODEL = "gpt-5.6-sol";
const NATIVE_DXF_CHECKPOINT_METHODOLOGY_VERSION = 1;
const MAX_VISUAL_RECOVERY_BLOCKS_PER_PAGE = 32;
const MAX_VISUAL_RECOVERY_BLOCKS_PER_JOB = 320;
const ABANDONED_STAGE_CLEANUP_MS = 24 * 60 * 60_000;
export type CworksTargetLanguage = "en" | "ja";

function targetLanguage(job: Pick<CworksJob, "targetLanguage">): CworksTargetLanguage {
  return job.targetLanguage === "ja" ? "ja" : "en";
}

function targetLanguageName(language: CworksTargetLanguage): string {
  return language === "ja" ? "Japanese" : "English";
}

function nativeDxfCpuAwareOptions(signal: AbortSignal) {
  return {
    cpuBudgetMs: NATIVE_DXF_CPU_BUDGET_MS,
    noCpuProgressTimeoutMs: NATIVE_DXF_NO_CPU_PROGRESS_TIMEOUT_MS,
    pollIntervalMs: NATIVE_DXF_CPU_POLL_INTERVAL_MS,
    signal,
  };
}

export function cworksTargetLanguagePromptRequirement(
  language: CworksTargetLanguage,
): string {
  return language === "ja"
    ? "Every human-language replacement must be written in Japanese and contain Japanese script (kanji, hiragana, or katakana), not an English-only translation."
    : "Every human-language replacement must be written in English.";
}

export function isCworksTargetLanguageText(
  value: string,
  language: CworksTargetLanguage,
): boolean {
  if (!value.trim()) return false;
  return language === "ja"
    ? /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value)
    : !Array.from(value).some((char) =>
      /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char));
}

export type CworksJob = typeof cworksTranslationJobs.$inferSelect;
export const cworksRenderLayoutVersion = RENDER_LAYOUT_VERSION;

export {
  buildNativeDxfCheckpoint,
  isNativeDxfCheckpointResumeEligible,
  nativeDxfCheckpointResumeEligibility,
  nativeDxfMethodologyHash,
} from "./native-dxf-checkpoints";

type CworksRenderObstacle = {
  id: string;
  paragraphId?: string;
  placementGroupId?: string;
  compactGroupId?: string;
  compactGroupCompact?: boolean;
  layoutGroupId?: string;
  layoutGroupCompact?: boolean;
  pageNumber: number;
  bbox: [number, number, number, number];
};

export function buildCworksManualTouchupRenderFingerprint(
  source: Buffer,
  pageNumber: number,
  translations: CworksTranslation[],
  obstacles: CworksRenderObstacle[],
): string {
  return sha256(JSON.stringify({
    renderLayoutVersion: RENDER_LAYOUT_VERSION,
    sourceSha256: sha256(source),
    pageNumber,
    translations: translations.filter((item) => item.pageNumber === pageNumber),
    obstacles: obstacles.filter((item) => item.pageNumber === pageNumber),
  }));
}

export function assertCworksManualTouchupRenderBinding(
  job: CworksJob,
  source: Buffer,
  translations: CworksTranslation[],
  obstacles: CworksRenderObstacle[],
): void {
  const brief = job.repairBrief as any;
  if (brief?.kind !== "cworks-manual-touchup" || !brief.previewRenderFingerprint) return;
  const pageNumber = Number(brief.pages?.[0]?.pageNumber);
  if (!Number.isInteger(pageNumber)) throw new Error("MANUAL_PREVIEW_MISMATCH");
  const actual = buildCworksManualTouchupRenderFingerprint(
    source,
    pageNumber,
    translations,
    obstacles,
  );
  if (
    brief.previewRenderLayoutVersion !== RENDER_LAYOUT_VERSION
    || actual !== brief.previewRenderFingerprint
  ) {
    throw new Error("MANUAL_PREVIEW_MISMATCH");
  }
}
export type CworksBlock = {
  id: string;
  paragraphId?: string;
  placementGroupId?: string;
  compactGroupId?: string;
  compactGroupCompact?: boolean;
  layoutGroupId?: string;
  layoutGroupCompact?: boolean;
  text: string;
  bbox: [number, number, number, number];
  fontSize: number;
  direction?: [number, number];
  color?: number;
  suspicious?: boolean;
  recoveredFromVisual?: boolean;
  visualRecoveryFailed?: boolean;
  extractedText?: string;
  recoverySourceHash?: string;
  rasterBacked?: boolean;
};
export type CworksVisualRecoveryRegion = {
  id: string;
  bbox: [number, number, number, number];
  kind?: "raster-title" | "raster-strip" | "raster-region";
};
export type CworksPage = {
  pageNumber: number;
  width: number;
  height: number;
  blocks: CworksBlock[];
  visualRecoveryRegions?: CworksVisualRecoveryRegion[];
};
export type CworksTranslation = {
  id: string;
  paragraphId?: string;
  placementGroupId?: string;
  compactGroupId?: string;
  compactGroupCompact?: boolean;
  compactGroupTranslation?: string;
  layoutGroupId?: string;
  layoutGroupCompact?: boolean;
  layoutGroupTranslation?: string;
  pageNumber: number;
  bbox: [number, number, number, number];
  fontSize: number;
  direction: [number, number];
  color: number;
  source: string;
  translation: string;
  uncertain: boolean;
  recoveredFromVisual?: boolean;
  recoverySourceHash?: string;
  rasterBacked?: boolean;
};
export type CworksRenderPageMeta = {
  pageNumber: number;
  sourceBlockCount: number;
  translatedBlockCount: number;
  warnings: CworksUnresolvedLine[];
  preview: CworksPreviewMetadata;
};
export type CworksPreviewMetadata = {
  pixelWidth: number;
  pixelHeight: number;
  pageWidthPoints: number;
  pageHeightPoints: number;
};
export type CworksUnresolvedLine = {
  blockId: string;
  sourceText: string;
  bbox: [number, number, number, number];
  rejectionCategory: "uncertain_translation" | "missing_translation" | "unsupported_direction" | "overlap" | "text_too_long";
};
export type CworksCoverage = {
  targetLineCount: number;
  recoveredLineCount: number;
  translatedLineCount: number;
  placedLineCount: number;
  unresolvedLineCount: number;
  placementPercent: number;
  complete: boolean;
};
export type CworksMachineAuditFinding = {
  type: "source_residue" | "missing_translation" | "semantic_mismatch" | "placement" | "unreadable";
  message: string;
  sourceBlockId?: string;
};
export type CworksPageMachineAudit = {
  pageNumber: number;
  status: "passed" | "findings";
  model: string;
  findings: CworksMachineAuditFinding[];
};

const DEFERRED_TABLE_AUDIT_TYPES = new Set(["source_residue", "placement"]);

export function normalizeNativeDxfHybridAuditFindings(
  findings: readonly CworksMachineAuditFinding[],
  tableById: ReadonlyMap<string, { sourceText?: string }>,
  translations: ReadonlyMap<string, string>,
  targetLanguage: "en" | "ja",
): {
  effectiveFindings: CworksMachineAuditFinding[];
  deferredFindings: CworksMachineAuditFinding[];
} {
  const effectiveFindings: CworksMachineAuditFinding[] = [];
  const deferredFindings: CworksMachineAuditFinding[] = [];
  for (const finding of findings) {
    const table = finding.sourceBlockId
      ? tableById.get(finding.sourceBlockId) : undefined;
    const replacement = finding.sourceBlockId
      ? translations.get(finding.sourceBlockId) : undefined;
    const legitimatelyDeferred = Boolean(
      table
      && finding.sourceBlockId
      && DEFERRED_TABLE_AUDIT_TYPES.has(finding.type)
      && isNativeDxfTargetLanguageText(
        table.sourceText,
        replacement,
        targetLanguage,
      ),
    );
    (legitimatelyDeferred ? deferredFindings : effectiveFindings).push(finding);
  }
  return { effectiveFindings, deferredFindings };
}
type RenderPageExecutor = (options: {
  page: CworksPage;
  inputPath: string;
  translationsPath: string;
  fragmentPath: string;
  thumbnailPath: string;
  metadataPath: string;
}) => Promise<CworksRenderPageMeta>;
type RenderCworksPagesOptions = {
  renderPage?: RenderPageExecutor;
  readObject?: (storedName: string) => Promise<Buffer | null>;
  writeObject?: (storedName: string, content: Buffer | string) => Promise<void>;
  onCheckpointSaved?: (pageNumber: number) => Promise<void> | void;
};
type CworksTranslator = (
  prompt: string,
  projectId: string,
  maxTokens?: number,
  signal?: AbortSignal,
  options?: CworksTranslatorOptions,
) => Promise<string>;
type CworksTranslatorOptions = {
  /**
   * Native DXF batch responses are a machine-to-machine protocol, not a
   * conversational answer.  Keeping this opt-in prevents altering PDF and
   * visual-recovery provider behavior.
   */
  nativeDxfJsonResponse?: boolean;
};
type TranslateBlocksOptions = {
  askTranslator?: CworksTranslator;
  onCheckpointSaved?: (pageNumber: number) => Promise<void> | void;
};
type VisualRecoveryExecutor = (options: {
  block: CworksBlock;
  page: CworksPage;
  cropPath: string;
  signal: AbortSignal;
}) => Promise<string | null>;
type RecoverSuspiciousBlocksOptions = {
  recoverBlock?: VisualRecoveryExecutor;
  recoverRegion?: (options: {
    region: CworksVisualRecoveryRegion;
    page: CworksPage;
    cropPath: string;
    signal: AbortSignal;
  }) => Promise<string>;
};
type CworksProviderRequestOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  abortGraceMs?: number;
  quarantineKey?: string;
  onRetry?: (details: {
    nextAttempt: number;
    maxAttempts: number;
    timedOut: boolean;
  }) => Promise<void> | void;
  includeProviderMessageInLogs?: boolean;
};

class CworksProviderAttemptTimeout extends Error {
  constructor() {
    super("CAD translation provider request timed out");
    this.name = "CworksProviderAttemptTimeout";
  }
}

class CworksProviderCancellationUnconfirmed extends Error {
  readonly settlement: Promise<void>;

  constructor(settlement: Promise<void>) {
    super("CAD translation provider request did not settle after cancellation");
    this.name = "CworksProviderCancellationUnconfirmed";
    this.settlement = settlement;
  }
}

export class CworksProviderError extends Error {
  readonly attempts: number;
  readonly timedOut: boolean;
  readonly cancellationConfirmed: boolean;
  readonly retryable: boolean;
  readonly pageNumber?: number;

  constructor(
    message: string,
    options: {
      attempts: number;
      timedOut: boolean;
      cancellationConfirmed: boolean;
      retryable: boolean;
      pageNumber?: number;
    },
  ) {
    super(message);
    this.name = "CworksProviderError";
    this.attempts = options.attempts;
    this.timedOut = options.timedOut;
    this.cancellationConfirmed = options.cancellationConfirmed;
    this.retryable = options.retryable;
    this.pageNumber = options.pageNumber;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const unsettledProviderRequests = new Map<string, Promise<void>>();

function quarantineUnsettledProviderRequest(key: string, settlement: Promise<void>): void {
  const tracked = settlement.finally(() => {
    if (unsettledProviderRequests.get(key) === tracked) {
      unsettledProviderRequests.delete(key);
    }
  });
  unsettledProviderRequests.set(key, tracked);
}

export function hasUnsettledCworksProviderRequest(jobId: string): boolean {
  return unsettledProviderRequests.has(jobId);
}

function providerStatus(error: unknown): number | null {
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const value of [candidate?.status, candidate?.statusCode, candidate?.code]) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  }
  const match = String((error as any)?.message || "").match(/\b([45]\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function isTransientProviderFailure(error: unknown): boolean {
  if (error instanceof CworksProviderAttemptTimeout) return true;
  const status = providerStatus(error);
  if (status !== null) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const code = String((error as any)?.code || (error as any)?.cause?.code || "").toUpperCase();
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETDOWN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "EMPTY_RESPONSE",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }
  const message = String((error as any)?.message || error).toLowerCase();
  return /fetch failed|network error|socket hang up|connection reset|connection timed out/.test(message);
}

async function runBoundedProviderAttempt(
  invoke: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
  abortGraceMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutError = new CworksProviderAttemptTimeout();
  let timedOut = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = Promise.resolve()
    .then(() => invoke(controller.signal))
    .finally(() => {
      settled = true;
    });
  const settlement = request.then(() => undefined, () => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (!timedOut) throw error;
    if (!settled) {
      await Promise.race([
        settlement,
        delay(abortGraceMs),
      ]);
    }
    if (!settled) throw new CworksProviderCancellationUnconfirmed(settlement);
    throw timeoutError;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function describeProviderFailure(error: unknown, includeMessage = true): string {
  // Bounded, redacted diagnostic: provider/HTTP error messages are not a safe
  // contract and may echo URLs, request bodies, or credentials.
  const name = (error as any)?.constructor?.name ?? typeof error;
  const status = (error as any)?.status ?? (error as any)?.response?.status;
  if (!includeMessage) {
    return `${name}${typeof status === "number" ? ` status=${status}` : ""}`;
  }
  let message = String((error as any)?.message ?? error ?? "");
  message = message
    .replace(/(key|token|secret|password|authorization|api[-_]?key)(["']?\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/bearer\s+[\w.~+/=-]+/gi, "bearer [redacted]")
    .replace(/https?:\/\/\S+/gi, "[url]");
  if (message.length > 300) message = `${message.slice(0, 300)}…`;
  return `${name}${typeof status === "number" ? ` status=${status}` : ""}: ${message}`;
}

export async function requestCworksProviderWithRetry(
  invoke: (signal: AbortSignal) => Promise<string>,
  options: CworksProviderRequestOptions = {},
): Promise<string> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? PROVIDER_ATTEMPTS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? PROVIDER_RETRY_DELAY_MS);
  const abortGraceMs = Math.max(0, options.abortGraceMs ?? PROVIDER_ABORT_GRACE_MS);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runBoundedProviderAttempt(invoke, timeoutMs, abortGraceMs);
    } catch (error) {
      const cancellationConfirmed = !(error instanceof CworksProviderCancellationUnconfirmed);
      if (!cancellationConfirmed && options.quarantineKey) {
        quarantineUnsettledProviderRequest(
          options.quarantineKey,
          (error as CworksProviderCancellationUnconfirmed).settlement,
        );
      }
      const timedOut = error instanceof CworksProviderAttemptTimeout
        || error instanceof CworksProviderCancellationUnconfirmed;
      const retryable = cancellationConfirmed && isTransientProviderFailure(error);
      console.error(
        `[cworks-translator] provider attempt ${attempt}/${maxAttempts} failed (retryable=${retryable}): ${describeProviderFailure(error, options.includeProviderMessageInLogs !== false)}`,
      );
      if (!retryable || attempt === maxAttempts) {
        const message = !cancellationConfirmed
          ? "The translation provider timed out and cancellation could not be confirmed, so no overlapping retry was started."
          : timedOut
            ? `The translation provider did not respond in time after ${attempt} attempt(s).`
            : retryable
              ? `The translation provider was temporarily unavailable after ${attempt} attempt(s).`
              : "The translation provider rejected the request.";
        throw new CworksProviderError(message, {
          attempts: attempt,
          timedOut,
          cancellationConfirmed,
          retryable,
        });
      }
      await options.onRetry?.({
        nextAttempt: attempt + 1,
        maxAttempts,
        timedOut,
      });
      if (retryDelayMs) await delay(retryDelayMs);
    }
  }
  throw new CworksProviderError("The translation provider could not complete the request.", {
    attempts: maxAttempts,
    timedOut: false,
    cancellationConfirmed: true,
    retryable: true,
  });
}

let started = false;
let active = 0;
let ticking = false;

export function getCworksTranslationReadiness(): {
  ready: boolean;
  provider: "gemini" | "claude" | null;
  independentAuditorReady: boolean;
} {
  const independentAuditorReady = Boolean(
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim()
    && process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim(),
  );
  if (
    process.env.AI_INTEGRATIONS_GEMINI_API_KEY?.trim()
    && process.env.AI_INTEGRATIONS_GEMINI_BASE_URL?.trim()
  ) {
    return { ready: independentAuditorReady, provider: "gemini", independentAuditorReady };
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return { ready: independentAuditorReady, provider: "claude", independentAuditorReady };
  }
  return { ready: false, provider: null, independentAuditorReady };
}

async function askCworksTranslator(
  prompt: string,
  projectId: string,
  maxTokens = 4096,
  signal?: AbortSignal,
  options?: CworksTranslatorOptions,
): Promise<string> {
  const readiness = getCworksTranslationReadiness();
  if (readiness.provider === "gemini") {
    const ai = new GoogleGenAI({
      apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY!,
      httpOptions: {
        apiVersion: "",
        baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL!,
      },
    });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        temperature: 0.1,
        maxOutputTokens: maxTokens,
        abortSignal: signal,
        ...(options?.nativeDxfJsonResponse ? {
          // A long free-form answer previously let Gemini spend the entire
          // output allowance thinking, then terminate the JSON mid-row.
          // The schema is intentionally structural: exact membership remains
          // enforced locally against the immutable target-id mapping.
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            properties: {
              translations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    targetId: { type: "string" },
                    translation: { type: "string" },
                  },
                  required: ["targetId", "translation"],
                  additionalProperties: false,
                },
              },
            },
            required: ["translations"],
            additionalProperties: false,
          },
          // Translation rows do not need reasoning tokens.  This reserves the
          // bounded output for every requested row.
          thinkingConfig: { thinkingBudget: 0 },
        } : {}),
      },
    });
    const text = response.text?.trim();
    if (!text) {
      throw Object.assign(
        new Error("Gemini translator returned an empty response"),
        { code: "EMPTY_RESPONSE" },
      );
    }
    return text;
  }
  if (readiness.provider === "claude") {
    return askClaude(prompt, undefined, undefined, projectId, {
      logUsage: false,
      maxTokens,
      requireComplete: true,
      signal,
    });
  }
  throw new Error("No CAD translation provider is configured");
}

async function askCworksVisionRecovery(
  crop: Buffer,
  sourceLanguage: string,
  signal: AbortSignal,
): Promise<string> {
  if (getCworksTranslationReadiness().provider !== "gemini") {
    return "";
  }
  const ai = new GoogleGenAI({
    apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY!,
    httpOptions: {
      apiVersion: "",
      baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL!,
    },
  });
  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [{
      role: "user",
      parts: [
        {
          text: [
            "Read the single drawing-text line in this crop.",
            `The expected source language is ${sourceLanguage === "auto" ? "unknown; detect it from the visible line" : sourceLanguage}.`,
            "Return JSON only: {\"readable\":true,\"sourceText\":\"exact source wording\"}.",
            "Do not translate, expand abbreviations, infer hidden text, or include table borders.",
            "If the line cannot be read reliably, return {\"readable\":false,\"sourceText\":\"\"}.",
          ].join(" "),
        },
        {
          inlineData: {
            data: crop.toString("base64"),
            mimeType: "image/jpeg",
          },
        },
      ],
    }],
    config: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      abortSignal: signal,
    },
  });
  const text = response.text?.trim();
  if (!text) {
    throw Object.assign(
      new Error("Gemini visual recovery returned an empty response"),
      { code: "EMPTY_RESPONSE" },
    );
  }
  return text;
}

async function askCworksVisionRegionRecovery(
  crop: Buffer,
  sourceLanguage: string,
  regionKind: CworksVisualRecoveryRegion["kind"],
  signal: AbortSignal,
): Promise<string> {
  if (getCworksTranslationReadiness().provider !== "gemini") return "";
  const ai = new GoogleGenAI({
    apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY!,
    httpOptions: {
      apiVersion: "",
      baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL!,
    },
  });
  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [{
      role: "user",
      parts: [
        {
          text: [
            regionKind === "raster-strip" || regionKind === "raster-region"
              ? "Inspect this tightly bounded embedded-image region from a rendered hybrid CAD page. A local rendered-region audit detected likely human-language text here."
              : "Inspect this bounded top title zone from a selectable CAD PDF.",
            `The expected source language is ${sourceLanguage === "auto" ? "unknown; detect each line independently" : sourceLanguage}.`,
            "Return only visually readable human-language headings or labels that are rasterized in the image.",
            "Ignore pure dimensions, quantities, axes, drawing numbers, standards, model numbers, signatures, and logos.",
            "For each line return its exact source wording and a tight bbox in normalized crop coordinates from 0 to 1000.",
            regionKind === "raster-strip" || regionKind === "raster-region"
              ? "For each line also set likelySourceLanguage true only when the visible wording is confidently human language rather than a code or measurement."
              : "",
            regionKind === "raster-strip" || regionKind === "raster-region"
              ? "Return JSON only: {\"lines\":[{\"sourceText\":\"...\",\"bbox\":[x0,y0,x1,y1],\"likelySourceLanguage\":true}]}."
              : "Return JSON only: {\"lines\":[{\"sourceText\":\"...\",\"bbox\":[x0,y0,x1,y1]}]}.",
            "If no qualifying line is visible, return {\"lines\":[]}. Do not translate or infer hidden text.",
          ].filter(Boolean).join(" "),
        },
        {
          inlineData: {
            data: crop.toString("base64"),
            mimeType: "image/jpeg",
          },
        },
      ],
    }],
    config: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      abortSignal: signal,
    },
  });
  const text = response.text?.trim();
  if (!text) {
    throw Object.assign(
      new Error("Gemini raster-title recovery returned an empty response"),
      { code: "EMPTY_RESPONSE" },
    );
  }
  return text;
}

function getCworksIndependentAuditor(): OpenAI {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim();
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim();
  if (!apiKey || !baseURL) {
    throw new Error("The independent drawing audit provider is not configured");
  }
  return new OpenAI({ apiKey, baseURL });
}

function normalizeMachineAuditFinding(value: any): CworksMachineAuditFinding | null {
  const allowed = new Set<CworksMachineAuditFinding["type"]>([
    "source_residue",
    "missing_translation",
    "semantic_mismatch",
    "placement",
    "unreadable",
  ]);
  const type = allowed.has(value?.type) ? value.type : null;
  const message = typeof value?.message === "string"
    ? value.message.replace(/\s+/g, " ").trim().slice(0, 500)
    : "";
  if (!type || !message) return null;
  const sourceBlockId = typeof value?.sourceBlockId === "string"
    ? value.sourceBlockId.slice(0, 120)
    : undefined;
  return { type, message, ...(sourceBlockId ? { sourceBlockId } : {}) };
}

export function parseCworksMachineAudit(
  raw: string,
  pageNumber: number,
): CworksPageMachineAudit {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(unfenced);
  const findings = Array.isArray(parsed?.findings)
    ? parsed.findings
        .map(normalizeMachineAuditFinding)
        .filter((item: CworksMachineAuditFinding | null): item is CworksMachineAuditFinding => Boolean(item))
        .slice(0, 100)
    : [];
  const passed = parsed?.passed === true && findings.length === 0;
  return {
    pageNumber,
    status: passed ? "passed" : "findings",
    model: MACHINE_AUDIT_MODEL,
    findings: passed
      ? []
      : findings.length
        ? findings
        : [{
            type: "unreadable",
            message: "The independent auditor did not positively confirm this rendered page.",
          }],
  };
}

type NativeDxfTranslationRow = {
  targetId: string;
  translation: string;
};

function parseNativeDxfTranslationRows(
  raw: string,
  allowedTargetIds: ReadonlySet<string>,
  requireExactTargetIds = false,
): NativeDxfTranslationRow[] {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(unfenced);
  const rows = Array.isArray(parsed?.translations)
    ? parsed.translations
    : Array.isArray(parsed) ? parsed : [];
  if (requireExactTargetIds) {
    const seen = new Set<string>();
    if (rows.length !== allowedTargetIds.size) {
      throw new Error("Native DXF translation response did not contain exactly one row per target");
    }
    for (const row of rows) {
      if (
        typeof row?.targetId !== "string"
        || !allowedTargetIds.has(row.targetId)
        || typeof row?.translation !== "string"
        || !row.translation.trim()
        || seen.has(row.targetId)
      ) {
        throw new Error("Native DXF translation response contained an invalid or duplicate target");
      }
      seen.add(row.targetId);
    }
    if (seen.size !== allowedTargetIds.size) {
      throw new Error("Native DXF translation response omitted a target");
    }
  }
  return rows
    .filter((row: any) =>
      typeof row?.targetId === "string"
      && allowedTargetIds.has(row.targetId)
      && typeof row?.translation === "string"
      && row.translation.trim())
    .map((row: any) => ({
      targetId: row.targetId,
      translation: row.translation.trim(),
    }));
}

export async function parseNativeDxfTranslationRowsWithRepair(
  raw: string,
  allowedTargetIds: ReadonlySet<string>,
  repair: (malformedResponse: string) => Promise<string>,
  requireExactTargetIds = false,
): Promise<NativeDxfTranslationRow[]> {
  try {
    return parseNativeDxfTranslationRows(raw, allowedTargetIds, requireExactTargetIds);
  } catch {
    const repaired = await repair(raw.slice(0, 12_000));
    return parseNativeDxfTranslationRows(repaired, allowedTargetIds, requireExactTargetIds);
  }
}

class NativeDxfMalformedTranslationResponse extends Error {
  readonly targetCount: number;
  readonly afterSubdivision: boolean;

  constructor(targetCount = 0, afterSubdivision = false) {
    super(
      `Native DXF translation response remained invalid for ${targetCount} target(s) `
      + `after JSON repair${afterSubdivision ? " and one bounded subdivision" : ""}; `
      + "no row from the failed request was accepted without an exact mapped response.",
    );
    this.name = "NativeDxfMalformedTranslationResponse";
    this.targetCount = targetCount;
    this.afterSubdivision = afterSubdivision;
  }
}

type NativeDxfTranslationBatchRequest = (
  batch: any[],
  targetIds: ReadonlySet<string>,
  wireTargetIds?: ReadonlyMap<string, string>,
) => Promise<string>;

type NativeDxfTranslationBatchRepair = (
  batch: any[],
  targetIds: ReadonlySet<string>,
  malformedResponse: string,
  wireTargetIds?: ReadonlyMap<string, string>,
) => Promise<string>;

/**
 * A malformed large response must not cause us to silently accept a partial
 * translation map.  The one bounded subdivision is deliberately based on the
 * original source batch, not on the malformed provider response.  A caller can
 * persist each successful sibling through onSubBatchSuccess before the other
 * sibling is attempted.
 */
export async function requestNativeDxfTranslationRowsWithBoundedSubdivision(
  batch: any[],
  requestBatch: NativeDxfTranslationBatchRequest,
  repairBatch: NativeDxfTranslationBatchRepair,
  splitBatch: (batch: any[]) => [any[], any[]],
  onSubBatchSuccess?: (rows: NativeDxfTranslationRow[], complete: boolean) => Promise<void>,
  wireTargetIdsForBatch?: (batch: any[]) => ReadonlyMap<string, string>,
): Promise<NativeDxfTranslationRow[]> {
  const requestRows = async (sourceBatch: any[]): Promise<NativeDxfTranslationRow[]> => {
    const immutableTargetIds = new Set<string>(sourceBatch.map((item: any) => item.targetId));
    if (
      sourceBatch.length !== immutableTargetIds.size
      || [...immutableTargetIds].some((targetId) => !targetId)
    ) {
      throw new NativeDxfMalformedTranslationResponse(sourceBatch.length);
    }
    const wireTargetIds = wireTargetIdsForBatch?.(sourceBatch);
    const targetIds = wireTargetIds
      ? new Set<string>([...wireTargetIds.values()])
      : immutableTargetIds;
    if (
      wireTargetIds
      && (wireTargetIds.size !== immutableTargetIds.size
        || targetIds.size !== immutableTargetIds.size
        || [...immutableTargetIds].some((targetId) => !wireTargetIds.get(targetId))
        || [...targetIds].some((targetId) => !targetId))
    ) {
      throw new NativeDxfMalformedTranslationResponse(sourceBatch.length);
    }
    const immutableIdByWireId = wireTargetIds
      ? new Map([...wireTargetIds.entries()].map(([immutableId, wireId]) => [wireId, immutableId]))
      : new Map([...immutableTargetIds].map((targetId) => [targetId, targetId]));
    const mapToImmutableIds = (rows: NativeDxfTranslationRow[]) => rows.map((row) => ({
      ...row,
      targetId: immutableIdByWireId.get(row.targetId)!,
    }));
    const raw = await requestBatch(sourceBatch, targetIds, wireTargetIds);
    try {
      return mapToImmutableIds(parseNativeDxfTranslationRows(raw, targetIds, true));
    } catch {
      // The repair request is still provider-bounded, but its failure is a
      // provider failure, not malformed response data eligible for subdivision.
      const repaired = await repairBatch(
        sourceBatch, targetIds, raw.slice(0, 12_000), wireTargetIds,
      );
      try {
        return mapToImmutableIds(parseNativeDxfTranslationRows(repaired, targetIds, true));
      } catch {
        throw new NativeDxfMalformedTranslationResponse(sourceBatch.length);
      }
    }
  };

  try {
    const rows = await requestRows(batch);
    await onSubBatchSuccess?.(rows, true);
    return rows;
  } catch (error) {
    if (!(error instanceof NativeDxfMalformedTranslationResponse) || batch.length < 2) {
      throw error;
    }
    const [left, right] = splitBatch(batch);
    if (!left.length || !right.length || left.length >= batch.length || right.length >= batch.length) {
      throw error;
    }
    const rows: NativeDxfTranslationRow[] = [];
    let leftRows: NativeDxfTranslationRow[];
    try {
      leftRows = await requestRows(left);
    } catch (subdivisionError) {
      if (subdivisionError instanceof NativeDxfMalformedTranslationResponse) {
        throw new NativeDxfMalformedTranslationResponse(left.length, true);
      }
      throw subdivisionError;
    }
    rows.push(...leftRows);
    await onSubBatchSuccess?.(leftRows, false);
    let rightRows: NativeDxfTranslationRow[];
    try {
      rightRows = await requestRows(right);
    } catch (subdivisionError) {
      if (subdivisionError instanceof NativeDxfMalformedTranslationResponse) {
        throw new NativeDxfMalformedTranslationResponse(right.length, true);
      }
      throw subdivisionError;
    }
    rows.push(...rightRows);
    await onSubBatchSuccess?.(rightRows, true);
    return rows;
  }
}

export function buildCworksAuditLedger(pageTranslations: CworksTranslation[]) {
  const grouped = new Map<string, CworksTranslation[]>();
  const individual: CworksTranslation[] = [];
  for (const item of pageTranslations) {
    const compactGroupId = item.compactGroupId
      || (item.layoutGroupCompact ? item.layoutGroupId : undefined);
    const compactTranslation = item.compactGroupTranslation || item.layoutGroupTranslation;
    if (compactGroupId && compactTranslation) {
      const members = grouped.get(compactGroupId) || [];
      members.push(item);
      grouped.set(compactGroupId, members);
    } else {
      individual.push(item);
    }
  }
  return [
    ...individual.map((item) => ({
      id: item.id,
      source: item.source,
      translation: item.translation,
      uncertain: item.uncertain,
      bbox: item.bbox,
    })),
    ...Array.from(grouped.entries()).map(([compactGroupId, members]) => ({
      id: compactGroupId,
      memberIds: members.map((item) => item.id),
      source: joinedLayoutSource(members.map((item) => ({
        id: item.id,
        text: item.source,
        bbox: item.bbox,
        fontSize: item.fontSize,
      }))),
      translation: members[0].compactGroupTranslation || members[0].layoutGroupTranslation,
      uncertain: members.some((item) => item.uncertain),
      bboxes: members.map((item) => item.bbox),
    })),
  ];
}

async function askCworksIndependentPageAudit(
  sourcePage: Buffer,
  translatedPage: Buffer,
  pageTranslations: CworksTranslation[],
  sourceLanguage: string,
  requestedTargetLanguage: CworksTargetLanguage,
  signal: AbortSignal,
): Promise<string> {
  const client = getCworksIndependentAuditor();
  const ledger = buildCworksAuditLedger(pageTranslations);
  const completion = await client.chat.completions.create({
    model: MACHINE_AUDIT_MODEL,
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [{
      role: "system",
      content: [
        "You are the independent quality auditor for an engineering drawing translation.",
        `Audit methodology version: ${MACHINE_AUDIT_METHODOLOGY_VERSION}.`,
        `The first image is the original source page and the second is the rendered ${targetLanguageName(requestedTargetLanguage)} draft.`,
        "Compare every visible human-language label, table cell, heading, note, and rotated annotation.",
        `Flag visible source-language residue, missing ${targetLanguageName(requestedTargetLanguage)}, any replacement written in the wrong target language, materially wrong technical meaning, misplaced/unreadable overlays, or content that cannot be checked.`,
        "Do not flag dimensions, pure identifiers, standards, revision codes, model numbers, signatures, or logos when intentionally preserved.",
        "Never approve by inference: passed may be true only when the page is visually accountable and the supplied ledger has no uncertain line.",
        "Return JSON only: {\"passed\":boolean,\"findings\":[{\"type\":\"source_residue|missing_translation|semantic_mismatch|placement|unreadable\",\"message\":\"specific finding\",\"sourceBlockId\":\"optional ledger id\"}]}",
      ].join(" "),
    }, {
      role: "user",
      content: [{
        type: "text",
        text: [
          `Expected source language: ${sourceLanguage === "auto" ? "auto-detect each visible line" : sourceLanguage}.`,
          `Required target language: ${targetLanguageName(requestedTargetLanguage)} (${requestedTargetLanguage}).`,
          `Positioned source-line ledger: ${JSON.stringify(ledger).slice(0, 60_000)}`,
        ].join("\n"),
      }, {
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${sourcePage.toString("base64")}`,
          detail: "high",
        },
      }, {
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${translatedPage.toString("base64")}`,
          detail: "high",
        },
      }],
    }],
  }, { signal });
  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) {
    throw Object.assign(new Error("Independent page auditor returned an empty response"), {
      code: "EMPTY_RESPONSE",
    });
  }
  return text;
}

function leaseUntil() {
  return new Date(Date.now() + LEASE_MS);
}

type ProcessorStage = "extraction" | "overlay" | "render" | "crop" | "merge";
type ProcessorExecutor = (
  command: string,
  args: string[],
  options: {
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;
type ProcessorFailure = Error & {
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};
export type ProcessorFailureDiagnostic = {
  jobId?: string;
  stage: ProcessorStage;
  attempt: number;
  maxAttempts: number;
  exitCode: string | number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  deterministic: boolean;
  stderr: string;
};
type RunProcessorOptions = {
  stage: ProcessorStage;
  timeoutMs: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  jobId?: string;
  executor?: ProcessorExecutor;
  beforeAttempt?: (attempt: number) => Promise<void> | void;
  onRetry?: (nextAttempt: number, maxAttempts: number) => Promise<void> | void;
  logDiagnostic?: (diagnostic: ProcessorFailureDiagnostic) => void;
};

export class CworksProcessorError extends Error {
  readonly stage: ProcessorStage;
  readonly deterministic: boolean;
  readonly attempts: number;

  constructor(
    message: string,
    options: { stage: ProcessorStage; deterministic: boolean; attempts: number },
  ) {
    super(message);
    this.name = "CworksProcessorError";
    this.stage = options.stage;
    this.deterministic = options.deterministic;
    this.attempts = options.attempts;
  }
}

const defaultProcessorExecutor: ProcessorExecutor = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, args, {
      ...options,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as ProcessorFailure;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function boundedDiagnosticText(value: unknown): string {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  return text.replace(/\0/g, "").slice(-4_000);
}

export function sanitizeProcessorUserMessage(message: string, fallback: string): string {
  const safe = message
    .replace(/[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/g, "the source file")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "the source file")
    .replace(/\b(?:python\d*(?:\.\d+)?|processor\.py)\b/gi, "drawing processor")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || fallback).slice(0, 500);
}

function documentRejectionMessage(stderr: string): string | null {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.kind === "document_rejected" && typeof parsed.message === "string") {
        return sanitizeProcessorUserMessage(
          parsed.message,
          "This PDF cannot be processed safely. Please check the file and try again.",
        );
      }
    } catch {
      // Non-JSON traceback lines remain available in the internal diagnostic.
    }
  }
  return null;
}

function processorUserMessage(stage: ProcessorStage): string {
  return stage === "extraction"
    ? "The drawing processor could not inspect this PDF. Please retry the drawing set; any saved page translations remain safe."
    : "The drawing processor could not finish placing the translated text. Please retry the drawing set; saved page translations remain safe.";
}

export async function runProcessor(
  args: string[],
  options: RunProcessorOptions,
): Promise<any> {
  const executor = options.executor || defaultProcessorExecutor;
  const maxAttempts = Math.max(1, options.maxAttempts || 1);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  const logDiagnostic = options.logDiagnostic || ((diagnostic: ProcessorFailureDiagnostic) => {
    console.error("[cworks-translator] processor failure", JSON.stringify(diagnostic));
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await options.beforeAttempt?.(attempt);
    try {
      const { stdout } = await executor(
        process.env.PYTHON_BIN || "python3",
        [PROCESSOR, ...args],
        {
          timeout: options.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        },
      );
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) throw Object.assign(new Error("Processor returned no result"), { code: "INVALID_OUTPUT" });
      try {
        return JSON.parse(line);
      } catch {
        throw Object.assign(new Error("Processor returned invalid JSON"), { code: "INVALID_OUTPUT" });
      }
    } catch (caught: any) {
      const err = caught as ProcessorFailure;
      const stderr = boundedDiagnosticText(err.stderr);
      const rejectionMessage = documentRejectionMessage(stderr);
      const deterministic = rejectionMessage !== null;
      const exitCode = err.code ?? null;
      const signal = err.signal ?? null;
      const killed = err.killed === true;
      const timedOut = exitCode === "ETIMEDOUT" || (killed && signal === "SIGTERM");
      logDiagnostic({
        jobId: options.jobId,
        stage: options.stage,
        attempt,
        maxAttempts,
        exitCode,
        signal,
        killed,
        timedOut,
        deterministic,
        stderr,
      });

      if (deterministic || attempt === maxAttempts) {
        throw new CworksProcessorError(
          rejectionMessage || processorUserMessage(options.stage),
          { stage: options.stage, deterministic, attempts: attempt },
        );
      }
      await options.onRetry?.(attempt + 1, maxAttempts);
      if (retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new CworksProcessorError(processorUserMessage(options.stage), {
    stage: options.stage,
    deterministic: false,
    attempts: maxAttempts,
  });
}

export async function claimNextJob(options: { jobId?: string } = {}): Promise<CworksJob | null> {
  const now = new Date();
  const claimable = or(
    inArray(cworksTranslationJobs.status, ["queued", "revising"]),
    and(eq(cworksTranslationJobs.status, "running"), lt(cworksTranslationJobs.leaseExpiresAt, now)),
  );
  const [candidate] = await db.select().from(cworksTranslationJobs)
    .where(options.jobId
      ? and(eq(cworksTranslationJobs.id, options.jobId), claimable)
      : claimable)
    .orderBy(asc(cworksTranslationJobs.createdAt))
    .limit(1);
  if (!candidate) return null;

  const runToken = randomUUID();
  const resuming = candidate.status === "running" || candidate.retryCount > 0 || candidate.pagesDone > 0;
  const condition = candidate.status === "running"
    ? and(
        eq(cworksTranslationJobs.id, candidate.id),
        eq(cworksTranslationJobs.status, "running"),
        eq(cworksTranslationJobs.runToken, candidate.runToken || ""),
        lt(cworksTranslationJobs.leaseExpiresAt, now),
      )
    : and(eq(cworksTranslationJobs.id, candidate.id), eq(cworksTranslationJobs.status, candidate.status));

  const [claimed] = await db.update(cworksTranslationJobs)
    .set({
      status: "running",
      runToken,
      leaseExpiresAt: leaseUntil(),
      startedAt: candidate.startedAt || new Date(),
      completedAt: null,
      errorMessage: null,
      progressNote: candidate.status === "revising"
        ? "Applying review feedback"
        : resuming
          ? "Resuming from the last saved page"
          : "Preparing drawing set",
      updatedAt: new Date(),
    })
    .where(condition)
    .returning();
  return claimed || null;
}

async function updateClaimed(job: CworksJob, values: Partial<typeof cworksTranslationJobs.$inferInsert>) {
  const rows = await db.update(cworksTranslationJobs)
    .set({ ...values, leaseExpiresAt: leaseUntil(), updatedAt: new Date() })
    .where(and(eq(cworksTranslationJobs.id, job.id), eq(cworksTranslationJobs.runToken, job.runToken || "")))
    .returning({ id: cworksTranslationJobs.id });
  if (!rows.length) throw new Error("CAD translation lease was superseded");
}

async function assertOwned(job: CworksJob): Promise<void> {
  const [owned] = await db.select({ runToken: cworksTranslationJobs.runToken, status: cworksTranslationJobs.status })
    .from(cworksTranslationJobs)
    .where(eq(cworksTranslationJobs.id, job.id))
    .limit(1);
  if (!owned || owned.status !== "running" || owned.runToken !== job.runToken) {
    throw new Error("CAD translation lease was superseded");
  }
}

async function queueCleanup(storedNames: string[], jobId: string | null) {
  const names = Array.from(new Set(storedNames.filter(Boolean)));
  if (!names.length) return;
  await db.insert(cworksTranslationCleanup).values(names.map((storedName) => ({
    storedName,
    jobId,
  }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
}

export async function runCworksCleanupBatch(options: {
  jobId?: string;
  deleteObject?: (storedName: string) => Promise<void>;
} = {}) {
  const { jobId, deleteObject = deleteFromObjectStorageStrict } = options;
  const now = new Date();
  const expiredPreviews = await db.select().from(cworksTranslationTouchups).where(and(
    eq(cworksTranslationTouchups.status, "previewed"),
    lte(cworksTranslationTouchups.expiresAt, now),
  )).limit(100);
  if (expiredPreviews.length) {
    await db.transaction(async (tx) => {
      const names = expiredPreviews
        .map((row) => row.previewStoredName)
        .filter((name): name is string => Boolean(name));
      if (names.length) {
        await tx.insert(cworksTranslationCleanup).values(names.map((storedName) => ({
          storedName,
          jobId: expiredPreviews.find((row) => row.previewStoredName === storedName)?.jobId || null,
        }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
      await tx.update(cworksTranslationTouchups).set({ status: "expired" }).where(inArray(
        cworksTranslationTouchups.id,
        expiredPreviews.map((row) => row.id),
      ));
    });
  }
  const rows = await db.select().from(cworksTranslationCleanup)
    .where(jobId
      ? eq(cworksTranslationCleanup.jobId, jobId)
      : lte(cworksTranslationCleanup.nextAttemptAt, new Date()))
    .orderBy(asc(cworksTranslationCleanup.createdAt))
    .limit(20);
  for (const row of rows) {
    try {
      // Inspection caches are represented in the existing cleanup outbox from
      // the moment they are written. They remain reusable while the owning job
      // exists; once deletion removes that job, this same outbox row performs
      // the object deletion. This avoids an untracked cache-object namespace.
      if (row.jobId && isNativeDxfInspectionCacheKey(row.storedName)) {
        const [owningJob] = await db.select({ id: cworksTranslationJobs.id })
          .from(cworksTranslationJobs)
          .where(eq(cworksTranslationJobs.id, row.jobId))
          .limit(1);
        if (owningJob) {
          // Do not let a durable cache row at the head of the outbox starve
          // ordinary deletion work. The job deletion route brings all of its
          // outbox rows forward again when the job is actually removed.
          await db.update(cworksTranslationCleanup)
            .set({ nextAttemptAt: new Date(Date.now() + 60 * 60_000) })
            .where(eq(cworksTranslationCleanup.id, row.id));
          continue;
        }
      }
      await deleteObject(row.storedName);
      await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.id, row.id));
    } catch (err: any) {
      const attempts = row.attempts + 1;
      const delayMs = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(attempts, 8)));
      await db.update(cworksTranslationCleanup).set({
        attempts,
        lastError: String(err?.message || err).slice(0, 800),
        nextAttemptAt: new Date(Date.now() + delayMs),
      }).where(eq(cworksTranslationCleanup.id, row.id));
    }
  }
}

function isPureDrawingIdentifier(text: string): boolean {
  const value = text.trim();
  if (/^(?:ГОСТ|СП|СНиП|ТУ|ISO|EN|BS|DIN|ASTM|JIS|GB|NF|AS\/NZS)(?:\s|[-–—./]|\d)/iu.test(value)) return true;
  const compactCode = value.replace(/\s*([-–—./])\s*/gu, "$1");
  // Digit-led drawing numbers are identifiers even when their discipline
  // suffix uses the source script. Never generalize this to arbitrary
  // letter-led words: План-1, Вид-1, and Узел-1-А are human labels.
  if (/^\d+(?:[-–—./][\p{L}\d]+)+$/u.test(compactCode)) return true;
  // Hyphen/slash forms are grid or detail markers. Dot notation such as
  // Cyrillic Ф1.2 must be transliterated to its English code form F1.2.
  if (/^[\p{L}](?:[-–—/]\d[\p{L}\d\-–—./]*|\d[\p{L}\d\-–—/]*)$/u.test(compactCode)) return true;
  if (/^[\p{L}]$/u.test(value)) return true;
  if (/^[\d\s.,x×+±\-–—/]+\s*(?:mm|cm|m|m²|m2|pcs?|kg|%|мм|см|м|м²|м2|шт|кг)\.?$/iu.test(value)) return true;
  if (/^[A-Z0-9][A-Z0-9._/+\-–—]{1,24}$/u.test(value) && /\d/.test(value)) return true;
  return false;
}

export function shouldTranslate(
  block: CworksBlock,
  depth: string,
  sourceLanguage = "auto",
): boolean {
  if (!block.suspicious && !/\p{L}/u.test(block.text)) return false;
  const explicitScript = {
    ru: /\p{Script=Cyrillic}/u,
    ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
    zh: /\p{Script=Han}/u,
    ko: /\p{Script=Hangul}/u,
    ar: /\p{Script=Arabic}/u,
    he: /\p{Script=Hebrew}/u,
  }[sourceLanguage];
  if (!block.suspicious && explicitScript && !explicitScript.test(block.text)) return false;
  if (isPureDrawingIdentifier(block.text)) return false;
  if (depth === "major-text" && (block.fontSize < 5.5 || block.text.trim().length < 2)) return false;
  return true;
}

export function fitAwareDrawingTranslation(block: CworksBlock, translation: string): string {
  const source = block.text.replace(/\s+/g, " ").trim().replace(/[.:;]+$/u, "");
  const sourceKey = source.toLocaleLowerCase("ru-RU");
  const conventional = new Map<string, string>([
    ["проверил", "CHK"],
    ["гип", "CPE"],
    ["инв. n подл", "Orig. inv. No."],
    ["подп. и дата", "Sign. & date"],
    ["взам. инв. n", "Repl. Inv."],
    ["инв", "inv."],
    ["взам", "Repl."],
    ["подп", "Sign."],
  ]).get(sourceKey);
  if (!conventional) return translation;
  const [dx, dy] = block.direction;
  const followsVerticalAxis = Math.abs(dy) > Math.abs(dx);
  const availableWidth = Math.max(
    1,
    followsVerticalAxis ? block.bbox[3] - block.bbox[1] : block.bbox[2] - block.bbox[0],
  );
  const estimatedWidth = translation.length * Math.max(block.fontSize, 5) * 0.48;
  return estimatedWidth > availableWidth * 1.05 ? conventional : translation;
}

function parseVisualRecovery(raw: string): string | null {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let candidate = "";
  try {
    const parsed = JSON.parse(unfenced);
    if (parsed?.readable === false) return null;
    candidate = typeof parsed?.sourceText === "string" ? parsed.sourceText : "";
  } catch {
    candidate = unfenced;
  }
  candidate = candidate.replace(/\s+/g, " ").trim();
  if (
    !candidate
    || candidate.length > 1_000
    || /^(?:unreadable|illegible|unknown|none)$/i.test(candidate)
  ) {
    return null;
  }
  const unknown = Array.from(candidate).filter((char) => char === "?" || char === "\ufffd").length;
  if (unknown >= 2 && unknown / Math.max(candidate.length, 1) >= 0.35) return null;
  return candidate;
}

function visualRegionSourceHash(
  job: CworksJob,
  page: CworksPage,
  region: CworksVisualRecoveryRegion,
): string {
  return createHash("sha256").update(JSON.stringify({
    visualRecoveryMethodologyVersion: VISUAL_RECOVERY_METHODOLOGY_VERSION,
    revisionCount: job.revisionCount,
    sourceLanguage: job.sourceLanguage,
    pageNumber: page.pageNumber,
    regionId: region.id,
    regionKind: region.kind || "raster-title",
    bbox: region.bbox,
  })).digest("hex");
}

function parseVisualRegionRecovery(
  raw: string,
  region: CworksVisualRecoveryRegion,
): CworksBlock[] {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed?.lines)) return [];
  const [rx0, ry0, rx1, ry1] = region.bbox;
  const width = rx1 - rx0;
  const height = ry1 - ry0;
  return parsed.lines.slice(0, 12).flatMap((line: any, index: number) => {
    const sourceText = typeof line?.sourceText === "string"
      ? line.sourceText.replace(/\s+/g, " ").trim()
      : "";
    const box = line?.bbox;
    if (
      !sourceText
      || sourceText.length > 500
      || !/\p{L}/u.test(sourceText)
      || (
        (region.kind === "raster-strip" || region.kind === "raster-region")
        && line?.likelySourceLanguage !== true
      )
      || !Array.isArray(box)
      || box.length !== 4
      || box.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))
    ) return [];
    const normalized = box.map((value: number) => Math.max(0, Math.min(1000, value)));
    if (normalized[2] <= normalized[0] || normalized[3] <= normalized[1]) return [];
    const bbox: [number, number, number, number] = [
      rx0 + (normalized[0] / 1000) * width,
      ry0 + (normalized[1] / 1000) * height,
      rx0 + (normalized[2] / 1000) * width,
      ry0 + (normalized[3] / 1000) * height,
    ];
    return [{
      id: `${region.id}-l${index}`,
      text: sourceText,
      bbox,
      fontSize: Math.max(5, Math.min(18, (bbox[3] - bbox[1]) * 0.8)),
      direction: [1, 0] as [number, number],
      color: 0,
      suspicious: false,
      recoveredFromVisual: true,
      rasterBacked: true,
    }];
  });
}

function overlapsExtractedBlock(candidate: CworksBlock, blocks: CworksBlock[]): boolean {
  const [ax0, ay0, ax1, ay1] = candidate.bbox;
  const area = Math.max(1, (ax1 - ax0) * (ay1 - ay0));
  return blocks.some((block) => {
    const [bx0, by0, bx1, by1] = block.bbox;
    const blockArea = Math.max(1, (bx1 - bx0) * (by1 - by0));
    const overlap = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0))
      * Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
    return overlap / area >= 0.20 || overlap / blockArea >= 0.20;
  });
}

function visualRecoverySourceHash(job: CworksJob, page: CworksPage, block: CworksBlock): string {
  return createHash("sha256").update(JSON.stringify({
    visualRecoveryMethodologyVersion: VISUAL_RECOVERY_METHODOLOGY_VERSION,
    revisionCount: job.revisionCount,
    sourceLanguage: job.sourceLanguage,
    pageNumber: page.pageNumber,
    blockId: block.id,
    extractedText: block.text,
    bbox: block.bbox,
    direction: block.direction,
  })).digest("hex");
}

export async function recoverSuspiciousBlocks(
  job: CworksJob,
  pages: CworksPage[],
  inputPath: string,
  dir: string,
  options: RecoverSuspiciousBlocksOptions = {},
): Promise<{
  pages: CworksPage[];
  attemptedCount: number;
  recoveredCount: number;
  unresolvedCount: number;
}> {
  const checkpointRows = await db.select().from(cworksTranslationCheckpoints).where(and(
    eq(cworksTranslationCheckpoints.jobId, job.id),
    eq(cworksTranslationCheckpoints.revisionCount, job.revisionCount),
  ));
  const savedRecoveries = new Map<string, CworksTranslation>();
  for (const checkpoint of checkpointRows) {
    if (!Array.isArray(checkpoint.translations)) continue;
    for (const item of checkpoint.translations as CworksTranslation[]) {
      if (
        item?.recoveredFromVisual
        && item.id
        && item.source?.trim()
        && item.recoverySourceHash
      ) {
        savedRecoveries.set(item.id, item);
      }
    }
  }

  const recoveredPages: CworksPage[] = [];
  let attemptedCount = 0;
  let recoveredCount = 0;
  let unresolvedCount = 0;
  let remainingJobBudget = MAX_VISUAL_RECOVERY_BLOCKS_PER_JOB;
  const cropDir = path.join(dir, "visual-recovery");
  await fs.mkdir(cropDir, { recursive: true });

  for (const page of pages) {
    let remainingPageBudget = MAX_VISUAL_RECOVERY_BLOCKS_PER_PAGE;
    const blocks: CworksBlock[] = [];
    const suspectCount = page.blocks.filter((block) => block.suspicious).length;
    if (suspectCount) {
      await updateClaimed(job, {
        progress: Math.max(10, Math.min(67, job.progress || 10)),
        progressNote: `Recovering unreadable drawing text — page ${page.pageNumber}`,
      });
    }
    for (const block of page.blocks) {
      if (!block.suspicious) {
        blocks.push(block);
        continue;
      }
      const recoverySourceHash = visualRecoverySourceHash(job, page, block);
      const saved = savedRecoveries.get(block.id);
      if (saved?.recoverySourceHash === recoverySourceHash) {
        if (remainingPageBudget <= 0 || remainingJobBudget <= 0) {
          blocks.push({ ...block, visualRecoveryFailed: true });
          unresolvedCount++;
          continue;
        }
        remainingPageBudget--;
        remainingJobBudget--;
        blocks.push({
          ...block,
          text: saved.source,
          extractedText: block.text,
          suspicious: false,
          recoveredFromVisual: true,
          recoverySourceHash,
        });
        recoveredCount++;
        continue;
      }
      if (remainingPageBudget <= 0 || remainingJobBudget <= 0) {
        blocks.push({ ...block, visualRecoveryFailed: true });
        unresolvedCount++;
        continue;
      }
      remainingPageBudget--;
      remainingJobBudget--;
      attemptedCount++;
      const safeId = block.id.replace(/[^A-Za-z0-9_-]/g, "_");
      const cropPath = path.join(cropDir, `${safeId}.jpg`);
      let recovered: string | null = null;
      try {
        if (options.recoverBlock) {
          const controller = new AbortController();
          recovered = await options.recoverBlock({
            block,
            page,
            cropPath,
            signal: controller.signal,
          });
        } else if (getCworksTranslationReadiness().provider === "gemini") {
          await runProcessor([
            "crop",
            inputPath,
            String(page.pageNumber),
            ...block.bbox.map(String),
            cropPath,
          ], {
            stage: "crop",
            timeoutMs: PAGE_RENDER_TIMEOUT_MS,
            jobId: job.id,
          });
          const crop = await fs.readFile(cropPath);
          const raw = await requestCworksProviderWithRetry(
            (signal) => askCworksVisionRecovery(crop, job.sourceLanguage, signal),
            {
              quarantineKey: job.id,
              includeProviderMessageInLogs: false,
              onRetry: async ({ nextAttempt, maxAttempts }) => {
                await updateClaimed(job, {
                  progressNote: `Visual text recovery hit a temporary issue on page ${page.pageNumber} — retrying (${nextAttempt} of ${maxAttempts})`,
                });
              },
            },
          );
          recovered = parseVisualRecovery(raw);
        }
      } catch (error) {
        if (error instanceof CworksProviderError && !error.cancellationConfirmed) throw error;
        // A failed crop or unreadable line remains visible and is counted by
        // the completeness gate. Never log its source text or private image.
        recovered = null;
      } finally {
        await fs.rm(cropPath, { force: true });
      }
      const normalized = recovered ? parseVisualRecovery(recovered) : null;
      if (normalized) {
        blocks.push({
          ...block,
          text: normalized,
          extractedText: block.text,
          suspicious: false,
          recoveredFromVisual: true,
          recoverySourceHash,
        });
        recoveredCount++;
      } else {
        blocks.push({ ...block, visualRecoveryFailed: true });
        unresolvedCount++;
      }
    }
    for (const region of page.visualRecoveryRegions || []) {
      if (remainingPageBudget <= 0 || remainingJobBudget <= 0) {
        unresolvedCount++;
        continue;
      }
      const recoverySourceHash = visualRegionSourceHash(job, page, region);
      const matchingRestored = Array.from(savedRecoveries.values())
        .filter((item) =>
          item.rasterBacked
          && item.recoverySourceHash === recoverySourceHash
          && item.pageNumber === page.pageNumber);
      const restored = matchingRestored
        .map((item) => ({
          id: item.id,
          text: item.source,
          bbox: item.bbox,
          fontSize: item.fontSize,
          direction: item.direction,
          color: item.color,
          suspicious: false,
          recoveredFromVisual: true,
          recoverySourceHash,
          rasterBacked: true,
        } satisfies CworksBlock))
        .filter((candidate) => !overlapsExtractedBlock(candidate, blocks))
        .slice(0, Math.min(remainingPageBudget, remainingJobBudget));
      if (matchingRestored.length) {
        blocks.push(...restored);
        remainingPageBudget -= restored.length;
        remainingJobBudget -= restored.length;
        recoveredCount += restored.length;
        continue;
      }
      remainingPageBudget--;
      remainingJobBudget--;
      attemptedCount++;
      const safeId = region.id.replace(/[^A-Za-z0-9_-]/g, "_");
      const cropPath = path.join(cropDir, `${safeId}.jpg`);
      let recoveredRegionBlocks: CworksBlock[] = [];
      try {
        let raw: string;
        if (options.recoverRegion) {
          const controller = new AbortController();
          raw = await options.recoverRegion({
            region,
            page,
            cropPath,
            signal: controller.signal,
          });
        } else if (getCworksTranslationReadiness().provider === "gemini") {
          await updateClaimed(job, {
            progressNote: region.kind === "raster-strip" || region.kind === "raster-region"
              ? `Checking audited rasterized drawing notes — page ${page.pageNumber}`
              : `Checking rasterized drawing titles — page ${page.pageNumber}`,
          });
          await runProcessor([
            "crop",
            inputPath,
            String(page.pageNumber),
            ...region.bbox.map(String),
            cropPath,
          ], {
            stage: "crop",
            timeoutMs: PAGE_RENDER_TIMEOUT_MS,
            jobId: job.id,
          });
          const crop = await fs.readFile(cropPath);
          raw = await requestCworksProviderWithRetry(
            (signal) => askCworksVisionRegionRecovery(
              crop,
              job.sourceLanguage,
              region.kind || "raster-title",
              signal,
            ),
            {
              quarantineKey: job.id,
              includeProviderMessageInLogs: false,
              onRetry: async ({ nextAttempt, maxAttempts }) => {
                await updateClaimed(job, {
                  progressNote: `Raster text recovery hit a temporary issue on page ${page.pageNumber} — retrying (${nextAttempt} of ${maxAttempts})`,
                });
              },
            },
          );
        } else {
          raw = "{\"lines\":[]}";
        }
        recoveredRegionBlocks = parseVisualRegionRecovery(raw, region)
          .filter((candidate) =>
            shouldTranslate(candidate, job.drawingDepth, job.sourceLanguage)
            && !overlapsExtractedBlock(candidate, blocks))
          .slice(0, Math.min(remainingPageBudget + 1, remainingJobBudget + 1))
          .map((candidate) => ({ ...candidate, recoverySourceHash }));
      } catch (error) {
        if (error instanceof CworksProviderError && !error.cancellationConfirmed) throw error;
        unresolvedCount++;
      } finally {
        await fs.rm(cropPath, { force: true });
      }
      blocks.push(...recoveredRegionBlocks);
      const extraBudgetUsed = Math.max(0, recoveredRegionBlocks.length - 1);
      remainingPageBudget -= extraBudgetUsed;
      remainingJobBudget -= extraBudgetUsed;
      recoveredCount += recoveredRegionBlocks.length;
    }
    recoveredPages.push({ ...page, blocks });
  }
  await fs.rm(cropDir, { recursive: true, force: true });
  return {
    pages: recoveredPages,
    attemptedCount,
    recoveredCount,
    unresolvedCount,
  };
}

export function requireRecoverableCworksText(
  job: Pick<CworksJob, "drawingDepth" | "sourceLanguage">,
  pages: CworksPage[],
): number {
  const recoverableBlockCount = pages.reduce(
    (count, page) => count + page.blocks.filter((block) =>
      shouldTranslate(block, job.drawingDepth, job.sourceLanguage)).length,
    0,
  );
  if (!recoverableBlockCount) {
    throw new Error("No translatable human-language text was found in the selectable drawing or its bounded raster regions.");
  }
  return recoverableBlockCount;
}

function chunksOfBlocks(blocks: CworksBlock[]): CworksBlock[][] {
  const chunks: CworksBlock[][] = [];
  let current: CworksBlock[] = [];
  let chars = 0;
  for (const block of blocks) {
    const next = block.text.length + block.id.length + 10;
    if (current.length && (current.length >= 32 || chars + next > 5_000)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(block);
    chars += next;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function parseTranslationJson(raw: string): Array<{
  id: string;
  translation: string;
  uncertain?: boolean;
  layoutGroupTranslation?: string;
}> {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Translator returned invalid JSON");
  const parsed = JSON.parse(unfenced.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Translator response was not an array");
  return parsed
    .filter((x) => x && typeof x.id === "string" && typeof x.translation === "string")
    .map((x) => ({
      id: x.id,
      translation: x.translation,
      uncertain: x.uncertain === true,
      layoutGroupTranslation: typeof x.layoutGroupTranslation === "string"
        ? x.layoutGroupTranslation
        : undefined,
    }));
}

function joinedLayoutSource(blocks: CworksBlock[]): string {
  let joined = "";
  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (joined.endsWith("-")) joined = `${joined.slice(0, -1)}${text}`;
    else joined = joined ? `${joined} ${text}` : text;
  }
  return joined;
}

function placementGroupKey(block: Pick<CworksBlock, "id" | "paragraphId" | "placementGroupId" | "layoutGroupId">): string {
  return block.placementGroupId || block.layoutGroupId || block.paragraphId || block.id;
}

function compactGroupKey(block: Pick<CworksBlock, "compactGroupId" | "layoutGroupId" | "layoutGroupCompact">): string | undefined {
  return block.compactGroupId
    || (block.layoutGroupCompact ? block.layoutGroupId : undefined);
}

function layoutContext(blocks: CworksBlock[]) {
  const groups = new Map<string, CworksBlock[]>();
  for (const block of blocks) {
    const key = compactGroupKey(block);
    if (!key) continue;
    const members = groups.get(key) || [];
    members.push(block);
    groups.set(key, members);
  }
  return new Map(Array.from(groups.entries()).map(([key, members]) => [
    key,
    {
      memberIds: members.map((member) => member.id),
      source: joinedLayoutSource(members),
      compact: true,
    },
  ]));
}

function translationPromptInput(blocks: CworksBlock[], allEligible: CworksBlock[]) {
  const context = layoutContext(allEligible);
  return blocks.map((block) => {
    const key = compactGroupKey(block);
    if (!key) return { id: block.id, text: block.text };
    const group = context.get(key);
    return {
      id: block.id,
      text: block.text,
      ...(group && group.memberIds.length > 1 && group.compact
        ? {
            layoutGroupId: key,
            layoutGroupMemberIds: group.memberIds,
            layoutGroupSource: group.source,
          }
        : {}),
    };
  });
}

function translationIsResolved(
  block: CworksBlock,
  translated: { translation: string; uncertain?: boolean } | undefined,
  sourceLanguage = "auto",
  requestedTargetLanguage: CworksTargetLanguage = "en",
): boolean {
  if (!translated || translated.uncertain === true || !translated.translation.trim()) return false;
  if (!isCworksTargetLanguageText(translated.translation, requestedTargetLanguage)) return false;
  if (
    sourceLanguage !== "auto"
    && block.text.replace(/\s+/g, " ").trim().toLocaleLowerCase()
      === translated.translation.replace(/\s+/g, " ").trim().toLocaleLowerCase()
  ) {
    return false;
  }
  return true;
}

function layoutTranslationIsResolved(
  value: string | undefined,
  requestedTargetLanguage: CworksTargetLanguage = "en",
): value is string {
  if (!value?.trim()) return false;
  return isCworksTargetLanguageText(value, requestedTargetLanguage);
}

function pageSourceHash(job: CworksJob, page: CworksPage, eligible: CworksBlock[], skill: string): string {
  return createHash("sha256").update(JSON.stringify({
    translationMethodologyVersion: TRANSLATION_METHODOLOGY_VERSION,
    revisionCount: job.revisionCount,
    sourceLanguage: job.sourceLanguage,
    targetLanguage: targetLanguage(job),
    drawingDepth: job.drawingDepth,
    scope: job.scope,
    feedbackNotes: job.feedbackNotes || "",
    methodologyHash: createHash("sha256").update(skill).digest("hex"),
    pageNumber: page.pageNumber,
    blocks: eligible.map((block) => ({
      id: block.id,
      text: block.text,
      extractedText: block.extractedText || block.text,
      recoveredFromVisual: Boolean(block.recoveredFromVisual),
      visualRecoveryFailed: Boolean(block.visualRecoveryFailed),
      rasterBacked: Boolean(block.rasterBacked),
      paragraphId: block.paragraphId,
      placementGroupId: block.placementGroupId,
      compactGroupId: block.compactGroupId,
      compactGroupCompact: Boolean(block.compactGroupCompact),
      layoutGroupId: block.layoutGroupId,
      layoutGroupCompact: Boolean(block.layoutGroupCompact),
      bbox: block.bbox,
      fontSize: block.fontSize,
      direction: block.direction || [1, 0],
      color: block.color || 0,
    })),
  })).digest("hex");
}

function readCheckpointTranslations(
  checkpoint: typeof cworksTranslationCheckpoints.$inferSelect,
  sourceHash: string,
  eligible: CworksBlock[],
): CworksTranslation[] | null {
  if (checkpoint.sourceHash !== sourceHash || !Array.isArray(checkpoint.translations)) return null;
  const translations = checkpoint.translations as CworksTranslation[];
  const expectedIds = eligible.map((block) => block.id);
  if (
    translations.length !== expectedIds.length
    || translations.some((item, index) =>
      !item
      || item.id !== expectedIds[index]
      || item.pageNumber !== checkpoint.pageNumber
      || typeof item.translation !== "string"
      || typeof item.source !== "string"
    )
  ) {
    return null;
  }
  return translations;
}

type CworksRepairPage = {
  pageNumber: number;
  unsafePlacementBlockIds: string[];
  placementFailures: Array<{
    blockId: string;
    rejectionCategory: string;
    bbox?: [number, number, number, number];
  }>;
  retryWholePage: boolean;
  findings: Array<{ type: string; message: string; sourceBlockId?: string }>;
  reviewerNotes?: string | null;
};

function readRepairPages(job: CworksJob): Map<number, CworksRepairPage> {
  const brief = job.repairBrief as any;
  if (
    !["cworks-unresolved-repair", "cworks-manual-touchup"].includes(brief?.kind)
    || !Array.isArray(brief.pages)
  ) return new Map();
  return new Map(brief.pages
    .filter((page: any) => Number.isInteger(page?.pageNumber))
    .map((page: any) => [page.pageNumber, {
      pageNumber: page.pageNumber,
      unsafePlacementBlockIds: Array.isArray(page.unsafePlacementBlockIds)
        ? page.unsafePlacementBlockIds.map(String)
        : [],
      placementFailures: Array.isArray(page.placementFailures)
        ? page.placementFailures.flatMap((failure: any) => {
            if (
              typeof failure?.blockId !== "string"
              || typeof failure?.rejectionCategory !== "string"
            ) return [];
            const bbox = Array.isArray(failure.bbox)
              && failure.bbox.length === 4
              && failure.bbox.every((value: unknown) =>
                typeof value === "number" && Number.isFinite(value))
              ? failure.bbox.map(Number) as [number, number, number, number]
              : undefined;
            return [{
              blockId: failure.blockId.slice(0, 120),
              rejectionCategory: failure.rejectionCategory.slice(0, 80),
              ...(bbox ? { bbox } : {}),
            }];
          })
        : [],
      retryWholePage: page.retryWholePage === true,
      findings: Array.isArray(page.findings) ? page.findings : [],
      reviewerNotes: typeof page.reviewerNotes === "string" ? page.reviewerNotes : null,
    }]));
}

function readManualOverrides(job: CworksJob): Map<string, string> {
  const brief = job.repairBrief as any;
  if (brief?.kind !== "cworks-manual-touchup" || !Array.isArray(brief.overrides)) return new Map();
  const requestedTargetLanguage = targetLanguage(job);
  const overrides = new Map<string, string>();
  for (const item of brief.overrides) {
    if (typeof item?.blockId !== "string" || typeof item?.translation !== "string") continue;
    if (!isCworksTargetLanguageText(item.translation, requestedTargetLanguage)) {
      throw new Error(
        `Manual touch-up ${item.blockId} is not written in ${targetLanguageName(requestedTargetLanguage)}`,
      );
    }
    overrides.set(item.blockId, item.translation);
  }
  return overrides;
}

async function savePageCheckpoint(
  job: CworksJob,
  page: CworksPage,
  sourceHash: string,
  translations: CworksTranslation[],
  pageTokenEstimate: number,
  pageWarningCount: number,
  progress: number,
  tokenEstimate: number,
  resuming: boolean,
) {
  await db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: cworksTranslationJobs.id })
      .from(cworksTranslationJobs)
      .where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "running"),
        eq(cworksTranslationJobs.runToken, job.runToken || ""),
      ))
      .limit(1);
    if (!owned) throw new Error("CAD translation lease was superseded");

    await tx.insert(cworksTranslationCheckpoints).values({
      jobId: job.id,
      revisionCount: job.revisionCount,
      pageNumber: page.pageNumber,
      sourceHash,
      translations,
      tokenEstimate: pageTokenEstimate,
      warningCount: pageWarningCount,
    }).onConflictDoUpdate({
      target: [
        cworksTranslationCheckpoints.jobId,
        cworksTranslationCheckpoints.revisionCount,
        cworksTranslationCheckpoints.pageNumber,
      ],
      set: {
        sourceHash,
        translations,
        tokenEstimate: pageTokenEstimate,
        warningCount: pageWarningCount,
        updatedAt: new Date(),
      },
    });

    const updated = await tx.update(cworksTranslationJobs).set({
      progress,
      pagesDone: page.pageNumber,
      progressNote: `${resuming ? "Resuming translation" : "Translating drawing text"} — page ${page.pageNumber} saved`,
      tokenEstimate,
      costEstimate: ((tokenEstimate / 1_000_000) * 9).toFixed(4),
      leaseExpiresAt: leaseUntil(),
      updatedAt: new Date(),
    }).where(and(
      eq(cworksTranslationJobs.id, job.id),
      eq(cworksTranslationJobs.status, "running"),
      eq(cworksTranslationJobs.runToken, job.runToken || ""),
    )).returning({ id: cworksTranslationJobs.id });
    if (!updated.length) throw new Error("CAD translation lease was superseded");
  });
}

export async function translateBlocks(
  job: CworksJob,
  pages: CworksPage[],
  skill: string,
  options: TranslateBlocksOptions = {},
): Promise<{ translations: CworksTranslation[]; tokenEstimate: number; warningCount: number }> {
  const translations: CworksTranslation[] = [];
  const requestedTargetLanguage = targetLanguage(job);
  const requestedTargetName = targetLanguageName(requestedTargetLanguage);
  let tokenEstimate = 0;
  let warningCount = 0;
  let chunksDone = 0;
  const askTranslator = options.askTranslator || askCworksTranslator;
  const totalChunks = pages.reduce((n, page) => n + chunksOfBlocks(
    page.blocks.filter((block) =>
      shouldTranslate(block, job.drawingDepth, job.sourceLanguage) && !block.visualRecoveryFailed),
  ).length, 0);
  const checkpointRows = await db.select().from(cworksTranslationCheckpoints).where(and(
    eq(cworksTranslationCheckpoints.jobId, job.id),
    eq(cworksTranslationCheckpoints.revisionCount, job.revisionCount),
  ));
  const checkpoints = new Map(checkpointRows.map((row) => [row.pageNumber, row]));
  const repairPages = readRepairPages(job);
  const repairKind = (job.repairBrief as any)?.kind;
  const isRevisionRepair = ["cworks-unresolved-repair", "cworks-manual-touchup"].includes(repairKind);
  const isAutomaticRepair = repairKind === "cworks-unresolved-repair";
  const manualOverrides = readManualOverrides(job);
  const priorCheckpointRows = isRevisionRepair && job.revisionCount > 0
    ? await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, job.id),
      eq(cworksTranslationCheckpoints.revisionCount, job.revisionCount - 1),
    ))
    : [];
  const priorCheckpoints = new Map(priorCheckpointRows.map((row) => [row.pageNumber, row]));
  let resumedPages = 0;

  for (const page of pages) {
    const eligible = page.blocks.filter((block) =>
      shouldTranslate(block, job.drawingDepth, job.sourceLanguage));
    const sourceHash = pageSourceHash(job, page, eligible, skill);
    const checkpoint = checkpoints.get(page.pageNumber);
    const saved = checkpoint ? readCheckpointTranslations(checkpoint, sourceHash, eligible) : null;
    if (!saved) break;
    translations.push(...saved);
    tokenEstimate += checkpoint!.tokenEstimate;
    warningCount += checkpoint!.warningCount;
    chunksDone += chunksOfBlocks(eligible).length;
    resumedPages++;
  }

  if (resumedPages > 0) {
    const nextPage = Math.min(resumedPages + 1, pages.length);
    const progress = 12 + Math.round((chunksDone / Math.max(totalChunks, 1)) * 56);
    await updateClaimed(job, {
      progress,
      pagesDone: resumedPages,
      progressNote: resumedPages === pages.length
        ? "All translated pages restored from saved checkpoints"
        : `Resuming translation — page ${nextPage} of ${pages.length}`,
      tokenEstimate,
      costEstimate: ((tokenEstimate / 1_000_000) * 9).toFixed(4),
    });
  }

  for (const page of pages.slice(resumedPages)) {
    const eligible = page.blocks.filter((block) =>
      shouldTranslate(block, job.drawingDepth, job.sourceLanguage));
    const sourceHash = pageSourceHash(job, page, eligible, skill);
    const pageTranslationsById = new Map<string, CworksTranslation>();
    const freshLayoutTranslations = new Map<string, string>();
    let pageTokenEstimate = 0;
    let pageWarningCount = 0;
    const repairPage = repairPages.get(page.pageNumber);
    const requestedTargetIds = new Set([
      ...(repairPage?.unsafePlacementBlockIds || []),
      ...(repairPage?.findings || []).flatMap((finding) => finding.sourceBlockId ? [finding.sourceBlockId] : []),
      ...eligible.flatMap((block) => manualOverrides.has(block.id) ? [block.id] : []),
    ]);
    const layoutMembers = new Map<string, string[]>();
    for (const block of eligible) {
      const key = placementGroupKey(block);
      const members = layoutMembers.get(key) || [];
      members.push(block.id);
      layoutMembers.set(key, members);
    }
    const blocksById = new Map(eligible.map((block) => [block.id, block]));
    const targetedIds = new Set<string>();
    for (const requestedId of requestedTargetIds) {
      const requestedBlock = blocksById.get(requestedId);
      const groupId = requestedBlock
        ? placementGroupKey(requestedBlock)
        : (layoutMembers.has(requestedId) ? requestedId : undefined);
      if (groupId) {
        for (const memberId of layoutMembers.get(groupId) || []) targetedIds.add(memberId);
      } else {
        targetedIds.add(requestedId);
      }
    }
    const priorTranslations = priorCheckpoints.get(page.pageNumber)?.translations;
    if (isRevisionRepair && !repairPage?.retryWholePage && Array.isArray(priorTranslations)) {
      const blocksById = new Map(eligible.map((block) => [block.id, block]));
      for (const previous of priorTranslations as CworksTranslation[]) {
        const block = blocksById.get(previous?.id);
        const placementMatches = block
          && JSON.stringify(previous.bbox) === JSON.stringify(block.bbox)
          && previous.fontSize === block.fontSize
          && JSON.stringify(previous.direction || [1, 0]) === JSON.stringify(block.direction || [1, 0])
          && previous.color === (block.color || 0)
          && Boolean(previous.recoveredFromVisual) === Boolean(block.recoveredFromVisual)
          && Boolean(previous.rasterBacked) === Boolean(block.rasterBacked)
          && previous.recoverySourceHash === block.recoverySourceHash;
        if (
          block
          && placementMatches
          && !targetedIds.has(block.id)
          && previous.source === block.text
            && translationIsResolved(block, previous, job.sourceLanguage, requestedTargetLanguage)
        ) {
          pageTranslationsById.set(block.id, {
            ...previous,
            paragraphId: block.paragraphId,
            placementGroupId: block.placementGroupId,
            compactGroupId: block.compactGroupId,
            compactGroupCompact: Boolean(block.compactGroupCompact),
            layoutGroupId: block.layoutGroupId,
            layoutGroupCompact: Boolean(block.layoutGroupCompact),
            pageNumber: page.pageNumber,
            bbox: block.bbox,
            fontSize: block.fontSize,
            direction: block.direction || [1, 0],
            color: block.color || 0,
            recoveredFromVisual: Boolean(block.recoveredFromVisual),
            recoverySourceHash: block.recoverySourceHash,
            rasterBacked: Boolean(block.rasterBacked),
          });
        }
      }
    }
    if (repairKind === "cworks-manual-touchup" && Array.isArray(priorTranslations)) {
      const priorById = new Map((priorTranslations as CworksTranslation[]).map((item) => [item.id, item]));
      for (const block of eligible) {
        const override = manualOverrides.get(block.id);
        const previous = priorById.get(block.id);
        if (override === undefined || !previous || previous.source !== block.text) continue;
        pageTranslationsById.set(block.id, {
          ...previous,
          paragraphId: block.paragraphId,
          placementGroupId: block.placementGroupId,
          compactGroupId: block.compactGroupId,
          compactGroupCompact: Boolean(block.compactGroupCompact),
          layoutGroupId: block.layoutGroupId,
          layoutGroupCompact: Boolean(block.layoutGroupCompact),
          pageNumber: page.pageNumber,
          bbox: block.bbox,
          fontSize: block.fontSize,
          direction: block.direction || [1, 0],
          color: block.color || 0,
          translation: override,
          uncertain: false,
        });
      }
    }
    for (const block of eligible.filter((item) => item.visualRecoveryFailed)) {
      pageTranslationsById.set(block.id, {
        id: block.id,
        pageNumber: page.pageNumber,
        bbox: block.bbox,
        fontSize: block.fontSize,
        direction: block.direction || [1, 0],
        color: block.color || 0,
        source: block.text,
        translation: block.text,
        uncertain: true,
        recoveredFromVisual: false,
      });
      pageWarningCount++;
    }
    const chunks = chunksOfBlocks(eligible.filter((block) =>
      !block.visualRecoveryFailed && !pageTranslationsById.has(block.id)));
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const input = translationPromptInput(chunk, eligible);
      const feedback = job.feedbackNotes?.trim()
        ? `\nReviewer feedback for this revision:\n${job.feedbackNotes.slice(0, 5000)}\n`
        : "";
      const repairGuidance = repairPage
        ? `\nAutomatic repair evidence for page ${page.pageNumber}:\n${JSON.stringify({
          findings: repairPage.findings,
          unsafePlacementBlockIds: repairPage.unsafePlacementBlockIds,
          placementFailures: repairPage.placementFailures || [],
          expandedLayoutGroupBlockIds: Array.from(targetedIds),
          reviewerNotes: repairPage.reviewerNotes || undefined,
        }).slice(0, 8000)}
Correct only the supplied unresolved lines; do not invent changes outside this evidence.
Treat each rejectionCategory and bbox as a hard physical constraint. For text_too_long use concise conventional drawing ${requestedTargetName}. For overlap do not expand beyond the supplied geometry.${requestedTargetLanguage === "en" ? " In narrow title cells, conventional abbreviations such as CHK (checked by) and CPE (chief project engineer) are preferred to unreadably small literal phrases." : " Use concise standard Japanese construction terminology while retaining Japanese script."}\n`
        : "";
      const prompt = `${skill}

Translate these positioned text lines from ${job.sourceLanguage === "auto" ? "the detected source language" : job.sourceLanguage} to ${requestedTargetName}.
Coverage mode: ${job.drawingDepth}. Scope: ${job.scope}.${feedback}${repairGuidance}
Return ONLY a compact JSON array in this exact shape:
[{"id":"p1-l0","translation":"${requestedTargetName} text","uncertain":false,"layoutGroupTranslation":"Complete ${requestedTargetName} wording for this visual group"}]

Rules:
- Return one entry for every supplied id, in the same order.
- When layoutGroupId is present, use layoutGroupSource to understand split words and adjacent lines.
- For every member of a multi-line layout group, return the same concise layoutGroupTranslation containing the complete ${requestedTargetName} wording for the whole group.
- Keep translation as the best ${requestedTargetName} equivalent of the individual source line; layoutGroupTranslation is what will be placed when fragmented lines should be rendered coherently.
- ${cworksTargetLanguagePromptRequirement(requestedTargetLanguage)}
- Preserve dimensions, quantities, standards, drawing numbers, revision codes, and model numbers exactly.
- Do not translate pure codes. If a line is ambiguous, preserve the source and set uncertain true.
- Never add explanations outside the JSON.

Lines:
${JSON.stringify(input)}`;
      await updateClaimed(job, {
        progress: 12 + Math.round((chunksDone / Math.max(totalChunks, 1)) * 56),
        pagesDone: Math.max(0, page.pageNumber - 1),
        progressNote: `${resumedPages ? "Resuming translation" : "Translating drawing text"} — page ${page.pageNumber} of ${pages.length}, text group ${chunkIndex + 1} of ${chunks.length}`,
        tokenEstimate: tokenEstimate + pageTokenEstimate,
        costEstimate: (((tokenEstimate + pageTokenEstimate) / 1_000_000) * 9).toFixed(4),
      });
      const requestTranslation = async (requestPrompt: string, maxTokens?: number) => {
        try {
          return await requestCworksProviderWithRetry(
            (signal) => askTranslator(requestPrompt, "cworks-translator", maxTokens, signal),
            {
              quarantineKey: job.id,
              includeProviderMessageInLogs: false,
              onRetry: async ({ nextAttempt, maxAttempts, timedOut }) => {
                await updateClaimed(job, {
                  pagesDone: Math.max(0, page.pageNumber - 1),
                  progressNote: `Translation provider ${timedOut ? "timed out" : "hit a temporary issue"} on page ${page.pageNumber} — retrying request (${nextAttempt} of ${maxAttempts})`,
                });
              },
            },
          );
        } catch (error) {
          if (!(error instanceof CworksProviderError)) throw error;
          const pageError = new CworksProviderError(
            error.cancellationConfirmed
              ? `${error.message.replace(/\.$/, "")} Page ${page.pageNumber} was not saved; earlier completed pages remain safe.`
              : `The translation provider timed out on page ${page.pageNumber}, and cancellation could not be confirmed. No overlapping retry was started; earlier completed pages remain safe.`,
            {
              attempts: error.attempts,
              timedOut: error.timedOut,
              cancellationConfirmed: error.cancellationConfirmed,
              retryable: error.retryable,
              pageNumber: page.pageNumber,
            },
          );
          await updateClaimed(job, {
            pagesDone: Math.max(0, page.pageNumber - 1),
            progressNote: `Translation provider could not finish page ${page.pageNumber} after ${error.attempts} attempt(s)`,
          });
          throw pageError;
        }
      };
      let raw = await requestTranslation(prompt);
      let parsed: ReturnType<typeof parseTranslationJson> = [];
      try {
        parsed = parseTranslationJson(raw);
      } catch {
        raw = await requestTranslation(
          `Repair this into ONLY the required JSON array. Do not alter ids or translations:\n${raw.slice(0, 12000)}`,
        );
        try {
          parsed = parseTranslationJson(raw);
        } catch {
          // The focused passes below still get a bounded chance to translate
          // every missing id. If they also fail, the page remains unresolved
          // and the completeness gate prevents silent publication.
        }
      }
      const byId = new Map(parsed.map((x) => [x.id, x]));
      const unresolvedBlocks = chunk.filter((block) =>
        !translationIsResolved(block, byId.get(block.id), job.sourceLanguage, requestedTargetLanguage));
      if (unresolvedBlocks.length) {
        const retryInput = translationPromptInput(unresolvedBlocks, eligible);
        const resolutionPrompt = `${skill}

This is a focused second pass for construction-drawing lines that the first pass left unresolved.
Translate every recoverable human-language line to concise professional ${requestedTargetName}.
Use conventional ${requestedTargetName} equivalents for source-language construction terms and abbreviations.
Preserve pure drawing numbers, standards identifiers, dimensions, quantities, revision codes, and model numbers exactly; set uncertain true only for those pure identifiers or genuinely unreadable language.
Return ONLY a compact JSON array with one entry per supplied id:
[{"id":"p1-l0","translation":"${requestedTargetName} text","uncertain":false,"layoutGroupTranslation":"Complete ${requestedTargetName} wording for this visual group"}]
${cworksTargetLanguagePromptRequirement(requestedTargetLanguage)}
When layoutGroupId is present, return the same complete layoutGroupTranslation for every supplied member of that group.

Lines:
${JSON.stringify(retryInput)}`;
        let retryRaw = await requestTranslation(resolutionPrompt);
        let retryParsed: ReturnType<typeof parseTranslationJson> = [];
        try {
          retryParsed = parseTranslationJson(retryRaw);
        } catch {
          retryRaw = await requestTranslation(
            `Repair this into ONLY the required JSON array. Do not alter ids or translations:\n${retryRaw.slice(0, 12000)}`,
          );
          try {
            retryParsed = parseTranslationJson(retryRaw);
          } catch {
            // This pass is an optional coverage improvement. Preserve the
            // first-pass result and keep the source visible rather than
            // failing an otherwise recoverable drawing revision.
          }
        }
        for (const retryItem of retryParsed) {
          const previous = byId.get(retryItem.id);
          byId.set(retryItem.id, {
            ...previous,
            ...retryItem,
            layoutGroupTranslation:
              retryItem.layoutGroupTranslation || previous?.layoutGroupTranslation,
          });
        }
        pageTokenEstimate += Math.ceil((resolutionPrompt.length + retryRaw.length) / 4);
      }
      const stillUnresolvedBlocks = chunk.filter((block) =>
        !translationIsResolved(block, byId.get(block.id), job.sourceLanguage, requestedTargetLanguage));
      if (stillUnresolvedBlocks.length) {
        const finalInput = translationPromptInput(stillUnresolvedBlocks, eligible);
        const finalPrompt = `${skill}

This is the final best-effort pass for clean human-language drawing text.
Pure dimensions, quantities, standards, drawing numbers, revision codes, and model numbers have already been excluded.
Translate every supplied line to concise professional ${requestedTargetName}. For a source-language abbreviation, use its conventional ${requestedTargetName} abbreviation or a concise ${requestedTargetName} expansion.
Do not return an English-only translation when Japanese is requested. Set uncertain true only if the source is genuinely unreadable.
Return ONLY a compact JSON array with one entry per supplied id:
[{"id":"p1-l0","translation":"${requestedTargetName} text","uncertain":false,"layoutGroupTranslation":"Complete ${requestedTargetName} wording for this visual group"}]
When layoutGroupId is present, return the same complete layoutGroupTranslation for every supplied member of that group.

Lines:
${JSON.stringify(finalInput)}`;
        let finalRaw = await requestTranslation(finalPrompt);
        let finalParsed: ReturnType<typeof parseTranslationJson> = [];
        try {
          finalParsed = parseTranslationJson(finalRaw);
        } catch {
          finalRaw = await requestTranslation(
            `Repair this into ONLY the required JSON array. Do not alter ids or translations:\n${finalRaw.slice(0, 12000)}`,
          );
          try {
            finalParsed = parseTranslationJson(finalRaw);
          } catch {
            // Best-effort output is never allowed to invalidate the durable
            // primary translation. The unresolved line remains visible and
            // is reported through coverage and page warnings.
          }
        }
        for (const finalItem of finalParsed) {
          const previous = byId.get(finalItem.id);
          byId.set(finalItem.id, {
            ...previous,
            ...finalItem,
            layoutGroupTranslation:
              finalItem.layoutGroupTranslation || previous?.layoutGroupTranslation,
          });
        }
        pageTokenEstimate += Math.ceil((finalPrompt.length + finalRaw.length) / 4);
      }
      const groupTranslations = new Map<string, string>();
      for (const block of chunk) {
        const candidate = byId.get(block.id)?.layoutGroupTranslation?.trim();
        const key = compactGroupKey(block);
        if (
          Boolean(key)
          && layoutTranslationIsResolved(candidate, requestedTargetLanguage)
          && key
          && !groupTranslations.has(key)
        ) {
          groupTranslations.set(key, candidate);
          freshLayoutTranslations.set(key, candidate);
        }
      }
      for (const block of chunk) {
        const translated = byId.get(block.id);
        const value = requestedTargetLanguage === "en"
          ? fitAwareDrawingTranslation(block, translated?.translation?.trim() || block.text)
          : translated?.translation?.trim() || block.text;
        const resolved = translationIsResolved(
          block, translated, job.sourceLanguage, requestedTargetLanguage,
        );
        if (!resolved) pageWarningCount++;
        pageTranslationsById.set(block.id, {
          id: block.id,
          paragraphId: block.paragraphId,
          placementGroupId: block.placementGroupId,
          compactGroupId: block.compactGroupId,
          compactGroupCompact: Boolean(block.compactGroupCompact),
          layoutGroupId: block.layoutGroupId,
          layoutGroupCompact: Boolean(block.layoutGroupCompact),
          compactGroupTranslation: groupTranslations.get(compactGroupKey(block) || ""),
          layoutGroupTranslation: groupTranslations.get(compactGroupKey(block) || ""),
          pageNumber: page.pageNumber,
          bbox: block.bbox,
          fontSize: block.fontSize,
          direction: block.direction || [1, 0],
          color: block.color || 0,
          source: block.text,
          translation: value,
          uncertain: !resolved,
          recoveredFromVisual: Boolean(block.recoveredFromVisual),
          recoverySourceHash: block.recoverySourceHash,
          rasterBacked: Boolean(block.rasterBacked),
        });
      }
      pageTokenEstimate += Math.ceil((prompt.length + raw.length) / 4);
      chunksDone++;
      await updateClaimed(job, {
        progress: 12 + Math.round((chunksDone / Math.max(totalChunks, 1)) * 56),
        pagesDone: Math.max(0, page.pageNumber - 1),
        progressNote: `${resumedPages ? "Resuming translation" : "Translating drawing text"} — page ${page.pageNumber} of ${pages.length}`,
        tokenEstimate: tokenEstimate + pageTokenEstimate,
        costEstimate: (((tokenEstimate + pageTokenEstimate) / 1_000_000) * 9).toFixed(4),
      });
    }
    for (const translation of pageTranslationsById.values()) {
      const key = translation.compactGroupId
        || (translation.layoutGroupCompact ? translation.layoutGroupId : undefined);
      const fresh = key ? freshLayoutTranslations.get(key) : undefined;
      if (fresh && key) {
        translation.compactGroupTranslation = fresh;
        translation.layoutGroupTranslation = fresh;
      } else if (!key) {
        translation.compactGroupTranslation = undefined;
        translation.layoutGroupTranslation = undefined;
      }
    }
    tokenEstimate += pageTokenEstimate;
    warningCount += pageWarningCount;
    const pageTranslations = eligible
      .map((block) => pageTranslationsById.get(block.id))
      .filter((item): item is CworksTranslation => Boolean(item));
    if (pageTranslations.length !== eligible.length) {
      throw new Error(`Translation provider omitted positioned lines on page ${page.pageNumber}`);
    }
    translations.push(...pageTranslations);
    await savePageCheckpoint(
      job,
      page,
      sourceHash,
      pageTranslations,
      pageTokenEstimate,
      pageWarningCount,
      12 + Math.round((chunksDone / Math.max(totalChunks, 1)) * 56),
      tokenEstimate,
      resumedPages > 0,
    );
    await options.onCheckpointSaved?.(page.pageNumber);
  }
  return { translations, tokenEstimate, warningCount };
}

type CworksRenderCheckpoint = typeof cworksTranslationRenderCheckpoints.$inferSelect;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pageRenderHash(
  job: CworksJob,
  page: CworksPage,
  translations: CworksTranslation[],
): string {
  return sha256(JSON.stringify({
    renderLayoutVersion: RENDER_LAYOUT_VERSION,
    targetLanguage: targetLanguage(job),
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    translations: translations
      .filter((item) => item.pageNumber === page.pageNumber)
      .map((item) => ({
        id: item.id,
        paragraphId: item.paragraphId,
        placementGroupId: item.placementGroupId,
        compactGroupId: item.compactGroupId,
        compactGroupCompact: item.compactGroupCompact,
        compactGroupTranslation: item.compactGroupTranslation,
        layoutGroupId: item.layoutGroupId,
        layoutGroupCompact: item.layoutGroupCompact,
        layoutGroupTranslation: item.layoutGroupTranslation,
        bbox: item.bbox,
        fontSize: item.fontSize,
        direction: item.direction,
        color: item.color,
        source: item.source,
        translation: item.translation,
        rasterBacked: Boolean(item.rasterBacked),
      })),
    obstacles: page.blocks.map((block) => ({
      id: block.id,
      paragraphId: block.paragraphId,
      placementGroupId: block.placementGroupId,
      compactGroupId: block.compactGroupId,
      compactGroupCompact: block.compactGroupCompact,
      layoutGroupId: block.layoutGroupId,
      layoutGroupCompact: block.layoutGroupCompact,
      bbox: block.bbox,
    })),
  }));
}

function checkpointObjectNames(checkpoint: CworksRenderCheckpoint | undefined): string[] {
  if (!checkpoint) return [];
  return [checkpoint.fragmentStoredName, checkpoint.thumbnailStoredName]
    .filter((name): name is string => Boolean(name));
}

async function discardStaleRenderCheckpoints(
  job: CworksJob,
  checkpoints: CworksRenderCheckpoint[],
): Promise<void> {
  const stale = checkpoints.filter((row) => row.revisionCount !== job.revisionCount);
  if (!stale.length) return;
  const currentNames = new Set(
    checkpoints
      .filter((row) => row.revisionCount === job.revisionCount)
      .flatMap(checkpointObjectNames),
  );
  const storedNames = Array.from(new Set(
    stale.flatMap(checkpointObjectNames).filter((name) => !currentNames.has(name)),
  ));
  await db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: cworksTranslationJobs.id })
      .from(cworksTranslationJobs)
      .where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "running"),
        eq(cworksTranslationJobs.runToken, job.runToken || ""),
      ))
      .limit(1);
    if (!owned) throw new Error("CAD translation lease was superseded");
    if (storedNames.length) {
      await tx.insert(cworksTranslationCleanup).values(storedNames.map((storedName) => ({
        storedName,
        jobId: job.id,
      }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
    }
    await tx.delete(cworksTranslationRenderCheckpoints).where(and(
      eq(cworksTranslationRenderCheckpoints.jobId, job.id),
      ne(cworksTranslationRenderCheckpoints.revisionCount, job.revisionCount),
    ));
  });
}

async function planRenderCheckpoint(
  job: CworksJob,
  page: CworksPage,
  renderHash: string,
  fragmentStoredName: string,
  thumbnailStoredName: string,
  previous: CworksRenderCheckpoint | undefined,
): Promise<void> {
  const previousNames = checkpointObjectNames(previous)
    .filter((name) => name !== fragmentStoredName && name !== thumbnailStoredName);
  const cleanupOutboxNames = Array.from(new Set([
    ...previousNames,
    fragmentStoredName,
    thumbnailStoredName,
  ]));
  await db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: cworksTranslationJobs.id })
      .from(cworksTranslationJobs)
      .where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "running"),
        eq(cworksTranslationJobs.runToken, job.runToken || ""),
      ))
      .limit(1);
    if (!owned) throw new Error("CAD translation lease was superseded");
    // Register every immutable object name before either upload. If this worker
    // loses its lease during an Object Storage request, the object remains
    // discoverable even after a replacement run overwrites the checkpoint row.
    if (cleanupOutboxNames.length) {
      await tx.insert(cworksTranslationCleanup).values(cleanupOutboxNames.map((storedName) => ({
        storedName,
        jobId: job.id,
        nextAttemptAt: new Date(Date.now() + ABANDONED_STAGE_CLEANUP_MS),
      }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
    }
    await tx.insert(cworksTranslationRenderCheckpoints).values({
      jobId: job.id,
      revisionCount: job.revisionCount,
      pageNumber: page.pageNumber,
      renderHash,
      status: "processing",
      runToken: job.runToken,
      fragmentStoredName,
      thumbnailStoredName,
      fragmentSha256: null,
      thumbnailSha256: null,
      sourceBlockCount: 0,
      translatedBlockCount: 0,
      warnings: [],
      previewMetadata: null,
    }).onConflictDoUpdate({
      target: [
        cworksTranslationRenderCheckpoints.jobId,
        cworksTranslationRenderCheckpoints.revisionCount,
        cworksTranslationRenderCheckpoints.pageNumber,
      ],
      set: {
        renderHash,
        status: "processing",
        runToken: job.runToken,
        fragmentStoredName,
        thumbnailStoredName,
        fragmentSha256: null,
        thumbnailSha256: null,
        sourceBlockCount: 0,
        translatedBlockCount: 0,
        warnings: [],
        previewMetadata: null,
        updatedAt: new Date(),
      },
    });
  });
}

async function saveRenderCheckpoint(
  job: CworksJob,
  page: CworksPage,
  renderHash: string,
  meta: CworksRenderPageMeta,
  fragmentSha256: string,
  thumbnailSha256: string,
  completedPages: number,
  totalPages: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const ready = await tx.update(cworksTranslationRenderCheckpoints).set({
      status: "ready",
      fragmentSha256,
      thumbnailSha256,
      sourceBlockCount: meta.sourceBlockCount,
      translatedBlockCount: meta.translatedBlockCount,
      warnings: meta.warnings,
      previewMetadata: meta.preview,
      updatedAt: new Date(),
    }).where(and(
      eq(cworksTranslationRenderCheckpoints.jobId, job.id),
      eq(cworksTranslationRenderCheckpoints.revisionCount, job.revisionCount),
      eq(cworksTranslationRenderCheckpoints.pageNumber, page.pageNumber),
      eq(cworksTranslationRenderCheckpoints.renderHash, renderHash),
      eq(cworksTranslationRenderCheckpoints.runToken, job.runToken || ""),
      eq(cworksTranslationRenderCheckpoints.status, "processing"),
    )).returning({
      id: cworksTranslationRenderCheckpoints.id,
      fragmentStoredName: cworksTranslationRenderCheckpoints.fragmentStoredName,
      thumbnailStoredName: cworksTranslationRenderCheckpoints.thumbnailStoredName,
    });
    if (!ready.length) throw new Error("CAD translation lease was superseded");

    const updated = await tx.update(cworksTranslationJobs).set({
      progress: 70 + Math.round((completedPages / Math.max(totalPages, 1)) * 24),
      progressNote: `Placing ${targetLanguageName(targetLanguage(job))} text — page ${page.pageNumber} of ${totalPages} saved`,
      leaseExpiresAt: leaseUntil(),
      updatedAt: new Date(),
    }).where(and(
      eq(cworksTranslationJobs.id, job.id),
      eq(cworksTranslationJobs.status, "running"),
      eq(cworksTranslationJobs.runToken, job.runToken || ""),
    )).returning({ id: cworksTranslationJobs.id });
    if (!updated.length) throw new Error("CAD translation lease was superseded");

    const readyObjectNames = [
      ready[0].fragmentStoredName,
      ready[0].thumbnailStoredName,
    ].filter((name): name is string => Boolean(name));
    if (readyObjectNames.length) {
      await tx.delete(cworksTranslationCleanup).where(inArray(
        cworksTranslationCleanup.storedName,
        readyObjectNames,
      ));
    }
  });
}

function normalizeRenderPageMeta(value: any, pageNumber: number): CworksRenderPageMeta {
  if (
    Number(value?.pageNumber) !== pageNumber
    || !Number.isInteger(Number(value?.sourceBlockCount))
    || !Number.isInteger(Number(value?.translatedBlockCount))
    || !Array.isArray(value?.warnings)
    || !Number.isInteger(Number(value?.preview?.pixelWidth))
    || !Number.isInteger(Number(value?.preview?.pixelHeight))
    || !Number.isFinite(Number(value?.preview?.pageWidthPoints))
    || !Number.isFinite(Number(value?.preview?.pageHeightPoints))
    || Number(value.preview.pixelWidth) <= 0
    || Number(value.preview.pixelHeight) <= 0
    || Number(value.preview.pageWidthPoints) <= 0
    || Number(value.preview.pageHeightPoints) <= 0
  ) {
    throw new Error(`Drawing processor returned invalid metadata for page ${pageNumber}`);
  }
  return {
    pageNumber,
    sourceBlockCount: Number(value.sourceBlockCount),
    translatedBlockCount: Number(value.translatedBlockCount),
    preview: {
      pixelWidth: Number(value.preview.pixelWidth),
      pixelHeight: Number(value.preview.pixelHeight),
      pageWidthPoints: Number(value.preview.pageWidthPoints),
      pageHeightPoints: Number(value.preview.pageHeightPoints),
    },
    warnings: value.warnings.map((warning: unknown) => {
      if (!warning || typeof warning !== "object") {
        throw new Error(`Drawing processor returned an invalid unresolved line for page ${pageNumber}`);
      }
      const item = warning as Record<string, unknown>;
      const bbox = Array.isArray(item.bbox) ? item.bbox.map(Number) : [];
      const categories = new Set([
        "uncertain_translation", "missing_translation", "unsupported_direction", "overlap", "text_too_long",
      ]);
      if (
        typeof item.blockId !== "string"
        || typeof item.sourceText !== "string"
        || bbox.length !== 4
        || bbox.some((coordinate) => !Number.isFinite(coordinate))
        || typeof item.rejectionCategory !== "string"
        || !categories.has(item.rejectionCategory)
      ) {
        throw new Error(`Drawing processor returned an invalid unresolved line for page ${pageNumber}`);
      }
      return {
        blockId: item.blockId,
        sourceText: item.sourceText,
        bbox: bbox as [number, number, number, number],
        rejectionCategory: item.rejectionCategory as CworksUnresolvedLine["rejectionCategory"],
      };
    }).slice(0, 10_000),
  };
}

export function summarizeCworksCoverage(
  translations: CworksTranslation[],
  pages: Array<{ translatedBlockCount: number }>,
  targetLineCount = translations.length,
): CworksCoverage {
  const recoveredLineCount = translations.filter((item) => item.recoveredFromVisual).length;
  const translatedLineCount = translations.filter((item) =>
    !item.uncertain && Boolean(item.translation.trim())).length;
  const placedLineCount = pages.reduce(
    (sum, page) => sum + Math.max(0, Number(page.translatedBlockCount) || 0),
    0,
  );
  const resolvedLineCount = Math.min(translatedLineCount, placedLineCount);
  const unresolvedLineCount = Math.max(0, targetLineCount - resolvedLineCount);
  const placementPercent = targetLineCount
    ? Math.round((placedLineCount / targetLineCount) * 1_000) / 10
    : 100;
  return {
    targetLineCount,
    recoveredLineCount,
    translatedLineCount,
    placedLineCount,
    unresolvedLineCount,
    placementPercent,
    complete: targetLineCount > 0
      && translatedLineCount === targetLineCount
      && placedLineCount === targetLineCount,
  };
}

export function isCworksCoverageSeverelyIncomplete(
  targetLineCount: number,
  placedLineCount: number,
): boolean {
  if (targetLineCount <= 0) return true;
  const unresolved = Math.max(0, targetLineCount - placedLineCount);
  return unresolved > 0;
}

export async function renderCworksPages(
  job: CworksJob,
  pages: CworksPage[],
  translations: CworksTranslation[],
  inputPath: string,
  translationsPath: string,
  dir: string,
  options: RenderCworksPagesOptions = {},
): Promise<{
  checkpoints: CworksRenderCheckpoint[];
  fragmentPaths: string[];
}> {
  if (!job.runToken) throw new Error("CAD translation job is missing its active run token");
  const readObject = options.readObject || readFileFromObjectStorage;
  const writeObject = options.writeObject || writeFileToObjectStorage;
  const fragmentDir = path.join(dir, "fragments");
  const thumbnailDir = path.join(dir, "render-thumbnails");
  const metadataDir = path.join(dir, "render-metadata");
  await Promise.all([
    fs.mkdir(fragmentDir, { recursive: true }),
    fs.mkdir(thumbnailDir, { recursive: true }),
    fs.mkdir(metadataDir, { recursive: true }),
  ]);
  const defaultRenderPage: RenderPageExecutor = async ({
    page,
    inputPath: sourcePath,
    translationsPath: payloadPath,
    fragmentPath,
    thumbnailPath,
    metadataPath,
  }) => normalizeRenderPageMeta(await runProcessor(
    [
      "render",
      sourcePath,
      payloadPath,
      String(page.pageNumber),
      fragmentPath,
      thumbnailPath,
      metadataPath,
    ],
    {
      stage: "render",
      timeoutMs: PAGE_RENDER_TIMEOUT_MS,
      jobId: job.id,
    },
  ), page.pageNumber);
  const renderPage = options.renderPage || defaultRenderPage;

  let allCheckpoints = await db.select().from(cworksTranslationRenderCheckpoints)
    .where(eq(cworksTranslationRenderCheckpoints.jobId, job.id));
  for (const page of pages) {
    const renderHash = pageRenderHash(job, page, translations);
    const reusable = allCheckpoints.find((row) =>
      row.revisionCount !== job.revisionCount
      && row.status === "ready"
      && row.renderHash === renderHash
      && row.fragmentStoredName
      && row.thumbnailStoredName
      && row.fragmentSha256
      && row.thumbnailSha256);
    if (!reusable) continue;
    await db.insert(cworksTranslationRenderCheckpoints).values({
      jobId: job.id,
      revisionCount: job.revisionCount,
      pageNumber: page.pageNumber,
      renderHash,
      status: "ready",
      runToken: job.runToken,
      fragmentStoredName: reusable.fragmentStoredName,
      thumbnailStoredName: reusable.thumbnailStoredName,
      fragmentSha256: reusable.fragmentSha256,
      thumbnailSha256: reusable.thumbnailSha256,
      sourceBlockCount: reusable.sourceBlockCount,
      translatedBlockCount: reusable.translatedBlockCount,
      warnings: reusable.warnings,
      previewMetadata: reusable.previewMetadata,
    }).onConflictDoNothing({
      target: [
        cworksTranslationRenderCheckpoints.jobId,
        cworksTranslationRenderCheckpoints.revisionCount,
        cworksTranslationRenderCheckpoints.pageNumber,
      ],
    });
  }
  allCheckpoints = await db.select().from(cworksTranslationRenderCheckpoints)
    .where(eq(cworksTranslationRenderCheckpoints.jobId, job.id));
  await discardStaleRenderCheckpoints(job, allCheckpoints);
  allCheckpoints = allCheckpoints.filter((row) => row.revisionCount === job.revisionCount);
  const byPage = new Map(allCheckpoints.map((row) => [row.pageNumber, row]));
  const fragmentPaths: string[] = [];
  let completedPages = 0;

  for (const page of pages) {
    const renderHash = pageRenderHash(job, page, translations);
    const fragmentPath = path.join(fragmentDir, `page-${page.pageNumber}.pdf`);
    const thumbnailPath = path.join(thumbnailDir, `page-${page.pageNumber}.jpg`);
    const metadataPath = path.join(metadataDir, `page-${page.pageNumber}.json`);
    const existing = byPage.get(page.pageNumber);
    if (
      existing?.status === "ready"
      && existing.renderHash === renderHash
      && existing.fragmentStoredName
      && existing.thumbnailStoredName
      && existing.fragmentSha256
      && existing.thumbnailSha256
    ) {
      const [fragment, thumbnail] = await Promise.all([
        readObject(existing.fragmentStoredName),
        readObject(existing.thumbnailStoredName),
      ]);
      if (
        fragment
        && thumbnail
        && sha256(fragment) === existing.fragmentSha256
        && sha256(thumbnail) === existing.thumbnailSha256
      ) {
        await fs.writeFile(fragmentPath, fragment);
        await fs.writeFile(thumbnailPath, thumbnail);
        fragmentPaths.push(fragmentPath);
        completedPages++;
        await updateClaimed(job, {
          progress: 70 + Math.round((completedPages / Math.max(pages.length, 1)) * 24),
          progressNote: `Resuming final placement — page ${page.pageNumber} of ${pages.length} restored`,
        });
        continue;
      }
    }

    const runPrefix = `cworks-translator/${job.id}/render-r${job.revisionCount}/${job.runToken}`;
    const fragmentStoredName = `${runPrefix}/page-${page.pageNumber}-${renderHash.slice(0, 16)}.pdf`;
    const thumbnailStoredName = `${runPrefix}/page-${page.pageNumber}-${renderHash.slice(0, 16)}.jpg`;
    await planRenderCheckpoint(
      job,
      page,
      renderHash,
      fragmentStoredName,
      thumbnailStoredName,
      existing,
    );
    await Promise.all([
      fs.rm(fragmentPath, { force: true }),
      fs.rm(thumbnailPath, { force: true }),
      fs.rm(metadataPath, { force: true }),
    ]);
    const meta = normalizeRenderPageMeta(await renderPage({
      page,
      inputPath,
      translationsPath,
      fragmentPath,
      thumbnailPath,
      metadataPath,
    }), page.pageNumber);
    const [fragment, thumbnail] = await Promise.all([
      fs.readFile(fragmentPath),
      fs.readFile(thumbnailPath),
    ]);
    await assertOwned(job);
    await writeObject(fragmentStoredName, fragment);
    await assertOwned(job);
    await writeObject(thumbnailStoredName, thumbnail);
    completedPages++;
    await saveRenderCheckpoint(
      job,
      page,
      renderHash,
      meta,
      sha256(fragment),
      sha256(thumbnail),
      completedPages,
      pages.length,
    );
    await options.onCheckpointSaved?.(page.pageNumber);
    fragmentPaths.push(fragmentPath);
  }

  const checkpoints = await db.select().from(cworksTranslationRenderCheckpoints)
    .where(and(
      eq(cworksTranslationRenderCheckpoints.jobId, job.id),
      eq(cworksTranslationRenderCheckpoints.revisionCount, job.revisionCount),
      eq(cworksTranslationRenderCheckpoints.status, "ready"),
    ))
    .orderBy(asc(cworksTranslationRenderCheckpoints.pageNumber));
  if (
    checkpoints.length !== pages.length
    || checkpoints.some((row, index) => row.pageNumber !== pages[index]?.pageNumber)
    || fragmentPaths.length !== pages.length
  ) {
    throw new Error("Rendered page checkpoints are incomplete");
  }
  return { checkpoints, fragmentPaths };
}

type AuditCworksRenderedPagesOptions = {
  askAuditor?: (
    sourcePage: Buffer,
    translatedPage: Buffer,
    pageTranslations: CworksTranslation[],
    sourceLanguage: string,
    targetLanguage: CworksTargetLanguage,
    signal: AbortSignal,
  ) => Promise<string>;
  renderSourceThumbnail?: (page: CworksPage, outputPath: string) => Promise<void>;
};

export async function auditCworksRenderedPages(
  job: CworksJob,
  pages: CworksPage[],
  translations: CworksTranslation[],
  inputPath: string,
  dir: string,
  options: AuditCworksRenderedPagesOptions = {},
): Promise<{
  audits: CworksPageMachineAudit[];
  sourceThumbnailPaths: Map<number, string>;
}> {
  const sourceThumbnailDir = path.join(dir, "source-thumbnails");
  const translatedThumbnailDir = path.join(dir, "render-thumbnails");
  await fs.mkdir(sourceThumbnailDir, { recursive: true });
  const askAuditor = options.askAuditor || askCworksIndependentPageAudit;
  const audits: CworksPageMachineAudit[] = [];
  const sourceThumbnailPaths = new Map<number, string>();

  for (const page of pages) {
    await assertOwned(job);
    const sourceThumbnailPath = path.join(sourceThumbnailDir, `page-${page.pageNumber}.jpg`);
    if (options.renderSourceThumbnail) {
      await options.renderSourceThumbnail(page, sourceThumbnailPath);
    } else {
      await runProcessor(
        ["thumbnail", inputPath, String(page.pageNumber), sourceThumbnailPath],
        {
          stage: "render",
          timeoutMs: PAGE_RENDER_TIMEOUT_MS,
          jobId: job.id,
        },
      );
    }
    const translatedThumbnailPath = path.join(
      translatedThumbnailDir,
      `page-${page.pageNumber}.jpg`,
    );
    const [sourceThumbnail, translatedThumbnail] = await Promise.all([
      fs.readFile(sourceThumbnailPath),
      fs.readFile(translatedThumbnailPath),
    ]);
    const pageTranslations = translations.filter((item) => item.pageNumber === page.pageNumber);
    await updateClaimed(job, {
      progress: 94 + Math.round((audits.length / Math.max(pages.length, 1)) * 3),
      progressNote: `Independent visual audit — page ${page.pageNumber} of ${pages.length}`,
    });
    const raw = await requestCworksProviderWithRetry(
      (signal) => askAuditor(
        sourceThumbnail,
        translatedThumbnail,
        pageTranslations,
        job.sourceLanguage,
        targetLanguage(job),
        signal,
      ),
      {
        quarantineKey: `${job.id}:independent-audit`,
        includeProviderMessageInLogs: false,
        onRetry: async ({ nextAttempt, maxAttempts, timedOut }) => {
          await updateClaimed(job, {
            progressNote: `Independent page audit ${timedOut ? "timed out" : "hit a temporary issue"} on page ${page.pageNumber} — retrying (${nextAttempt} of ${maxAttempts})`,
          });
        },
      },
    );
    audits.push(parseCworksMachineAudit(raw, page.pageNumber));
    sourceThumbnailPaths.set(page.pageNumber, sourceThumbnailPath);
  }
  return { audits, sourceThumbnailPaths };
}

export async function previewCworksManualTouchup(
  job: CworksJob,
  pageNumber: number,
  blockId: string,
  proposedTranslation: string,
): Promise<{
  sourceText: string;
  beforeTranslation: string;
  thumbnail: Buffer;
  meta: CworksRenderPageMeta;
  renderFingerprint: string;
  renderLayoutVersion: number;
}> {
  const [checkpoint, source] = await Promise.all([
    db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, job.id),
      eq(cworksTranslationCheckpoints.revisionCount, job.revisionCount),
      eq(cworksTranslationCheckpoints.pageNumber, pageNumber),
    )).limit(1),
    readFileFromObjectStorage(job.sourceStoredName),
  ]);
  if (!source) throw new Error("MANUAL_SOURCE_MISSING");
  const translations = Array.isArray(checkpoint[0]?.translations)
    ? checkpoint[0].translations as CworksTranslation[]
    : [];
  const current = translations.find((item) => item.id === blockId);
  if (!current) throw new Error("MANUAL_BLOCK_NOT_FOUND");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cworks-touchup-${job.id}-`));
  try {
    const inputPath = path.join(dir, "input.pdf");
    const translationsPath = path.join(dir, "translations.json");
    const fragmentPath = path.join(dir, "preview.pdf");
    const thumbnailPath = path.join(dir, "preview.jpg");
    const metadataPath = path.join(dir, "preview.json");
    const blocksPath = path.join(dir, "blocks.json");
    await fs.writeFile(inputPath, source);
    await runProcessor(["extract", inputPath, blocksPath, job.sourceLanguage], {
      stage: "extraction",
      timeoutMs: EXTRACTION_TIMEOUT_MS,
      maxAttempts: EXTRACTION_ATTEMPTS,
      jobId: job.id,
    });
    const extracted = JSON.parse(await fs.readFile(blocksPath, "utf8")) as { pages: CworksPage[] };
    const extractedPage = extracted.pages.find((page) => page.pageNumber === pageNumber);
    if (!extractedPage) throw new Error("MANUAL_BLOCK_NOT_FOUND");
    const candidateTranslations = translations.map((item) =>
      item.id === blockId
        ? { ...item, translation: proposedTranslation, uncertain: false }
        : item);
    const obstacles = extractedPage.blocks.map((item) => ({
      id: item.id,
      paragraphId: item.paragraphId,
      placementGroupId: item.placementGroupId,
      compactGroupId: item.compactGroupId,
      compactGroupCompact: item.compactGroupCompact,
      layoutGroupId: item.layoutGroupId,
      layoutGroupCompact: item.layoutGroupCompact,
      pageNumber,
      bbox: item.bbox,
    }));
    const renderFingerprint = buildCworksManualTouchupRenderFingerprint(
      source,
      pageNumber,
      candidateTranslations,
      obstacles,
    );
    await Promise.all([
      fs.writeFile(translationsPath, JSON.stringify({
        translations: candidateTranslations,
        obstacles,
        targetLanguage: targetLanguage(job),
      })),
    ]);
    const raw = await runProcessor([
      "render",
      inputPath,
      translationsPath,
      String(pageNumber),
      fragmentPath,
      thumbnailPath,
      metadataPath,
    ], {
      stage: "render",
      timeoutMs: PAGE_RENDER_TIMEOUT_MS,
      jobId: job.id,
    });
    return {
      sourceText: current.source,
      beforeTranslation: current.translation,
      thumbnail: await fs.readFile(thumbnailPath),
      meta: normalizeRenderPageMeta(raw, pageNumber),
      renderFingerprint,
      renderLayoutVersion: RENDER_LAYOUT_VERSION,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function synchronizeNativeDxfLedgerEntries(
  entries: any[],
  translations: Map<string, string>,
  preservedHandles: Set<string>,
  requestedTargetLanguage: CworksTargetLanguage = "en",
): void {
  for (const entry of entries) {
    const key = typeof entry.targetId === "string" ? entry.targetId : entry.handle;
    const replacement = translations.get(key);
    entry.replacement = replacement || null;
    if (replacement) {
      entry.preservationReason = nativeDxfEmbeddedTechnicalIdentifierReason(
        entry.plain,
        replacement,
        requestedTargetLanguage,
      );
    } else if (!preservedHandles.has(key)) {
      entry.preservationReason = null;
    }
    entry.accounting = !entry.isCyrillicTarget
      ? "non_target"
      : replacement
        ? "translated_pending_patch"
        : preservedHandles.has(key)
          ? "preserved"
          : "unresolved";
  }
}

export function nativeDxfEmbeddedTechnicalIdentifierReason(
  source: unknown,
  replacement: unknown,
  requestedTargetLanguage: CworksTargetLanguage = "en",
): string | null {
  if (typeof source !== "string" || typeof replacement !== "string") return null;
  const identifierPattern = /(?<![\p{L}\p{N}])(?:\d+-\p{Script=Cyrillic}+-\d+|\d+-\p{Script=Cyrillic})(?![\p{L}\p{N}])/gu;
  const identifiers = [...source.matchAll(identifierPattern)].map((match) => match[0]);
  if (!identifiers.length) return null;
  const retained = [...new Set(
    identifiers.filter((identifier) => {
      const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Japanese technical prose commonly touches identifiers without spaces
      // (for example 3-Вр-1以上). Allow CJK adjacency while still rejecting a
      // match that is merely a prefix of a longer Latin/Cyrillic/digit code.
      return new RegExp(
        `(?<![\\p{Script=Cyrillic}\\p{Script=Latin}\\p{N}])${escaped}(?![\\p{Script=Cyrillic}\\p{Script=Latin}\\p{N}])`,
        "u",
      ).test(replacement);
    }),
  )];
  if (!retained.length) return null;
  const removeRetained = (value: string) => retained.reduce(
    (text, identifier) => text.split(identifier).join(" "),
    value,
  );
  const sourceProse = removeRetained(source).trim();
  const replacementProse = removeRetained(replacement).trim();
  const hasTargetScript = requestedTargetLanguage === "ja"
    ? /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(replacementProse)
    : /\p{Script=Latin}/u.test(replacementProse);
  if (/\p{Script=Cyrillic}/u.test(sourceProse) && (
    !hasTargetScript
    || /\p{Script=Cyrillic}/u.test(replacementProse)
  )) return null;
  return `embedded_technical_identifier: retained exact span ${retained.map((value) => JSON.stringify(value)).join(", ")} while surrounding prose is translated`;
}

export function isNativeDxfTargetLanguageText(
  source: unknown,
  replacement: unknown,
  requestedTargetLanguage: CworksTargetLanguage,
): boolean {
  if (typeof replacement !== "string") return false;
  return isCworksTargetLanguageText(replacement, requestedTargetLanguage)
    || nativeDxfEmbeddedTechnicalIdentifierReason(
      source,
      replacement,
      requestedTargetLanguage,
    ) !== null;
}

export function reusableNativeDxfTranslations(
  priorLedger: any,
  currentInventory: any,
  requestedTargetLanguage: CworksTargetLanguage = "en",
): Map<string, string> {
  const reusable = new Map<string, string>();
  const storedTargetLanguage = priorLedger?.targetLanguage;
  const priorTargetLanguage: CworksTargetLanguage | null =
    storedTargetLanguage === undefined || storedTargetLanguage === null
      ? "en"
      : storedTargetLanguage === "en" || storedTargetLanguage === "ja"
        ? storedTargetLanguage
        : null;
  if (
    !priorLedger
    || priorTargetLanguage !== requestedTargetLanguage
    || priorLedger.sourceSha256 !== currentInventory?.sha256
    || !Array.isArray(priorLedger.entries)
    || !Array.isArray(currentInventory?.textEntries || currentInventory?.mtext)
  ) return reusable;
  const currentEntries = currentInventory.textEntries || currentInventory.mtext;
  const currentByTarget = new Map<string, any>(
    currentEntries
      .filter((entry: any) =>
        typeof entry?.targetId === "string" || typeof entry?.handle === "string")
      .map((entry: any) => [entry.targetId || entry.handle, entry]),
  );
  const currentHandleCounts = new Map<string, number>();
  for (const entry of currentEntries) if (typeof entry?.handle === "string") {
    currentHandleCounts.set(entry.handle, (currentHandleCounts.get(entry.handle) || 0) + 1);
  }
  for (const entry of currentEntries) if (
    typeof entry?.handle === "string"
    && currentHandleCounts.get(entry.handle) === 1
    && !currentByTarget.has(entry.handle)
  ) currentByTarget.set(entry.handle, entry);
  for (const prior of priorLedger.entries) {
    const key = prior?.targetId || prior?.handle;
    const current: any = currentByTarget.get(key);
    if (
      !current
      || current.patchableInDxf === false
      || current.isCyrillicTarget === false
      || current.preservedDrawingCodeCandidate === true
      || prior.accounting !== "translated_and_patched"
      || typeof prior.replacement !== "string"
      || !prior.replacement.trim()
      || prior.plain !== current.plainText
      || prior.source !== current.rawText
    ) continue;
    reusable.set(current.targetId || key, prior.replacement.trim());
  }
  return reusable;
}

export function removeNativeDxfPreservedTranslations(
  translations: Map<string, string>,
  preservedHandles: Set<string>,
): void {
  for (const handle of preservedHandles) translations.delete(handle);
}

export async function readOptionalNativeDxfPriorLedger(
  read: () => Promise<Buffer | string | null | undefined>,
  timeoutMs = 10_000,
): Promise<any | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const bytes = await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (bytes === null || bytes === undefined) return null;
    const serialized = typeof bytes === "string" ? bytes : bytes.toString("utf8");
    return JSON.parse(serialized);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function applyNativeDxfExactGlossary(
  entries: Array<{ targetId?: unknown; handle?: unknown; plain?: unknown }>,
  translations: Map<string, string>,
): void {
  for (const entry of entries) {
    const key = typeof entry.targetId === "string" ? entry.targetId
      : typeof entry.handle === "string" ? entry.handle : null;
    if (!key) continue;
    const exact = entry.plain === "Архитектурные решения"
      ? "Arch. Design"
      : entry.plain === "Номер"
        ? "No."
        : entry.plain === "Кат."
          ? "Cat."
          : entry.plain === "АО"
            ? "JSC"
            : entry.plain === "не менее 3-Вр-1"
              ? "min 3-Вр-1"
              : entry.plain === "Реконструкция дома расположенного в Японии"
                ? "House Reconst., Japan"
                : entry.plain === "по адресу: Шинагава-ку, Хигаси Готанда 3-9-13"
                  ? "Addr.: Shinagawa-ku, H. Gotanda 3-9-13"
                  : entry.plain === "Кладочный план 3-го"
                    ? "3F Masonry Plan"
                    : entry.plain === "Ведомость перемычек"
                      ? "Lintel Sched."
                      : entry.plain === "Схема сечения"
                        ? "Section"
                        : entry.plain === "Экспликация помещений"
                          ? "Room Sched."
          : null;
    if (exact) translations.set(key, exact);
  }
}

export function applyNativeDxfSplitGlossary(
  entries: Array<{ targetId?: unknown; handle?: unknown; plain?: unknown; maxCharacters?: unknown }>,
  groups: Array<{ handles?: unknown }>,
  translations: Map<string, string>,
): void {
  const byHandle = new Map(entries
    .filter((entry): entry is { handle: string; plain?: unknown; maxCharacters?: unknown } =>
      typeof entry.handle === "string"
      && ((entry as any).entityType === undefined || (entry as any).entityType === "MTEXT"))
    .map((entry) => [entry.handle, entry]));
  for (const group of groups) {
    if (!Array.isArray(group?.handles) || group.handles.length !== 2) continue;
    const members = group.handles.map((handle) =>
      typeof handle === "string" ? byHandle.get(handle) : undefined);
    if (members.some((member) => !member)) continue;
    let reconstructed = "";
    let previousWasContinuation = false;
    for (const member of members) {
      const text = String(member!.plain || "").trim();
      const continuation = /[-‑–]$/.test(text);
      const fragment = text.replace(/[-‑–]$/, "").trim();
      reconstructed += reconstructed
        ? previousWasContinuation ? fragment : ` ${fragment}`
        : fragment;
      previousWasContinuation = continuation;
    }
    const normalized = reconstructed.replace(/\s+/g, " ").trim();
    const replacements = ["Slab U/S", "Elevation"];
    if (
      normalized !== "Отм. низа перекрытия"
      || replacements.some((replacement, index) => {
        const maxCharacters = Number(members[index]!.maxCharacters);
        return !Number.isFinite(maxCharacters) || replacement.length > maxCharacters;
      })
    ) continue;
    translations.set(
      typeof (members[0] as any).targetId === "string"
        ? (members[0] as any).targetId : String(group.handles[0]),
      replacements[0],
    );
    translations.set(
      typeof (members[1] as any).targetId === "string"
        ? (members[1] as any).targetId : String(group.handles[1]),
      replacements[1],
    );
  }
}

export function applyNativeDxfContextPairGlossary(
  entries: Array<{
    targetId?: unknown;
    handle?: unknown;
    plain?: unknown;
    plainText?: unknown;
    maxCharacters?: unknown;
  }>,
  translations: Map<string, string>,
): void {
  const plain = (entry: typeof entries[number]) =>
    typeof entry.plain === "string" ? entry.plain : entry.plainText;
  for (let index = 0; index + 1 < entries.length; index++) {
    const first = entries[index];
    const second = entries[index + 1];
    if (
      typeof first.handle !== "string"
      || typeof second.handle !== "string"
      || plain(first) !== "Отм. низа"
      || plain(second) !== "перекрытия"
    ) continue;
    const replacements = ["Soffit EL", "of slab"];
    const maxCharacters = [first, second].map((entry) => {
      const declared = Number(entry.maxCharacters);
      const entryPlain = plain(entry);
      return Number.isFinite(declared)
        ? declared
        : typeof entryPlain === "string" ? entryPlain.length : Number.NaN;
    });
    if (maxCharacters.some((limit, member) =>
      !Number.isFinite(limit) || replacements[member].length > limit)) continue;
    translations.set(
      typeof first.targetId === "string" ? first.targetId : first.handle,
      replacements[0],
    );
    translations.set(
      typeof second.targetId === "string" ? second.targetId : second.handle,
      replacements[1],
    );
  }
}

export function synchronizeNativeDxfDimensionCacheTranslations(
  bindings: Array<{ dimensionTargetId?: unknown; cacheTargetId?: unknown }>,
  translations: Map<string, string>,
): void {
  for (const binding of bindings) {
    if (typeof binding?.dimensionTargetId !== "string"
      || typeof binding?.cacheTargetId !== "string") continue;
    const replacement = translations.get(binding.dimensionTargetId);
    if (replacement) translations.set(binding.cacheTargetId, replacement);
    else translations.delete(binding.cacheTargetId);
  }
}

export function nativeDxfReplacementPreservesPlaceholder(
  source: unknown,
  replacement: unknown,
): boolean {
  return typeof source !== "string" || !source.includes("<>")
    || (typeof replacement === "string" && replacement.includes("<>"));
}

export type NativeDxfTableScriptTarget = {
  targetId: string;
  tableHandle: string;
  sourceOrdinal: number;
  sourceOccurrenceCount?: number;
  source: string;
  translation: string;
};

export function dedupeNativeDxfTableTargets<T extends {
  targetId: string;
  tableHandle: string;
  sourceText: string;
  sourceOccurrenceCount?: number;
}>(targets: T[]): Array<T & { sourceOccurrenceCount: number }> {
  const groups = new Map<string, T[]>();
  for (const target of targets) {
    const key = `${target.tableHandle.toUpperCase()}\0${target.sourceText}`;
    const members = groups.get(key) || [];
    members.push(target);
    groups.set(key, members);
  }
  return [...groups.values()].map((members) => {
    members.sort((left, right) =>
      left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0);
    return {
      ...members[0],
      sourceOccurrenceCount: members.reduce((sum, member) =>
        sum + (Number.isInteger(member.sourceOccurrenceCount)
          && Number(member.sourceOccurrenceCount) > 0
          ? Number(member.sourceOccurrenceCount) : 1), 0),
    };
  }).sort((left, right) =>
    left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0);
}

function autoLispString(value: string): string {
  const parts: string[] = [];
  let literal = "";
  const flush = () => {
    if (!literal) return;
    parts.push(`"${literal.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    literal = "";
  };
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 32 || codePoint === 127) {
      flush();
      parts.push(`(chr ${codePoint})`);
    } else {
      literal += character;
    }
  }
  flush();
  if (!parts.length) return '""';
  return parts.length === 1 ? parts[0] : `(strcat ${parts.join(" ")})`;
}

/**
 * Builds a reviewable, deliberately non-saving AutoLISP command for ACAD_TABLE
 * values that the byte-preserving DXF patcher cannot safely edit.
 */
export function buildNativeDxfTableScript(
  targets: NativeDxfTableScriptTarget[],
): {
  format: "cworks-dxf-table-script-v1";
  command: "CWORKS_APPLY_TABLE_TRANSLATIONS";
  script: string;
  sha256: string;
  manifestSha256: string;
  targetCount: number;
  expectedAppliedCount: number;
} {
  const ordered = [...targets].sort((left, right) =>
    left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0);
  const ids = new Set<string>();
  for (const target of ordered) {
    if (
      !target.targetId || ids.has(target.targetId)
      || !/^[0-9A-F]+$/i.test(target.tableHandle)
      || !Number.isInteger(target.sourceOrdinal) || target.sourceOrdinal < 0
      || (target.sourceOccurrenceCount !== undefined
        && (!Number.isInteger(target.sourceOccurrenceCount) || target.sourceOccurrenceCount < 1))
      || !target.source || !target.translation
    ) throw new Error("Invalid or duplicate native DXF table script target");
    ids.add(target.targetId);
  }
  const deduped = new Map<string, typeof ordered[number] & {
    sourceOccurrenceCount: number;
  }>();
  for (const target of ordered) {
    const tableHandle = target.tableHandle.toUpperCase();
    const key = `${tableHandle}\0${target.source}`;
    const existing = deduped.get(key);
    if (existing) {
      if (existing.translation !== target.translation) {
        throw new Error("Conflicting translations for the same native DXF table source");
      }
      existing.sourceOccurrenceCount += target.sourceOccurrenceCount ?? 1;
    } else {
      deduped.set(key, {
        ...target,
        tableHandle,
        sourceOccurrenceCount: target.sourceOccurrenceCount ?? 1,
      });
    }
  }
  const manifest = [...deduped.values()].map((target) => ({
    targetId: target.targetId,
    tableHandle: target.tableHandle,
    sourceOrdinal: target.sourceOrdinal,
    sourceOccurrenceCount: target.sourceOccurrenceCount,
    source: target.source,
    translation: target.translation,
  }));
  const manifestSha256 = createHash("sha256")
    .update(JSON.stringify(manifest)).digest("hex");
  const rows = manifest.map((target) =>
    `    (list ${autoLispString(target.targetId)} ${autoLispString(target.tableHandle)} ${autoLispString(target.source)} ${autoLispString(target.translation)} ${target.sourceOccurrenceCount})`)
    .join("\n");
  const script = [
    ";; Cworks source-verified ACAD_TABLE translation script.",
    ";; Review before use. This command only changes eligible matching table cells in memory.",
    "(defun CWORKS_APPLY_TABLE_TARGET (row / ent table rowCount columnCount rowIndex columnIndex source replacement expected cellText cellType contentType editable fieldId hasFormula merged minRow maxRow minColumn maxColumn eligible matches unsafeCells coordinates coordinate writeResult appliedCells writeErrors)",
    "  (setq ent (handent (cadr row)) source (caddr row) replacement (cadddr row) expected (car (cddddr row)) matches 0 unsafeCells 0 coordinates nil appliedCells 0 writeErrors 0)",
    "  (if (null ent)",
    "    (list 0 0 1 0 0 0 1)",
    "    (progn",
    "      (setq table (vlax-ename->vla-object ent))",
    "      (if (/= (vla-get-ObjectName table) \"AcDbTable\")",
    "        (list 0 0 1 0 0 0 1)",
    "        (progn",
    "          (setq rowCount (vla-get-Rows table) columnCount (vla-get-Columns table) rowIndex 0)",
    "          (while (< rowIndex rowCount)",
    "            (setq columnIndex 0)",
    "            (while (< columnIndex columnCount)",
    "              (setq cellText (vla-GetText table rowIndex columnIndex))",
    "              (if (= cellText source)",
    "                (progn",
    "                  (setq matches (1+ matches))",
    "                  (setq cellType (vla-GetCellType table rowIndex columnIndex))",
    "                  (setq contentType (vla-GetContentType table rowIndex columnIndex))",
    "                  (setq editable (vla-IsContentEditable table rowIndex columnIndex))",
    "                  (setq fieldId (vla-GetFieldId table rowIndex columnIndex))",
    // Autodesk ActiveX GetHasFormula requires a third, zero-based content index.
    "                  (setq hasFormula (vla-GetHasFormula table rowIndex columnIndex 0))",
    "                  (setq minRow 0 maxRow 0 minColumn 0 maxColumn 0)",
    "                  (setq merged (vla-IsMergedCell table rowIndex columnIndex 'minRow 'maxRow 'minColumn 'maxColumn))",
    "                  (setq eligible (and (= cellType 1) (= contentType 1) (= editable :vlax-true) (= fieldId 0) (= hasFormula :vlax-false) (= merged :vlax-false) (null (vl-string-search \"%<\" cellText)) (null (vl-string-search \"%<\" replacement))))",
    "                  (if eligible",
    "                    (setq coordinates (cons (list rowIndex columnIndex) coordinates))",
    "                    (setq unsafeCells (1+ unsafeCells)))))",
    "              (setq columnIndex (1+ columnIndex)))",
    "            (setq rowIndex (1+ rowIndex)))",
    "          (if (or (/= matches expected) (> unsafeCells 0))",
    "            (list 0 0 1 (if (/= matches expected) 1 0) unsafeCells 0 0)",
    "            (progn",
    "              (foreach coordinate (reverse coordinates)",
    "                (setq writeResult (vl-catch-all-apply 'vla-SetText (list table (car coordinate) (cadr coordinate) replacement)))",
    "                (if (vl-catch-all-error-p writeResult) (setq writeErrors (1+ writeErrors)) (setq appliedCells (1+ appliedCells))))",
    "              (list (if (> appliedCells 0) 1 0) appliedCells (if (= appliedCells expected) 0 1) 0 0 (if (and (> appliedCells 0) (> writeErrors 0)) 1 0) writeErrors))))))))",
    `(defun c:CWORKS_APPLY_TABLE_TRANSLATIONS (/ rows matchedTargets appliedCells skippedTargets countMismatch unsafeCells partialErrors errors row result comResult acadResult lispsys answer)`,
    "  (setq matchedTargets 0 appliedCells 0 skippedTargets 0 countMismatch 0 unsafeCells 0 partialErrors 0 errors 0)",
    "  (setq rows (list",
    rows,
    "  ))",
    "  (setq comResult (vl-catch-all-apply 'vl-load-com nil))",
    "  (setq acadResult (if (vl-catch-all-error-p comResult) comResult (vl-catch-all-apply 'vlax-get-acad-object nil)))",
    "  (setq lispsys (vl-catch-all-apply 'getvar (list \"LISPSYS\")))",
    "  (cond",
    "    ((vl-catch-all-error-p acadResult) (princ \"\\nCworks aborted: Windows AutoCAD ActiveX is unavailable.\"))",
    "    ((/= (strcase (vl-filename-extension (getvar \"DWGNAME\"))) \".DWG\") (princ \"\\nCworks aborted: open an explicit derivative .dwg first.\"))",
    "    ((or (vl-catch-all-error-p lispsys) (not (numberp lispsys)) (<= lispsys 0)) (princ \"\\nCworks aborted: Windows AutoCAD 2021+ with Unicode LISPSYS is required.\"))",
    "    ((/= (strcase (getstring T \"\\nType YES to confirm this is a derivative DWG and apply eligible table translations: \")) \"YES\") (princ \"\\nCworks cancelled.\"))",
    "    (T",
    `      (princ "\\nCWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=${manifestSha256}")`,
    "      (foreach row rows",
    "        (setq result (vl-catch-all-apply 'CWORKS_APPLY_TABLE_TARGET (list row)))",
    "        (if (vl-catch-all-error-p result)",
    "          (progn (setq skippedTargets (1+ skippedTargets)) (setq errors (1+ errors)))",
    "          (progn",
    "            (setq matchedTargets (+ matchedTargets (car result)))",
    "            (setq appliedCells (+ appliedCells (cadr result)))",
    "            (setq skippedTargets (+ skippedTargets (caddr result)))",
    "            (setq countMismatch (+ countMismatch (cadddr result)))",
    "            (setq unsafeCells (+ unsafeCells (car (cddddr result))))",
    "            (setq partialErrors (+ partialErrors (cadr (cddddr result))))",
    "            (setq errors (+ errors (caddr (cddddr result)))))))",
    "      (princ (strcat \"\\nCworks table translations: matchedTargets=\" (itoa matchedTargets) \" appliedCells=\" (itoa appliedCells) \" skippedTargets=\" (itoa skippedTargets) \" countMismatch=\" (itoa countMismatch) \" unsafeCells=\" (itoa unsafeCells) \" partialErrors=\" (itoa partialErrors) \" errors=\" (itoa errors)))",
    `      (princ "\\nCWORKS_APPLY_TABLE_TRANSLATIONS_END manifestSha256=${manifestSha256}")))`,
    "  (princ)",
    ")",
    `(princ "\\nRun CWORKS_APPLY_TABLE_TRANSLATIONS after review. Manifest ${manifestSha256}.")`,
    "(princ)",
    "",
  ].join("\n");
  return {
    format: "cworks-dxf-table-script-v1",
    command: "CWORKS_APPLY_TABLE_TRANSLATIONS",
    script,
    sha256: createHash("sha256").update(script).digest("hex"),
    manifestSha256,
    targetCount: manifest.length,
    expectedAppliedCount: manifest.reduce((sum, target) =>
      sum + target.sourceOccurrenceCount, 0),
  };
}

export function buildNativeDxfAuditPayload(
  ledger: any,
  maxBytes = 100_000,
): string {
  const entries = Array.isArray(ledger?.entries)
    ? ledger.entries.filter((entry: any) => entry?.isCyrillicTarget === true)
    : [];
  const targetIds = new Set<string>();
  const compactEntries = entries.map((entry: any) => {
    const targetId = entry.targetId || entry.handle;
    if (
      typeof targetId !== "string" || !targetId
      || typeof entry.handle !== "string" || !entry.handle
      || targetIds.has(targetId)
    ) {
      throw new Error("Native DXF audit target IDs must be non-empty and unique");
    }
    targetIds.add(targetId);
    return {
      ...(entry.targetId ? {
        targetId: entry.targetId,
        entityType: entry.entityType,
      } : {}),
      handle: entry.handle,
      plain: entry.plain,
      maxCharacters: entry.maxCharacters,
      definitionBlock: entry.definitionBlock ?? null,
      placementCount: entry.placementCount ?? 1,
      replacement: entry.replacement,
      accounting: entry.accounting,
      preservationReason: entry.preservationReason,
    };
  });
  const serialized = JSON.stringify({
    format: ledger?.format,
    targetLanguage: ledger?.targetLanguage,
    sourceSha256: ledger?.sourceSha256,
    placementManifestSha256: ledger?.placementManifestSha256,
    placementCount: ledger?.placementCount,
    auditScope: ledger?.auditScope && typeof ledger.auditScope === "object"
      && !Array.isArray(ledger.auditScope) ? ledger.auditScope : null,
    tableScript: ledger?.tableScript ? {
      sha256: ledger.tableScript.sha256,
      manifestSha256: ledger.tableScript.manifestSha256,
      targetCount: ledger.tableScript.targetCount,
      expectedAppliedCount: ledger.tableScript.expectedAppliedCount,
    } : null,
    tableTargets: Array.isArray(ledger?.tableTargets) ? ledger.tableTargets.map((entry: any) => ({
      targetId: entry.targetId,
      tableHandle: entry.tableHandle,
      sourceOrdinal: entry.sourceOrdinal,
      sourceOccurrenceCount: entry.sourceOccurrenceCount ?? 1,
      source: entry.source,
      translation: entry.translation,
      accounting: entry.accounting,
    })) : [],
    splitFragmentGroups: Array.isArray(ledger?.splitFragmentGroups)
      ? ledger.splitFragmentGroups
      : [],
    unresolved: Array.isArray(ledger?.unresolved) ? ledger.unresolved : [],
    correctionDiagnostics: Array.isArray(ledger?.correctionDiagnostics)
      ? ledger.correctionDiagnostics
      : [],
    entries: compactEntries,
  });
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(`Native DXF compact audit payload exceeds ${maxBytes} byte safety limit`);
  }
  return serialized;
}

const NATIVE_DXF_BATCH_MAX_TARGETS = 90;
const NATIVE_DXF_BATCH_MAX_SOURCE_CHARACTERS = 16_000;
const NATIVE_DXF_BATCH_MAX_BYTES = 64_000;
const NATIVE_DXF_AUDIT_MAX_TARGETS = 75;
const NATIVE_DXF_AUDIT_MAX_BYTES = 90_000;

function boundedNativeDxfBatches(units: any[][]): any[][] {
  const batches: any[][] = [];
  let pending: any[] = [];
  let pendingCharacters = 0;
  let pendingBytes = 0;
  for (const unit of units) {
    const unitCharacters = unit.reduce((sum, item) =>
      sum + String(item.plainText ?? item.sourceText ?? "").length, 0);
    const unitBytes = Buffer.byteLength(JSON.stringify(unit), "utf8");
    if (unit.length > NATIVE_DXF_BATCH_MAX_TARGETS
      || unitCharacters > NATIVE_DXF_BATCH_MAX_SOURCE_CHARACTERS
      || unitBytes > NATIVE_DXF_BATCH_MAX_BYTES) {
      throw new Error("A native DXF translation unit exceeds the bounded provider request limit");
    }
    if (pending.length && (
      pending.length + unit.length > NATIVE_DXF_BATCH_MAX_TARGETS
      || pendingCharacters + unitCharacters > NATIVE_DXF_BATCH_MAX_SOURCE_CHARACTERS
      || pendingBytes + unitBytes > NATIVE_DXF_BATCH_MAX_BYTES
    )) {
      batches.push(pending);
      pending = [];
      pendingCharacters = 0;
      pendingBytes = 0;
    }
    pending.push(...unit);
    pendingCharacters += unitCharacters;
    pendingBytes += unitBytes;
  }
  if (pending.length) batches.push(pending);
  return batches;
}

export function buildNativeDxfAuditPayloadChunks(ledger: any): string[] {
  const entries = Array.isArray(ledger?.entries)
    ? ledger.entries.filter((entry: any) => entry?.isCyrillicTarget === true)
    : [];
  const tables = Array.isArray(ledger?.tableTargets) ? ledger.tableTargets : [];
  const items = [
    ...entries.map((entry: any) => ({ kind: "entry", value: entry })),
    ...tables.map((entry: any) => ({ kind: "table", value: entry })),
  ];
  if (!items.length) return [buildNativeDxfAuditPayload(ledger, NATIVE_DXF_AUDIT_MAX_BYTES)];

  const makeLedger = (chunk: typeof items) => {
    const chunkEntries = chunk.filter((item) => item.kind === "entry").map((item) => item.value);
    const chunkTables = chunk.filter((item) => item.kind === "table").map((item) => item.value);
    const ids = new Set(chunk.map((item) => item.value.targetId || item.value.handle));
    const handles = new Set(chunkEntries.map((entry: any) => entry.handle));
    return {
      ...ledger,
      entries: chunkEntries,
      tableTargets: chunkTables,
      // tableScript is an attestation for the complete ledger, whereas this
      // request contains only a bounded partition. Without this explicit
      // scope, an auditor can (and did) compare a full-script count with the
      // subset supplied in one request and manufacture a false mismatch.
      auditScope: {
        kind: "bounded_partition",
        completeLedger: false,
        partitionTargetCount: chunk.length,
        partitionEntryCount: chunkEntries.length,
        partitionTableTargetCount: chunkTables.length,
        partitionTableOccurrenceCount: chunkTables.reduce((sum: number, entry: any) =>
          sum + (Number.isInteger(entry?.sourceOccurrenceCount)
            && entry.sourceOccurrenceCount > 0 ? entry.sourceOccurrenceCount : 1), 0),
        fullLedgerTargetCount: items.length,
        fullLedgerEntryCount: entries.length,
        fullLedgerTableTargetCount: tables.length,
        fullLedgerTableOccurrenceCount: tables.reduce((sum: number, entry: any) =>
          sum + (Number.isInteger(entry?.sourceOccurrenceCount)
            && entry.sourceOccurrenceCount > 0 ? entry.sourceOccurrenceCount : 1), 0),
      },
      splitFragmentGroups: (Array.isArray(ledger?.splitFragmentGroups)
        ? ledger.splitFragmentGroups : []).filter((group: any) =>
        Array.isArray(group?.handles) && group.handles.some((handle: string) => handles.has(handle))),
      unresolved: (Array.isArray(ledger?.unresolved) ? ledger.unresolved : [])
        .filter((entry: any) => ids.has(entry.targetId || entry.handle)),
      correctionDiagnostics: (Array.isArray(ledger?.correctionDiagnostics)
        ? ledger.correctionDiagnostics : []).filter((entry: any) =>
        ids.has(entry.targetId || entry.handle) || handles.has(entry.handle)),
    };
  };

  const payloads: string[] = [];
  let pending: typeof items = [];
  for (const item of items) {
    const candidate = [...pending, item];
    let serialized: string | null = null;
    try {
      serialized = buildNativeDxfAuditPayload(makeLedger(candidate), NATIVE_DXF_AUDIT_MAX_BYTES);
    } catch (error) {
      if (!pending.length) throw error;
    }
    if (pending.length && (
      candidate.length > NATIVE_DXF_AUDIT_MAX_TARGETS || serialized === null
    )) {
      payloads.push(buildNativeDxfAuditPayload(
        makeLedger(pending), NATIVE_DXF_AUDIT_MAX_BYTES,
      ));
      pending = [item];
      buildNativeDxfAuditPayload(makeLedger(pending), NATIVE_DXF_AUDIT_MAX_BYTES);
    } else {
      pending = candidate;
    }
  }
  if (pending.length) {
    payloads.push(buildNativeDxfAuditPayload(
      makeLedger(pending), NATIVE_DXF_AUDIT_MAX_BYTES,
    ));
  }
  return payloads;
}

export const NATIVE_DXF_TRANSLATION_GLOSSARY =
  "Approved exact compact terms are AutoCAD fit-evidenced readable construction abbreviations, not semantic omissions: Архитектурные решения=Arch. Design; Реконструкция дома расположенного в Японии=House Reconst., Japan; по адресу: Шинагава-ку, Хигаси Готанда 3-9-13=Addr.: Shinagawa-ku, H. Gotanda 3-9-13; Кладочный план 3-го=3F Masonry Plan; Ведомость перемычек=Lintel Sched.; Схема сечения=Section; Экспликация помещений=Room Sched. Glossary: ш. and шаг mean spacing or @; Кол.уч. means Qty or changed portions (not participants); м2 means m².";

const NATIVE_DXF_AUDIT_PARTITION_SCOPE_POLICY =
  "When auditScope.kind is bounded_partition and completeLedger is false, this request intentionally contains only that partition's entries and tableTargets. Audit every supplied row, but do not infer full-drawing coverage from the partition or compare its local table row/occurrence counts with the complete-ledger tableScript targetCount or expectedAppliedCount.";

export const NATIVE_DXF_AUDIT_POLICY = [
  "Independently audit this native DXF translation ledger.",
  NATIVE_DXF_AUDIT_PARTITION_SCOPE_POLICY,
  "Verify every Cyrillic target has a replacement or explicit preservation reason, split groups are coherent (with no duplicated reconstructed word), replacements fit their maxCharacters where possible, and construction glossary terms are correct.",
  "Approved exact compact construction terms are readable AutoCAD fit-evidenced abbreviations, not semantic omissions: Arch. Design, House Reconst., Japan, Addr.: Shinagawa-ku, H. Gotanda 3-9-13, 3F Masonry Plan, Lintel Sched., Section, and Room Sched.",
  "An exact preserved technical standard or drawing identifier containing no prose or unit, such as ГОСТ5264-80-Н1, Пр-1, 198/ДУ-2021. АР, or П.в.-3/-4, may validly retain source script because transliteration can change the code, but it must have an explicit preservation reason.",
  "An exact isolated uppercase Cyrillic letter used as a grid or stage identifier may likewise remain unchanged only when its ledger entry has an explicit preservation reason identifying it as that non-language identifier.",
  "An exact embedded technical code span such as 3-Вр-1 or 10-А may retain source script inside an otherwise translated replacement only when the surrounding prose is translated and preservationReason explicitly names that exact retained span. Reject a transliterated, partially copied, or otherwise altered code.",
  "Reject preserved prose, headings, labels, and units such as м2.",
  "A definitionBlock entry is stored once but may have placementCount repeated visible INSERT placements. Audit its translation once while requiring the accounting to cover every reported placement.",
  "ACAD_TABLE targets are intentionally applied later by the source-verified tableScript. translated_pending_table_script is complete translation accounting and is not by itself a finding; do reject missing or wrong-language table translations and inconsistent script hash/count evidence.",
  "Return JSON only {\"passed\":boolean,\"findings\":[{\"type\":\"missing_translation|semantic_mismatch|placement|source_residue|unreadable\",\"message\":\"...\",\"sourceBlockId\":\"targetId\"}]}."
].join(" ");

function nativeDxfAuditPolicy(language: CworksTargetLanguage): string {
  if (language === "en") return NATIVE_DXF_AUDIT_POLICY;
  return [
    "Independently audit this native DXF translation ledger.",
    NATIVE_DXF_AUDIT_PARTITION_SCOPE_POLICY,
    "The required target language is Japanese. Reject every translated human-language replacement that does not contain kanji, hiragana, or katakana; English-only replacement text is a blocking wrong-language finding.",
    "Verify every Cyrillic source target has a Japanese replacement or an explicit preservation reason, split groups are coherent, replacements fit maxCharacters where possible, and technical meaning is correct.",
    "ACAD_TABLE translations with translated_pending_table_script accounting are intentionally applied later by the source-verified tableScript and are not a finding by themselves. Reject missing or wrong-language table translations and inconsistent script hash/count evidence.",
    "Exact standards, drawing identifiers, and isolated grid/stage identifiers may remain byte-identical only with an explicit preservation reason. Reject preserved prose, headings, labels, and units.",
    "Return JSON only {\"passed\":boolean,\"findings\":[{\"type\":\"missing_translation|semantic_mismatch|placement|source_residue|unreadable\",\"message\":\"...\",\"sourceBlockId\":\"handle\"}]}.",
  ].join(" ");
}

/**
 * Partition scope changes how a bounded payload is interpreted; it does not
 * change the saved translation/audit methodology. In particular, a successor
 * checkpoint that is already marked pending re-audit must remain resumable so
 * that this corrected instruction can be applied to its saved translations.
 */
function nativeDxfCheckpointAuditPolicy(language: CworksTargetLanguage): string {
  return nativeDxfAuditPolicy(language)
    .replace(` ${NATIVE_DXF_AUDIT_PARTITION_SCOPE_POLICY}`, "");
}

export type NativeDxfJobAttemptOptions = {
  readObject?: (storedName: string) => Promise<Buffer | null>;
  writeObject?: (storedName: string, content: Buffer | string) => Promise<void>;
  deleteObject?: (storedName: string) => Promise<void>;
  runProcess?: typeof runNativeDxfProcess;
  askTranslator?: CworksTranslator;
  askAuditor?: (payload: string, signal?: AbortSignal) => Promise<string>;
};

function isNativeDxfInspectionCacheKey(storedName: string): boolean {
  return /^cworks-translator\/[^/]+\/inspection-cache\/[a-f0-9]{64}\/[a-f0-9]{64}\.json\.gz$/u
    .test(storedName);
}

/**
 * The retry route persists this exact brief before enqueueing an explicit
 * resume. Keeping intent on the job (rather than inferring it from a row that
 * may disappear between enqueue and claim) lets the worker fail closed.
 */
export const NATIVE_DXF_RETRY_BRIEF_KIND = "cworks-native-dxf-retry";

export function isNativeDxfResumeIntent(job: Pick<CworksJob, "sourceFormat" | "repairBrief">): boolean {
  const brief = job.repairBrief as any;
  return job.sourceFormat === "dxf"
    && brief?.kind === NATIVE_DXF_RETRY_BRIEF_KIND
    && brief?.mode === "resume";
}

function nativeDxfResumeIntentError(
  job: Pick<CworksJob, "revisionCount" | "targetLanguage" | "repairBrief">,
): string | null {
  const brief = job.repairBrief as any;
  if (brief?.sourceRevision !== job.revisionCount) return "resume_intent_revision_mismatch";
  const expectedLanguage = job.targetLanguage === "ja" ? "ja" : "en";
  if (brief?.targetLanguage !== expectedLanguage) return "resume_intent_language_mismatch";
  if (brief?.provisionalPlacementValidation !== true) return "resume_intent_incomplete";
  return null;
}

function isNativeDxfTargetedCorrectionIntent(
  job: Pick<CworksJob, "sourceFormat" | "repairBrief">,
): boolean {
  return job.sourceFormat === "dxf"
    && isNativeDxfTargetedCorrectionBrief(job.repairBrief);
}

function nativeDxfTargetedCorrectionIntentError(
  job: Pick<CworksJob, "revisionCount" | "targetLanguage" | "repairBrief">,
): string | null {
  if (!isNativeDxfTargetedCorrectionBrief(job.repairBrief)) {
    return "targeted_correction_intent_incomplete";
  }
  const brief = job.repairBrief;
  if (brief.sourceRevision !== job.revisionCount - 1) {
    return "targeted_correction_revision_mismatch";
  }
  if (brief.targetLanguage !== (job.targetLanguage === "ja" ? "ja" : "en")) {
    return "targeted_correction_language_mismatch";
  }
  return null;
}

class NativeDxfResumeRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Native DXF resume rejected: ${reason}`);
    this.name = "NativeDxfResumeRejectedError";
    this.reason = reason;
  }
}

export function nativeDxfCheckpointMethodologyHash(language: CworksTargetLanguage): string {
  return nativeDxfMethodologyHash({
    checkpointEnvelopeVersion: NATIVE_DXF_CHECKPOINT_METHODOLOGY_VERSION,
    translationMethodologyVersion: TRANSLATION_METHODOLOGY_VERSION,
    auditMethodologyVersion: MACHINE_AUDIT_METHODOLOGY_VERSION,
    auditModel: MACHINE_AUDIT_MODEL,
    translationGlossary: language === "en" ? NATIVE_DXF_TRANSLATION_GLOSSARY : "",
    auditPolicy: nativeDxfCheckpointAuditPolicy(language),
  });
}

function nativeDxfCheckpointBinding(
  job: CworksJob,
  sourceSha256: string,
  targetLanguage: CworksTargetLanguage,
  placementManifestSha256?: string | null,
  revisionCount = job.revisionCount,
): NativeDxfCheckpointBinding {
  return {
    sourceSha256,
    revisionCount,
    targetLanguage,
    methodologyHash: nativeDxfCheckpointMethodologyHash(targetLanguage),
    placementManifestSha256: placementManifestSha256 || null,
  };
}

function nativeDxfTranslationsRecord(translations: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...translations.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));
}

function nativeDxfTranslationsMap(value: unknown): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value).filter(([, replacement]) =>
    typeof replacement === "string" && Boolean(replacement.trim())) as Array<[string, string]>);
}

function readNativeDxfSavedAudit(value: unknown): CworksPageMachineAudit | null {
  if (
    !value
    || typeof value !== "object"
    || (value as any).pageNumber !== 1
    || !["passed", "findings"].includes((value as any).status)
    || typeof (value as any).model !== "string"
    || !Array.isArray((value as any).findings)
  ) return null;
  return {
    pageNumber: 1,
    status: (value as any).status,
    model: (value as any).model,
    findings: (value as any).findings,
  };
}

function nativeDxfCheckpointPayloadComplete(value: unknown): boolean {
  if (!isNativeDxfCheckpointResumeEligible(value, {
    sourceSha256: typeof (value as any)?.sourceSha256 === "string"
      ? (value as any).sourceSha256 : "",
    revisionCount: Number.isInteger((value as any)?.revisionCount)
      ? (value as any).revisionCount : -1,
    targetLanguage: (value as any)?.targetLanguage === "ja" ? "ja" : "en",
    methodologyHash: typeof (value as any)?.methodologyHash === "string"
      ? (value as any).methodologyHash : "",
    placementManifestSha256: typeof (value as any)?.placementManifestSha256 === "string"
      ? (value as any).placementManifestSha256 : null,
  })) return false;
  const checkpoint = value as NativeDxfCheckpoint;
  if (checkpoint.stage === "translation_batch") return true;
  if (
    !readNativeDxfSavedAudit(checkpoint.audit)
    || !Number.isInteger(checkpoint.auditIndex)
    || checkpoint.auditIndex < 0
    || checkpoint.auditIndex > 2
  ) return false;
  if (
    checkpoint.stage === "correction"
    && !Array.isArray(checkpoint.correctionDiagnostics)
  ) return false;
  if (
    checkpoint.targetedCorrectionCompletedTargetIds !== undefined
    && (
      !Array.isArray(checkpoint.targetedCorrectionCompletedTargetIds)
      || checkpoint.targetedCorrectionCompletedTargetIds.some((targetId) =>
        typeof targetId !== "string" || !targetId)
      || new Set(checkpoint.targetedCorrectionCompletedTargetIds).size
        !== checkpoint.targetedCorrectionCompletedTargetIds.length
    )
  ) return false;
  if (
    checkpoint.targetedCorrectionIntent !== undefined
    && !isNativeDxfTargetedCorrectionBrief(checkpoint.targetedCorrectionIntent)
  ) return false;
  if (
    checkpoint.targetedCorrectionCompletionReasons !== undefined
    && (
      !checkpoint.targetedCorrectionIntent
      || !checkpoint.targetedCorrectionCompletedTargetIds
      || !Object.entries(checkpoint.targetedCorrectionCompletionReasons).every(([targetId, reason]) =>
        checkpoint.targetedCorrectionCompletedTargetIds!.includes(targetId)
        && typeof reason === "string"
        && Boolean(reason.trim()))
    )
  ) return false;
  return checkpoint.stage !== "pre_patch"
    || Boolean(
      checkpoint.ledger
      && typeof checkpoint.ledger === "object"
      && !Array.isArray(checkpoint.ledger),
    );
}

async function saveNativeDxfCheckpoint(
  job: CworksJob,
  checkpoint: NativeDxfCheckpoint,
  values: {
    progress?: number;
    progressNote?: string;
    tokenEstimate?: number;
    warningCount?: number;
  } = {},
  leaseLost = false,
): Promise<void> {
  await db.transaction(async (tx) => {
    const leaseNow = new Date();
    const [owned] = await tx.select({ id: cworksTranslationJobs.id })
      .from(cworksTranslationJobs)
      .where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "running"),
        eq(cworksTranslationJobs.runToken, job.runToken || ""),
        gt(cworksTranslationJobs.leaseExpiresAt, leaseNow),
      ))
      .for("update")
      .limit(1);
    if (!owned || leaseLost) throw new Error("CAD translation lease was superseded");
    await tx.insert(cworksTranslationCheckpoints).values({
      jobId: job.id,
      revisionCount: job.revisionCount,
      pageNumber: 1,
      sourceHash: checkpoint.sourceSha256,
      // Native checkpoints are envelopes; PDF checkpoints remain arrays.
      translations: checkpoint,
      tokenEstimate: values.tokenEstimate ?? 0,
      warningCount: values.warningCount ?? 0,
    }).onConflictDoUpdate({
      target: [
        cworksTranslationCheckpoints.jobId,
        cworksTranslationCheckpoints.revisionCount,
        cworksTranslationCheckpoints.pageNumber,
      ],
      set: {
        sourceHash: checkpoint.sourceSha256,
        translations: checkpoint,
        tokenEstimate: values.tokenEstimate ?? 0,
        warningCount: values.warningCount ?? 0,
        updatedAt: new Date(),
      },
    });
    if (values.progress !== undefined || values.progressNote !== undefined) {
      const updated = await tx.update(cworksTranslationJobs).set({
        ...(values.progress === undefined ? {} : { progress: values.progress }),
        ...(values.progressNote === undefined ? {} : { progressNote: values.progressNote }),
        ...(values.tokenEstimate === undefined ? {} : { tokenEstimate: values.tokenEstimate }),
        ...(values.tokenEstimate === undefined
          ? {}
          : { costEstimate: ((values.tokenEstimate / 1_000_000) * 9).toFixed(4) }),
        leaseExpiresAt: leaseUntil(),
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "running"),
        eq(cworksTranslationJobs.runToken, job.runToken || ""),
      )).returning({ id: cworksTranslationJobs.id });
      if (!updated.length) throw new Error("CAD translation lease was superseded");
    }
  });
}

export async function runNativeDxfJobAttempt(
  job: CworksJob,
  options: NativeDxfJobAttemptOptions = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cworks-dxf-${job.id}-`));
  const staged: string[] = [];
  let published = false;
  let leaseLost = false;
  // The heartbeat is the ownership authority while a native process is
  // running. Passing this signal through CPU-aware supervision ensures a
  // superseded or cancelled job terminates its complete subprocess tree.
  const nativeProcessAbortController = new AbortController();
  const readObject = options.readObject || readFileFromObjectStorage;
  const writeObject = options.writeObject || writeFileToObjectStorage;
  const deleteObject = options.deleteObject || deleteFromObjectStorageStrict;
  const runProcess = options.runProcess || runNativeDxfProcess;
  const askTranslator = options.askTranslator || askCworksTranslator;
  const resumeRequested = isNativeDxfResumeIntent(job);
  const resumeIntentError = resumeRequested ? nativeDxfResumeIntentError(job) : null;
  let targetedCorrectionRequested = job.sourceFormat === "dxf"
    && hasNativeDxfTargetedCorrectionKind(job.repairBrief);
  let diagnosticContext: NativeDxfDiagnosticContext = {
    stage: "setup",
    location: "attempt_boundary",
  };
  const setDiagnosticContext = (
    stage: NativeDxfDiagnosticContext["stage"],
    location: NativeDxfDiagnosticContext["location"],
  ) => {
    diagnosticContext = { stage, location };
  };
  const saveCheckpoint = async (
    checkpoint: NativeDxfCheckpoint,
    values: {
      progress?: number;
      progressNote?: string;
      tokenEstimate?: number;
      warningCount?: number;
    },
  ) => {
    setDiagnosticContext("checkpoint", "checkpoint_write");
    await saveNativeDxfCheckpoint(job, checkpoint, values, leaseLost);
  };
  const targetedCorrectionIntentError = targetedCorrectionRequested
    ? nativeDxfTargetedCorrectionIntentError(job)
    : null;
  const heartbeat = setInterval(async () => {
    try {
      const rows = await db.update(cworksTranslationJobs)
        .set({ leaseExpiresAt: leaseUntil(), updatedAt: new Date() })
        .where(and(
          eq(cworksTranslationJobs.id, job.id),
          eq(cworksTranslationJobs.status, "running"),
          eq(cworksTranslationJobs.runToken, job.runToken || ""),
        ))
        .returning({ id: cworksTranslationJobs.id });
      if (!rows.length) {
        leaseLost = true;
        nativeProcessAbortController.abort();
      }
    } catch {
      // Ownership is proved again before each irreversible publication step.
    }
  }, 60_000);
  heartbeat.unref();
  try {
    if (resumeIntentError) throw new NativeDxfResumeRejectedError(resumeIntentError);
    if (targetedCorrectionIntentError) {
      throw new NativeDxfResumeRejectedError(targetedCorrectionIntentError);
    }
    setDiagnosticContext("setup", "source_read");
    const source = await readObject(job.sourceStoredName);
    if (!source) {
      if (resumeRequested) throw new NativeDxfResumeRejectedError("source_missing");
      throw new Error("Source DXF is missing from private storage");
    }
    // Always digest the bytes just read from private storage before considering
    // a durable inspection result. Cache keys never stand in for source reads.
    const sourceSha256 = sha256(source);
    const processorSha256 = nativeDxfProcessorFingerprint(await Promise.all([
      fs.readFile(DXF_PROCESSOR).then((content) => ({ name: "dxf_processor.py", content })),
      fs.readFile(path.join(apiServerRoot, "src/cworks-translator/dxf_table_cells.py"))
        .then((content) => ({ name: "dxf_table_cells.py", content })),
    ]));
    const inspectionCacheKey = nativeDxfInspectionCacheKey(
      job.id,
      sourceSha256,
      processorSha256,
    );
    const input = path.join(dir, "source.dxf"), inventoryPath = path.join(dir, "inventory.json");
    const translationsPath = path.join(dir, "translations.json"), output = path.join(dir, "translated.dxf");
    const patchReport = path.join(dir, "patch-report.json"), sourceSvg = path.join(dir, "source.svg");
    const translatedSvg = path.join(dir, "translated.svg");
    await fs.writeFile(input, source);
    let inventory: any = null;
    try {
      setDiagnosticContext("inspect", "inspection_cache");
      // The production App Storage wrapper exposes metadata without fetching
      // the body. Reject an oversized cache before it can allocate a large
      // Buffer; injected test storage has only the existing readObject API.
      const metadata = options.readObject
        ? undefined
        : await getObjectStorageMetadata(inspectionCacheKey);
      const metadataSize = metadata ? Number(metadata.size) : null;
      const tooLarge = Boolean(
        metadata && (!Number.isFinite(metadataSize) || metadataSize! > MAX_NATIVE_DXF_INSPECTION_CACHE_BYTES),
      );
      if (tooLarge) {
        logger.warn({ jobId: job.id, cacheReason: "compressed_size" },
          "Native DXF inspection cache was rejected before download; inspecting source");
      }
      // Metadata is intentionally required for the production cache path:
      // cache acceleration is optional, while downloading a body of unknown
      // size is not. Test injectors retain the narrow readObject contract.
      const cached = options.readObject
        ? await readObject(inspectionCacheKey)
        : metadata && !tooLarge
          ? await readObject(inspectionCacheKey)
          : null;
      if (cached) {
        const cacheResult = readNativeDxfInspectionCache(
          cached,
          sourceSha256,
          processorSha256,
        );
        if (cacheResult.inventory) {
          inventory = cacheResult.inventory;
          await updateClaimed(job, {
            progress: 8,
            progressNote: "Reusing source- and processor-bound native DXF inspection",
          });
        } else {
          logger.warn({ jobId: job.id, cacheReason: cacheResult.reason },
            "Native DXF inspection cache was rejected; inspecting source");
        }
      }
    } catch (error) {
      // The cache is an optional acceleration. Do not let a private-storage
      // transient prevent a safe fresh inspector run, and never log drawing
      // content or cache bytes.
      logger.warn({ jobId: job.id, cacheError: describeProviderFailure(error, false) },
        "Native DXF inspection cache could not be read; inspecting source");
    }
    if (!inventory) {
      setDiagnosticContext("inspect", "inspection_process");
      await updateClaimed(job, { progress: 8, progressNote: "Inspecting safe native DXF text and table targets" });
      await runProcess(DXF_PROCESSOR, "inspect", [input, inventoryPath], {
        jobId: job.id, timeoutMs: EXTRACTION_TIMEOUT_MS,
        cpuAware: nativeDxfCpuAwareOptions(nativeProcessAbortController.signal),
      });
      const inventoryJson = await fs.readFile(inventoryPath);
      inventory = JSON.parse(inventoryJson.toString("utf8")) as any;
      // Register the immutable, job-scoped object before writing it. Cleanup
      // retains these rows while their job exists, then deletes them after a
      // job deletion even if this worker is interrupted between calls.
      const cacheContent = encodeNativeDxfInspectionCache(
        inventory,
        inventoryJson,
        sourceSha256,
        processorSha256,
      );
      if (cacheContent) {
        try {
          await queueCleanup([inspectionCacheKey], job.id);
          await writeObject(inspectionCacheKey, cacheContent);
          // A deletion can race between queueing its outbox row and the
          // storage write. If deletion already consumed that row, remove this
          // object rather than leaving an untracked cache behind.
          const [[owner], [tracked]] = await Promise.all([
            db.select({ id: cworksTranslationJobs.id }).from(cworksTranslationJobs)
              .where(and(
                eq(cworksTranslationJobs.id, job.id),
                eq(cworksTranslationJobs.status, "running"),
                eq(cworksTranslationJobs.runToken, job.runToken || ""),
              )).limit(1),
            db.select({ id: cworksTranslationCleanup.id }).from(cworksTranslationCleanup)
              .where(eq(cworksTranslationCleanup.storedName, inspectionCacheKey)).limit(1),
          ]);
          if (!owner || !tracked) {
            try {
              await deleteObject(inspectionCacheKey);
            } catch (cleanupError) {
              // The original outbox row may have been consumed by job
              // deletion. Re-register before surfacing the optional-cache
              // failure so a transient delete cannot orphan this object.
              await queueCleanup([inspectionCacheKey], job.id);
              throw cleanupError;
            }
            logger.warn({ jobId: job.id },
              "Native DXF inspection cache write lost its job binding and was removed");
          }
        } catch (error) {
          logger.warn({ jobId: job.id, cacheError: describeProviderFailure(error, false) },
            "Native DXF inspection cache could not be persisted");
        }
      } else {
        logger.warn({ jobId: job.id },
          "Native DXF inspection result was not cacheable; continuing without cache");
      }
    }
    const requestedTargetLanguage = targetLanguage(job);
    const requestedTargetName = targetLanguageName(requestedTargetLanguage);
    if (typeof inventory.sha256 !== "string" || inventory.sha256 !== sourceSha256) {
      if (resumeRequested) throw new NativeDxfResumeRejectedError("source_mismatch");
      throw new Error("Native DXF source hash verification failed");
    }
    const checkpointBinding = nativeDxfCheckpointBinding(
      job,
      sourceSha256,
      requestedTargetLanguage,
      typeof inventory.placementManifestSha256 === "string"
        ? inventory.placementManifestSha256
        : null,
    );
    setDiagnosticContext("checkpoint", "checkpoint_read");
    let [checkpointRow] = await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, job.id),
      eq(cworksTranslationCheckpoints.revisionCount, job.revisionCount),
      eq(cworksTranslationCheckpoints.pageNumber, 1),
    )).limit(1);
    // A new explicitly consented correction revision is seeded from its
    // predecessor. Once it saves its own checkpoint, every interruption uses
    // that successor snapshot and cannot spend the one correction pass again.
    let checkpointIsCurrentRevision = Boolean(checkpointRow);
    let checkpointValidationBinding = checkpointBinding;
    if (targetedCorrectionRequested && !checkpointRow) {
      const brief = job.repairBrief as any;
      [checkpointRow] = await db.select().from(cworksTranslationCheckpoints).where(and(
        eq(cworksTranslationCheckpoints.jobId, job.id),
        eq(cworksTranslationCheckpoints.revisionCount, brief.sourceRevision),
        eq(cworksTranslationCheckpoints.pageNumber, 1),
      )).limit(1);
      checkpointIsCurrentRevision = false;
      checkpointValidationBinding = nativeDxfCheckpointBinding(
        job,
        sourceSha256,
        requestedTargetLanguage,
        typeof inventory.placementManifestSha256 === "string"
          ? inventory.placementManifestSha256
          : null,
        brief.sourceRevision,
      );
    }
    const checkpointValue = checkpointRow?.translations as unknown;
    const rawCheckpointEligibility = !checkpointRow
      ? nativeDxfCheckpointResumeEligibility(null, checkpointValidationBinding)
      : checkpointRow.sourceHash !== checkpointValidationBinding.sourceSha256
        ? { eligible: false as const, reason: "source_mismatch" as const }
        : nativeDxfCheckpointResumeEligibility(checkpointValue, checkpointValidationBinding);
    const checkpointEligibility = rawCheckpointEligibility.eligible
      && nativeDxfCheckpointPayloadComplete(checkpointValue)
      ? rawCheckpointEligibility
      : rawCheckpointEligibility.eligible
        ? {
            eligible: false as const,
            reason: "malformed" as const,
            stage: rawCheckpointEligibility.stage,
          }
        : rawCheckpointEligibility;
    const checkpointCarriesTargetedIntent = Boolean(
      checkpointValue
      && typeof checkpointValue === "object"
      && !Array.isArray(checkpointValue)
      && Object.prototype.hasOwnProperty.call(checkpointValue, "targetedCorrectionIntent"),
    );
    if ((resumeRequested || targetedCorrectionRequested || checkpointCarriesTargetedIntent)
      && !checkpointEligibility.eligible) {
      throw new NativeDxfResumeRejectedError(
        checkpointRow ? checkpointEligibility.reason : "checkpoint_missing",
      );
    }
    const savedCheckpoint = checkpointEligibility.eligible
      && isNativeDxfCheckpointResumeEligible(checkpointValue, checkpointValidationBinding)
      ? checkpointValue
      : null;
    if (
      isNativeDxfTargetedCorrectionBrief(job.repairBrief)
      && isNativeDxfTargetedCorrectionBrief(savedCheckpoint?.targetedCorrectionIntent)
    ) {
      const durableIntent = savedCheckpoint.targetedCorrectionIntent;
      const queuedIntent = job.repairBrief;
      if (
        queuedIntent.sourceRevision !== durableIntent.sourceRevision
        || queuedIntent.targetLanguage !== durableIntent.targetLanguage
        || queuedIntent.requestedAt !== durableIntent.requestedAt
        || queuedIntent.targetIds.length !== durableIntent.targetIds.length
        || queuedIntent.targetIds.some((targetId, index) =>
          targetId !== durableIntent.targetIds[index])
      ) {
        throw new NativeDxfResumeRejectedError("targeted_correction_intent_mismatch");
      }
    }
    // A retry brief is only a queueing hint. Once correction work has been
    // checkpointed, that durable intent is authoritative even if retry
    // metadata was replaced or cleared.
    if (!targetedCorrectionRequested && savedCheckpoint?.targetedCorrectionIntent) {
      targetedCorrectionRequested = true;
    }
    // A mismatched native checkpoint is evidence for a different input or
    // methodology. It is intentionally ignored, never partially merged.
    const checkpointTranslations = savedCheckpoint
      ? nativeDxfTranslationsMap(savedCheckpoint.translations)
      : new Map<string, string>();
    const checkpointAudit = savedCheckpoint?.audit;
    const savedAudit = readNativeDxfSavedAudit(checkpointAudit);
    const checkpointAuditIndex = Number.isInteger(savedCheckpoint?.auditIndex)
      ? savedCheckpoint!.auditIndex!
      : -1;
    // Audit/correction/pre-patch checkpoints already contain the complete
    // post-translation snapshot for that stage.  In particular, an omitted
    // target is durable unresolved evidence, not permission to ask the
    // translator for fresh work on an automatic retry.
    const resumePostTranslationStage = targetedCorrectionRequested
      || savedCheckpoint?.stage === "audit"
      || savedCheckpoint?.stage === "correction"
      || savedCheckpoint?.stage === "pre_patch";
    // A resumed audited snapshot is immutable until a new correction actually
    // changes a translation. Fresh work performs the normal binding sync; a
    // terminal/pre-patch snapshot must not be rewritten merely by resuming.
    let shouldSynchronizeDimensionCache = !resumePostTranslationStage;
    const checkpointCorrectionDiagnostics = Array.isArray(savedCheckpoint?.correctionDiagnostics)
      ? savedCheckpoint!.correctionDiagnostics as Array<{ handle: string; reason: string; pass: number }>
      : [];
    const textEntries = Array.isArray(inventory.textEntries) ? inventory.textEntries : [];
    const unresolvedVisibleText = Array.isArray(inventory.unresolvedVisibleText)
      ? inventory.unresolvedVisibleText : [];
    const dimensionCacheBindings = (Array.isArray(inventory.dimensionCacheBindings)
      ? inventory.dimensionCacheBindings : []).filter((binding: any) =>
      typeof binding?.dimensionTargetId === "string"
      && typeof binding?.cacheTargetId === "string");
    const targets = textEntries.filter((x: any) =>
      x.isCyrillicTarget && x.patchableInDxf === true
      && typeof x.targetId === "string" && typeof x.entityType === "string");
    const rawTableTargets = (Array.isArray(inventory.tableTargets) ? inventory.tableTargets : [])
      .filter((x: any) =>
        typeof x.targetId === "string" && typeof x.tableHandle === "string"
        && typeof x.sourceText === "string" && Number.isInteger(x.sourceOrdinal));
    const tableTargets = dedupeNativeDxfTableTargets(rawTableTargets);
    const groups = (Array.isArray(inventory.splitFragmentGroups)
      ? inventory.splitFragmentGroups : []).filter((group: any) =>
      Array.isArray(group?.handles) && group.handles.every((handle: unknown) =>
        typeof handle === "string"
        && targets.some((entry: any) =>
          entry.entityType === "MTEXT" && entry.handle === handle)));
    const targetById = new Map(targets.map((x: any) => [x.targetId, x]));
    const tableById = new Map(tableTargets.map((x: any) => [x.targetId, x]));
    const mtextByHandle = new Map(targets
      .filter((x: any) => x.entityType === "MTEXT")
      .map((x: any) => [x.handle, x]));
    const isUnitLabel = (item: any) => /^\s*(?:м2|м²|m2|m²)\s*$/iu.test(item.plainText);
    const preservation = targets.filter((x: any) => x.preservedDrawingCodeCandidate && !isUnitLabel(x)).map((x: any) => ({
      targetId: x.targetId, handle: x.handle, source: x.plainText, reason: "drawing_code_candidate: explicit non-language drawing identifier preservation",
    }));
    const preservedTargetIds = new Set<string>(preservation.map((item: any) => item.targetId));
    const translateTargets = targets.filter((x: any) => !x.preservedDrawingCodeCandidate || isUnitLabel(x));
    const allTranslateTargets = [
      ...translateTargets,
      ...tableTargets.map((x: any) => ({
        ...x,
        plainText: x.sourceText,
        rawText: x.sourceText,
        handle: x.tableHandle,
        entityType: "ACAD_TABLE",
      })),
    ];
    const targetedCorrectionBrief = targetedCorrectionRequested
      ? (isNativeDxfTargetedCorrectionBrief(job.repairBrief)
        ? job.repairBrief
        : savedCheckpoint?.targetedCorrectionIntent || null)
      : null;
    if (targetedCorrectionRequested && !targetedCorrectionBrief) {
      throw new NativeDxfResumeRejectedError("targeted_correction_intent_incomplete");
    }
    if (targetedCorrectionBrief && targetedCorrectionBrief.sourceRevision !== job.revisionCount - 1) {
      throw new NativeDxfResumeRejectedError("targeted_correction_revision_mismatch");
    }
    if (targetedCorrectionBrief && targetedCorrectionBrief.targetLanguage !== requestedTargetLanguage) {
      throw new NativeDxfResumeRejectedError("targeted_correction_language_mismatch");
    }
    // The route's target list is evidence-derived, but prove it again from the
    // predecessor envelope after every source inspection. This check occurs
    // before the first correction provider request.
    if (targetedCorrectionBrief && !checkpointIsCurrentRevision) {
      // Patch-fit findings are recorded on the active review page after the
      // pre-patch checkpoint was saved, so include that durable page evidence
      // in the same allow-list. It is still intersected with the predecessor
      // ledger's immutable target inventory by the helper.
      const correctionPages = await db.select({
        machineAuditFindings: cworksTranslationPages.machineAuditFindings,
      }).from(cworksTranslationPages).where(eq(cworksTranslationPages.jobId, job.id));
      const evidenceTargetIds = new Set(nativeDxfTargetedCorrectionTargetIds(
        savedCheckpoint,
        correctionPages.map((page) => page.machineAuditFindings),
      ));
      if (targetedCorrectionBrief.targetIds.some((targetId) =>
        !evidenceTargetIds.has(targetId)
        || (!targetById.has(targetId) && !tableById.has(targetId)))) {
        throw new NativeDxfResumeRejectedError("targeted_correction_target_mismatch");
      }
      if (!readNativeDxfSavedAudit(savedCheckpoint?.audit)) {
        throw new NativeDxfResumeRejectedError("targeted_correction_audit_evidence_missing");
      }
    }
    if (targetedCorrectionBrief) {
      // Consent is an immutable list of source targets, not a promise that
      // every listed target remains translatable.  In particular, a later
      // parser policy can classify a source-bound drawing code as protected.
      // It must still be present and patchable in the inspected source; it is
      // accounted for below as explicitly preserved rather than being silently
      // dropped or treated as permission to translate it.
      const sourcePatchableTargetIds = new Set([
        ...targets.map((item: any) => item.targetId),
        ...tableTargets.map((item: any) => item.targetId),
      ]);
      if (targetedCorrectionBrief.targetIds.some((targetId) => !sourcePatchableTargetIds.has(targetId))) {
        throw new NativeDxfResumeRejectedError("targeted_correction_targets_unusable");
      }
    }
    let translations = new Map<string, string>(checkpointTranslations);
    if (!savedCheckpoint && job.revisionCount > 0 && job.ledgerStoredName) {
      const priorLedger = await readOptionalNativeDxfPriorLedger(
        () => readObject(job.ledgerStoredName!),
      );
      if (priorLedger) {
        translations = reusableNativeDxfTranslations(
          priorLedger, inventory, requestedTargetLanguage,
        );
      }
    }
    // Current parser classification is authoritative. A prior revision may
    // predate identifier protection and contain a transliteration for a handle
    // now required to remain byte-for-byte intact.
    if (!resumePostTranslationStage) {
      removeNativeDxfPreservedTranslations(translations, preservedTargetIds);
    }
    const reusedTranslationCount = translations.size;
    const initialTranslationTargets = resumePostTranslationStage
      ? []
      : allTranslateTargets.filter((item: any) => !translations.has(item.targetId));
    const freshTokenEstimate = Math.ceil(
      initialTranslationTargets.reduce((sum: number, item: any) => sum + item.plainText.length, 0) / 3,
    ) + initialTranslationTargets.length * 24;
    let tokenEstimate = resumePostTranslationStage
      ? Number(checkpointRow?.tokenEstimate) || freshTokenEstimate
      : freshTokenEstimate;
    await updateClaimed(job, {
      progress: 22,
      progressNote: resumePostTranslationStage
        ? `Resuming saved ${savedCheckpoint!.stage} snapshot; retaining ${reusedTranslationCount} exact translations and recorded unresolved targets`
        : reusedTranslationCount
          ? `Reused ${reusedTranslationCount} source-bound translations; translating ${initialTranslationTargets.length} missing safe text/table targets`
          : `Translating ${initialTranslationTargets.length} safe native DXF text/table targets in contextual batches`,
      tokenEstimate,
      costEstimate: ((tokenEstimate / 1_000_000) * 9).toFixed(4),
    });
    let targetedCorrectionNeedsAudit = Boolean(
      targetedCorrectionBrief
      && (!checkpointIsCurrentRevision
        || (savedCheckpoint as any)?.targetedCorrectionPendingReaudit === true),
    );
    const targetedCorrectionDiagnostics: Array<{ handle: string; reason: string; pass: number }> = [];
    const completedTargetedCorrectionIds = new Set(
      Array.isArray((savedCheckpoint as any)?.targetedCorrectionCompletedTargetIds)
        ? (savedCheckpoint as any).targetedCorrectionCompletedTargetIds.filter(
          (targetId: unknown): targetId is string => typeof targetId === "string",
        )
        : [],
    );
    const targetedCorrectionCompletionReasons = new Map(
      Object.entries((savedCheckpoint as any)?.targetedCorrectionCompletionReasons || {})
        .filter(([, reason]) => typeof reason === "string" && Boolean(reason.trim())) as Array<[string, string]>,
    );
    const targetedCheckpointState = (pendingReaudit: boolean) => targetedCorrectionBrief ? ({
      targetedCorrectionIntent: targetedCorrectionBrief,
      targetedCorrectionPendingReaudit: pendingReaudit,
      targetedCorrectionCompletedTargetIds: [...completedTargetedCorrectionIds].sort(),
      targetedCorrectionCompletionReasons: Object.fromEntries(
        [...targetedCorrectionCompletionReasons.entries()].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0),
      ),
    }) : {};
    // A consent may legitimately name a patchable text target that is now
    // classified as an exact drawing identifier. Do not discard that consent
    // or send the identifier to a provider. Remove any predecessor-era
    // replacement, then durably account for this correction attempt as an
    // explicit preservation. This makes a retry of the same successor safe:
    // it reuses the saved completion state instead of demanding a new revision
    // or spending another correction pass.
    if (targetedCorrectionBrief) {
      for (const targetId of targetedCorrectionBrief.targetIds) {
        const item: any = targetById.get(targetId);
        if (!item || !item.preservedDrawingCodeCandidate || isUnitLabel(item)) continue;
        translations.delete(targetId);
        completedTargetedCorrectionIds.add(targetId);
        targetedCorrectionCompletionReasons.set(
          targetId,
          "explicitly_preserved_drawing_code_not_sent_to_provider",
        );
      }
    }
    const targetedCorrectionStillPending = Boolean(
      targetedCorrectionBrief
      && targetedCorrectionBrief.targetIds.some((targetId) => !completedTargetedCorrectionIds.has(targetId)),
    );
    if (targetedCorrectionBrief && targetedCorrectionStillPending) {
      // One consented correction pass, deliberately bounded by the revision
      // brief. Split fragments must travel together; a dimension cache is not
      // sent separately because its dimension override is authoritative.
      const originalPendingIds = targetedCorrectionBrief.targetIds.filter((targetId) =>
        !completedTargetedCorrectionIds.has(targetId));
      const effectiveIdByOriginalId = new Map(originalPendingIds.map((targetId) => [targetId, targetId]));
      const correctionIds = new Set(originalPendingIds);
      for (const group of groups) {
        const memberIds = group.handles.map((handle: string) =>
          (mtextByHandle.get(handle) as any)?.targetId).filter(Boolean);
        if (memberIds.some((targetId: string) => correctionIds.has(targetId))) {
          memberIds.forEach((targetId: string) => correctionIds.add(targetId));
        }
      }
      for (const binding of dimensionCacheBindings) {
        if (correctionIds.has(binding.cacheTargetId)) {
          correctionIds.delete(binding.cacheTargetId);
          correctionIds.add(binding.dimensionTargetId);
          effectiveIdByOriginalId.set(binding.cacheTargetId, binding.dimensionTargetId);
        }
      }
      const correctionItems = [...correctionIds].map((targetId) =>
        targetById.get(targetId) || tableById.get(targetId))
        .filter((item: any) => item && (!item.preservedDrawingCodeCandidate || isUnitLabel(item)));
      if (!correctionItems.length) {
        throw new NativeDxfResumeRejectedError("targeted_correction_targets_unusable");
      }
      const correctionPending = new Set(correctionItems.map((item: any) => item.targetId));
      const correctionUnits: any[][] = [];
      for (const group of groups) {
        const members = group.handles.map((handle: string) => mtextByHandle.get(handle))
          .filter((item: any) => item && correctionPending.has(item.targetId));
        if (members.length) {
          correctionUnits.push(members);
          members.forEach((item: any) => correctionPending.delete(item.targetId));
        }
      }
      for (const item of correctionItems) {
        if (correctionPending.has(item.targetId)) correctionUnits.push([item]);
      }
      const correctionWireTargetIds = (candidate: any[]): ReadonlyMap<string, string> =>
        new Map(candidate.map((item: any, index: number) => [item.targetId, `t${index + 1}`]));
      const splitCorrectionBatch = (candidate: any[]): [any[], any[]] => {
        const candidateIds = new Set(candidate.map((item: any) => item.targetId));
        const units: any[][] = [];
        const groupedIds = new Set<string>();
        for (const group of groups) {
          const members = group.handles
            .map((handle: string) => mtextByHandle.get(handle))
            .filter((item: any) => item && candidateIds.has(item.targetId));
          if (!members.length) continue;
          units.push(members);
          members.forEach((item: any) => groupedIds.add(item.targetId));
        }
        for (const item of candidate) {
          if (!groupedIds.has(item.targetId)) units.push([item]);
        }
        if (units.length < 2) {
          const midpoint = Math.ceil(candidate.length / 2);
          return [candidate.slice(0, midpoint), candidate.slice(midpoint)];
        }
        const midpoint = Math.ceil(units.length / 2);
        return [units.slice(0, midpoint).flat(), units.slice(midpoint).flat()];
      };
      for (const correctionBatch of boundedNativeDxfBatches(correctionUnits)) {
        const targetedBatchReasons = new Map<string, string>();
        const persistedCorrectionTargetIds = new Set<string>();
        setDiagnosticContext("translate", "translation_provider");
        const rows = await requestNativeDxfTranslationRowsWithBoundedSubdivision(
          correctionBatch,
          async (candidate, _candidateTargetIds, wireTargetIds) => {
            setDiagnosticContext("translate", "translation_provider");
            return requestCworksProviderWithRetry(
              (signal) => askTranslator([
                "Correct only these consented, audit-affected native DXF text/table targets.",
                "Return JSON only {\"translations\":[{\"targetId\":\"...\",\"translation\":\"...\"}]}; include every supplied short targetId exactly once, non-empty, and do not invent IDs.",
                `Use concise engineering ${requestedTargetName}; preserve dimension placeholders and exact protected technical identifiers.`,
                `targets: ${JSON.stringify(candidate.map((item: any) => ({
                  targetId: wireTargetIds!.get(item.targetId),
                  entityType: item.entityType || "ACAD_TABLE",
                  handle: item.handle || item.tableHandle,
                  source: item.plainText || item.sourceText,
                  currentReplacement: translations.get(item.targetId) || "",
                  maxCharacters: (item.plainText || item.sourceText).length,
                })))}`,
              ].join("\n"), job.id, 8192, signal, { nativeDxfJsonResponse: true }),
              { quarantineKey: job.id, includeProviderMessageInLogs: false },
            );
          },
          async (candidate, candidateTargetIds, malformedResponse, wireTargetIds) => {
            setDiagnosticContext("translate", "translation_provider");
            return requestCworksProviderWithRetry(
              (signal) => askTranslator([
                "Repair this malformed native DXF correction response into ONLY the required JSON object.",
                "Return every supplied targetId exactly once with a non-empty translation; do not invent IDs.",
                `Allowed targetIds: ${JSON.stringify([...candidateTargetIds])}`,
                `Original sources: ${JSON.stringify(candidate.map((item: any) => ({
                  targetId: wireTargetIds?.get(item.targetId) || item.targetId,
                  source: item.plainText ?? item.sourceText,
                  maxCharacters: item.plainText?.length ?? item.sourceText?.length,
                })))}`,
                `Malformed response: ${malformedResponse}`,
              ].join("\n"), job.id, 8192, signal, { nativeDxfJsonResponse: true }),
              { quarantineKey: job.id, includeProviderMessageInLogs: false },
            );
          },
          splitCorrectionBatch,
          async (subRows, complete) => {
            if (complete) return;
            const subBatchTargetIds = new Set(subRows.map((row) => row.targetId));
            for (const row of subRows) {
              const sourceItem: any = targetById.get(row.targetId) || tableById.get(row.targetId);
              if (
                isNativeDxfTargetLanguageText(
                  sourceItem?.plainText ?? sourceItem?.sourceText,
                  row.translation,
                  requestedTargetLanguage,
                )
                && nativeDxfReplacementPreservesPlaceholder(
                  sourceItem?.rawText ?? sourceItem?.plainText ?? sourceItem?.sourceText,
                  row.translation,
                )
              ) {
                translations.set(row.targetId, row.translation);
              } else {
                targetedCorrectionDiagnostics.push({
                  handle: sourceItem?.handle || sourceItem?.tableHandle || row.targetId,
                  reason: "Targeted correction returned an invalid target-language or placeholder-changing replacement.",
                  pass: 1,
                });
                targetedBatchReasons.set(
                  row.targetId,
                  "provider_attempt_consumed_invalid_replacement_retained",
                );
              }
              persistedCorrectionTargetIds.add(row.targetId);
            }
            synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
            for (const [originalId, effectiveId] of effectiveIdByOriginalId) {
              if (!subBatchTargetIds.has(effectiveId)) continue;
              completedTargetedCorrectionIds.add(originalId);
              const isSplitMember = groups.some((group: any) => group.handles.some((handle: string) =>
                (mtextByHandle.get(handle) as any)?.targetId === originalId));
              targetedCorrectionCompletionReasons.set(
                originalId,
                originalId === effectiveId
                  ? (targetedBatchReasons.get(originalId)
                    || (isSplitMember
                      ? "provider_attempt_consumed_with_required_split_fragment_context"
                      : "provider_attempt_consumed"))
                  : "provider_attempt_consumed_via_authoritative_dimension_cache_sync",
              );
            }
            await saveCheckpoint(
              buildNativeDxfCheckpoint(checkpointBinding, {
                stage: "correction",
                completedBatchCount: savedCheckpoint?.completedBatchCount ?? 0,
                translations: nativeDxfTranslationsRecord(translations),
                audit: savedAudit!,
                auditIndex: Math.max(0, checkpointAuditIndex),
                correctionDiagnostics: [
                  ...checkpointCorrectionDiagnostics,
                  ...targetedCorrectionDiagnostics,
                ],
                ...targetedCheckpointState(true),
              }),
              {
                progress: 46,
                progressNote: "Saved targeted correction subdivision before completing its bounded batch",
                tokenEstimate,
              },
            );
          },
          correctionWireTargetIds,
        );
        for (const row of rows) {
          const targetId = row.targetId;
          if (persistedCorrectionTargetIds.has(targetId)) continue;
          const sourceItem: any = targetById.get(targetId) || tableById.get(targetId);
          if (
            !isNativeDxfTargetLanguageText(
              sourceItem?.plainText ?? sourceItem?.sourceText,
              row.translation,
              requestedTargetLanguage,
            )
            || !nativeDxfReplacementPreservesPlaceholder(
              sourceItem?.rawText ?? sourceItem?.plainText ?? sourceItem?.sourceText,
              row.translation,
            )
          ) {
            targetedCorrectionDiagnostics.push({
              handle: sourceItem?.handle || sourceItem?.tableHandle || targetId,
              reason: "Targeted correction returned an invalid target-language or placeholder-changing replacement.",
              pass: 1,
            });
            targetedBatchReasons.set(
              targetId,
              "provider_attempt_consumed_invalid_replacement_retained",
            );
            continue;
          }
          translations.set(targetId, row.translation);
        }
        // A batch checkpoint makes an interrupted 742-item correction resume
        // from exact saved work, not from an accidental fresh correction pass.
        synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
        const batchTargetIds = new Set(correctionBatch.map((item: any) => item.targetId));
        for (const [originalId, effectiveId] of effectiveIdByOriginalId) {
          if (!batchTargetIds.has(effectiveId)) continue;
          completedTargetedCorrectionIds.add(originalId);
          const isSplitMember = groups.some((group: any) => group.handles.some((handle: string) =>
            (mtextByHandle.get(handle) as any)?.targetId === originalId));
          targetedCorrectionCompletionReasons.set(
            originalId,
            originalId === effectiveId
              ? (targetedBatchReasons.get(originalId)
                || (isSplitMember
                ? "provider_attempt_consumed_with_required_split_fragment_context"
                : "provider_attempt_consumed"))
              : "provider_attempt_consumed_via_authoritative_dimension_cache_sync",
          );
        }
        await saveCheckpoint(
          buildNativeDxfCheckpoint(checkpointBinding, {
            stage: "correction",
            completedBatchCount: savedCheckpoint?.completedBatchCount ?? 0,
            translations: nativeDxfTranslationsRecord(translations),
            audit: savedAudit!,
            auditIndex: Math.max(0, checkpointAuditIndex),
            correctionDiagnostics: [
              ...checkpointCorrectionDiagnostics,
              ...targetedCorrectionDiagnostics,
            ],
            ...targetedCheckpointState(true),
          }),
          {
            progress: 46,
            progressNote: `Saved consented targeted native DXF correction batch before complete re-audit`,
            tokenEstimate,
          },
        );
      }
      tokenEstimate += Math.ceil(correctionItems.reduce((sum: number, item: any) =>
        sum + String(item.plainText ?? item.sourceText ?? "").length, 0) / 3)
        + correctionItems.length * 24;
      shouldSynchronizeDimensionCache = true;
      targetedCorrectionNeedsAudit = true;
    }
    // Batches retain deterministic handle ordering and explicit group membership,
    // so a hyphen continuation is never silently treated as unrelated text.
    const groupedHandles = new Set<string>();
    const units: any[][] = [];
    if (!resumePostTranslationStage) {
      for (const group of groups) {
        const members = group.handles.map((handle: string) => mtextByHandle.get(handle))
          .filter((item: any) => item
            && (!item.preservedDrawingCodeCandidate || isUnitLabel(item))
            && !translations.has(item.targetId));
        if (members.length) {
          units.push(members);
          members.forEach((item: any) => groupedHandles.add(item.targetId));
        }
      }
      for (const item of initialTranslationTargets) {
        if (!groupedHandles.has(item.targetId)) units.push([item]);
      }
    }
    const batches = boundedNativeDxfBatches(units);
    const checkpointCompletedBatchCount = resumePostTranslationStage
      ? savedCheckpoint?.completedBatchCount ?? 0
      : batches.length;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const buildTranslationPrompt = (
        candidate: any[],
        candidateTargetIds: ReadonlySet<string>,
        wireTargetIds?: ReadonlyMap<string, string>,
      ) => {
        const wireTargetId = (immutableTargetId: string, handle?: string) =>
          wireTargetIds?.get(immutableTargetId)
          // A pre-translated split member is context only, never an allowed
          // response key. Keep its stable handle useful without leaking an
          // internal long target id into the wire protocol.
          || (wireTargetIds ? `prior:${handle || "unknown"}` : immutableTargetId);
        const candidateMtextHandles = new Set(candidate
          .filter((x: any) => x.entityType === "MTEXT").map((x: any) => x.handle));
        const candidateGroups = groups
          .filter((g: any) => g.handles.some((h: string) => candidateMtextHandles.has(h)))
          .map((g: any) => ({
            ...g,
            currentReplacements: g.handles.map((handle: string) => ({
              targetId: wireTargetId(
                (mtextByHandle.get(handle) as any)?.targetId,
                handle,
              ),
              handle,
              replacement: translations.get((mtextByHandle.get(handle) as any)?.targetId) || null,
              requestedNow: candidateMtextHandles.has(handle),
            })),
          }));
        return [
          `Translate each Russian DXF safe text or table source to concise engineering ${requestedTargetName}. Every replacement must be at or below maxCharacters where possible; use standard concise construction terminology rather than expanding labels.`,
          `Return JSON only: {"translations":[{"targetId":"exact supplied targetId","translation":"${requestedTargetName}"}]}.`,
          requestedTargetLanguage === "ja"
            ? "Every replacement must contain Japanese script (kanji, hiragana, or katakana). English-only output is invalid."
            : "",
          "Every supplied targetId is a short transport key mapped locally to an immutable DXF target. Copy it byte-for-byte exactly once; do not invent, alter, or omit a key. Do not preserve unit labels.",
          requestedTargetLanguage === "en" ? NATIVE_DXF_TRANSLATION_GLOSSARY : "",
          "For each splitFragmentGroups chain, reconstruct the word, translate it once, then distribute non-empty sequential fragments across every member so concatenating member replacements yields that one translation exactly once. Never duplicate the full translated word on each handle.",
          `splitFragmentGroups: ${JSON.stringify(candidateGroups)}`,
          `targets: ${JSON.stringify(candidate.map((x: any) => ({ targetId: wireTargetId(x.targetId, x.handle), entityType: x.entityType, handle: x.handle, source: x.plainText, raw: x.rawText, layer: x.layer, maxCharacters: x.plainText.length })))}`,
        ].join("\n");
      };
      const wireTargetIdsForBatch = (candidate: any[]): ReadonlyMap<string, string> =>
        new Map(candidate.map((item: any, index) => [item.targetId, `t${index + 1}`]));
      const splitBatch = (candidate: any[]): [any[], any[]] => {
        const candidateIds = new Set(candidate.map((item: any) => item.targetId));
        const splitUnits: any[][] = [];
        const groupedIds = new Set<string>();
        for (const group of groups) {
          const members = group.handles
            .map((handle: string) => mtextByHandle.get(handle))
            .filter((item: any) => item && candidateIds.has(item.targetId));
          if (!members.length) continue;
          splitUnits.push(members);
          members.forEach((item: any) => groupedIds.add(item.targetId));
        }
        for (const item of candidate) {
          if (!groupedIds.has(item.targetId)) splitUnits.push([item]);
        }
        if (splitUnits.length < 2) {
          const midpoint = Math.ceil(candidate.length / 2);
          return [candidate.slice(0, midpoint), candidate.slice(midpoint)];
        }
        const midpoint = Math.ceil(splitUnits.length / 2);
        return [
          splitUnits.slice(0, midpoint).flat(),
          splitUnits.slice(midpoint).flat(),
        ];
      };
      setDiagnosticContext("translate", "translation_provider");
      const rows = await requestNativeDxfTranslationRowsWithBoundedSubdivision(
        batch,
        async (candidate, candidateTargetIds, wireTargetIds) => requestCworksProviderWithRetry(
          (signal) => askTranslator(
            buildTranslationPrompt(candidate, candidateTargetIds, wireTargetIds),
            job.id,
            8192,
            signal,
            { nativeDxfJsonResponse: true },
          ),
          { quarantineKey: job.id, includeProviderMessageInLogs: false },
        ),
        async (candidate, candidateTargetIds, malformedResponse, wireTargetIds) =>
          requestCworksProviderWithRetry(
            (signal) => askTranslator([
              "Repair this malformed native DXF translation response into ONLY the required JSON object.",
              "Return {\"translations\":[{\"targetId\":\"exact supplied targetId\",\"translation\":\"non-empty translation\"}]}.",
              "Do not invent or alter targetIds. Include only targetIds from the allowed list.",
              `Allowed targetIds: ${JSON.stringify([...candidateTargetIds])}`,
              `Original sources: ${JSON.stringify(candidate.map((item: any) => ({
                targetId: wireTargetIds?.get(item.targetId) || item.targetId,
                source: item.plainText ?? item.sourceText,
                maxCharacters: item.plainText?.length ?? item.sourceText?.length,
              })))}`,
              `Malformed response: ${malformedResponse}`,
            ].join("\n"), job.id, 8192, signal, { nativeDxfJsonResponse: true }),
            { quarantineKey: job.id, includeProviderMessageInLogs: false },
          ),
        splitBatch,
        async (subRows, complete) => {
          for (const row of subRows) translations.set(row.targetId, row.translation);
          await saveCheckpoint(
            buildNativeDxfCheckpoint(checkpointBinding, {
              stage: "translation_batch",
              // A partial subdivision is intentionally recorded as the number
              // of fully completed outer batches (not as a false completion).
              completedBatchCount: complete ? batchIndex + 1 : batchIndex,
              translations: nativeDxfTranslationsRecord(translations),
            }),
            {
              progress: complete
                ? 22 + Math.round(((batchIndex + 1) / Math.max(batches.length, 1)) * 25)
                : 22 + Math.round((batchIndex / Math.max(batches.length, 1)) * 25),
              progressNote: complete
                ? `Saved native DXF translation batch ${batchIndex + 1} of ${batches.length}`
                : `Saved native DXF translation subdivision before completing batch ${batchIndex + 1}`,
              tokenEstimate,
            },
          );
        },
        wireTargetIdsForBatch,
      );
    }
    // Deterministic terminology is established before ledger creation and is
    // still independently audited and geometry-checked by the native patcher.
    if (!resumePostTranslationStage) {
      if (requestedTargetLanguage === "en") {
        applyNativeDxfExactGlossary(targets.map((x: any) => ({ ...x, plain: x.plainText })), translations);
        applyNativeDxfSplitGlossary(targets.map((x: any) => ({ ...x, plain: x.plainText })), groups, translations);
        applyNativeDxfContextPairGlossary(targets, translations);
      }
      synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
      for (const [targetId, replacement] of translations) {
        const sourceItem: any = targetById.get(targetId) || tableById.get(targetId);
        if (!isNativeDxfTargetLanguageText(
          sourceItem?.plainText ?? sourceItem?.sourceText,
          replacement,
          requestedTargetLanguage,
        ) || !nativeDxfReplacementPreservesPlaceholder(
          sourceItem?.rawText ?? sourceItem?.plainText ?? sourceItem?.sourceText,
          replacement,
        )) translations.delete(targetId);
      }
      synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
      removeNativeDxfPreservedTranslations(translations, preservedTargetIds);
    }
    let unresolved = allTranslateTargets.filter((x: any) => !translations.has(x.targetId))
      .map((x: any) => ({
        targetId: x.targetId, handle: x.handle, entityType: x.entityType,
        reason: "missing_translation",
      }));
    const ledger: any = {
      ...(resumePostTranslationStage
        && savedCheckpoint?.ledger
        && typeof savedCheckpoint.ledger === "object"
        && !Array.isArray(savedCheckpoint.ledger)
        ? JSON.parse(JSON.stringify(savedCheckpoint.ledger))
        : {}),
      format: "cworks-native-dxf-ledger-v1", targetLanguage: requestedTargetLanguage,
      sourceSha256: inventory.sha256,
      placementManifestSha256: inventory.placementManifestSha256,
      placementCount: inventory.placementCount,
      splitFragmentGroups: groups,
      dimensionCacheBindings,
      unresolvedVisibleText,
      entries: textEntries.map((x: any) => ({
        targetId: x.targetId, entityType: x.entityType,
        handle: x.handle, source: x.rawText, plain: x.plainText, maxCharacters: x.plainText.length, isCyrillicTarget: x.isCyrillicTarget && x.patchableInDxf === true,
        definitionBlock: x.definitionBlock || null,
        placementCount: Number.isInteger(x.placementCount) ? x.placementCount : 1,
        placements: Array.isArray(x.placements) ? x.placements : [],
        replacement: translations.get(x.targetId) || null,
        accounting: !(x.isCyrillicTarget && x.patchableInDxf === true) ? "non_target"
          : translations.has(x.targetId) ? "translated_pending_patch"
            : preservation.some((p: any) => p.targetId === x.targetId) ? "preserved" : "unresolved",
        preservationReason: translations.has(x.targetId)
          ? nativeDxfEmbeddedTechnicalIdentifierReason(
              x.plainText,
              translations.get(x.targetId),
              requestedTargetLanguage,
            )
          : preservation.find((p: any) => p.targetId === x.targetId)?.reason || null,
      })),
      tableTargets: tableTargets.map((x: any) => ({
        targetId: x.targetId,
        tableHandle: x.tableHandle,
        sourceOrdinal: x.sourceOrdinal,
         sourceOccurrenceCount: x.sourceOccurrenceCount,
        source: x.sourceText,
        sourceSha256: createHash("sha256").update(x.sourceText).digest("hex"),
        translation: translations.get(x.targetId) || null,
        accounting: translations.has(x.targetId)
          ? "translated_pending_table_script" : "unresolved",
      })),
      unresolved,
      hybridCoverage: {
        pendingTableTargetCount: 0,
        pendingTableCellCount: 0,
        unresolvedVisibleTextCount: unresolvedVisibleText.length,
        opaqueReviewRequired: Boolean(inventory.highRiskScan?.findings?.length),
        unplacedTargetCount: translateTargets.filter((entry: any) =>
          Math.max(0, Number(entry.placementCount) || 0) === 0).length,
      },
      manualRequirements: {
        kind: "source-bound-table-application",
        explicitConfirmationRequired: true,
        derivativeExtension: ".dwg",
        unicodeLispsysRequired: true,
        windowsActiveXRequired: true,
        sourceSha256: inventory.sha256,
        placementManifestSha256: inventory.placementManifestSha256,
        targets: tableTargets.map((target: any) => ({
          targetId: target.targetId,
          tableHandle: target.tableHandle,
          sourceSha256: createHash("sha256").update(target.sourceText).digest("hex"),
          sourceOccurrenceCount: target.sourceOccurrenceCount,
        })),
      },
    };
    const rebuildTableScript = () => {
      ledger.tableScript = buildNativeDxfTableScript(ledger.tableTargets
        .filter((entry: any) => typeof entry.translation === "string")
        .map((entry: any) => ({
          targetId: entry.targetId,
          tableHandle: entry.tableHandle,
          sourceOrdinal: entry.sourceOrdinal,
           sourceOccurrenceCount: entry.sourceOccurrenceCount,
          source: entry.source,
          translation: entry.translation,
        })));
    };
    rebuildTableScript();
    // A separate OpenAI provider audits source/plain/replacement/group/accounting;
    // it is deliberately not the translation provider.
    await updateClaimed(job, { progress: 56, progressNote: "Running independent DXF source, replacement, and accounting audit" });
    const runAudit = async (auditPayload: string) => {
      setDiagnosticContext("audit", "audit_provider");
      const raw = await requestCworksProviderWithRetry(async (signal) => {
        if (options.askAuditor) return options.askAuditor(auditPayload, signal);
        const response = await getCworksIndependentAuditor().chat.completions.create({
          model: MACHINE_AUDIT_MODEL, max_completion_tokens: 8192, response_format: { type: "json_object" },
           messages: [{ role: "system", content: nativeDxfAuditPolicy(requestedTargetLanguage) },
            { role: "user", content: auditPayload }],
        }, { signal });
        const content = response.choices[0]?.message?.content?.trim();
        if (!content) {
          throw Object.assign(new Error("Independent native DXF auditor returned an empty response"), {
            code: "EMPTY_RESPONSE",
          });
        }
        return content;
      }, {
        quarantineKey: job.id,
        includeProviderMessageInLogs: false,
      });
      return parseCworksMachineAudit(raw, 1);
    };
    let audit: CworksPageMachineAudit = savedAudit || {
      pageNumber: 1, status: "findings", model: MACHINE_AUDIT_MODEL,
      findings: [{ type: "unreadable", message: "Native DXF audit did not run." }],
    };
    let correctionDiagnostics: Array<{ handle: string; reason: string; pass: number }> =
      [...checkpointCorrectionDiagnostics, ...targetedCorrectionDiagnostics];
    const checkpointHasTerminalAudit = Boolean(
      savedCheckpoint
      && !targetedCorrectionNeedsAudit
      && (
        savedCheckpoint.stage === "pre_patch"
        || (["audit", "correction"].includes(savedCheckpoint.stage)
          && audit.status === "passed")
        || (savedCheckpoint.stage === "audit"
          && audit.status === "findings"
          && checkpointAuditIndex >= 2)
      )
      && savedAudit,
    );
    let resumeSavedAuditFindings = Boolean(
      savedCheckpoint?.stage === "audit"
      && checkpointAuditIndex >= 0
      && checkpointAuditIndex < 2
      && audit.status === "findings",
    );
    const firstAuditIndex = checkpointHasTerminalAudit
      ? 3
      : targetedCorrectionNeedsAudit
        ? 0
      : savedCheckpoint?.stage === "correction"
        ? Math.max(0, checkpointAuditIndex + 1)
        : savedCheckpoint?.stage === "audit"
          ? Math.max(0, checkpointAuditIndex)
          : 0;
    let lastAuditIndex = Math.max(0, checkpointAuditIndex);
    // The correction revision has a deliberate budget of one correction pass.
    // It does still audit every ledger chunk once, rather than narrowing the
    // independent audit to the corrected IDs.
    const auditLimit = targetedCorrectionNeedsAudit ? 1 : 3;
    for (let auditIndex = firstAuditIndex; auditIndex < auditLimit; auditIndex++) {
      lastAuditIndex = auditIndex;
      // Exact standard drawing-title terminology is deterministic, but remains
      // subject to the same independent audit as every provider translation.
      if (!resumePostTranslationStage) {
        if (requestedTargetLanguage === "en") {
          applyNativeDxfExactGlossary(ledger.entries, translations);
          applyNativeDxfSplitGlossary(ledger.entries, groups, translations);
          applyNativeDxfContextPairGlossary(ledger.entries, translations);
        }
        synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
        for (const [targetId, replacement] of translations) {
          const sourceItem: any = targetById.get(targetId) || tableById.get(targetId);
          if (!isNativeDxfTargetLanguageText(
            sourceItem?.plainText ?? sourceItem?.sourceText,
            replacement,
            requestedTargetLanguage,
          ) || !nativeDxfReplacementPreservesPlaceholder(
            sourceItem?.rawText ?? sourceItem?.plainText ?? sourceItem?.sourceText,
            replacement,
          )) translations.delete(targetId);
        }
        synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
        removeNativeDxfPreservedTranslations(translations, preservedTargetIds);
      } else if (shouldSynchronizeDimensionCache) {
        synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
      }
      synchronizeNativeDxfLedgerEntries(
        ledger.entries,
        translations,
        preservedTargetIds,
        requestedTargetLanguage,
      );
      for (const entry of ledger.tableTargets) {
        entry.translation = translations.get(entry.targetId) || null;
        entry.accounting = entry.translation
          ? "translated_pending_table_script" : "unresolved";
      }
      rebuildTableScript();
      unresolved = allTranslateTargets.filter((x: any) => !translations.has(x.targetId))
        .map((x: any) => ({
          targetId: x.targetId, handle: x.handle, entityType: x.entityType,
          reason: "missing_translation",
        }));
      ledger.unresolved = unresolved;
      ledger.correctionDiagnostics = correctionDiagnostics;
      if (checkpointHasTerminalAudit) break;
      if (resumeSavedAuditFindings) {
        // The prior audit was durably saved immediately before its correction
        // pass. Continue with that finding set without paying for it twice.
        resumeSavedAuditFindings = false;
      } else {
        const auditPayloads = buildNativeDxfAuditPayloadChunks(ledger);
        const chunkAudits: CworksPageMachineAudit[] = [];
        for (const auditPayload of auditPayloads) {
          await updateClaimed(job, {
            progress: auditIndex === 0 ? 56 : 62 + auditIndex * 5,
            progressNote: `Independent native DXF audit ${auditIndex + 1} of 3 — batch ${chunkAudits.length + 1} of ${auditPayloads.length}`,
          });
          chunkAudits.push(await runAudit(JSON.stringify({
            requiredTargetLanguage: requestedTargetName,
            scriptRequirement: requestedTargetLanguage === "ja"
              ? "Every translated replacement must contain Japanese script; reject English-only output."
              : "English output is required, except exact explicitly preserved technical identifiers.",
            ledger: JSON.parse(auditPayload),
          })));
        }
        const combinedFindings = chunkAudits.flatMap((chunkAudit) => chunkAudit.findings);
        audit = {
          pageNumber: 1,
          status: combinedFindings.length ? "findings" : "passed",
          model: MACHINE_AUDIT_MODEL,
          findings: combinedFindings,
        };
        await saveCheckpoint(
          buildNativeDxfCheckpoint(checkpointBinding, {
            stage: "audit",
            completedBatchCount: checkpointCompletedBatchCount,
            translations: nativeDxfTranslationsRecord(translations),
            audit,
            auditIndex,
            correctionDiagnostics,
            ...targetedCheckpointState(false),
          }),
          {
            progress: audit.status === "passed" ? 70 : 58 + auditIndex * 5,
            progressNote: `Saved native DXF audit ${auditIndex + 1} of 3 before any correction`,
            tokenEstimate,
            warningCount: audit.findings.length,
          },
        );
      }
      if (
        audit.status === "passed"
        || audit.findings.length === 0
        || auditIndex === auditLimit - 1
        || targetedCorrectionRequested
      ) break;
      const actionable = audit.findings.filter((finding) =>
        finding.sourceBlockId
        && (targetById.has(finding.sourceBlockId) || tableById.has(finding.sourceBlockId)));
      if (!actionable.length) break;
      const correctionPass = auditIndex + 1;
      await updateClaimed(job, {
        progress: 59 + correctionPass * 5,
        progressNote: `Applying audit-directed native DXF correction pass ${correctionPass} of 2`,
      });
      const correctionHandles = new Set<string>();
      for (const finding of actionable) {
        correctionHandles.add(finding.sourceBlockId!);
        const findingEntry: any = targetById.get(finding.sourceBlockId!);
        for (const group of groups) if (findingEntry?.entityType === "MTEXT"
          && group.handles.includes(findingEntry.handle)) {
          group.handles.forEach((handle: string) => {
            const member: any = mtextByHandle.get(handle);
            if (member) correctionHandles.add(member.targetId);
          });
        }
      }
      const correctionItems = [...correctionHandles].map((targetId) =>
        targetById.get(targetId) || tableById.get(targetId))
      .filter((item: any) => item && (!item.preservedDrawingCodeCandidate || isUnitLabel(item)));
      const correctionItemIds = new Set(correctionItems.map((item: any) => item.targetId));
      const corrected = new Set<string>();
      let correctionChanged = false;
      const correctionUnits: any[][] = [];
      const correctionPending = new Set(correctionItems.map((item: any) => item.targetId));
      for (const group of groups) {
        const members = group.handles.map((handle: string) => mtextByHandle.get(handle))
          .filter((item: any) => item && correctionPending.has(item.targetId));
        if (members.length) {
          correctionUnits.push(members);
          members.forEach((item: any) => correctionPending.delete(item.targetId));
        }
      }
      for (const item of correctionItems) {
        if (correctionPending.has(item.targetId)) correctionUnits.push([item]);
      }
      for (const correctionBatch of boundedNativeDxfBatches(correctionUnits)) {
        const batchIds = new Set(correctionBatch.map((item: any) => item.targetId));
        const correctionWireTargetIds = new Map(
          correctionBatch.map((item: any, index: number) => [item.targetId, `t${index + 1}`]),
        );
        const correctionWireIds = new Set(correctionWireTargetIds.values());
        const immutableIdByCorrectionWireId = new Map(
          [...correctionWireTargetIds.entries()].map(([immutableId, wireId]) =>
            [wireId, immutableId]),
        );
        const correctionPrompt = [
          "Correct only these audited DXF text/table translations. Return JSON only {\"translations\":[{\"targetId\":\"...\",\"translation\":\"...\"}]}; every supplied short transport targetId exactly once and non-empty. Every targetId maps locally to an immutable DXF target, so copy it byte-for-byte and do not invent, alter, or omit it.",
          `Use concise engineering ${requestedTargetName} <= maxCharacters where possible. ${requestedTargetLanguage === "en" ? NATIVE_DXF_TRANSLATION_GLOSSARY : "Every replacement must contain Japanese script; English-only output is invalid."} Split chains must concatenate to exactly one translation with non-empty sequential fragments, never duplicate it.`,
          `Audit findings: ${JSON.stringify(actionable.filter((finding) =>
            finding.sourceBlockId && batchIds.has(finding.sourceBlockId)).map((finding) => ({
            ...finding,
            sourceBlockId: correctionWireTargetIds.get(finding.sourceBlockId!)!,
          })))}`,
          `targets: ${JSON.stringify(correctionBatch.map((item: any) => ({ targetId: correctionWireTargetIds.get(item.targetId), entityType: item.entityType || "ACAD_TABLE", handle: item.handle || item.tableHandle, source: item.plainText || item.sourceText, currentReplacement: translations.get(item.targetId) || "", maxCharacters: (item.plainText || item.sourceText).length })))}`,
        ].join("\n");
        setDiagnosticContext("translate", "translation_provider");
        const correctionRaw = await requestCworksProviderWithRetry(
          (signal) => askTranslator(
            correctionPrompt, job.id, 8192, signal, { nativeDxfJsonResponse: true },
          ),
          { quarantineKey: job.id, includeProviderMessageInLogs: false },
        );
        const correctionRows = (await parseNativeDxfTranslationRowsWithRepair(
          correctionRaw,
          correctionWireIds,
          (malformedResponse) => requestCworksProviderWithRetry(
            (signal) => askTranslator([
              "Repair this malformed native DXF correction response into ONLY the required JSON object.",
              "Return {\"translations\":[{\"targetId\":\"exact supplied targetId\",\"translation\":\"non-empty translation\"}]}.",
              "Do not invent or alter targetIds. Include only targetIds from the allowed list.",
              `Allowed targetIds: ${JSON.stringify([...correctionWireIds])}`,
              `Malformed response: ${malformedResponse}`,
            ].join("\n"), job.id, 8192, signal, { nativeDxfJsonResponse: true }),
            { quarantineKey: job.id, includeProviderMessageInLogs: false },
          ),
          true,
        )).map((row) => ({
          ...row,
          targetId: immutableIdByCorrectionWireId.get(row.targetId)!,
        }));
        for (const row of correctionRows) if (correctionItemIds.has(row.targetId)) {
          if (translations.get(row.targetId) !== row.translation) correctionChanged = true;
          translations.set(row.targetId, row.translation);
          corrected.add(row.targetId);
        }
      }
      for (const item of correctionItems) {
        if (!corrected.has(item.targetId)) {
          correctionDiagnostics.push({
            handle: item.handle || item.tableHandle,
            reason: `The audit-directed correction response omitted targetId ${item.targetId}; the prior replacement was retained.`,
            pass: correctionPass,
          });
        }
      }
      if (correctionChanged) {
        shouldSynchronizeDimensionCache = true;
        synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
      }
      await saveCheckpoint(
        buildNativeDxfCheckpoint(checkpointBinding, {
          stage: "correction",
          completedBatchCount: checkpointCompletedBatchCount,
          translations: nativeDxfTranslationsRecord(translations),
          audit,
          auditIndex,
          correctionDiagnostics,
          ...targetedCheckpointState(false),
        }),
        {
          progress: 62 + correctionPass * 5,
          progressNote: `Saved native DXF correction pass ${correctionPass} before re-audit`,
          tokenEstimate,
          warningCount: audit.findings.length,
        },
      );
      tokenEstimate += Math.ceil(correctionItems.reduce((sum: number, item: any) =>
        sum + String(item.plainText ?? item.sourceText ?? "").length, 0) / 3)
        + correctionItems.length * 24;
      await updateClaimed(job, {
        progress: 62 + correctionPass * 5,
        progressNote: `Re-running independent native DXF audit after correction pass ${correctionPass}`,
      });
    }
    // A valid table translation is intentionally absent from the byte patch.
    // Auditor placement/source-residue observations about that deferred state
    // are useful review context, but are not blocking translation defects.
    const { effectiveFindings: effectiveAuditFindings, deferredFindings } =
      normalizeNativeDxfHybridAuditFindings(
        audit.findings,
        tableById,
        translations,
        requestedTargetLanguage,
      );
    const unresolvedVisibleFindings = unresolvedVisibleText.map((item: any, index: number) => ({
      targetId: typeof item?.targetId === "string" ? item.targetId : `UNRESOLVED_VISIBLE:${index}`,
      handle: typeof item?.handle === "string" ? item.handle : "visible-text",
      reason: typeof item?.reason === "string"
        ? item.reason : "visible_text_not_safely_patchable",
    }));
    const blocking = [
      ...unresolved,
      ...unresolvedVisibleFindings,
      ...effectiveAuditFindings.map((f) => ({
        targetId: f.sourceBlockId,
        handle: f.sourceBlockId
          ? (targetById.get(f.sourceBlockId) as any)?.handle
            || (tableById.get(f.sourceBlockId) as any)?.tableHandle
          : "audit",
        reason: f.message,
      })),
    ];
    if (!resumePostTranslationStage || shouldSynchronizeDimensionCache) {
      synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
    }
    for (const [targetId, replacement] of translations) {
      const sourceItem: any = targetById.get(targetId) || tableById.get(targetId);
      const validReplacement = isNativeDxfTargetLanguageText(
        sourceItem?.plainText ?? sourceItem?.sourceText,
        replacement,
        requestedTargetLanguage,
      ) && nativeDxfReplacementPreservesPlaceholder(
        sourceItem?.rawText ?? sourceItem?.plainText ?? sourceItem?.sourceText,
        replacement,
      );
      if (!validReplacement) {
        // A post-translation checkpoint is an audited immutable snapshot. Keep
        // its exact value for evidence and fail closed through blockingFindings
        // rather than silently changing what was audited on resume.
        if (!resumePostTranslationStage) translations.delete(targetId);
        blocking.push({
          targetId,
          handle: sourceItem?.handle || sourceItem?.tableHandle,
          reason: !nativeDxfReplacementPreservesPlaceholder(
            sourceItem?.rawText ?? sourceItem?.plainText ?? sourceItem?.sourceText,
            replacement,
          ) ? "dimension_placeholder_not_preserved" : "wrong_target_language_script",
        });
      }
    }
    if (!resumePostTranslationStage || shouldSynchronizeDimensionCache) {
      synchronizeNativeDxfDimensionCacheTranslations(dimensionCacheBindings, translations);
    }
    unresolved = allTranslateTargets.filter((x: any) => !translations.has(x.targetId))
      .map((x: any) => ({
        targetId: x.targetId, handle: x.handle, entityType: x.entityType,
        reason: nativeDxfReplacementPreservesPlaceholder(
          x.rawText ?? x.plainText ?? x.sourceText,
          translations.get(x.targetId),
        ) ? "missing_translation" : "dimension_placeholder_not_preserved",
      }));
    for (const item of unresolved) {
      if (!blocking.some((finding: any) => finding.targetId === item.targetId)) {
        blocking.push(item);
      }
    }
    ledger.unresolved = unresolved;
    for (const entry of ledger.tableTargets) {
      entry.translation = translations.get(entry.targetId) || null;
      entry.accounting = entry.translation
        ? "translated_pending_table_script" : "unresolved";
    }
    synchronizeNativeDxfLedgerEntries(
      ledger.entries,
      translations,
      preservedTargetIds,
      requestedTargetLanguage,
    );
    rebuildTableScript();
    // Everything needed to repeat the local patch is now durable: translated
    // batches, audit findings, correction diagnostics, and source binding. If
    // patch or preview fails, the next worker can resume without another AI
    // request. The checkpoint deliberately contains no released output.
    ledger.scriptAccounting = {
      sha256: ledger.tableScript.sha256,
      manifestSha256: ledger.tableScript.manifestSha256,
      targetCount: ledger.tableScript.targetCount,
      expectedAppliedCount: ledger.tableScript.expectedAppliedCount,
      pendingManualApplicationCount: ledger.tableScript.targetCount,
      blockingCount: ledger.tableTargets.filter((entry: any) => !entry.translation).length,
    };
    ledger.hybridCoverage = {
      ...ledger.hybridCoverage,
      pendingTableTargetCount: ledger.tableScript.targetCount,
      pendingTableCellCount: ledger.tableScript.expectedAppliedCount,
    };
    ledger.manualRequirements = {
      ...ledger.manualRequirements,
      tableScriptSha256: ledger.tableScript.sha256,
      tableManifestSha256: ledger.tableScript.manifestSha256,
    };
    ledger.independentAudit = {
      format: "cworks-native-dxf-independent-audit-v1",
      model: audit.model,
      rawStatus: audit.status,
      terminalStatus: effectiveAuditFindings.length ? "findings" : "passed",
      rawFindings: audit.findings,
      deferredFindings,
      deferredTableFindingCount: deferredFindings.length,
      findings: effectiveAuditFindings,
    };
    ledger.blockingFindings = blocking;
    await saveCheckpoint(
      buildNativeDxfCheckpoint(checkpointBinding, {
        stage: "pre_patch",
        completedBatchCount: checkpointCompletedBatchCount,
        translations: nativeDxfTranslationsRecord(translations),
        audit,
        auditIndex: lastAuditIndex,
        correctionDiagnostics,
        ledger: JSON.parse(JSON.stringify(ledger)),
        ...targetedCheckpointState(false),
      }),
      {
        progress: 74,
        progressNote: "Saved native DXF translation and audit evidence before patch",
        tokenEstimate,
        warningCount: blocking.length,
      },
    );
    const patchTranslations = [...translations].filter(([targetId]) =>
      targetById.has(targetId) && !preservedTargetIds.has(targetId));
    await fs.writeFile(translationsPath, JSON.stringify({
      targetLanguage: requestedTargetLanguage,
      translations: patchTranslations.map(([targetId, translation]) => ({ targetId, translation })),
    }));
    await updateClaimed(job, { progress: 76, progressNote: `Surgically patching ${patchTranslations.length} safe DXF text targets; ${ledger.tableScript.targetCount} table translations remain scripted` });
    if (leaseLost) throw new Error("CAD translation lease was superseded");
    await assertOwned(job);
    setDiagnosticContext("patch", "patch_process");
    await runProcess(DXF_PROCESSOR, "patch", [input, translationsPath, output, patchReport], {
      jobId: job.id, timeoutMs: PAGE_RENDER_TIMEOUT_MS,
      cpuAware: nativeDxfCpuAwareOptions(nativeProcessAbortController.signal),
    });
    if (leaseLost) throw new Error("CAD translation lease was superseded");
    await assertOwned(job);
    const patch = JSON.parse(await fs.readFile(patchReport, "utf8"));
    blocking.push(...(patch.unresolved || []).map((x: any) => ({
      targetId: x.targetId, handle: x.handle, reason: x.reason,
    })));
    const patchedTargetIds = new Set((patch.approvedChanges || [])
      .map((change: any) => change.targetId));
    const fitRejectedTargetIds = new Set((patch.unresolved || [])
      .map((item: any) => item.targetId));
    for (const entry of ledger.entries) {
      if (patchedTargetIds.has(entry.targetId)) entry.accounting = "translated_and_patched";
      else if (fitRejectedTargetIds.has(entry.targetId)) entry.accounting = "unresolved_fit";
      else if (entry.isCyrillicTarget
        && !preservation.some((p: any) => p.targetId === entry.targetId)) {
        entry.accounting = "unresolved";
      }
    }
    ledger.patch = patch;
    ledger.scriptAccounting = {
      sha256: ledger.tableScript.sha256,
      manifestSha256: ledger.tableScript.manifestSha256,
      targetCount: ledger.tableScript.targetCount,
      expectedAppliedCount: ledger.tableScript.expectedAppliedCount,
      pendingManualApplicationCount: ledger.tableScript.targetCount,
      blockingCount: ledger.tableTargets.filter((entry: any) => !entry.translation).length,
    };
    ledger.hybridCoverage = {
      ...ledger.hybridCoverage,
      pendingTableTargetCount: ledger.tableScript.targetCount,
      pendingTableCellCount: ledger.tableScript.expectedAppliedCount,
    };
    ledger.manualRequirements = {
      ...ledger.manualRequirements,
      tableScriptSha256: ledger.tableScript.sha256,
      tableManifestSha256: ledger.tableScript.manifestSha256,
    };
    ledger.independentAudit = {
      format: "cworks-native-dxf-independent-audit-v1",
      model: audit.model,
      rawStatus: audit.status,
      terminalStatus: effectiveAuditFindings.length ? "findings" : "passed",
      rawFindings: audit.findings,
      deferredFindings,
      deferredTableFindingCount: deferredFindings.length,
      findings: effectiveAuditFindings,
    };
    ledger.blockingFindings = blocking;
    await updateClaimed(job, { progress: 82, progressNote: "Generating safe-hybrid DXF review previews and table script evidence" });
    setDiagnosticContext("preview", "preview_process");
    await runProcess(DXF_PROCESSOR, "preview", [input, sourceSvg], {
      jobId: job.id, timeoutMs: PAGE_RENDER_TIMEOUT_MS,
      cpuAware: nativeDxfCpuAwareOptions(nativeProcessAbortController.signal),
    });
    await runProcess(DXF_PROCESSOR, "preview", [output, translatedSvg], {
      jobId: job.id, timeoutMs: PAGE_RENDER_TIMEOUT_MS,
      cpuAware: nativeDxfCpuAwareOptions(nativeProcessAbortController.signal),
    });
    const prefix = `cworks-translator/${job.id}/${job.runToken}`;
    const names = { output: `${prefix}/translated.dxf`, ledger: `${prefix}/ledger.json`, preservation: `${prefix}/preservation-report.json`, summary: `${prefix}/summary.md`, sourcePreview: `${prefix}/source.svg`, preview: `${prefix}/translated.svg` };
    for (const name of Object.values(names)) await queueCleanup([name], job.id);
    staged.push(...Object.values(names));
    if (leaseLost) throw new Error("CAD translation lease was superseded");
    await assertOwned(job);
    setDiagnosticContext("publish", "artifact_write");
    await Promise.all([
      writeObject(names.output, await fs.readFile(output)),
      writeObject(names.ledger, JSON.stringify(ledger, null, 2)),
      writeObject(names.preservation, JSON.stringify({ format: "cworks-dxf-preservation-v1", targetLanguage: requestedTargetLanguage, sourceSha256: inventory.sha256, placementManifestSha256: inventory.placementManifestSha256, placementCount: inventory.placementCount, preserved: preservation, patch, hybridCoverage: ledger.hybridCoverage, manualRequirements: ledger.manualRequirements, independentAudit: ledger.independentAudit }, null, 2)),
      writeObject(names.summary, `# ${job.title}\n\n## Safe-hybrid DXF translation summary\n- Source: ${job.originalFilename}\n- Target language: ${requestedTargetName}\n- Patchable Cyrillic text targets: ${targets.length}\n- Pending table targets requiring confirmed derivative-DWG application: ${ledger.hybridCoverage.pendingTableTargetCount}\n- Pending exact table cells: ${ledger.hybridCoverage.pendingTableCellCount}\n- Unresolved visible text: ${ledger.hybridCoverage.unresolvedVisibleTextCount}\n- Opaque review required: ${ledger.hybridCoverage.opaqueReviewRequired ? "yes" : "no"}\n- Unplaced targets: ${ledger.hybridCoverage.unplacedTargetCount}\n- Visible text placements: ${inventory.placementCount}\n- Safely patched text targets: ${patch.approvedChanges.length}\n- Table script SHA-256: ${ledger.tableScript.sha256}\n- Table manifest SHA-256: ${ledger.tableScript.manifestSha256}\n- Manual application is source-bound to source SHA-256 ${ledger.manualRequirements.sourceSha256} and requires Windows AutoCAD ActiveX, Unicode LISPSYS, an explicit derivative .dwg, and operator confirmation.\n- Explicitly preserved drawing codes: ${preservation.length}\n- Blocking findings: ${blocking.length}\n- Independent OpenAI audit: ${audit.status}\n\nPatchable text was surgically edited while geometry, layouts, block placements, tables, and non-approved records were preserved. Deferred table targets remain pending until the guarded source-verified table script is explicitly applied.\n`),
      writeObject(names.sourcePreview, await fs.readFile(sourceSvg)),
      writeObject(names.preview, await fs.readFile(translatedSvg)),
    ]);
    const findings = [
      ...unresolved.map((x: any) => ({ type: "missing_translation", message: x.reason, sourceBlockId: x.targetId })),
      ...unresolvedVisibleFindings.map((x: any) => ({
        type: "placement", message: x.reason, sourceBlockId: x.targetId,
      })),
      ...(patch.unresolved || []).map((x: any) => ({
        type: "placement", message: x.reason, sourceBlockId: x.targetId,
      })),
      ...effectiveAuditFindings,
    ];
    setDiagnosticContext("publish", "publication_transaction");
    await db.transaction(async (tx) => {
      const oldPages = await tx.select().from(cworksTranslationPages)
        .where(eq(cworksTranslationPages.jobId, job.id));
      // A consented correction is a history-preserving successor, not routine
      // render replacement. Keep its predecessor's private artifacts intact so
      // the append-only correction event and old checkpoint remain inspectable.
      const obsolete = targetedCorrectionRequested ? [] : [
        job.outputStoredName, job.summaryStoredName, job.ledgerStoredName, job.preservationStoredName,
        ...oldPages.flatMap((page) => [page.thumbnailStoredName, page.sourceThumbnailStoredName]),
      ].filter((name): name is string => Boolean(name));
      if (obsolete.length) {
        await tx.insert(cworksTranslationCleanup).values(obsolete.map((storedName) => ({
          storedName, jobId: job.id,
        }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
      const targetPlacementCount = translateTargets.reduce(
        (sum: number, entry: any) => sum + Math.max(0, Number(entry.placementCount) || 0),
        0,
      ) + tableTargets.reduce((sum: number, entry: any) =>
        sum + entry.sourceOccurrenceCount, 0);
      const patchedPlacementCount = ledger.entries.reduce(
        (sum: number, entry: any) => sum + (
          patchedTargetIds.has(entry.targetId) ? Math.max(0, Number(entry.placementCount) || 0) : 0
        ),
        0,
      );
      await tx.insert(cworksTranslationPages).values({
        jobId: job.id, pageNumber: 1, thumbnailStoredName: names.preview, sourceThumbnailStoredName: names.sourcePreview,
        sourceBlockCount: targetPlacementCount, translatedBlockCount: patchedPlacementCount,
        warnings: findings, machineAuditStatus: blocking.length ? "findings" : audit.status, machineAuditFindings: findings,
      }).onConflictDoUpdate({ target: [cworksTranslationPages.jobId, cworksTranslationPages.pageNumber], set: {
        thumbnailStoredName: names.preview, sourceThumbnailStoredName: names.sourcePreview, sourceBlockCount: targetPlacementCount, translatedBlockCount: patchedPlacementCount, warnings: findings, machineAuditStatus: blocking.length ? "findings" : audit.status, machineAuditFindings: findings,
      } });
      if (leaseLost) throw new Error("CAD translation lease was superseded");
      const published = await tx.update(cworksTranslationJobs).set({
        status: "awaiting_review", progress: 100, pageCount: 1, pagesDone: 1,
        progressNote: blocking.length ? `Safe-hybrid DXF draft ready with ${blocking.length} blocking finding(s)` : `Safe-hybrid DXF ready for CAD review; ${ledger.tableScript.targetCount} table target(s) await reviewed script application`,
        outputStoredName: names.output, ledgerStoredName: names.ledger, preservationStoredName: names.preservation, summaryStoredName: names.summary,
        machineAuditStatus: blocking.length ? "findings" : audit.status, machineAuditModel: MACHINE_AUDIT_MODEL,
        approvedRevision: null, approvedAt: null, completedAt: new Date(), runToken: null, leaseExpiresAt: null,
        tokenEstimate, costEstimate: ((tokenEstimate / 1_000_000) * 9).toFixed(4),
      }).where(and(eq(cworksTranslationJobs.id, job.id), eq(cworksTranslationJobs.runToken, job.runToken || "")))
        .returning({ id: cworksTranslationJobs.id });
      if (!published.length) throw new Error("CAD translation lease was superseded");
      await tx.delete(cworksTranslationCleanup).where(inArray(cworksTranslationCleanup.storedName, Object.values(names)));
    });
    published = true;
    setDiagnosticContext("cleanup", "cleanup");
    await runCworksCleanupBatch({ jobId: job.id, deleteObject });
  } catch (error) {
    const resumeRejected = error instanceof NativeDxfResumeRejectedError;
    const retry = !resumeRejected && job.retryCount < 1;
    const providerFailure = error instanceof CworksProviderError;
    const concise = error instanceof NativeDxfProcessError
      ? error.message
      : resumeRejected
      ? error.message
      : error instanceof NativeDxfMalformedTranslationResponse
      ? error.message
      : providerFailure
      ? "The native DXF translation provider could not complete a bounded request."
      : error instanceof SyntaxError
        ? "A native DXF translation or audit response was malformed."
        : "Native DXF processing stopped safely before publication.";
    const diagnostic = describeNativeDxfError(error, diagnosticContext);
    const safeFailureCode = `[${diagnostic.stage}:${diagnostic.code}]`;
    await db.update(cworksTranslationJobs).set({
      status: retry ? "queued" : "failed",
      progressNote: retry
        ? "Retrying native DXF from immutable source; no partial output was published"
        : "Native DXF processing failed safely; no partial output was published",
      errorMessage: retry
        ? `First native DXF attempt failed; retrying automatically. ${safeFailureCode} ${concise}`
        : `${safeFailureCode} ${concise}`,
      retryCount: job.retryCount + (retry ? 1 : 0),
      runToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(cworksTranslationJobs.id, job.id),
      eq(cworksTranslationJobs.status, "running"),
      eq(cworksTranslationJobs.runToken, job.runToken || ""),
    ));
    logger.error({
      jobId: job.id, retry,
      diagnostic,
      failure: error instanceof NativeDxfProcessError
        ? error.kind
        : error instanceof NativeDxfMalformedTranslationResponse
          ? {
              kind: "native_dxf_translation_protocol_invalid",
              targetCount: error.targetCount,
              afterSubdivision: error.afterSubdivision,
            }
          : describeProviderFailure(error, false),
    }, "Native DXF job stopped before publication");
  } finally {
    clearInterval(heartbeat);
    // This is idempotent and covers every exceptional route through the
    // attempt boundary, including one that is interrupted during cleanup.
    nativeProcessAbortController.abort();
    if (!published && staged.length) {
      const failedCleanup: string[] = [];
      for (const storedName of staged) {
        try {
           await deleteObject(storedName);
          await db.delete(cworksTranslationCleanup)
            .where(eq(cworksTranslationCleanup.storedName, storedName));
        } catch {
          failedCleanup.push(storedName);
        }
      }
      if (failedCleanup.length) {
        await queueCleanup(failedCleanup, job.id);
        await db.update(cworksTranslationCleanup).set({ nextAttemptAt: new Date() })
          .where(inArray(cworksTranslationCleanup.storedName, failedCleanup));
      }
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runNativeDxfJob(job: CworksJob): Promise<void> {
  try {
    await runNativeDxfJobAttempt(job);
  } catch {
    // Covers failures before the attempt's inner boundary exists (for example,
    // temporary-directory allocation) and any future cleanup regression.
    const retry = job.retryCount < 1;
    await db.update(cworksTranslationJobs).set({
      status: retry ? "queued" : "failed",
      progressNote: retry
        ? "Retrying native DXF from immutable source; no partial output was published"
        : "Native DXF processing failed safely; no partial output was published",
      errorMessage: "Native DXF processing stopped safely before publication.",
      retryCount: job.retryCount + (retry ? 1 : 0),
      runToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(cworksTranslationJobs.id, job.id),
      eq(cworksTranslationJobs.status, "running"),
      eq(cworksTranslationJobs.runToken, job.runToken || ""),
    ));
  }
}

async function processJob(job: CworksJob) {
  if (job.sourceFormat === "dxf") return runNativeDxfJob(job);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cad-${job.id}-`));
  const inputPath = path.join(dir, "input.pdf");
  const blocksPath = path.join(dir, "blocks.json");
  const translationsPath = path.join(dir, "translations.json");
  const outputPath = path.join(dir, "translated.pdf");
  const stagedObjects: string[] = [];
  let published = false;
  let leaseLost = false;
  let finalRenderingStarted = false;
  const heartbeat = setInterval(async () => {
    try {
      const rows = await db.update(cworksTranslationJobs)
        .set({ leaseExpiresAt: leaseUntil(), updatedAt: new Date() })
        .where(and(eq(cworksTranslationJobs.id, job.id), eq(cworksTranslationJobs.runToken, job.runToken || "")))
        .returning({ id: cworksTranslationJobs.id });
      if (!rows.length) leaseLost = true;
    } catch {
      // A transient database failure does not immediately abandon a run; the
      // next heartbeat/update still has to prove ownership before publication.
    }
  }, 60_000);
  heartbeat.unref();
  try {
    const source = await readFileFromObjectStorage(job.sourceStoredName);
    if (!source) throw new Error("Source PDF is missing from private storage");
    await fs.writeFile(inputPath, source);
    await updateClaimed(job, {
      progress: Math.max(5, Math.min(job.progress, 68)),
      progressNote: job.pagesDone > 0
        ? "Inspecting the source before resuming saved pages"
        : "Inspecting pages and positioned drawing text",
    });

    const inspected = await runProcessor(["extract", inputPath, blocksPath, job.sourceLanguage], {
      stage: "extraction",
      timeoutMs: EXTRACTION_TIMEOUT_MS,
      maxAttempts: EXTRACTION_ATTEMPTS,
      jobId: job.id,
      beforeAttempt: async () => {
        await fs.rm(blocksPath, { force: true });
      },
      onRetry: async (nextAttempt, maxAttempts) => {
        await updateClaimed(job, {
          progressNote: `Inspection hit a temporary processor issue — retrying (${nextAttempt} of ${maxAttempts})`,
        });
      },
    });
    const extracted = JSON.parse(await fs.readFile(blocksPath, "utf8")) as { pageCount: number; pages: CworksPage[] };
    const initiallyEligibleBlockCount = extracted.pages.reduce(
      (n, p) => n + p.blocks.filter((b) =>
        shouldTranslate(b, job.drawingDepth, job.sourceLanguage)).length,
      0,
    );
    await updateClaimed(job, {
      pageCount: extracted.pageCount,
      progress: Math.max(10, Math.min(job.progress, 68)),
      progressNote: job.pagesDone > 0
        ? `Source verified — checking saved progress across ${extracted.pageCount} pages`
        : `Found ${initiallyEligibleBlockCount} positioned text lines across ${extracted.pageCount} pages`,
    });

    const recovered = await recoverSuspiciousBlocks(job, extracted.pages, inputPath, dir);
    const recoverableBlockCount = requireRecoverableCworksText(job, recovered.pages);
    const skill = await fs.readFile(SKILL_PATH, "utf8");
    const translated = await translateBlocks(job, recovered.pages, skill);
    const obstacles = recovered.pages.flatMap((page) =>
      page.blocks.map((block) => ({
        id: block.id,
        paragraphId: block.paragraphId,
        placementGroupId: block.placementGroupId,
        compactGroupId: block.compactGroupId,
        compactGroupCompact: block.compactGroupCompact,
        layoutGroupId: block.layoutGroupId,
        layoutGroupCompact: block.layoutGroupCompact,
        pageNumber: page.pageNumber,
        bbox: block.bbox,
      })),
    );
    assertCworksManualTouchupRenderBinding(
      job,
      source,
      translated.translations,
      obstacles,
    );
    await fs.writeFile(translationsPath, JSON.stringify({
      translations: translated.translations,
      obstacles,
      targetLanguage: targetLanguage(job),
    }, null, 2));
    finalRenderingStarted = true;
    await updateClaimed(job, {
      progress: 70,
      progressNote: "Preparing restart-safe page placement",
    });

    const rendered = await renderCworksPages(
      job,
      recovered.pages,
      translated.translations,
      inputPath,
      translationsPath,
      dir,
    );
    const coverage = summarizeCworksCoverage(
      translated.translations,
      rendered.checkpoints,
      recoverableBlockCount,
    );
    const audited = await auditCworksRenderedPages(
      job,
      recovered.pages,
      translated.translations,
      inputPath,
      dir,
    );
    const machineAuditPassed = audited.audits.every((audit) => audit.status === "passed");
    const machineAuditFindingCount = audited.audits.reduce(
      (sum, audit) => sum + audit.findings.length,
      0,
    );
    await updateClaimed(job, {
      progress: 96,
      progressNote: `Combining ${rendered.fragmentPaths.length} completed vector pages`,
    });
    const mergeResult = await runProcessor(
      ["merge", outputPath, ...rendered.fragmentPaths],
      {
        stage: "merge",
        timeoutMs: MERGE_TIMEOUT_MS,
        jobId: job.id,
      },
    );
    if (Number(mergeResult?.pageCount) !== extracted.pageCount) {
      throw new Error("Merged translated PDF has an unexpected page count");
    }
    const runPrefix = `cworks-translator/${job.id}/${job.runToken}`;
    const outputStoredName = `${runPrefix}/translated.pdf`;
    const summaryStoredName = `${runPrefix}/summary.md`;
    const sourceThumbnailNames = new Map(
      recovered.pages.map((page) => [
        page.pageNumber,
        `${runPrefix}/source-page-${page.pageNumber}.jpg`,
      ]),
    );
    await db.insert(cworksTranslationCleanup).values(
      [outputStoredName, summaryStoredName, ...sourceThumbnailNames.values()].map((storedName) => ({
        storedName,
        jobId: job.id,
        nextAttemptAt: new Date(Date.now() + ABANDONED_STAGE_CLEANUP_MS),
      })),
    ).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
    if (leaseLost) throw new Error("CAD translation lease was superseded");
    await assertOwned(job);
    await writeFileToObjectStorage(outputStoredName, await fs.readFile(outputPath));
    stagedObjects.push(outputStoredName);
    for (const [pageNumber, storedName] of sourceThumbnailNames) {
      const localPath = audited.sourceThumbnailPaths.get(pageNumber);
      if (!localPath) throw new Error(`Source review thumbnail is missing for page ${pageNumber}`);
      await assertOwned(job);
      await writeFileToObjectStorage(storedName, await fs.readFile(localPath));
      stagedObjects.push(storedName);
    }
    const oldPages = await db.select().from(cworksTranslationPages).where(eq(cworksTranslationPages.jobId, job.id));
    const oldObjectNames = [
      ...oldPages.map((p) => p.thumbnailStoredName),
      ...oldPages.map((p) => p.sourceThumbnailStoredName),
      job.outputStoredName,
      job.summaryStoredName,
    ].filter((name): name is string => Boolean(name));

    const targetCountsByPage = new Map(recovered.pages.map((page) => [
      page.pageNumber,
      page.blocks.filter((block) =>
        shouldTranslate(block, job.drawingDepth, job.sourceLanguage)).length,
    ]));
    const pageRows: Array<typeof cworksTranslationPages.$inferInsert> = rendered.checkpoints.map((checkpoint) => {
      if (!checkpoint.thumbnailStoredName) {
        throw new Error(`Rendered page ${checkpoint.pageNumber} is missing its private thumbnail`);
      }
      const audit = audited.audits.find((item) => item.pageNumber === checkpoint.pageNumber);
      if (!audit) {
        throw new Error(`Independent audit is missing for page ${checkpoint.pageNumber}`);
      }
      return {
        jobId: job.id,
        pageNumber: checkpoint.pageNumber,
        thumbnailStoredName: checkpoint.thumbnailStoredName,
        sourceThumbnailStoredName: sourceThumbnailNames.get(checkpoint.pageNumber),
        sourceBlockCount: targetCountsByPage.get(checkpoint.pageNumber) || 0,
        translatedBlockCount: checkpoint.translatedBlockCount,
        warnings: [
          ...(Array.isArray(checkpoint.warnings) ? checkpoint.warnings : []),
          ...audit.findings.map((finding) => `Independent audit: ${finding.message}`),
        ],
        previewMetadata: checkpoint.previewMetadata,
        machineAuditStatus: audit.status,
        machineAuditFindings: audit.findings,
      };
    });
    const totalWarnings = translated.warningCount + rendered.checkpoints.reduce(
      (sum, checkpoint) => sum + (Array.isArray(checkpoint.warnings) ? checkpoint.warnings.length : 0),
      machineAuditFindingCount,
    );
    const summary = `# ${job.title}

## CAD translation summary
- Source file: ${job.originalFilename}
- Source language: ${job.sourceLanguage}
- Target language: ${targetLanguageName(targetLanguage(job))}
- Pages: ${extracted.pageCount}
- Target human-language lines: ${coverage.targetLineCount}
- Recovered from broken font extraction with Gemini 3.1 Pro: ${coverage.recoveredLineCount}
- Translated confidently: ${coverage.translatedLineCount}
- Placed in the vector PDF: ${coverage.placedLineCount}
- Unresolved / retained in source language: ${coverage.unresolvedLineCount}
- Placement coverage: ${coverage.placementPercent}%
- Strict accounting gate: ${coverage.complete ? "passed" : "blocked"}
- Independent visual audit (${MACHINE_AUDIT_MODEL}): ${machineAuditPassed ? "passed" : `blocked with ${machineAuditFindingCount} finding(s)`}
- Visual recovery attempts this run: ${recovered.attemptedCount}
- Review warnings: ${totalWarnings}
- Coverage: ${job.drawingDepth}
- Revision: ${job.revisionCount}
- Estimated AI tokens: ${translated.tokenEstimate.toLocaleString()}
- Estimated AI cost: $${((translated.tokenEstimate / 1_000_000) * 9).toFixed(4)}

## Review note
This is a machine-generated draft, not a certified/legal translation. It is not final until a qualified human reviewer checks every page, resolves every independent-audit finding, and signs the approval declaration.
`;
    if (leaseLost) throw new Error("CAD translation lease was superseded");
    await assertOwned(job);
    await writeFileToObjectStorage(summaryStoredName, summary);
    stagedObjects.push(summaryStoredName);
    await updateClaimed(job, {
      progress: 98,
      progressNote: "Publishing the complete translated drawing set",
    });

    // Publish the complete revision in one database transaction. Reviewers see
    // either the old complete set or the new complete set—never an in-between.
    clearInterval(heartbeat);
    await db.transaction(async (tx) => {
      const [owned] = await tx.select({ runToken: cworksTranslationJobs.runToken })
        .from(cworksTranslationJobs)
        .where(and(
          eq(cworksTranslationJobs.id, job.id),
          eq(cworksTranslationJobs.status, "running"),
          eq(cworksTranslationJobs.runToken, job.runToken || ""),
        ))
        .limit(1);
      if (!owned) throw new Error("CAD translation lease was superseded");
      if (pageRows.length) {
        // Upsert avoids a delete/insert uniqueness race while preserving
        // atomic visibility of the revision inside this transaction.
        for (const row of pageRows) {
          await tx.insert(cworksTranslationPages).values(row).onConflictDoUpdate({
            target: [cworksTranslationPages.jobId, cworksTranslationPages.pageNumber],
            set: {
              thumbnailStoredName: row.thumbnailStoredName,
              sourceThumbnailStoredName: row.sourceThumbnailStoredName,
              sourceBlockCount: row.sourceBlockCount,
              translatedBlockCount: row.translatedBlockCount,
              warnings: row.warnings,
              previewMetadata: row.previewMetadata,
              machineAuditStatus: row.machineAuditStatus,
              machineAuditFindings: row.machineAuditFindings,
            },
          });
        }
      }
      if (oldObjectNames.length) {
        await tx.insert(cworksTranslationCleanup).values(oldObjectNames.map((storedName) => ({
          storedName,
          jobId: job.id,
        }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
      const fragmentNames = rendered.checkpoints
        .map((checkpoint) => checkpoint.fragmentStoredName)
        .filter((name): name is string => Boolean(name));
      if (fragmentNames.length) {
        await tx.insert(cworksTranslationCleanup).values(fragmentNames.map((storedName) => ({
          storedName,
          jobId: job.id,
        }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
      await tx.delete(cworksTranslationCleanup).where(inArray(
        cworksTranslationCleanup.storedName,
        [outputStoredName, summaryStoredName, ...sourceThumbnailNames.values()],
      ));
      // Translation checkpoints are immutable revision evidence. Retaining them
      // also makes restoration of an earlier completed revision possible.
      await tx.delete(cworksTranslationRenderCheckpoints).where(eq(cworksTranslationRenderCheckpoints.jobId, job.id));
      const updated = await tx.update(cworksTranslationJobs).set({
        status: "awaiting_review",
        progress: 100,
        pagesDone: extracted.pageCount,
        pageCount: inspected.pageCount || extracted.pageCount,
        progressNote: totalWarnings
          ? `Draft ready for qualified review — ${totalWarnings} blocking item(s) require resolution`
          : "Draft ready for qualified page-by-page review",
        outputStoredName,
        summaryStoredName,
        machineAuditStatus: machineAuditPassed ? "passed" : "findings",
        machineAuditModel: MACHINE_AUDIT_MODEL,
        approvedRevision: null,
        approvedAt: null,
        tokenEstimate: translated.tokenEstimate,
        costEstimate: ((translated.tokenEstimate / 1_000_000) * 9).toFixed(4),
        errorMessage: null,
        completedAt: new Date(),
        runToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.runToken, job.runToken || ""),
      )).returning({ id: cworksTranslationJobs.id });
      if (!updated.length) throw new Error("CAD translation lease was superseded");
    });
    published = true;

    // The new revision is visible now. Superseded private objects were queued
    // in the same transaction and remain retryable across process restarts.
    await runCworksCleanupBatch({ jobId: job.id });
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 800);
    const deterministicProcessorFailure = err instanceof CworksProcessorError && err.deterministic;
    const exhaustedExtractionRetry = err instanceof CworksProcessorError
      && err.stage === "extraction"
      && !err.deterministic;
    const exhaustedProviderRetry = err instanceof CworksProviderError;
    const retry = job.retryCount < 1
      && !deterministicProcessorFailure
      && !exhaustedExtractionRetry
      && !exhaustedProviderRetry
      && !/No translatable text layer|maximum is|more than/.test(message);
    await db.update(cworksTranslationJobs).set({
      status: retry ? "queued" : "failed",
      progressNote: retry
        ? "Retrying from the last durable checkpoint"
        : err instanceof CworksProviderError && err.pageNumber
          ? `Translation provider could not finish page ${err.pageNumber}; saved pages remain safe`
          : finalRenderingStarted
            ? "Final PDF placement stopped; saved rendered pages remain safe"
            : "Translation failed",
      errorMessage: retry ? `First attempt failed; retrying automatically. ${message}` : message,
      retryCount: job.retryCount + (retry ? 1 : 0),
      runToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(eq(cworksTranslationJobs.id, job.id), eq(cworksTranslationJobs.runToken, job.runToken || "")));
    if (!retry) console.error(`[cworks-translator] job ${job.id} failed: ${message}`);
  } finally {
    clearInterval(heartbeat);
    if (!published && stagedObjects.length) {
      const failedCleanup: string[] = [];
      for (const storedName of stagedObjects) {
        try {
          await deleteFromObjectStorageStrict(storedName);
          await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.storedName, storedName));
        } catch {
          failedCleanup.push(storedName);
        }
      }
      if (failedCleanup.length) {
        await queueCleanup(failedCleanup, job.id);
        await db.update(cworksTranslationCleanup)
          .set({ nextAttemptAt: new Date() })
          .where(inArray(cworksTranslationCleanup.storedName, failedCleanup));
      }
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function tick() {
  if (ticking || active >= MAX_CONCURRENT) return;
  ticking = true;
  try {
    await runCworksCleanupBatch();
    while (active < MAX_CONCURRENT) {
      const job = await claimNextJob();
      if (!job) break;
      active++;
      void processJob(job)
        .catch(() => {
          // Last-resort containment: branch-specific boundaries own detailed,
          // redacted job state. Never let a detached job rejection terminate Node.
          console.error(`[cworks-translator] job ${job.id} escaped its safety boundary`);
        })
        .finally(() => {
          active--;
          void tick();
        });
    }
  } catch (err: any) {
    console.error("[cworks-translator] worker tick failed:", err?.message);
  } finally {
    ticking = false;
  }
}

export function startCworksTranslationWorker() {
  if (started) return;
  started = true;
  setInterval(() => void tick(), POLL_MS).unref();
  setTimeout(() => void tick(), 1_500).unref();
}

export function kickCworksTranslationWorker() {
  setTimeout(() => void tick(), 50).unref();
}