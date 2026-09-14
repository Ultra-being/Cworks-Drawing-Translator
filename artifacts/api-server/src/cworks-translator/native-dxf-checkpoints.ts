import { createHash } from "node:crypto";
import type { NativeDxfTargetedCorrectionBrief } from "./native-dxf-targeted-correction";

/**
 * Native DXF checkpoints intentionally live in the existing cworks checkpoint
 * row.  The row's translations JSONB column contains this envelope, rather
 * than a bare array (the PDF worker only consumes bare arrays).  Keeping the
 * binding in the envelope makes an old or cross-language row unusable instead
 * of silently reusing confidential drawing work.
 */
export const NATIVE_DXF_CHECKPOINT_FORMAT = "cworks-native-dxf-checkpoint-v1";

export type NativeDxfCheckpointStage =
  | "translation_batch"
  | "audit"
  | "correction"
  | "pre_patch";

export type NativeDxfCheckpointBinding = {
  sourceSha256: string;
  revisionCount: number;
  targetLanguage: "en" | "ja";
  methodologyHash: string;
  placementManifestSha256?: string | null;
};

export type NativeDxfCheckpoint = NativeDxfCheckpointBinding & {
  format: typeof NATIVE_DXF_CHECKPOINT_FORMAT;
  sourceRevision: number;
  stage: NativeDxfCheckpointStage;
  completedBatchCount: number;
  translations: Record<string, string>;
  audit?: unknown;
  auditIndex?: number;
  correctionDiagnostics?: unknown[];
  /** Successor correction work is durable but its mandatory full audit has not completed. */
  targetedCorrectionPendingReaudit?: boolean;
  /** Immutable IDs whose one consented correction attempt was durably consumed. */
  targetedCorrectionCompletedTargetIds?: string[];
  /** The full consented intent survives retry metadata cleanup. */
  targetedCorrectionIntent?: NativeDxfTargetedCorrectionBrief;
  /** Every original requested ID is terminally accounted for once consumed. */
  targetedCorrectionCompletionReasons?: Record<string, string>;
  ledger?: unknown;
};

export type NativeDxfCheckpointEligibility = {
  eligible: boolean;
  reason:
    | "eligible"
    | "missing"
    | "malformed"
    | "format_mismatch"
    | "source_mismatch"
    | "revision_mismatch"
    | "language_mismatch"
    | "methodology_mismatch"
    | "placement_manifest_mismatch";
  stage?: NativeDxfCheckpointStage;
};

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTargetLanguage(value: unknown): value is "en" | "ja" {
  return value === "en" || value === "ja";
}

function hasTranslations(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, translation]) =>
    Boolean(key) && typeof translation === "string" && Boolean(translation.trim()));
}

function isStage(value: unknown): value is NativeDxfCheckpointStage {
  return value === "translation_batch"
    || value === "audit"
    || value === "correction"
    || value === "pre_patch";
}

/**
 * This is deliberately a reasoned contract, not a truthy row check.  Routes
 * may use it to label a retry as "resume" only when every binding matches.
 * A non-eligible result means full restart and must never claim AI work was
 * reused.
 */
export function nativeDxfCheckpointResumeEligibility(
  value: unknown,
  expected: NativeDxfCheckpointBinding,
): NativeDxfCheckpointEligibility {
  if (value == null) return { eligible: false, reason: "missing" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { eligible: false, reason: "malformed" };
  }
  const checkpoint = value as Partial<NativeDxfCheckpoint>;
  if (checkpoint.format !== NATIVE_DXF_CHECKPOINT_FORMAT || !isStage(checkpoint.stage)) {
    return { eligible: false, reason: "format_mismatch" };
  }
  if (
    !isSha256(checkpoint.sourceSha256)
    || !Number.isInteger(checkpoint.sourceRevision)
    || !Number.isInteger(checkpoint.revisionCount)
    || !isTargetLanguage(checkpoint.targetLanguage)
    || typeof checkpoint.methodologyHash !== "string"
    || !Number.isInteger(checkpoint.completedBatchCount)
    || checkpoint.completedBatchCount < 0
    || !hasTranslations(checkpoint.translations)
  ) {
    return { eligible: false, reason: "malformed", stage: checkpoint.stage };
  }
  if (checkpoint.sourceSha256 !== expected.sourceSha256) {
    return { eligible: false, reason: "source_mismatch", stage: checkpoint.stage };
  }
  if (
    checkpoint.sourceRevision !== expected.revisionCount
    || checkpoint.revisionCount !== expected.revisionCount
  ) {
    return { eligible: false, reason: "revision_mismatch", stage: checkpoint.stage };
  }
  if (checkpoint.targetLanguage !== expected.targetLanguage) {
    return { eligible: false, reason: "language_mismatch", stage: checkpoint.stage };
  }
  if (checkpoint.methodologyHash !== expected.methodologyHash) {
    return { eligible: false, reason: "methodology_mismatch", stage: checkpoint.stage };
  }
  if (
    (expected.placementManifestSha256 || null)
    !== (checkpoint.placementManifestSha256 || null)
  ) {
    return { eligible: false, reason: "placement_manifest_mismatch", stage: checkpoint.stage };
  }
  return { eligible: true, reason: "eligible", stage: checkpoint.stage };
}

export function isNativeDxfCheckpointResumeEligible(
  value: unknown,
  expected: NativeDxfCheckpointBinding,
): value is NativeDxfCheckpoint {
  return nativeDxfCheckpointResumeEligibility(value, expected).eligible;
}

export function nativeDxfMethodologyHash(input: {
  checkpointEnvelopeVersion?: number;
  translationMethodologyVersion: number;
  auditMethodologyVersion: number;
  auditModel?: string;
  translationGlossary: string;
  auditPolicy: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function buildNativeDxfCheckpoint(
  binding: NativeDxfCheckpointBinding,
  values: Omit<NativeDxfCheckpoint, keyof NativeDxfCheckpointBinding | "format" | "sourceRevision">,
): NativeDxfCheckpoint {
  return {
    format: NATIVE_DXF_CHECKPOINT_FORMAT,
    ...binding,
    sourceRevision: binding.revisionCount,
    ...values,
  };
}