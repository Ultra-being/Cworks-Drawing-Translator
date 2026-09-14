import { Router } from "express";
import multer from "multer";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { execFile } from "child_process";
import { isDeepStrictEqual, promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod/v4";
import { db } from "../../db";
import {
  cworksTranslationCleanup,
  cworksTranslationCadDerivatives,
  cworksTranslationCheckpoints,
  cworksTranslationJobs,
  cworksTranslationPageReviews,
  cworksTranslationPages,
  cworksTranslationRenderCheckpoints,
  cworksTranslationReviewEvents,
  cworksTranslationTouchups,
  users,
} from "@workspace/db/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  deleteFromObjectStorageStrict,
  getObjectStorageMetadata,
  getObjectStorageUploadSignedUrl,
  readFileFromObjectStorage,
  streamFromObjectStorage,
  writeFileToObjectStorage,
} from "../object-storage-helper";
import {
  cworksRenderLayoutVersion,
  getCworksTranslationReadiness,
  hasUnsettledCworksProviderRequest,
  isCworksTargetLanguageText,
  isNativeDxfTargetLanguageText,
  isCworksCoverageSeverelyIncomplete,
  kickCworksTranslationWorker,
  nativeDxfCheckpointMethodologyHash,
  NATIVE_DXF_RETRY_BRIEF_KIND,
  normalizeNativeDxfHybridAuditFindings,
  previewCworksManualTouchup,
} from "../cworks-translator/worker";
import { nativeDxfCheckpointResumeEligibility } from "../cworks-translator/native-dxf-checkpoints";
import {
  buildNativeDxfTargetedCorrectionBrief,
  isNativeDxfTargetedCorrectionBrief,
} from "../cworks-translator/native-dxf-targeted-correction";
import { authLimiter } from "../middleware/rateLimit";
import { logger } from "../lib/logger";

const router = Router();
const CAD_DERIVATIVE_REVIEWER_ROLES = new Set(["owner", "admin"]);
const execFileAsync = promisify(execFile);
const apiServerRoot = path.basename(process.cwd()) === "api-server"
  ? process.cwd() : path.join(process.cwd(), "artifacts/api-server");
const DXF_PROCESSOR = path.join(apiServerRoot, "src/cworks-translator/dxf_processor.py");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

declare module "express-session" {
  interface SessionData {
    cworksAuthed: boolean;
    cworksLoginAt: number;
    cworksReviewerSessionId: string;
  }
}

function appPassword(): string | null {
  const value = process.env.CWORKS_APP_PASSWORD;
  return value?.trim() ? value : null;
}

// --- Product password gate ----------------------------------------------------

router.post("/auth/login", authLimiter, (req, res) => {
  const configured = appPassword();
  if (!configured) {
    return res.status(503).json({ error: "Access is not configured yet. Set an app password first." });
  }
  const supplied = String(req.body?.password || "");
  if (!supplied || supplied !== configured) {
    return res.status(401).json({ error: "That password is not correct." });
  }
  // Regeneration prevents session fixation, but the product password is only an
  // additional gate. Preserve any separately authenticated workspace identity.
  const workspaceIdentity = {
    userId: req.session.userId,
    username: req.session.username,
    clientId: req.session.clientId,
    role: req.session.role,
    loginAt: req.session.loginAt,
  };
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Could not start a session" });
    if (workspaceIdentity.userId) req.session.userId = workspaceIdentity.userId;
    if (workspaceIdentity.username) req.session.username = workspaceIdentity.username;
    if (workspaceIdentity.clientId) req.session.clientId = workspaceIdentity.clientId;
    if (workspaceIdentity.role) req.session.role = workspaceIdentity.role;
    if (workspaceIdentity.loginAt) req.session.loginAt = workspaceIdentity.loginAt;
    req.session.cworksAuthed = true;
    req.session.cworksLoginAt = Date.now();
    req.session.cworksReviewerSessionId = randomUUID();
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: "Could not start a session" });
      res.json({ ok: true });
    });
  });
});

router.post("/auth/logout", (req, res) => {
  req.session.cworksAuthed = false;
  req.session.save(() => res.json({ ok: true }));
});

router.get("/auth/status", async (req, res) => {
  const authenticated = req.session.cworksAuthed === true;
  const userId = req.session.userId;
  const role = req.session.role;
  if (!authenticated || !userId || !role) {
    return res.json({
      authenticated,
      workspaceIdentity: null,
      derivativeReviewAuthorized: false,
    });
  }
  const [user] = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    displayName: users.displayName,
    role: users.role,
    status: users.status,
  }).from(users).where(eq(users.id, userId)).limit(1);
  const identityValid = Boolean(user && user.status === "active" && user.role === role);
  res.json({
    authenticated,
    workspaceIdentity: identityValid ? {
      id: user!.id,
      name: user!.displayName?.trim() || user!.email?.trim() || user!.username,
      role: user!.role,
    } : null,
    derivativeReviewAuthorized: identityValid && CAD_DERIVATIVE_REVIEWER_ROLES.has(role),
  });
});

router.use((req, res, next) => {
  if (req.session.cworksAuthed === true) return next();
  res.status(401).json({ error: "Unauthorized" });
});

// --- Job routes ---------------------------------------------------------------

function publicJob(job: typeof cworksTranslationJobs.$inferSelect) {
  const {
    sourceStoredName: _sourceStoredName,
    outputStoredName: _outputStoredName,
    summaryStoredName: _summaryStoredName,
    ledgerStoredName: _ledgerStoredName,
    preservationStoredName: _preservationStoredName,
    runToken: _runToken,
    leaseExpiresAt: _leaseExpiresAt,
    repairBrief: _repairBrief,
    ...safe
  } = job;
  return safe;
}

type RetryMode = "resume" | "restart" | "full_restart";

type RetryMetadata = {
  resumeAvailable: boolean;
  resumeEligibility: "unavailable" | "provisional";
  fullRestartAvailable: boolean;
  checkpointCount: number;
  checkpointRevision: number | null;
  resumeReason: string;
  resumeValidationNote: string;
  fullRestartWarning: string;
};

type DownloadAvailability = {
  original: boolean;
  output: boolean;
  summary: boolean;
  ledger: boolean;
  preservationReport: boolean;
  tableScript: boolean;
  draftDxf: boolean;
};

type ObjectAvailability = Pick<
  DownloadAvailability,
  "original" | "output" | "summary" | "ledger" | "preservationReport"
>;

const FULL_RESTART_WARNING =
  "A full restart discards saved checkpoints and repeats AI translation and audit work. Provider usage and charges may occur again.";

type RetryCheckpointEvidence = {
  translations: unknown;
  updatedAt: Date | string;
};

export function retryMetadataFromEvidence(
  job: typeof cworksTranslationJobs.$inferSelect,
  rows: RetryCheckpointEvidence[],
  sourceSha256: string | null = null,
): RetryMetadata {
  const checkpointRevision = rows.length ? job.revisionCount : null;
  if (!rows.length) {
    return {
      resumeAvailable: false,
      resumeEligibility: "unavailable",
      fullRestartAvailable: job.status === "failed",
      checkpointCount: 0,
      checkpointRevision,
      resumeReason: "No durable checkpoint is available for this revision",
      resumeValidationNote: "No checkpoint can be offered for resume.",
      fullRestartWarning: FULL_RESTART_WARNING,
    };
  }

  if (job.sourceFormat !== "dxf") {
    // PDF checkpoint rows are validated again by the worker against each
    // page's source hash and methodology. A non-empty row is enough to offer
    // resume; invalid rows are ignored by the worker rather than reused.
    const resumeAvailable = rows.some((row) =>
      Array.isArray(row.translations) && row.translations.length > 0);
    return {
      resumeAvailable,
      resumeEligibility: resumeAvailable ? "provisional" : "unavailable",
      fullRestartAvailable: job.status === "failed",
      checkpointCount: rows.length,
      checkpointRevision,
      resumeReason: resumeAvailable
        ? "Saved PDF page checkpoints will be revalidated before reuse"
        : "The saved PDF checkpoint is empty",
      resumeValidationNote: resumeAvailable
        ? "The worker performs final source-hash and page validation before any provider request; that validation may block resume."
        : "No valid saved page translation is available for resume.",
      fullRestartWarning: FULL_RESTART_WARNING,
    };
  }

  // Native DXF checkpoints are envelopes, not PDF translation arrays. Check
  // every binding that the route can observe here; the worker repeats the
  // same fail-closed check after inspecting the source placement manifest.
  const row = [...rows].sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  const value = row?.translations as any;
  let resumeReason = "No eligible native DXF checkpoint is available";
  let resumeAvailable = false;
  let resumeValidationNote = "No checkpoint can be offered for resume.";
  if (!sourceSha256) {
    resumeReason = "The source DXF is unavailable, so checkpoint reuse is blocked";
  } else if (!value || typeof value !== "object" || Array.isArray(value)) {
    resumeReason = "The saved native DXF checkpoint has no binding envelope";
  } else if (!SHA256_PATTERN.test(String(value.methodologyHash || ""))) {
    resumeReason = "The native DXF checkpoint methodology binding is invalid";
  } else {
    const targetLanguage = job.targetLanguage === "ja" ? "ja" : "en";
    const placementManifestSha256 = typeof value.placementManifestSha256 === "string"
      ? value.placementManifestSha256
      : null;
    if (placementManifestSha256 && !SHA256_PATTERN.test(placementManifestSha256)) {
      resumeReason = "The native DXF checkpoint placement binding is malformed";
      resumeValidationNote = "A malformed placement binding cannot be offered for resume.";
    } else {
      // The current placement manifest only exists after the worker inspects
      // the source. Strip the saved value from this route-side comparison so
      // metadata cannot claim that a checkpoint matches itself. The worker
      // receives a durable resume intent and performs the exact comparison
      // before any AI/provider request.
      const sourcePolicyCheckpoint = {
        ...value,
        placementManifestSha256: null,
      };
      const eligibility = nativeDxfCheckpointResumeEligibility(sourcePolicyCheckpoint, {
        sourceSha256,
        revisionCount: job.revisionCount,
        targetLanguage,
        methodologyHash: nativeDxfCheckpointMethodologyHash(targetLanguage),
        placementManifestSha256: null,
      });
      resumeAvailable = eligibility.eligible;
      resumeReason = eligibility.eligible
        ? `Provisional native DXF source/revision/language/policy eligibility at ${eligibility.stage || "saved"} stage`
        : `Native DXF checkpoint is not eligible (${eligibility.reason})`;
      resumeValidationNote = eligibility.eligible
        ? "Final worker inspection must verify the current placement manifest before any AI/provider request; a mismatch aborts resume and requires an explicit full restart."
        : "The worker will not reuse this checkpoint.";
    }
  }
  return {
    resumeAvailable,
    resumeEligibility: resumeAvailable ? "provisional" : "unavailable",
    fullRestartAvailable: job.status === "failed",
    checkpointCount: rows.length,
    checkpointRevision,
    resumeReason,
    resumeValidationNote,
    fullRestartWarning: FULL_RESTART_WARNING,
  };
}

async function retryMetadataForJob(
  job: typeof cworksTranslationJobs.$inferSelect,
): Promise<RetryMetadata> {
  const targetedCorrection = isNativeDxfTargetedCorrectionBrief(job.repairBrief)
    ? job.repairBrief
    : null;
  if (
    targetedCorrection
    && (
      targetedCorrection.sourceRevision !== job.revisionCount - 1
      || targetedCorrection.targetLanguage !== (job.targetLanguage === "ja" ? "ja" : "en")
    )
  ) {
    return {
      resumeAvailable: false,
      resumeEligibility: "unavailable",
      fullRestartAvailable: job.status === "failed",
      checkpointCount: 0,
      checkpointRevision: null,
      resumeReason: "The targeted correction predecessor binding is invalid",
      resumeValidationNote: "A targeted correction can resume only from its exact predecessor checkpoint.",
      fullRestartWarning: FULL_RESTART_WARNING,
    };
  }
  // A correction successor can fail before it has saved its own checkpoint.
  // Its valid, immutable brief deliberately binds resume to the predecessor
  // checkpoint; normal DXF retries still validate the current revision.
  const checkpointRevision = targetedCorrection?.sourceRevision ?? job.revisionCount;
  const rows = await db.select().from(cworksTranslationCheckpoints).where(and(
    eq(cworksTranslationCheckpoints.jobId, job.id),
    eq(cworksTranslationCheckpoints.revisionCount, checkpointRevision),
  ));
  if (job.sourceFormat !== "dxf") {
    return retryMetadataFromEvidence(job, rows);
  }
  // Exact source binding is only needed for a failed native DXF retry. This
  // path is never called for running/polling jobs.
  const source = job.sourceStoredName
    ? await readFileFromObjectStorage(job.sourceStoredName)
    : null;
  return retryMetadataFromEvidence(
    targetedCorrection ? { ...job, revisionCount: checkpointRevision } : job,
    rows,
    source ? sha256Bytes(source) : null,
  );
}

export function retryRepairBriefForRequest(
  job: typeof cworksTranslationJobs.$inferSelect,
  mode: "resume" | "full_restart",
): unknown {
  const current = job.repairBrief;
  const existing = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : null;
  if (job.sourceFormat !== "dxf") return current;
  if (isNativeDxfTargetedCorrectionBrief(current)) {
    // A failed targeted successor must retain its immutable, charge-limited
    // correction instruction. Replacing it with the generic DXF resume intent
    // would discard the predecessor binding and could cause a broad rerun.
    return mode === "resume" ? current : null;
  }
  if (mode === "resume") {
    // repair_brief is existing JSONB durable job metadata. The native worker
    // treats this exact kind/mode as an explicit fail-closed resume intent.
    // Keep the source revision so a queued intent can never float to a later
    // revision after a review transition.
    return {
      kind: NATIVE_DXF_RETRY_BRIEF_KIND,
      mode: "resume",
      sourceRevision: job.revisionCount,
      targetLanguage: job.targetLanguage === "ja" ? "ja" : "en",
      provisionalPlacementValidation: true,
    };
  }
  if (existing?.kind === NATIVE_DXF_RETRY_BRIEF_KIND) {
    // A full restart must not leave a stale resume instruction behind.
    return null;
  }
  return current;
}

export function downloadAvailabilityFromMetadata(
  job: typeof cworksTranslationJobs.$inferSelect,
  objects: ObjectAvailability,
): DownloadAvailability {
  const base: DownloadAvailability = {
    ...objects,
    ledger: false,
    preservationReport: false,
    tableScript: false,
    draftDxf: false,
  };
  if (job.sourceFormat !== "dxf" || !REVIEW_VISIBLE_STATUSES.has(job.status)) {
    return base;
  }
  base.ledger = objects.ledger;
  base.preservationReport = objects.preservationReport;
  // These links are gated by the same status/pointer checks as their
  // download endpoints. The endpoints perform any byte/hash validation only
  // after the user requests the artifact; polling must never download a DXF.
  base.tableScript = base.ledger;
  base.draftDxf = job.status === "awaiting_review"
    && base.original
    && base.output
    && base.ledger;
  if (job.status === "done") {
    const releaseAllowed = job.approvedRevision !== null
      && job.approvedRevision === job.revisionCount
      && Boolean(job.approvedAt);
    base.original = releaseAllowed && base.original;
    base.output = releaseAllowed && base.output;
    base.ledger = releaseAllowed && base.ledger;
    base.preservationReport = releaseAllowed && base.preservationReport;
    base.tableScript = releaseAllowed && base.tableScript;
  }
  return base;
}

export type ObjectMetadataReader = (storedName: string | null) => Promise<unknown | null>;

export async function downloadAvailabilityForJob(
  job: typeof cworksTranslationJobs.$inferSelect,
  metadataReader?: ObjectMetadataReader,
): Promise<DownloadAvailability> {
  const readMetadata: ObjectMetadataReader = metadataReader || (async (storedName) => {
    if (!storedName) return null;
    try {
      return await getObjectStorageMetadata(storedName);
    } catch {
      return null;
    }
  });
  const [originalMetadata, outputMetadata, summaryMetadata] = await Promise.all([
    readMetadata(job.sourceStoredName),
    readMetadata(job.outputStoredName),
    readMetadata(job.summaryStoredName),
  ]);
  const objects: ObjectAvailability = {
    original: Boolean(originalMetadata),
    output: Boolean(outputMetadata),
    summary: Boolean(summaryMetadata),
    ledger: false,
    preservationReport: false,
  };
  if (job.sourceFormat !== "dxf" || !REVIEW_VISIBLE_STATUSES.has(job.status)) {
    return downloadAvailabilityFromMetadata(job, objects);
  }
  const [ledgerMetadata, preservationMetadata] = await Promise.all([
    readMetadata(job.ledgerStoredName),
    readMetadata(job.preservationStoredName),
  ]);
  return downloadAvailabilityFromMetadata(job, {
    ...objects,
    ledger: Boolean(ledgerMetadata),
    preservationReport: Boolean(preservationMetadata),
  });
}

// Review pages/thumbnails (and published outputs) belong to the last
// atomically published revision. They must never be served while a job is
// mid-run or mid-revision, so partial work is never exposed.
const REVIEW_VISIBLE_STATUSES = new Set(["awaiting_review", "done"]);

function publicCoverage(
  pages: Array<typeof cworksTranslationPages.$inferSelect>,
  sourceFormat: string,
) {
  const placedLineCount = pages.reduce((sum, page) => sum + page.translatedBlockCount, 0);
  return publicCoverageWithTranslations(pages, [], {
    recoveredLineCount: 0,
    translatedLineCount: placedLineCount,
  }, sourceFormat);
}

export function publicCoverageWithTranslations(
  pages: Array<typeof cworksTranslationPages.$inferSelect>,
  translations: unknown[],
  publishedCounts?: { recoveredLineCount: number; translatedLineCount: number } | null,
  sourceFormat = "pdf",
) {
  const targetLineCount = pages.reduce((sum, page) => sum + page.sourceBlockCount, 0);
  const placedLineCount = pages.reduce((sum, page) => sum + page.translatedBlockCount, 0);
  const nativeDxf = sourceFormat === "dxf";
  const recoveredLineCount = translations.length
    ? translations.filter((item: any) => item?.recoveredFromVisual === true).length
    : publishedCounts?.recoveredLineCount ?? 0;
  const translatedLineCount = nativeDxf
    ? placedLineCount
    : translations.length
    ? translations.filter(
        (item: any) =>
          item
          && item.uncertain !== true
          && typeof item.translation === "string"
          && item.translation.trim().length > 0,
      ).length
    : publishedCounts?.translatedLineCount ?? 0;
  const unresolvedLineCount = Math.max(
    0,
    targetLineCount - Math.min(placedLineCount, translatedLineCount),
  );
  return {
    targetLineCount,
    recoveredLineCount,
    translatedLineCount,
    placedLineCount,
    unresolvedLineCount,
    placementPercent: targetLineCount
      ? Math.round((placedLineCount / targetLineCount) * 1_000) / 10
      : 100,
    complete: targetLineCount > 0
      && translatedLineCount === targetLineCount
      && placedLineCount === targetLineCount,
    severelyIncomplete: isCworksCoverageSeverelyIncomplete(
      targetLineCount,
      placedLineCount,
    ),
  };
}

const CAD_OPERATOR_ATTESTATION =
  "I attest as the qualified CAD operator that the translated DXF opened without repair warnings and that geometry, layouts, title blocks, and text were checked.";
const CAD_DERIVATIVE_ATTESTATION =
  "I attest that I am the identified qualified CAD operator, that I created and checked this human-edited CAD derivative from the linked approved native DXF revision, and that this derivative is not preservation proof and makes no byte-preservation claim.";
const CAD_HYBRID_DERIVATIVE_ATTESTATION =
  "I attest that I am the identified qualified CAD operator, that this derivative was created from the exact source-bound hybrid DXF revision in Windows AutoCAD with Unicode LISPSYS enabled, that I verified the source, script, and manifest hashes before applying, discarded any partial-application artifact, saved, closed, reopened, and inspected the derivative DWG, that the recorded script counters and manual coverage resolutions are complete and accurate, and that this derivative does not inherit byte-preservation proof.";
const CAD_DERIVATIVE_REVIEW_DECLARATION =
  "I confirm that I am qualified to review this engineering CAD derivative, checked the exact recorded derivative hash and source-bound evidence, checked every review page and finding, and accept responsibility for releasing this derivative.";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TABLE_SCRIPT_MAX_BYTES = 2 * 1024 * 1024;
const DXF_PROOF_FIELDS = [
  "unchangedEntityPropertiesVerified",
  "metadataIdentical",
  "nonTextRecordsIdentical",
  "reparsedCleanly",
  "lineEndingPreserved",
  "nonApprovedSegmentsIdentical",
] as const;

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type ArchivedCworksArtifact = {
  kind: string;
  storedName: string;
  sha256: string | null;
};

async function archiveCworksArtifactsForRevision(
  job: typeof cworksTranslationJobs.$inferSelect,
  pages: Array<typeof cworksTranslationPages.$inferSelect>,
) {
  const pointers: Array<{ kind: string; storedName: string | null }> = [
    { kind: "source", storedName: job.sourceStoredName },
    { kind: "translated_output", storedName: job.outputStoredName },
    { kind: "summary", storedName: job.summaryStoredName },
    { kind: "ledger", storedName: job.ledgerStoredName },
    { kind: "preservation_report", storedName: job.preservationStoredName },
    ...pages.flatMap((page) => [
      { kind: `page_${page.pageNumber}_thumbnail`, storedName: page.thumbnailStoredName },
      { kind: `page_${page.pageNumber}_source_thumbnail`, storedName: page.sourceThumbnailStoredName },
    ]),
  ].filter((pointer): pointer is { kind: string; storedName: string } => Boolean(pointer.storedName));
  const priorArtifacts: ArchivedCworksArtifact[] = await Promise.all(pointers.map(async (pointer) => {
    const bytes = await readFileFromObjectStorage(pointer.storedName);
    return {
      ...pointer,
      // Retain a null value rather than inventing a hash if a historical
      // pointer was already unavailable when the new revision was requested.
      sha256: bytes ? sha256Bytes(bytes) : null,
    };
  }));
  return {
    priorArtifacts,
    priorPageFindings: pages.map((page) => ({
      pageNumber: page.pageNumber,
      machineAuditStatus: page.machineAuditStatus,
      machineAuditFindings: Array.isArray(page.machineAuditFindings)
        ? page.machineAuditFindings
        : [],
    })),
  };
}

function findingTargetIds(finding: unknown): string[] {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return [];
  const value = finding as Record<string, unknown>;
  return [value.sourceBlockId, value.targetId].filter((id): id is string =>
    typeof id === "string" && Boolean(id));
}

/**
 * Reviewer resolution is authoritative for audit findings. The checkpoint
 * ledger is otherwise immutable; create a narrow selection view rather than
 * mutating that evidence. `unresolved` is intentionally retained because it
 * records independent translation/placement reasons, not a reviewed finding.
 */
function checkpointExcludingResolvedAuditFindings(
  checkpoint: unknown,
  resolvedFindingTargetIds: ReadonlySet<string>,
): unknown {
  if (
    !resolvedFindingTargetIds.size
    || !checkpoint
    || typeof checkpoint !== "object"
    || Array.isArray(checkpoint)
  ) return checkpoint;
  const envelope = checkpoint as Record<string, unknown>;
  const ledger = envelope.ledger;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return checkpoint;
  const filterResolved = (value: unknown) => Array.isArray(value)
    ? value.filter((finding) =>
      !findingTargetIds(finding).some((targetId) => resolvedFindingTargetIds.has(targetId)))
    : value;
  const currentLedger = ledger as Record<string, unknown>;
  const independentAudit = currentLedger.independentAudit;
  return {
    ...envelope,
    ledger: {
      ...currentLedger,
      blockingFindings: filterResolved(currentLedger.blockingFindings),
      independentAudit: independentAudit
        && typeof independentAudit === "object"
        && !Array.isArray(independentAudit)
        ? {
            ...(independentAudit as Record<string, unknown>),
            findings: filterResolved((independentAudit as Record<string, unknown>).findings),
            rawFindings: filterResolved((independentAudit as Record<string, unknown>).rawFindings),
          }
        : independentAudit,
    },
  };
}

type ValidatedNativeDxfTableScript = {
  script: string;
  sha256: string;
  manifestSha256: string;
  targetCount: number;
  expectedAppliedCount: number;
};

export function validateNativeDxfTableScriptLedger(
  ledger: any,
  targetLanguage: "en" | "ja" = "en",
): ValidatedNativeDxfTableScript | null {
  const hasHybridEvidence = ledger?.tableScript !== undefined
    || ledger?.tableTargets !== undefined
    || ledger?.scriptAccounting !== undefined;
  // Ledgers written before safe-hybrid support remain valid release evidence.
  if (!hasHybridEvidence) return null;
  const tableScript = ledger?.tableScript;
  const tableTargets = ledger?.tableTargets;
  if (!Array.isArray(tableTargets)) throw new Error("DXF_TABLE_SCRIPT_INVALID");

  const targetIds = new Set<string>();
  const ordered = [...tableTargets].sort((left: any, right: any) =>
    String(left?.targetId) < String(right?.targetId)
      ? -1
      : String(left?.targetId) > String(right?.targetId) ? 1 : 0);
  const deduped = new Map<string, any>();
  for (const entry of ordered) {
    const replacement = entry?.replacement ?? entry?.translation;
    const sourceSha256 = entry?.sourceSha256 ?? entry?.sourceTextSha256;
    if (
      typeof entry?.targetId !== "string"
      || !entry.targetId
      || targetIds.has(entry.targetId)
      || typeof entry?.tableHandle !== "string"
      || !/^[0-9a-f]+$/i.test(entry.tableHandle)
      || !Number.isInteger(entry?.sourceOrdinal)
      || entry.sourceOrdinal < 0
      || !Number.isInteger(entry?.sourceOccurrenceCount)
      || entry.sourceOccurrenceCount < 1
      || typeof entry?.source !== "string"
      || !entry.source
      || !SHA256_PATTERN.test(sourceSha256 || "")
      || !entry.targetId.startsWith(`ACAD_TABLE:${entry.tableHandle.toUpperCase()}:`)
      || !entry.targetId.endsWith(`:${sourceSha256}`)
      || typeof replacement !== "string"
      || !replacement.trim()
      || entry?.accounting !== "translated_pending_table_script"
      || !isNativeDxfTargetLanguageText(entry.source, replacement, targetLanguage)
      || sha256Bytes(Buffer.from(entry.source, "utf8")) !== sourceSha256
    ) throw new Error("DXF_TABLE_SCRIPT_INVALID");
    targetIds.add(entry.targetId);
    const tableHandle = entry.tableHandle.toUpperCase();
    const key = `${tableHandle}\0${entry.source}`;
    const existing = deduped.get(key);
    if (existing) {
      if (existing.translation !== replacement) throw new Error("DXF_TABLE_SCRIPT_INVALID");
      existing.sourceOccurrenceCount += entry.sourceOccurrenceCount;
    } else {
      deduped.set(key, {
        targetId: entry.targetId,
        tableHandle,
        sourceOrdinal: entry.sourceOrdinal,
        sourceOccurrenceCount: entry.sourceOccurrenceCount,
        source: entry.source,
        translation: replacement,
      });
    }
  }
  const manifest = [...deduped.values()];
  const manifestSha256 = sha256Bytes(Buffer.from(JSON.stringify(manifest), "utf8"));
  const expectedAppliedCount = manifest.reduce(
    (sum: number, target: any) => sum + target.sourceOccurrenceCount,
    0,
  );
  if (
    tableScript?.format !== "cworks-dxf-table-script-v1"
    || tableScript?.command !== "CWORKS_APPLY_TABLE_TRANSLATIONS"
    || typeof tableScript?.script !== "string"
    || Buffer.byteLength(tableScript.script, "utf8") < 1
    || Buffer.byteLength(tableScript.script, "utf8") > TABLE_SCRIPT_MAX_BYTES
    || !SHA256_PATTERN.test(tableScript?.sha256 || "")
    || tableScript.sha256 !== sha256Bytes(Buffer.from(tableScript.script, "utf8"))
    || !SHA256_PATTERN.test(tableScript?.manifestSha256 || "")
    || tableScript.manifestSha256 !== manifestSha256
    || tableScript.targetCount !== manifest.length
    || tableScript.expectedAppliedCount !== expectedAppliedCount
  ) throw new Error("DXF_TABLE_SCRIPT_INVALID");
  return {
    script: tableScript.script,
    sha256: tableScript.sha256,
    manifestSha256,
    targetCount: manifest.length,
    expectedAppliedCount,
  };
}

export function nativeDxfNeedsCadDerivative(ledger: any): boolean {
  const coverage = ledger?.hybridCoverage;
  return (Array.isArray(ledger?.tableTargets) && ledger.tableTargets.length > 0)
    || (Array.isArray(ledger?.unresolvedVisibleText) && ledger.unresolvedVisibleText.length > 0)
    || coverage?.opaqueReviewRequired === true
    || ["pendingTableTargetCount", "pendingTableCellCount", "unresolvedVisibleTextCount", "unplacedTargetCount"]
      .some((key) => Number(coverage?.[key]) > 0);
}

export function validateNativeDxfApprovalEvidence(
  reportBytes: Buffer,
  ledgerBytes: Buffer,
  sourceBytes: Buffer,
  outputBytes: Buffer,
  targetLanguage: "en" | "ja" = "en",
): {
  sourceSha256: string;
  translatedOutputSha256: string;
  preservationReportSha256: string;
  ledgerSha256: string;
  tableScriptSha256: string | null;
  tableManifestSha256: string | null;
  tableTargetCount: number;
} {
  let report: any;
  let ledger: any;
  try {
    report = JSON.parse(reportBytes.toString("utf8"));
    ledger = JSON.parse(ledgerBytes.toString("utf8"));
  } catch {
    throw new Error("DXF_APPROVAL_EVIDENCE_INVALID");
  }
  const patch = report?.patch;
  const evidenceTargetLanguage = (value: unknown): "en" | "ja" | null =>
    value === undefined || value === null
      ? "en"
      : value === "en" || value === "ja"
        ? value
        : null;
  const ledgerPatch = ledger?.patch;
  const sourceSha256 = sha256Bytes(sourceBytes);
  const translatedOutputSha256 = sha256Bytes(outputBytes);
  const entries = ledger?.entries;
  const approvedChanges = patch?.approvedChanges;
  const entryTargetIds = new Set<string>();
  const approvedTargetIds = new Set<string>();
  const placementIds = new Set<string>();
  let validatedTableScript: ValidatedNativeDxfTableScript | null;
  try {
    validatedTableScript = validateNativeDxfTableScriptLedger(ledger, targetLanguage);
  } catch {
    throw new Error("DXF_APPROVAL_EVIDENCE_INVALID");
  }
  const scriptAccounting = ledger?.scriptAccounting;
  const scriptAccountingValid = !validatedTableScript || (
    scriptAccounting?.sha256 === validatedTableScript.sha256
    && scriptAccounting?.manifestSha256 === validatedTableScript.manifestSha256
    && scriptAccounting?.targetCount === validatedTableScript.targetCount
    && scriptAccounting?.expectedAppliedCount === validatedTableScript.expectedAppliedCount
    && scriptAccounting?.pendingManualApplicationCount === validatedTableScript.targetCount
    && scriptAccounting?.blockingCount === 0
  );
  const entriesValid = Array.isArray(entries) && entries.every((entry: any) => {
    const targetId = entry?.targetId ?? entry?.handle;
    if (
      typeof targetId !== "string"
      || !targetId.trim()
      || typeof entry?.handle !== "string"
      || !entry.handle.trim()
      || entryTargetIds.has(targetId)
    ) return false;
    entryTargetIds.add(targetId);
    if (
      !Number.isInteger(entry.placementCount)
      || entry.placementCount < 0
      || !Array.isArray(entry.placements)
      || entry.placements.length !== entry.placementCount
      || !entry.placements.every((placement: any) => {
        if (
          typeof placement?.placementId !== "string"
          || !placement.placementId
          || placementIds.has(placement.placementId)
          || !Number.isFinite(placement?.x)
          || !Number.isFinite(placement?.y)
          || !Array.isArray(placement?.insertPath)
          || !placement.insertPath.every((part: any) => typeof part === "string" && part)
        ) return false;
        placementIds.add(placement.placementId);
        return true;
      })
    ) return false;
    if (entry.isCyrillicTarget === true) {
      if (entry.accounting === "translated_and_patched") {
        return isNativeDxfTargetLanguageText(
          entry.plain,
          entry.replacement,
          targetLanguage,
        );
      }
      return entry.accounting === "preserved"
        && typeof entry.preservationReason === "string"
        && entry.preservationReason.trim().length > 0;
    }
    return entry.isCyrillicTarget === false && entry.accounting === "non_target";
  });
  const approvedChangesValid = Array.isArray(approvedChanges)
    && approvedChanges.every((change: any) => {
      const targetId = change?.targetId ?? change?.handle;
      if (
        typeof targetId !== "string"
        || !targetId.trim()
        || typeof change?.handle !== "string"
        || !change.handle.trim()
        || approvedTargetIds.has(targetId)
      ) return false;
      approvedTargetIds.add(targetId);
      return true;
    });
  const translatedTargetIds = new Set(
    Array.isArray(entries)
      ? entries.filter((entry: any) =>
        entry?.isCyrillicTarget === true
        && entry?.accounting === "translated_and_patched")
        .map((entry: any) => entry.targetId ?? entry.handle)
      : [],
  );
  const translatedMatchesApproved = translatedTargetIds.size === approvedTargetIds.size
    && [...translatedTargetIds].every((targetId) => approvedTargetIds.has(targetId));
  const placementCount = Array.isArray(entries)
    ? entries.reduce((sum: number, entry: any) => sum + (Number(entry?.placementCount) || 0), 0)
    : -1;
  if (
    nativeDxfNeedsCadDerivative(ledger)
    || report?.format !== "cworks-dxf-preservation-v1"
    || !SHA256_PATTERN.test(report?.sourceSha256)
    || ledger?.format !== "cworks-native-dxf-ledger-v1"
    || !SHA256_PATTERN.test(ledger?.sourceSha256)
    || patch?.format !== "dxf-surgical-patch-v1"
    || !SHA256_PATTERN.test(patch?.sourceSha256)
    || !SHA256_PATTERN.test(patch?.outputSha256)
    || report.sourceSha256 !== patch.sourceSha256
    || ledger.sourceSha256 !== sourceSha256
    || patch.sourceSha256 !== sourceSha256
    || patch.outputSha256 !== translatedOutputSha256
    || !Array.isArray(patch?.unresolved)
    || patch.unresolved.length !== 0
    || !Array.isArray(ledger?.unresolved)
    || ledger.unresolved.length !== 0
    || !Array.isArray(ledger?.blockingFindings)
    || ledger.blockingFindings.length !== 0
    || !isDeepStrictEqual(ledgerPatch, patch)
    || !entriesValid
    || !scriptAccountingValid
    || !approvedChangesValid
    || !Number.isInteger(patch?.accountedVisibleTextCount ?? patch?.accountedMtextCount)
    || (patch.accountedVisibleTextCount ?? patch.accountedMtextCount) !== entries.length
    || !SHA256_PATTERN.test(patch?.placementManifestSha256)
    || patch.placementManifestSha256 !== ledger?.placementManifestSha256
    || patch.placementManifestSha256 !== report?.placementManifestSha256
    || !Number.isInteger(patch?.placementCount)
    || patch.placementCount !== ledger?.placementCount
    || patch.placementCount !== report?.placementCount
    || patch.placementCount !== placementCount
    || patch.placementCount !== placementIds.size
    || !translatedMatchesApproved
    || evidenceTargetLanguage(report?.targetLanguage) !== targetLanguage
    || evidenceTargetLanguage(ledger?.targetLanguage) !== targetLanguage
    || evidenceTargetLanguage(patch?.targetLanguage) !== targetLanguage
    || DXF_PROOF_FIELDS.some((field) => patch?.[field] !== true)
  ) {
    throw new Error("DXF_APPROVAL_EVIDENCE_INVALID");
  }
  return {
    sourceSha256,
    translatedOutputSha256,
    preservationReportSha256: sha256Bytes(reportBytes),
    ledgerSha256: sha256Bytes(ledgerBytes),
    tableScriptSha256: validatedTableScript?.sha256 ?? null,
    tableManifestSha256: validatedTableScript?.manifestSha256 ?? null,
    tableTargetCount: validatedTableScript?.targetCount ?? 0,
  };
}

type NativeDxfApprovalEvidence = ReturnType<typeof validateNativeDxfApprovalEvidence>;

type NativeDxfDraftEvidence = {
  sourceSha256: string;
  translatedOutputSha256: string;
  preservationReportSha256: string;
  ledgerSha256: string;
  placementManifestSha256: string;
  tableScriptSha256: string;
  tableManifestSha256: string;
  tableTargetCount: number;
  expectedAppliedCount: number;
  manualRequirementIds: string[];
  machineDefectCount: number;
  independentAuditModel: string;
  applicationOutputCaptureSupported: boolean;
};

function tableScriptSupportsCapturedApplicationOutput(
  tableScript: { script: string; manifestSha256: string },
): boolean {
  const begin = `CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=${tableScript.manifestSha256}`;
  const end = `CWORKS_APPLY_TABLE_TRANSLATIONS_END manifestSha256=${tableScript.manifestSha256}`;
  const beginIndex = tableScript.script.indexOf(begin);
  const endIndex = tableScript.script.indexOf(end);
  return beginIndex >= 0
    && endIndex > beginIndex
    && tableScript.script.indexOf(begin, beginIndex + begin.length) < 0
    && tableScript.script.indexOf(end, endIndex + end.length) < 0;
}

function hybridManualRequirementIds(ledger: any): string[] {
  const ids = new Set<string>();
  (Array.isArray(ledger?.unresolvedVisibleText)
    ? ledger.unresolvedVisibleText : []).forEach((finding: any, index: number) => {
      const targetId = typeof finding?.targetId === "string" && finding.targetId
        ? finding.targetId : `UNRESOLVED_VISIBLE:${index}`;
      ids.add(`visible:${targetId}`);
    });
  for (const entry of Array.isArray(ledger?.entries) ? ledger.entries : []) {
    if (
      entry?.isCyrillicTarget === true
      && Number(entry?.placementCount) === 0
      && typeof entry?.targetId === "string"
    ) ids.add(`unplaced:${entry.targetId}`);
  }
  if (ledger?.hybridCoverage?.opaqueReviewRequired === true) {
    ids.add("opaque-visibility-review");
  }
  return [...ids].sort();
}

function validateNativeDxfDraftEvidence(
  reportBytes: Buffer,
  ledgerBytes: Buffer,
  sourceBytes: Buffer,
  outputBytes: Buffer,
  targetLanguage: "en" | "ja",
): NativeDxfDraftEvidence {
  let report: any;
  let ledger: any;
  try {
    report = JSON.parse(reportBytes.toString("utf8"));
    ledger = JSON.parse(ledgerBytes.toString("utf8"));
  } catch {
    throw new Error("DXF_DRAFT_EVIDENCE_INVALID");
  }
  let tableScript: ValidatedNativeDxfTableScript | null;
  try {
    tableScript = validateNativeDxfTableScriptLedger(ledger, targetLanguage);
  } catch {
    throw new Error("DXF_DRAFT_EVIDENCE_INVALID");
  }
  const patch = ledger?.patch;
  const sourceSha256 = sha256Bytes(sourceBytes);
  const outputSha256 = sha256Bytes(outputBytes);
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const entryIds = new Set<string>();
  const placementIds = new Set<string>();
  const entriesValid = entries.every((entry: any) => {
    const targetId = entry?.targetId ?? entry?.handle;
    if (
      typeof targetId !== "string"
      || !targetId
      || typeof entry?.handle !== "string"
      || !entry.handle
      || entryIds.has(targetId)
      || !Number.isInteger(entry?.placementCount)
      || entry.placementCount < 0
      || !Array.isArray(entry?.placements)
      || entry.placements.length !== entry.placementCount
    ) return false;
    entryIds.add(targetId);
    if (!entry.placements.every((placement: any) => {
      if (
        typeof placement?.placementId !== "string"
        || !placement.placementId
        || placementIds.has(placement.placementId)
        || !Number.isFinite(placement?.x)
        || !Number.isFinite(placement?.y)
        || !Array.isArray(placement?.insertPath)
        || !placement.insertPath.every((part: any) => typeof part === "string" && part)
      ) return false;
      placementIds.add(placement.placementId);
      return true;
    })) return false;
    if (entry.isCyrillicTarget === true) {
      if (entry.accounting === "translated_and_patched") {
        return isNativeDxfTargetLanguageText(entry.plain, entry.replacement, targetLanguage);
      }
      return entry.accounting === "preserved"
        && typeof entry.preservationReason === "string"
        && entry.preservationReason.trim().length > 0;
    }
    return entry.isCyrillicTarget === false && entry.accounting === "non_target";
  });
  const approvedIds = new Set<string>();
  const approvedChangesValid = Array.isArray(patch?.approvedChanges)
    && patch.approvedChanges.every((change: any) => {
      const targetId = change?.targetId ?? change?.handle;
      if (
        typeof targetId !== "string"
        || !targetId
        || typeof change?.handle !== "string"
        || !change.handle
        || approvedIds.has(targetId)
      ) return false;
      approvedIds.add(targetId);
      return true;
    });
  const translatedIds = new Set(entries.filter((entry: any) =>
    entry?.isCyrillicTarget === true && entry?.accounting === "translated_and_patched")
    .map((entry: any) => entry?.targetId ?? entry?.handle));
  const translatedMatchesApproved = translatedIds.size === approvedIds.size
    && [...translatedIds].every((id) => approvedIds.has(id));
  const placementCount = entries.reduce((sum: number, entry: any) =>
    sum + (Number(entry?.placementCount) || 0), 0);
  const evidenceTargetLanguage = (value: unknown): "en" | "ja" | null =>
    value === undefined || value === null
      ? "en" : value === "en" || value === "ja" ? value : null;
  const independentAudit = ledger?.independentAudit;
  const tableById = new Map((Array.isArray(ledger?.tableTargets)
    ? ledger.tableTargets : []).map((target: any) => [
      target?.targetId,
      { sourceText: target?.source },
    ]));
  const tableTranslations = new Map((Array.isArray(ledger?.tableTargets)
    ? ledger.tableTargets : []).map((target: any) => [
      target?.targetId,
      target?.translation,
    ]));
  const normalizedAudit = Array.isArray(independentAudit?.rawFindings)
    ? normalizeNativeDxfHybridAuditFindings(
        independentAudit.rawFindings,
        tableById,
        tableTranslations,
        targetLanguage,
      )
    : null;
  const unresolvedVisibleText = Array.isArray(ledger?.unresolvedVisibleText)
    ? ledger.unresolvedVisibleText : [];
  const derivedUnplacedTargetCount = entries.filter((entry: any) =>
    entry?.isCyrillicTarget === true && entry?.placementCount === 0).length;
  const manualTargets = Array.isArray(ledger?.manualRequirements?.targets)
    ? ledger.manualRequirements.targets : [];
  const expectedManualTargets = (Array.isArray(ledger?.tableTargets)
    ? ledger.tableTargets : []).map((target: any) => ({
      targetId: target?.targetId,
      tableHandle: target?.tableHandle,
      sourceSha256: target?.sourceSha256 ?? target?.sourceTextSha256,
      sourceOccurrenceCount: target?.sourceOccurrenceCount,
    }));
  if (
    !nativeDxfNeedsCadDerivative(ledger)
    || !tableScript
    || report?.format !== "cworks-dxf-preservation-v1"
    || ledger?.format !== "cworks-native-dxf-ledger-v1"
    || patch?.format !== "dxf-surgical-patch-v1"
    || evidenceTargetLanguage(ledger?.targetLanguage) !== targetLanguage
    || evidenceTargetLanguage(report?.targetLanguage) !== targetLanguage
    || evidenceTargetLanguage(patch?.targetLanguage) !== targetLanguage
    || ledger?.sourceSha256 !== sourceSha256
    || report?.sourceSha256 !== sourceSha256
    || patch?.sourceSha256 !== sourceSha256
    || patch?.outputSha256 !== outputSha256
    || !isDeepStrictEqual(report?.patch, patch)
    || !isDeepStrictEqual(report?.hybridCoverage, ledger?.hybridCoverage)
    || !isDeepStrictEqual(report?.manualRequirements, ledger?.manualRequirements)
    || !isDeepStrictEqual(report?.independentAudit, independentAudit)
    || independentAudit?.format !== "cworks-native-dxf-independent-audit-v1"
    || typeof independentAudit?.model !== "string"
    || !independentAudit.model
    || !["passed", "findings"].includes(independentAudit?.rawStatus)
    || independentAudit?.terminalStatus !== "passed"
    || !Array.isArray(independentAudit?.findings)
    || independentAudit.findings.length !== 0
    || !Array.isArray(independentAudit?.rawFindings)
    || !Array.isArray(independentAudit?.deferredFindings)
    || !normalizedAudit
    || !isDeepStrictEqual(normalizedAudit.effectiveFindings, independentAudit.findings)
    || !isDeepStrictEqual(normalizedAudit.deferredFindings, independentAudit.deferredFindings)
    || !Number.isInteger(independentAudit?.deferredTableFindingCount)
    || independentAudit.deferredTableFindingCount !== independentAudit.deferredFindings.length
    || (independentAudit.rawStatus === "passed"
      && independentAudit.rawFindings.length !== 0)
    || (independentAudit.rawStatus === "findings"
      && independentAudit.deferredTableFindingCount < 1)
    || ledger?.hybridCoverage?.pendingTableTargetCount !== tableScript.targetCount
    || ledger?.hybridCoverage?.pendingTableCellCount !== tableScript.expectedAppliedCount
    || ledger?.hybridCoverage?.unresolvedVisibleTextCount !== unresolvedVisibleText.length
    || ledger?.hybridCoverage?.unplacedTargetCount !== derivedUnplacedTargetCount
    || typeof ledger?.hybridCoverage?.opaqueReviewRequired !== "boolean"
    || !isDeepStrictEqual(manualTargets, expectedManualTargets)
    || ledger?.manualRequirements?.sourceSha256 !== sourceSha256
    || ledger?.manualRequirements?.tableScriptSha256 !== tableScript.sha256
    || ledger?.manualRequirements?.tableManifestSha256 !== tableScript.manifestSha256
    || ledger?.manualRequirements?.placementManifestSha256 !== patch?.placementManifestSha256
    || report?.placementManifestSha256 !== patch?.placementManifestSha256
    || !SHA256_PATTERN.test(patch?.placementManifestSha256 || "")
    || !Number.isInteger(patch?.placementCount)
    || patch.placementCount !== placementCount
    || patch.placementCount !== ledger?.placementCount
    || report?.placementCount !== patch.placementCount
    || patch.placementCount !== placementIds.size
    || !entriesValid
    || !approvedChangesValid
    || !translatedMatchesApproved
    || !Number.isInteger(patch?.accountedVisibleTextCount ?? patch?.accountedMtextCount)
    || (patch.accountedVisibleTextCount ?? patch.accountedMtextCount) !== entries.length
    || ledger?.scriptAccounting?.sha256 !== tableScript.sha256
    || ledger?.scriptAccounting?.manifestSha256 !== tableScript.manifestSha256
    || ledger?.scriptAccounting?.targetCount !== tableScript.targetCount
    || ledger?.scriptAccounting?.expectedAppliedCount !== tableScript.expectedAppliedCount
    || ledger?.scriptAccounting?.pendingManualApplicationCount !== tableScript.targetCount
    || ledger?.scriptAccounting?.blockingCount !== 0
    || DXF_PROOF_FIELDS.some((field) => patch?.[field] !== true)
  ) throw new Error("DXF_DRAFT_EVIDENCE_INVALID");
  const expectedManualBlockers = unresolvedVisibleText.map((item: any, index: number) => ({
      targetId: typeof item?.targetId === "string"
        ? item.targetId : `UNRESOLVED_VISIBLE:${index}`,
      handle: typeof item?.handle === "string" ? item.handle : "visible-text",
      reason: typeof item?.reason === "string"
        ? item.reason : "visible_text_not_safely_patchable",
    }));
  const unmatchedBlockers = Array.isArray(ledger?.blockingFindings)
    ? [...ledger.blockingFindings] : [null];
  for (const expected of expectedManualBlockers) {
    const index = unmatchedBlockers.findIndex((finding) =>
      isDeepStrictEqual(finding, expected));
    if (index >= 0) unmatchedBlockers.splice(index, 1);
    else unmatchedBlockers.push({ missingExpectedManualBlocker: expected });
  }
  const machineDefectCount =
    (Array.isArray(ledger?.unresolved) ? ledger.unresolved.length : 1)
    + (Array.isArray(patch?.unresolved) ? patch.unresolved.length : 1)
    + unmatchedBlockers.length;
  return {
    sourceSha256,
    translatedOutputSha256: outputSha256,
    preservationReportSha256: sha256Bytes(reportBytes),
    ledgerSha256: sha256Bytes(ledgerBytes),
    placementManifestSha256: patch.placementManifestSha256,
    tableScriptSha256: tableScript.sha256,
    tableManifestSha256: tableScript.manifestSha256,
    tableTargetCount: tableScript.targetCount,
    expectedAppliedCount: tableScript.expectedAppliedCount,
    manualRequirementIds: hybridManualRequirementIds(ledger),
    machineDefectCount,
    independentAuditModel: independentAudit.model,
    applicationOutputCaptureSupported: tableScriptSupportsCapturedApplicationOutput(tableScript),
  };
}

async function readNativeDxfDraftEvidence(job: {
  sourceStoredName: string;
  outputStoredName: string | null;
  preservationStoredName: string | null;
  ledgerStoredName: string | null;
  targetLanguage: string;
}): Promise<NativeDxfDraftEvidence> {
  if (!job.outputStoredName || !job.preservationStoredName || !job.ledgerStoredName) {
    throw new Error("DXF_DRAFT_EVIDENCE_INVALID");
  }
  const [report, ledger, source, output] = await Promise.all([
    readFileFromObjectStorage(job.preservationStoredName),
    readFileFromObjectStorage(job.ledgerStoredName),
    readFileFromObjectStorage(job.sourceStoredName),
    readFileFromObjectStorage(job.outputStoredName),
  ]);
  if (!report || !ledger || !source || !output) throw new Error("DXF_DRAFT_EVIDENCE_INVALID");
  return validateNativeDxfDraftEvidence(
    report, ledger, source, output, job.targetLanguage === "ja" ? "ja" : "en",
  );
}

function hybridRecordedEvidenceMatches(
  recorded: any,
  current: NativeDxfDraftEvidence,
  derivativeSha256: string,
  sourceRevision: number,
): boolean {
  const resolutions = Array.isArray(recorded?.manualCoverageResolutions)
    ? recorded.manualCoverageResolutions : [];
  const resolutionIds = resolutions.map((item: any) => item?.requirementId);
  const operational = recorded?.operationalVerification;
  const applicationOutput = recorded?.applicationOutput;
  const legacyEvidence = recorded?.format === "cworks-hybrid-derivative-evidence-v1";
  const capturedOutputEvidence = recorded?.format === "cworks-hybrid-derivative-evidence-v2"
    && recordedCadTableApplicationOutputMatches(applicationOutput, current);
  return (legacyEvidence || capturedOutputEvidence)
    && recorded?.derivativeSha256 === derivativeSha256
    && recorded?.sourceRevision === sourceRevision
    && recorded?.sourceSha256 === current.sourceSha256
    && recorded?.translatedOutputSha256 === current.translatedOutputSha256
    && recorded?.preservationReportSha256 === current.preservationReportSha256
    && recorded?.ledgerSha256 === current.ledgerSha256
    && recorded?.placementManifestSha256 === current.placementManifestSha256
    && recorded?.tableScriptSha256 === current.tableScriptSha256
    && recorded?.tableManifestSha256 === current.tableManifestSha256
    && recorded?.tableTargetCount === current.tableTargetCount
    && recorded?.expectedAppliedCount === current.expectedAppliedCount
    && recorded?.independentAuditModel === current.independentAuditModel
    && isDeepStrictEqual(recorded?.counters, {
      expected: current.expectedAppliedCount,
      applied: current.expectedAppliedCount,
      missing: 0,
      ambiguous: 0,
      failed: 0,
      skipped: 0,
    })
    && new Set(resolutionIds).size === resolutionIds.length
    && resolutions.every((item: any) =>
      typeof item?.resolution === "string" && item.resolution.trim().length >= 3)
    && isDeepStrictEqual([...resolutionIds].sort(), current.manualRequirementIds)
    && operational?.platform === "windows_autocad"
    && Number.isInteger(operational?.autoCadMajorVersion)
    && operational.autoCadMajorVersion >= 2021
    && (operational?.lispSys === 1 || operational?.lispSys === 2)
    && operational?.sourceScriptManifestHashesVerified === true
    && operational?.partialApplicationEvidenceDisposition === "discarded"
    && operational?.savedClosedReopened === true
    && typeof operational?.reopenedInspectionNotes === "string"
    && operational.reopenedInspectionNotes.trim().length >= 3;
}

type CadTableApplicationOutputCounters = {
  matchedTargets: number;
  appliedCells: number;
  skippedTargets: number;
  countMismatch: number;
  unsafeCells: number;
  partialErrors: number;
  errors: number;
};

function parseCadTableApplicationOutput(
  output: string,
  evidence: Pick<NativeDxfDraftEvidence, "tableManifestSha256" | "tableTargetCount" | "expectedAppliedCount">,
): CadTableApplicationOutputCounters {
  if (!output.trim() || Buffer.byteLength(output, "utf8") > 1_000_000) {
    throw new Error("CAD_APPLICATION_OUTPUT_INVALID");
  }
  if (/Cworks (?:aborted|cancelled)\b/i.test(output)) {
    throw new Error("CAD_APPLICATION_OUTPUT_INVALID");
  }
  const beginPattern = /CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=([0-9a-f]{64})/g;
  const summaryPattern = /Cworks table translations: matchedTargets=(\d+) appliedCells=(\d+) skippedTargets=(\d+) countMismatch=(\d+) unsafeCells=(\d+) partialErrors=(\d+) errors=(\d+)/g;
  const endPattern = /CWORKS_APPLY_TABLE_TRANSLATIONS_END manifestSha256=([0-9a-f]{64})/g;
  const begins = [...output.matchAll(beginPattern)];
  const summaries = [...output.matchAll(summaryPattern)];
  const ends = [...output.matchAll(endPattern)];
  if (begins.length !== 1 || summaries.length !== 1 || ends.length !== 1) {
    throw new Error("CAD_APPLICATION_OUTPUT_INVALID");
  }
  const begin = begins[0];
  const summary = summaries[0];
  const end = ends[0];
  const beginEnd = begin.index! + begin[0].length;
  const summaryEnd = summary.index! + summary[0].length;
  if (
    begin.index! >= summary.index!
    || summary.index! >= end.index!
    || output.slice(beginEnd, summary.index).trim()
    || output.slice(summaryEnd, end.index).trim()
  ) throw new Error("CAD_APPLICATION_OUTPUT_INVALID");
  if (
    begin[1] !== evidence.tableManifestSha256
    || end[1] !== evidence.tableManifestSha256
  ) throw new Error("CAD_APPLICATION_OUTPUT_COUNTERS_MISMATCH");
  const counters: CadTableApplicationOutputCounters = {
    matchedTargets: Number(summary[1]),
    appliedCells: Number(summary[2]),
    skippedTargets: Number(summary[3]),
    countMismatch: Number(summary[4]),
    unsafeCells: Number(summary[5]),
    partialErrors: Number(summary[6]),
    errors: Number(summary[7]),
  };
  if (
    !Object.values(counters).every(Number.isSafeInteger)
    || counters.matchedTargets !== evidence.tableTargetCount
    || counters.appliedCells !== evidence.expectedAppliedCount
    || counters.skippedTargets !== 0
    || counters.countMismatch !== 0
    || counters.unsafeCells !== 0
    || counters.partialErrors !== 0
    || counters.errors !== 0
  ) throw new Error("CAD_APPLICATION_OUTPUT_COUNTERS_MISMATCH");
  return counters;
}

function recordedCadTableApplicationOutputMatches(
  applicationOutput: any,
  evidence: Pick<NativeDxfDraftEvidence, "tableManifestSha256" | "tableTargetCount" | "expectedAppliedCount">,
): boolean {
  if (
    typeof applicationOutput?.text !== "string"
    || applicationOutput.text.length === 0
    || applicationOutput.sha256 !== sha256Bytes(Buffer.from(applicationOutput.text, "utf8"))
  ) return false;
  try {
    return isDeepStrictEqual(
      parseCadTableApplicationOutput(applicationOutput.text, evidence),
      applicationOutput.parsedCounters,
    );
  } catch {
    return false;
  }
}

async function readNativeDxfApprovalEvidence(job: {
  sourceStoredName: string;
  outputStoredName: string | null;
  preservationStoredName: string | null;
  ledgerStoredName: string | null;
  targetLanguage: string;
}): Promise<NativeDxfApprovalEvidence> {
  if (!job.outputStoredName || !job.preservationStoredName || !job.ledgerStoredName) {
    throw new Error("DXF_APPROVAL_EVIDENCE_INVALID");
  }
  try {
    const [reportBytes, ledgerBytes, sourceBytes, outputBytes] = await Promise.all([
      readFileFromObjectStorage(job.preservationStoredName),
      readFileFromObjectStorage(job.ledgerStoredName),
      readFileFromObjectStorage(job.sourceStoredName),
      readFileFromObjectStorage(job.outputStoredName),
    ]);
    if (!reportBytes || !ledgerBytes || !sourceBytes || !outputBytes) {
      throw new Error("DXF_APPROVAL_EVIDENCE_INVALID");
    }
    return validateNativeDxfApprovalEvidence(
      reportBytes,
      ledgerBytes,
      sourceBytes,
      outputBytes,
      job.targetLanguage === "ja" ? "ja" : "en",
    );
  } catch {
    throw new Error("DXF_APPROVAL_EVIDENCE_INVALID");
  }
}

function parsePublishedCoverageSummary(
  summary: Buffer | null,
): { recoveredLineCount: number; translatedLineCount: number } | null {
  if (!summary) return null;
  const text = summary.toString("utf8");
  const recovered = text.match(
    /^- Recovered from broken font extraction with Gemini 3\.1 Pro: (\d+)$/m,
  );
  const translated = text.match(/^- Translated confidently: (\d+)$/m);
  if (!recovered || !translated) return null;
  return {
    recoveredLineCount: Number(recovered[1]),
    translatedLineCount: Number(translated[1]),
  };
}

function publicUnresolvedLines(
  warnings: unknown,
  pageNumber: number,
  translationsById: Map<string, any> = new Map(),
) {
  if (!Array.isArray(warnings)) return [];
  return warnings.flatMap((warning) => {
    if (!warning || typeof warning !== "object") return [];
    const item = warning as Record<string, unknown>;
    const bbox = Array.isArray(item.bbox) ? item.bbox.map(Number) : [];
    if (
      typeof item.blockId !== "string"
      || typeof item.sourceText !== "string"
      || typeof item.rejectionCategory !== "string"
      || bbox.length !== 4
      || bbox.some((coordinate) => !Number.isFinite(coordinate))
    ) return [];
    return [{
      blockId: item.blockId,
      sourceText: item.sourceText,
      currentTranslation: String(translationsById.get(item.blockId)?.translation || ""),
      pageNumber,
      bbox,
      rejectionCategory: item.rejectionCategory,
    }];
  });
}

function publicPreviewMetadata(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const preview = {
    pixelWidth: Number(item.pixelWidth),
    pixelHeight: Number(item.pixelHeight),
    pageWidthPoints: Number(item.pageWidthPoints),
    pageHeightPoints: Number(item.pageHeightPoints),
  };
  return Object.values(preview).every((dimension) => Number.isFinite(dimension) && dimension > 0)
    ? preview
    : null;
}

async function loadJob(req: any, res: any) {
  const [job] = await db.select().from(cworksTranslationJobs)
    .where(eq(cworksTranslationJobs.id, req.params.id))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Drawing translation job not found" });
    return null;
  }
  return job;
}

router.get("/health", async (_req, res) => {
  try {
    const { stdout } = await execFileAsync(process.env.PYTHON_BIN || "python3", [
      "-c",
      "import fitz; print(fitz.VersionBind)",
    ], { timeout: 10_000 });
    const translator = getCworksTranslationReadiness();
    res.json({
      ok: true,
      pdfEngine: "PyMuPDF",
      version: stdout.trim(),
      worker: "durable",
      translatorReady: translator.ready,
      translatorProvider: translator.provider,
      independentAuditorReady: translator.independentAuditorReady,
    });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: String(err?.message || err) });
  }
});

export const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceLanguage: z.enum(["auto", "ru", "ja", "zh", "ko", "de", "fr", "es", "ar", "he", "other"]).default("auto"),
  targetLanguage: z.enum(["en", "ja"]).default("en"),
  scope: z.enum(["full"]).default("full"),
  drawingDepth: z.enum(["major-text", "everything"]).default("major-text"),
  sourceFormat: z.enum(["pdf", "dxf"]).optional(),
});

const directUploadRequestSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  size: z.number().int().min(1).max(100 * 1024 * 1024),
});

type DirectUploadClaim = {
  v: 1;
  id: string;
  filename: string;
  sourceFormat: "pdf" | "dxf";
  sourceStoredName: string;
  size: number;
  expiresAt: number;
};

function uploadTokenSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return secret;
}

function signDirectUploadClaim(claim: DirectUploadClaim): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signature = createHmac("sha256", uploadTokenSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyDirectUploadClaim(token: unknown): DirectUploadClaim {
  if (typeof token !== "string") throw new Error("DIRECT_UPLOAD_TOKEN_INVALID");
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) throw new Error("DIRECT_UPLOAD_TOKEN_INVALID");
  const expectedSignature = createHmac("sha256", uploadTokenSecret()).update(payload).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new Error("DIRECT_UPLOAD_TOKEN_INVALID");
  }
  if (
    supplied.length !== expectedSignature.length
    || !timingSafeEqual(supplied, expectedSignature)
  ) throw new Error("DIRECT_UPLOAD_TOKEN_INVALID");
  let claim: DirectUploadClaim;
  try {
    claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("DIRECT_UPLOAD_TOKEN_INVALID");
  }
  if (
    claim?.v !== 1
    || typeof claim.id !== "string"
    || typeof claim.filename !== "string"
    || !["pdf", "dxf"].includes(claim.sourceFormat)
    || claim.sourceStoredName !== `cworks-translator/${claim.id}/source.${claim.sourceFormat}`
    || !Number.isInteger(claim.size)
    || claim.size < 1
    || claim.size > 100 * 1024 * 1024
    || !Number.isFinite(claim.expiresAt)
    || claim.expiresAt <= Date.now()
  ) throw new Error("DIRECT_UPLOAD_TOKEN_INVALID");
  return claim;
}

async function validateUploadedDrawing(
  filename: string,
  sourceFormat: "pdf" | "dxf",
  bytes: Buffer,
): Promise<void> {
  const extension = path.extname(filename).toLowerCase();
  if ((sourceFormat === "dxf" && extension !== ".dxf") || (sourceFormat === "pdf" && extension !== ".pdf")) {
    throw new Error("UPLOAD_EXTENSION_INVALID");
  }
  if (sourceFormat === "pdf" && (bytes.length < 5 || bytes.toString("ascii", 0, 5) !== "%PDF-")) {
    throw new Error("UPLOAD_PDF_INVALID");
  }
  if (sourceFormat !== "dxf") return;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cworks-dxf-upload-"));
  try {
    const input = path.join(temp, "source.dxf"), inventory = path.join(temp, "inventory.json");
    await fs.writeFile(input, bytes);
    await execFileAsync(process.env.PYTHON_BIN || "python3", [DXF_PROCESSOR, "inspect", input, inventory], {
      timeout: 30_000, maxBuffer: 128 * 1024,
    });
  } catch (err: any) {
    const stderr = String(err?.stderr || "");
    const rejection = /DXF_REJECTED:\s*([^\r\n]+)/.exec(stderr)?.[1]?.trim() || "";
    throw new Error(`UPLOAD_DXF_INVALID:${rejection}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function sendUploadValidationError(res: import("express").Response, err: any): boolean {
  if (err?.message === "UPLOAD_EXTENSION_INVALID") {
    res.status(400).json({ error: "File extension does not match the selected source format" });
    return true;
  }
  if (err?.message === "UPLOAD_PDF_INVALID") {
    res.status(400).json({ error: "The uploaded file is not a valid PDF" });
    return true;
  }
  if (typeof err?.message === "string" && err.message.startsWith("UPLOAD_DXF_INVALID:")) {
    const reason = err.message.slice("UPLOAD_DXF_INVALID:".length);
    if (reason === "binary DXF is not supported") {
      res.status(400).json({
        error: "This is a binary DXF. Re-export it as an AutoCAD 2018 text-format DXF (not binary); UTF-8 Russian text is supported.",
      });
      return true;
    }
    if (reason === "DXF must be UTF-8") {
      res.status(400).json({
        error: "This text-format DXF uses a legacy character encoding. Re-export it as UTF-8 AutoCAD 2018 DXF; Russian UTF-8 text is supported.",
      });
      return true;
    }
    if (reason === "only UTF-8 text-format DXF AC1032 is accepted") {
      res.status(400).json({
        error: "This is not an AutoCAD 2018 (AC1032) text-format DXF. Russian UTF-8 text is supported; only the container version is incompatible.",
      });
      return true;
    }
    res.status(400).json({
      error: reason
        ? `This DXF cannot be translated safely: ${reason}`
        : "This DXF is not a safe UTF-8 AutoCAD 2018 text-format file.",
    });
    return true;
  }
  return false;
}

router.post("/uploads/request-url", async (req, res) => {
  try {
    if (!getCworksTranslationReadiness().ready) {
      return res.status(503).json({
        error: "Translation is temporarily unavailable because no translation provider is configured",
      });
    }
    const data = directUploadRequestSchema.parse(req.body);
    const filename = path.basename(data.filename).slice(0, 240);
    const extension = path.extname(filename).toLowerCase();
    if (![".pdf", ".dxf"].includes(extension)) {
      return res.status(400).json({ error: "Choose a PDF or DXF drawing set" });
    }
    const sourceFormat = extension === ".dxf" ? "dxf" : "pdf";
    const id = randomUUID();
    const sourceStoredName = `cworks-translator/${id}/source.${sourceFormat}`;
    const claim: DirectUploadClaim = {
      v: 1,
      id,
      filename,
      sourceFormat,
      sourceStoredName,
      size: data.size,
      expiresAt: Date.now() + 15 * 60_000,
    };
    await db.insert(cworksTranslationCleanup).values({
      storedName: sourceStoredName,
      nextAttemptAt: new Date(claim.expiresAt + 5 * 60_000),
    }).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
    const uploadURL = await getObjectStorageUploadSignedUrl(sourceStoredName);
    res.json({ uploadURL, uploadToken: signDirectUploadClaim(claim) });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid upload details" });
    console.error("[cworks-translator] direct upload authorization failed:", err?.message);
    res.status(500).json({ error: "Could not prepare the secure upload" });
  }
});

router.post("/jobs/from-upload", async (req, res) => {
  let stagedSource: string | null = null;
  try {
    if (!getCworksTranslationReadiness().ready) {
      return res.status(503).json({
        error: "Translation is temporarily unavailable because no translation provider is configured",
      });
    }
    const claim = verifyDirectUploadClaim(req.body?.uploadToken);
    const [existing] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, claim.id)).limit(1);
    if (existing) return res.status(202).json({ job: publicJob(existing) });
    const data = createSchema.parse(req.body);
    const bytes = await readFileFromObjectStorage(claim.sourceStoredName);
    if (!bytes) return res.status(409).json({ error: "The secure upload is missing. Select the file and try again." });
    stagedSource = claim.sourceStoredName;
    if (bytes.length !== claim.size) {
      throw new Error("DIRECT_UPLOAD_SIZE_MISMATCH");
    }
    await validateUploadedDrawing(claim.filename, claim.sourceFormat, bytes);
    const job = await db.transaction(async (tx) => {
      const [created] = await tx.insert(cworksTranslationJobs).values({
        id: claim.id,
        title: data.title,
        sourceLanguage: data.sourceLanguage,
        targetLanguage: data.targetLanguage,
        scope: data.scope,
        drawingDepth: data.drawingDepth,
        sourceFormat: claim.sourceFormat,
        originalFilename: claim.filename,
        sourceStoredName: claim.sourceStoredName,
        status: "queued",
        progressNote: "Waiting for the translation worker",
      }).returning();
      await tx.delete(cworksTranslationCleanup)
        .where(eq(cworksTranslationCleanup.storedName, claim.sourceStoredName));
      return created;
    });
    stagedSource = null;
    kickCworksTranslationWorker();
    res.status(202).json({ job: publicJob(job) });
  } catch (err: any) {
    if (stagedSource) {
      try {
        await deleteFromObjectStorageStrict(stagedSource);
      } catch (cleanupErr: any) {
        await db.insert(cworksTranslationCleanup).values({
          storedName: stagedSource,
          lastError: String(cleanupErr?.message || cleanupErr).slice(0, 800),
          nextAttemptAt: new Date(Date.now() + 30_000),
        }).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
    }
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid job settings", details: err.errors });
    if (err?.message === "DIRECT_UPLOAD_TOKEN_INVALID") {
      return res.status(400).json({ error: "The secure upload expired. Select the file and try again." });
    }
    if (err?.message === "DIRECT_UPLOAD_SIZE_MISMATCH") {
      return res.status(400).json({ error: "The uploaded file size did not match the selected file" });
    }
    if (sendUploadValidationError(res, err)) return;
    console.error("[cworks-translator] uploaded job creation failed:", err?.message);
    res.status(500).json({ error: "Could not create the translation job" });
  }
});

router.post("/jobs", upload.single("file"), async (req, res) => {
  let stagedSource: string | null = null;
  try {
    if (!getCworksTranslationReadiness().ready) {
      return res.status(503).json({
        error: "Translation is temporarily unavailable because no translation provider is configured",
      });
    }
    const data = createSchema.parse(req.body);
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No PDF or DXF uploaded" });
    const filename = Buffer.from(file.originalname, "latin1").toString("utf8").slice(0, 240);
    const extension = path.extname(filename).toLowerCase();
    const sourceFormat = data.sourceFormat || (extension === ".dxf" ? "dxf" : "pdf");
    await validateUploadedDrawing(filename, sourceFormat, file.buffer);
    const id = randomUUID();
    const sourceStoredName = `cworks-translator/${id}/source.${sourceFormat}`;
    await writeFileToObjectStorage(sourceStoredName, file.buffer);
    stagedSource = sourceStoredName;
    const [job] = await db.insert(cworksTranslationJobs).values({
      id,
      title: data.title,
      sourceLanguage: data.sourceLanguage,
      targetLanguage: data.targetLanguage,
      scope: data.scope,
      drawingDepth: data.drawingDepth,
      sourceFormat,
      originalFilename: filename,
      sourceStoredName,
      status: "queued",
      progressNote: "Waiting for the translation worker",
    }).returning();
    stagedSource = null;
    kickCworksTranslationWorker();
    res.status(202).json({ job: publicJob(job) });
  } catch (err: any) {
    if (stagedSource) {
      try {
        await deleteFromObjectStorageStrict(stagedSource);
      } catch (cleanupErr: any) {
        await db.insert(cworksTranslationCleanup).values({
          storedName: stagedSource,
          lastError: String(cleanupErr?.message || cleanupErr).slice(0, 800),
          nextAttemptAt: new Date(Date.now() + 30_000),
        }).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
    }
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid job settings", details: err.errors });
    if (sendUploadValidationError(res, err)) return;
    console.error("[cworks-translator] upload failed:", err?.message);
    res.status(500).json({ error: "Could not create the translation job" });
  }
});

router.get("/jobs", async (_req, res) => {
  try {
    const jobs = await db.select().from(cworksTranslationJobs)
      .orderBy(desc(cworksTranslationJobs.createdAt))
      .limit(50);
    res.json({ jobs: jobs.map(publicJob) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/jobs/:id", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    const [pages, checkpointRows, pageReviews, reviewHistory] = REVIEW_VISIBLE_STATUSES.has(job.status)
      ? await Promise.all([
          db.select().from(cworksTranslationPages)
            .where(eq(cworksTranslationPages.jobId, job.id))
            .orderBy(asc(cworksTranslationPages.pageNumber)),
          db.select({ translations: cworksTranslationCheckpoints.translations })
            .from(cworksTranslationCheckpoints)
            .where(and(
              eq(cworksTranslationCheckpoints.jobId, job.id),
              eq(cworksTranslationCheckpoints.revisionCount, job.revisionCount),
            )),
          db.select().from(cworksTranslationPageReviews)
            .where(and(
              eq(cworksTranslationPageReviews.jobId, job.id),
              eq(cworksTranslationPageReviews.revisionCount, job.revisionCount),
            )),
          db.select().from(cworksTranslationReviewEvents)
            .where(eq(cworksTranslationReviewEvents.jobId, job.id))
            .orderBy(
              desc(cworksTranslationReviewEvents.createdAt),
              desc(cworksTranslationReviewEvents.id),
            )
            .limit(20),
        ])
      : [[], [], [], []];
    const derivatives = job.sourceFormat === "dxf"
      ? await db.select().from(cworksTranslationCadDerivatives)
          .where(eq(cworksTranslationCadDerivatives.jobId, job.id))
          .orderBy(asc(cworksTranslationCadDerivatives.createdAt))
      : [];
    const checkpointTranslations = checkpointRows.flatMap((row) =>
      Array.isArray(row.translations) ? row.translations : []);
    const translationsById = new Map(
      checkpointTranslations
        .filter((item: any) => typeof item?.id === "string")
        .map((item: any) => [item.id, item]),
    );
    const publishedCounts = job.sourceFormat === "dxf"
      || checkpointTranslations.length
      || !job.summaryStoredName
      ? null
      : parsePublishedCoverageSummary(
          await readFileFromObjectStorage(job.summaryStoredName),
        );
    const coverage = publicCoverageWithTranslations(
      pages,
      checkpointTranslations,
      publishedCounts,
      job.sourceFormat,
    );
    let hybridPending = false;
    if (job.sourceFormat === "dxf" && pages.length && job.ledgerStoredName) {
      const ledgerBytes = await readFileFromObjectStorage(job.ledgerStoredName);
      // Missing native evidence must not render a green completeness claim.
      hybridPending = !ledgerBytes || nativeDxfNeedsCadDerivative(
        JSON.parse(ledgerBytes.toString("utf8")),
      );
    }
    if (hybridPending) coverage.complete = false;
    const [retryMetadata, downloadAvailability] = await Promise.all([
      job.status === "failed"
        ? retryMetadataForJob(job)
        : Promise.resolve<RetryMetadata>({
            resumeAvailable: false,
            resumeEligibility: "unavailable",
            fullRestartAvailable: false,
            checkpointCount: 0,
            checkpointRevision: null,
            resumeReason: "Retry metadata is only available for failed jobs",
            resumeValidationNote: "Retry validation is only computed for failed jobs.",
            fullRestartWarning: FULL_RESTART_WARNING,
          }),
      downloadAvailabilityForJob(job),
    ]);
    res.json({
      job: publicJob(job),
      coverage: { ...coverage, hybridPending },
      retryMetadata,
      downloadAvailability,
      reviewHistory,
      derivatives: derivatives.map((derivative) => {
        const latest = reviewHistory.find((event) => event.derivativeId === derivative.id);
        return publicCadDerivative(
          derivative,
          latest?.decision === "derivative_approve" ? "approved"
            : latest?.decision === "derivative_revise" ? "revision_requested"
              : "pending_review",
        );
      }),
      pages: pages.map((p) => ({
        ...p,
        unresolvedLines: publicUnresolvedLines(p.warnings, p.pageNumber, translationsById),
        previewMetadata: publicPreviewMetadata(p.previewMetadata),
        review: pageReviews.find((review) => review.pageNumber === p.pageNumber) || null,
        warnings: [
          ...(Array.isArray(p.warnings)
            ? p.warnings.filter((warning) => typeof warning === "string").map(String)
            : []),
          ...(!coverage.complete && p.pageNumber === pages[0]?.pageNumber
            ? [`Completeness check: ${coverage.unresolvedLineCount} target lines remain unresolved. Approval and final PDF download are blocked.`]
            : []),
        ],
        thumbnailUrl: `/api/cworks-translator/jobs/${job.id}/pages/${p.pageNumber}/thumbnail?revision=${job.revisionCount}`,
        sourceThumbnailUrl: `/api/cworks-translator/jobs/${job.id}/pages/${p.pageNumber}/source-thumbnail?revision=${job.revisionCount}`,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/jobs/:id/pages/:pageNumber/thumbnail", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (!REVIEW_VISIBLE_STATUSES.has(job.status)) {
      return res.status(409).json({ error: "Page previews are only available once the job is ready for review" });
    }
    const pageNumber = Number(req.params.pageNumber);
    const [scopedPage] = await db.select().from(cworksTranslationPages)
      .where(and(
        eq(cworksTranslationPages.jobId, job.id),
        eq(cworksTranslationPages.pageNumber, pageNumber),
      ))
      .limit(1);
    if (!scopedPage) return res.status(404).json({ error: "Page preview not found" });
    res.setHeader("Cache-Control", "no-store");
    const ok = await streamFromObjectStorage(scopedPage.thumbnailStoredName, res, {
      contentType: job.sourceFormat === "dxf" ? "image/svg+xml; charset=utf-8" : "image/jpeg",
      disposition: "inline",
      filename: `page-${pageNumber}.${job.sourceFormat === "dxf" ? "svg" : "jpg"}`,
      req,
    });
    if (!ok && !res.headersSent) res.status(404).json({ error: "Page preview missing" });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get("/jobs/:id/pages/:pageNumber/source-thumbnail", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (!REVIEW_VISIBLE_STATUSES.has(job.status)) {
      return res.status(409).json({ error: "Source previews are only available once the draft is ready for review" });
    }
    const pageNumber = Number(req.params.pageNumber);
    const [scopedPage] = await db.select().from(cworksTranslationPages)
      .where(and(
        eq(cworksTranslationPages.jobId, job.id),
        eq(cworksTranslationPages.pageNumber, pageNumber),
      ))
      .limit(1);
    if (!scopedPage?.sourceThumbnailStoredName) {
      return res.status(404).json({ error: "Source page preview not found" });
    }
    res.setHeader("Cache-Control", "no-store");
    const ok = await streamFromObjectStorage(scopedPage.sourceThumbnailStoredName, res, {
      contentType: job.sourceFormat === "dxf" ? "image/svg+xml; charset=utf-8" : "image/jpeg",
      disposition: "inline",
      filename: `source-page-${pageNumber}.${job.sourceFormat === "dxf" ? "svg" : "jpg"}`,
      req,
    });
    if (!ok && !res.headersSent) res.status(404).json({ error: "Source page preview missing" });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

async function streamJobAsset(req: any, res: any, kind: "output" | "summary" | "source") {
  const job = await loadJob(req, res);
  if (!job) return;
  if (kind !== "source" && (
    job.status !== "done"
    || job.approvedRevision !== job.revisionCount
    || !job.approvedAt
  )) {
    return res.status(409).json({
      error: "Final translated files are locked until a qualified reviewer approves every page of this revision",
    });
  }
  if (kind === "output") {
    const pages = await db.select().from(cworksTranslationPages)
      .where(eq(cworksTranslationPages.jobId, job.id));
    const coverage = publicCoverage(pages, job.sourceFormat);
    if (!coverage.complete) {
      return res.status(409).json({
        error: `This ${job.sourceFormat === "dxf" ? "DXF" : "PDF"} is blocked by the completeness check: ${coverage.placedLineCount} of ${coverage.targetLineCount} target lines were placed.`,
        coverage,
      });
    }
  }
  const storedName = kind === "output" ? job.outputStoredName : kind === "summary" ? job.summaryStoredName : job.sourceStoredName;
  if (!storedName) return res.status(404).json({ error: "This file is not ready yet" });
  const isDxf = job.sourceFormat === "dxf";
  const extension = kind === "summary" ? "md" : isDxf ? "dxf" : "pdf";
  const filename = kind === "source"
    ? job.originalFilename
    : kind === "summary"
      ? `${job.title}-translation-summary.md`
      : `${job.title}-translated.${extension}`;
  if (
    isDxf
    && job.status === "done"
    && (kind === "source" || kind === "output")
  ) {
    try {
      const bytes = await readVerifiedNativeDxfReleaseAsset(job, kind);
      sendVerifiedDownload(
        res,
        bytes,
        kind === "source" ? job.originalFilename : filename,
        "application/dxf",
      );
    } catch {
      return res.status(409).json({
        error: "Released native DXF evidence is missing or no longer matches its approval attestation",
      });
    }
    return;
  }
  const ok = await streamFromObjectStorage(storedName, res, {
    contentType: kind === "summary" ? "text/markdown; charset=utf-8" : isDxf ? "application/dxf" : "application/pdf",
    disposition: "attachment",
    filename: filename.endsWith(`.${extension}`) ? filename : `${filename}.${extension}`,
    req,
  });
  if (!ok && !res.headersSent) res.status(404).json({ error: "Stored file not found" });
}

router.get("/jobs/:id/download", (req, res) => void streamJobAsset(req, res, "output"));
router.get("/jobs/:id/summary", (req, res) => void streamJobAsset(req, res, "summary"));
router.get("/jobs/:id/original", (req, res) => void streamJobAsset(req, res, "source"));

async function streamDxfEvidence(req: any, res: any, artifact: "ledger" | "preservation-report") {
  const job = await loadJob(req, res);
  if (!job) return;
  if (!REVIEW_VISIBLE_STATUSES.has(job.status)) return res.status(409).json({ error: "Draft evidence is only available once ready for review" });
  const storedName = artifact === "ledger" ? job.ledgerStoredName : job.preservationStoredName;
  if (!storedName) return res.status(404).json({ error: "This DXF evidence is not ready" });
  if (job.sourceFormat !== "dxf") {
    return res.status(404).json({ error: "Native DXF evidence is not available for this job" });
  }
  if (job.status === "done") {
    try {
      const bytes = await readVerifiedNativeDxfReleaseAsset(job, artifact);
      sendVerifiedDownload(res, bytes, `${job.title}-${artifact}.json`, "application/json; charset=utf-8");
    } catch {
      return res.status(409).json({
        error: "Released native DXF evidence is missing or no longer matches its approval attestation",
      });
    }
    return;
  }
  const ok = await streamFromObjectStorage(storedName, res, {
    contentType: "application/json; charset=utf-8", disposition: "attachment",
    filename: `${job.title}-${artifact}.json`, req,
  });
  if (!ok && !res.headersSent) res.status(404).json({ error: "Stored evidence not found" });
}
router.get("/jobs/:id/ledger", (req, res) => void streamDxfEvidence(req, res, "ledger"));
router.get("/jobs/:id/preservation-report", (req, res) => void streamDxfEvidence(req, res, "preservation-report"));

type NativeDxfReleaseAsset = "source" | "output" | "ledger" | "preservation-report";

async function readVerifiedNativeDxfReleaseAsset(
  job: typeof cworksTranslationJobs.$inferSelect,
  asset: NativeDxfReleaseAsset,
): Promise<Buffer> {
  if (
    job.sourceFormat !== "dxf"
    || job.status !== "done"
    || job.approvedRevision === null
    || job.approvedRevision !== job.revisionCount
  ) throw new Error("DXF_RELEASE_ATTESTATION_INVALID");
  const [approval] = await db.select().from(cworksTranslationReviewEvents)
    .where(and(
      eq(cworksTranslationReviewEvents.jobId, job.id),
      eq(cworksTranslationReviewEvents.revisionCount, job.approvedRevision),
      eq(cworksTranslationReviewEvents.decision, "approve"),
    ))
    .orderBy(desc(cworksTranslationReviewEvents.createdAt))
    .limit(1);
  if (
    !approval
    || !job.outputStoredName
    || !job.ledgerStoredName
    || !job.preservationStoredName
  ) {
    throw new Error("DXF_RELEASE_ATTESTATION_INVALID");
  }
  const [sourceBytes, outputBytes, ledgerBytes, reportBytes] = await Promise.all([
    readFileFromObjectStorage(job.sourceStoredName),
    readFileFromObjectStorage(job.outputStoredName),
    readFileFromObjectStorage(job.ledgerStoredName),
    readFileFromObjectStorage(job.preservationStoredName),
  ]);
  if (!sourceBytes || !outputBytes || !ledgerBytes || !reportBytes) {
    throw new Error("DXF_RELEASE_ATTESTATION_INVALID");
  }
  let bundle;
  try {
    bundle = validateNativeDxfApprovalEvidence(
      reportBytes,
      ledgerBytes,
      sourceBytes,
      outputBytes,
      job.targetLanguage === "ja" ? "ja" : "en",
    );
  } catch {
    throw new Error("DXF_RELEASE_ATTESTATION_INVALID");
  }
  if (
    bundle.sourceSha256 !== approval.sourceSha256
    || bundle.translatedOutputSha256 !== approval.translatedOutputSha256
    || bundle.preservationReportSha256 !== approval.preservationReportSha256
    || bundle.ledgerSha256 !== approval.ledgerSha256
  ) throw new Error("DXF_RELEASE_ATTESTATION_INVALID");
  return asset === "source"
    ? sourceBytes
    : asset === "output"
      ? outputBytes
      : asset === "ledger"
        ? ledgerBytes
        : reportBytes;
}

function sendVerifiedDownload(
  res: any,
  bytes: Buffer,
  filename: string,
  contentType: string,
): void {
  const safeFilename = filename.replace(/[\r\n"\\/]/g, "_");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
  res.setHeader("Content-Length", String(bytes.length));
  res.send(bytes);
}

function safeAttachmentStem(value: string): string {
  const stem = value.normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 100);
  return stem || "translated-drawing";
}

// A review draft is deliberately separate from the approval-gated final asset.
// It enables the operator to create a derivative without releasing this DXF.
router.get("/jobs/:id/draft-dxf", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat !== "dxf" || job.status !== "awaiting_review") {
      return res.status(409).json({ error: "Only the active native DXF review draft can be downloaded here" });
    }
    if (!job.outputStoredName || !job.ledgerStoredName) {
      return res.status(404).json({ error: "The machine-clean draft is not ready" });
    }
    const [output, ledgerBytes, source] = await Promise.all([
      readFileFromObjectStorage(job.outputStoredName),
      readFileFromObjectStorage(job.ledgerStoredName),
      readFileFromObjectStorage(job.sourceStoredName),
    ]);
    const ledger = ledgerBytes && JSON.parse(ledgerBytes.toString("utf8"));
    if (!output || !source || ledger?.format !== "cworks-native-dxf-ledger-v1"
      || ledger?.sourceSha256 !== sha256Bytes(source)
      || ledger?.patch?.sourceSha256 !== sha256Bytes(source)
      || ledger?.patch?.outputSha256 !== sha256Bytes(output)
      || ledger?.patch?.nonApprovedSegmentsIdentical !== true) {
      return res.status(409).json({ error: "The draft bytes no longer match their preservation evidence" });
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Cworks-Review-Status", "draft-not-for-construction");
    sendVerifiedDownload(res, output,
      `${safeAttachmentStem(job.title)}-DRAFT-machine-clean.dxf`, "application/dxf");
  } catch {
    if (!res.headersSent) res.status(409).json({ error: "The review draft could not be verified" });
  }
});

router.get("/jobs/:id/table-script", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat !== "dxf") {
      return res.status(404).json({ error: "An AutoCAD table script is not available for this job" });
    }
    if (!REVIEW_VISIBLE_STATUSES.has(job.status)) {
      return res.status(409).json({ error: "The AutoCAD table script is only available once the native DXF is ready for review" });
    }
    if (!job.ledgerStoredName) {
      return res.status(404).json({ error: "The AutoCAD table script is not ready" });
    }
    let ledgerBytes: Buffer;
    if (job.status === "done") {
      ledgerBytes = await readVerifiedNativeDxfReleaseAsset(job, "ledger");
    } else {
      const draftLedgerBytes = await readFileFromObjectStorage(job.ledgerStoredName);
      if (!draftLedgerBytes) {
        return res.status(404).json({ error: "The AutoCAD table script evidence is not ready" });
      }
      ledgerBytes = draftLedgerBytes;
    }
    const ledger = JSON.parse(ledgerBytes.toString("utf8"));
    const tableScript = validateNativeDxfTableScriptLedger(
      ledger,
      job.targetLanguage === "ja" ? "ja" : "en",
    );
    if (!tableScript) {
      return res.status(404).json({ error: "This legacy DXF job does not include an AutoCAD table script" });
    }
    const script = Buffer.from(tableScript.script, "utf8");
    res.setHeader("Cache-Control", "no-store");
    sendVerifiedDownload(
      res,
      script,
      `${safeAttachmentStem(job.title)}-autocad-table-translations.lsp`,
      "application/x-autolisp",
    );
  } catch (err: any) {
    if (!res.headersSent && (
      err?.message === "DXF_APPROVAL_EVIDENCE_INVALID"
      || err?.message === "DXF_RELEASE_ATTESTATION_INVALID"
      || err?.message === "DXF_TABLE_SCRIPT_INVALID"
      || err instanceof SyntaxError
    )) {
      return res.status(409).json({
        error: "The AutoCAD table script evidence is invalid or no longer matches this native DXF",
      });
    }
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.post("/jobs/:id/upgrade-table-script-evidence", async (req, res) => {
  let stagedArchiveName: string | null = null;
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat !== "dxf" || job.status !== "awaiting_review") {
      return res.status(409).json({
        error: "Only an active native DXF review draft can be upgraded to captured command output",
      });
    }
    if (!job.ledgerStoredName) {
      return res.status(404).json({ error: "The AutoCAD table script evidence is not ready" });
    }
    const ledgerBytes = await readFileFromObjectStorage(job.ledgerStoredName);
    const ledger = ledgerBytes && JSON.parse(ledgerBytes.toString("utf8"));
    const tableScript = ledger && validateNativeDxfTableScriptLedger(
      ledger,
      job.targetLanguage === "ja" ? "ja" : "en",
    );
    if (!tableScript) {
      return res.status(409).json({ error: "The legacy table script evidence is invalid" });
    }
    if (tableScriptSupportsCapturedApplicationOutput(tableScript)) {
      return res.status(409).json({ error: "This draft already supports captured AutoCAD command output" });
    }
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id))
        .limit(1);
      if (
        !currentJob
        || currentJob.status !== "awaiting_review"
        || currentJob.revisionCount !== job.revisionCount
        || currentJob.ledgerStoredName !== job.ledgerStoredName
      ) return null;
      const currentLedgerBytes = currentJob.ledgerStoredName
        ? await readFileFromObjectStorage(currentJob.ledgerStoredName)
        : null;
      const currentLedger = currentLedgerBytes && JSON.parse(currentLedgerBytes.toString("utf8"));
      const currentTableScript = currentLedger && validateNativeDxfTableScriptLedger(
        currentLedger,
        currentJob.targetLanguage === "ja" ? "ja" : "en",
      );
      if (!currentTableScript || tableScriptSupportsCapturedApplicationOutput(currentTableScript)) {
        return null;
      }
      const archivedTableScriptBytes = Buffer.from(currentTableScript.script, "utf8");
      const archivedTableScriptStoredName = [
        "cworks-translator",
        job.id,
        "evidence-archive",
        `revision-${job.revisionCount}-table-script-${currentTableScript.sha256}.lsp`,
      ].join("/");
      await writeFileToObjectStorage(archivedTableScriptStoredName, archivedTableScriptBytes);
      stagedArchiveName = archivedTableScriptStoredName;
      const [changed] = await tx.update(cworksTranslationJobs).set({
        status: "revising",
        progress: 0,
        pagesDone: 0,
        progressNote: "Captured-output table script upgrade queued",
        feedbackNotes: "Regenerate the source-bound AutoCAD table script with manifest-bound command output markers.",
        repairBrief: null,
        revisionCount: sql`${cworksTranslationJobs.revisionCount} + 1`,
        machineAuditStatus: "pending",
        machineAuditModel: null,
        approvedRevision: null,
        approvedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "awaiting_review"),
        eq(cworksTranslationJobs.revisionCount, job.revisionCount),
      )).returning();
      if (!changed) return null;
      await tx.insert(cworksTranslationReviewEvents).values({
        jobId: job.id,
        revisionCount: job.revisionCount,
        decision: "script_evidence_upgrade",
        reviewerName: "Authenticated operator",
        reviewerQualification: "Captured AutoCAD output migration control",
        reviewerSessionId,
        declaration: "The operator requested a new auditable draft revision whose source-bound AutoCAD table script emits manifest-bound command output. Existing artifacts and derivative candidates remain unchanged in history.",
        pageReviewSnapshot: {
          priorTableScriptSha256: currentTableScript.sha256,
          priorTableManifestSha256: currentTableScript.manifestSha256,
          archivedTableScriptStoredName,
          archivedTableScriptSha256: sha256Bytes(archivedTableScriptBytes),
        },
        notes: "Legacy table-script evidence retained; replacement generation queued as a new revision.",
      });
      return changed;
    });
    if (!updated) {
      if (stagedArchiveName) {
        await deleteFromObjectStorageStrict(stagedArchiveName).catch(() => undefined);
        stagedArchiveName = null;
      }
      return res.status(409).json({ error: "This draft changed or its table script was already upgraded" });
    }
    stagedArchiveName = null;
    kickCworksTranslationWorker();
    res.json({ job: publicJob(updated) });
  } catch (err: any) {
    if (stagedArchiveName) {
      await deleteFromObjectStorageStrict(stagedArchiveName).catch(() => undefined);
    }
    if (
      err?.message === "DXF_TABLE_SCRIPT_INVALID"
      || err instanceof SyntaxError
    ) {
      return res.status(409).json({ error: "The legacy table script evidence is invalid" });
    }
    res.status(500).json({ error: err.message });
  }
});

function publicCadDerivative(
  derivative: typeof cworksTranslationCadDerivatives.$inferSelect,
  reviewStatus?: "pending_review" | "approved" | "revision_requested",
) {
  const { storedName: _storedName, sourceOutputSha256, sourceApprovalEventId, ...safe } = derivative;
  return {
    ...safe,
    source: {
      revision: derivative.sourceRevision,
      translatedOutputSha256: sourceOutputSha256,
      approvalEventId: sourceApprovalEventId,
    },
    lineageKind: derivative.lineageKind,
    workflow: derivative.lineageKind === "hybrid_draft_completion"
      ? "hybrid_draft" : "approved_source_touchup",
    reviewStatus: derivative.lineageKind === "hybrid_draft_completion"
      ? reviewStatus ?? "pending_review" : "not_required",
    evidence: derivative.evidence,
    artifactClass: "human_edited_cad_derivative",
    preservationProof: false,
    bytePreservationClaim: false,
    downloadUrl: `/api/cworks-translator/jobs/${derivative.jobId}/cad-derivatives/${derivative.id}/download`,
    lineageReportUrl: `/api/cworks-translator/jobs/${derivative.jobId}/cad-derivatives/${derivative.id}/lineage-report`,
    draftDownloadUrl: derivative.lineageKind === "hybrid_draft_completion"
      ? `/api/cworks-translator/jobs/${derivative.jobId}/cad-derivatives/${derivative.id}/draft-download`
      : null,
    draftLineageReportUrl: derivative.lineageKind === "hybrid_draft_completion"
      ? `/api/cworks-translator/jobs/${derivative.jobId}/cad-derivatives/${derivative.id}/draft-lineage-report`
      : null,
  };
}

async function validateCadDerivativeContent(format: "dxf" | "dwg", bytes: Buffer): Promise<void> {
  if (format === "dwg") {
    // Every supported AutoCAD DWG begins with a six-byte AC10xx version code.
    // This is intentionally only a container sanity check, not a safety or
    // preservation proof for an opaque proprietary binary.
    if (bytes.length < 64 || !/^AC10\d{2}$/.test(bytes.toString("ascii", 0, 6))) {
      throw new Error("CAD_DERIVATIVE_CONTENT_INVALID");
    }
    return;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cworks-cad-derivative-"));
  try {
    const input = path.join(temp, "derivative.dxf");
    const inventory = path.join(temp, "inventory.json");
    await fs.writeFile(input, bytes);
    await execFileAsync(process.env.PYTHON_BIN || "python3", [
      DXF_PROCESSOR,
      "inspect",
      input,
      inventory,
    ], { timeout: 30_000, maxBuffer: 128 * 1024 });
  } catch {
    throw new Error("CAD_DERIVATIVE_CONTENT_INVALID");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

const cadDerivativeMetadataSchema = z.object({
  operatorName: z.string().trim().min(2).max(120),
  operatorQualification: z.string().trim().min(3).max(500),
  notes: z.string().trim().min(1).max(5000),
  lineageKind: z.enum(["approved_source_touchup", "hybrid_draft_completion"])
    .optional().default("approved_source_touchup"),
  sourceRevision: z.coerce.number().int().min(0).optional(),
  sourceSha256: z.string().regex(SHA256_PATTERN).optional(),
  sourceOutputSha256: z.string().regex(SHA256_PATTERN).optional(),
  preservationReportSha256: z.string().regex(SHA256_PATTERN).optional(),
  ledgerSha256: z.string().regex(SHA256_PATTERN).optional(),
  placementManifestSha256: z.string().regex(SHA256_PATTERN).optional(),
  tableScriptSha256: z.string().regex(SHA256_PATTERN).optional(),
  tableManifestSha256: z.string().regex(SHA256_PATTERN).optional(),
  applicationOutput: z.string().min(1).max(1_000_000).optional(),
  manualCoverageResolutions: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.array(z.object({
    requirementId: z.string().trim().min(1).max(500),
    resolution: z.string().trim().min(3).max(2000),
  })).max(1000)).optional(),
  operationalVerification: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.object({
    platform: z.literal("windows_autocad"),
    autoCadMajorVersion: z.number().int().min(2021).max(2100),
    lispSys: z.union([z.literal(1), z.literal(2)]),
    sourceScriptManifestHashesVerified: z.literal(true),
    partialApplicationEvidenceDisposition: z.literal("discarded"),
    savedClosedReopened: z.literal(true),
    reopenedInspectionNotes: z.string().trim().min(3).max(2000),
  })).optional(),
  attestation: z.enum([CAD_DERIVATIVE_ATTESTATION, CAD_HYBRID_DERIVATIVE_ATTESTATION]),
});

router.get("/jobs/:id/cad-derivative-requirements", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat !== "dxf" || job.status !== "awaiting_review") {
      return res.status(409).json({ error: "Hybrid derivative requirements are only available for a native DXF draft awaiting review" });
    }
    const evidence = await readNativeDxfDraftEvidence(job);
    res.json({
      format: "cworks-hybrid-derivative-requirements-v1",
      lineageKind: "hybrid_draft_completion",
      sourceRevision: job.revisionCount,
      sourceSha256: evidence.sourceSha256,
      sourceOutputSha256: evidence.translatedOutputSha256,
      preservationReportSha256: evidence.preservationReportSha256,
      ledgerSha256: evidence.ledgerSha256,
      placementManifestSha256: evidence.placementManifestSha256,
      tableScriptSha256: evidence.tableScriptSha256,
      tableManifestSha256: evidence.tableManifestSha256,
      tableTargetCount: evidence.tableTargetCount,
      expectedCounters: {
        expected: evidence.expectedAppliedCount,
        applied: evidence.expectedAppliedCount,
        missing: 0,
        ambiguous: 0,
        failed: 0,
        skipped: 0,
      },
      manualRequirementIds: evidence.manualRequirementIds,
      machineDefectCount: evidence.machineDefectCount,
      independentAuditModel: evidence.independentAuditModel,
      applicationOutputCaptureSupported: evidence.applicationOutputCaptureSupported,
      submissionAllowed: evidence.machineDefectCount === 0
        && evidence.applicationOutputCaptureSupported
        && ["passed", "findings"].includes(job.machineAuditStatus)
        && job.machineAuditModel === evidence.independentAuditModel,
      requiredAttestation: CAD_HYBRID_DERIVATIVE_ATTESTATION,
    });
  } catch (err: any) {
    if (err?.message === "DXF_DRAFT_EVIDENCE_INVALID") {
      return res.status(409).json({ error: "Hybrid draft evidence is missing, invalid, or stale" });
    }
    res.status(500).json({ error: "Could not load hybrid derivative requirements" });
  }
});

router.post("/jobs/:id/cad-derivatives", upload.single("file"), async (req, res) => {
  let stagedName: string | null = null;
  try {
    if (!req.session.userId || !req.session.role) {
      return res.status(401).json({ error: "Sign in with your named workspace account before submitting a CAD derivative" });
    }
    const [operatorAccount] = await db.select({
      id: users.id,
      role: users.role,
      status: users.status,
    }).from(users).where(eq(users.id, req.session.userId)).limit(1);
    if (
      !operatorAccount
      || operatorAccount.status !== "active"
      || operatorAccount.role !== req.session.role
    ) {
      return res.status(403).json({ error: "The authenticated CAD operator account is not active" });
    }
    const data = cadDerivativeMetadataSchema.parse(req.body);
    const job = await loadJob(req, res);
    if (!job) return;
    const hybridDraft = data.lineageKind === "hybrid_draft_completion";
    const validApprovedSource = job.sourceFormat === "dxf"
      && job.status === "done"
      && job.approvedRevision !== null
      && job.approvedRevision === job.revisionCount
      && Boolean(job.approvedAt);
    const validHybridDraft = job.sourceFormat === "dxf"
      && job.status === "awaiting_review"
      && job.approvedRevision === null
      && data.sourceRevision === job.revisionCount;
    if ((hybridDraft && !validHybridDraft) || (!hybridDraft && !validApprovedSource)) {
      return res.status(409).json({
        error: hybridDraft
          ? "Hybrid CAD derivatives must bind the active unapproved draft revision"
          : "Human-edited CAD derivatives can only be attached to an approved native DXF revision",
      });
    }
    if (
      (hybridDraft && data.attestation !== CAD_HYBRID_DERIVATIVE_ATTESTATION)
      || (!hybridDraft && data.attestation !== CAD_DERIVATIVE_ATTESTATION)
    ) return res.status(400).json({ error: "The attestation does not match this derivative lineage" });
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No DXF or DWG derivative uploaded" });
    const originalFilename = Buffer.from(file.originalname, "latin1").toString("utf8").slice(0, 240);
    const extension = path.extname(originalFilename).toLowerCase();
    if (extension !== ".dxf" && extension !== ".dwg") {
      return res.status(400).json({ error: "A CAD derivative must have a .dxf or .dwg extension" });
    }
    const format = extension.slice(1) as "dxf" | "dwg";
    if (hybridDraft && format !== "dwg") {
      return res.status(400).json({ error: "Safe-hybrid completion requires the explicitly saved DWG derivative" });
    }
    await validateCadDerivativeContent(format, file.buffer);

    const draftEvidence = hybridDraft ? await readNativeDxfDraftEvidence(job) : null;
    let applicationOutputCounters: CadTableApplicationOutputCounters | null = null;
    if (hybridDraft) {
      if (!draftEvidence!.applicationOutputCaptureSupported) {
        return res.status(409).json({
          error: "This legacy draft requires a new captured-output table-script revision before derivative submission",
        });
      }
      if (!data.applicationOutput) {
        return res.status(400).json({ error: "Complete CWORKS_APPLY_TABLE_TRANSLATIONS output is required" });
      }
      applicationOutputCounters = parseCadTableApplicationOutput(data.applicationOutput, draftEvidence!);
    }
    if (hybridDraft && (
      !["passed", "findings"].includes(job.machineAuditStatus)
      || job.machineAuditModel !== draftEvidence?.independentAuditModel
    )) {
      return res.status(409).json({ error: "Hybrid derivative submission is blocked until the bound independent audit completes successfully" });
    }
    if (draftEvidence?.machineDefectCount) {
      return res.status(409).json({ error: "Hybrid derivative submission is blocked by unresolved machine translation, patch, or independent-audit defects" });
    }
    if (hybridDraft && (
      data.sourceSha256 !== draftEvidence?.sourceSha256
      || data.sourceOutputSha256 !== draftEvidence?.translatedOutputSha256
      || data.preservationReportSha256 !== draftEvidence?.preservationReportSha256
      || data.ledgerSha256 !== draftEvidence?.ledgerSha256
      || data.placementManifestSha256 !== draftEvidence?.placementManifestSha256
      || data.tableScriptSha256 !== draftEvidence?.tableScriptSha256
      || data.tableManifestSha256 !== draftEvidence?.tableManifestSha256
      || !data.manualCoverageResolutions
      || !data.operationalVerification
    )) return res.status(409).json({ error: "Submitted hybrid evidence does not match the current source, script, manifest, or successful application counters" });
    if (hybridDraft) {
      const ids = data.manualCoverageResolutions!.map((item) => item.requirementId);
      if (
        new Set(ids).size !== ids.length
        || !isDeepStrictEqual([...ids].sort(), draftEvidence!.manualRequirementIds)
      ) return res.status(409).json({ error: "Every current manual CAD coverage requirement must be resolved exactly once" });
    } else {
      await Promise.all([
        readVerifiedNativeDxfReleaseAsset(job, "source"),
        readVerifiedNativeDxfReleaseAsset(job, "output"),
        readVerifiedNativeDxfReleaseAsset(job, "ledger"),
        readVerifiedNativeDxfReleaseAsset(job, "preservation-report"),
      ]);
    }
    const [approval] = hybridDraft ? [null] : await db.select().from(cworksTranslationReviewEvents)
      .where(and(
        eq(cworksTranslationReviewEvents.jobId, job.id),
        eq(cworksTranslationReviewEvents.revisionCount, job.approvedRevision),
        eq(cworksTranslationReviewEvents.decision, "approve"),
      ))
      .orderBy(desc(cworksTranslationReviewEvents.createdAt))
      .limit(1);
    if (!hybridDraft && (!approval || !SHA256_PATTERN.test(approval.translatedOutputSha256 || ""))) {
      return res.status(409).json({ error: "The approved source revision has no valid release attestation" });
    }

    const id = randomUUID();
    stagedName = `cworks-translator/${job.id}/cad-derivatives/${id}.${format}`;
    const derivativeSha256 = sha256Bytes(file.buffer);
    const recordedEvidence = hybridDraft ? {
      format: "cworks-hybrid-derivative-evidence-v2",
      derivativeSha256,
      sourceRevision: job.revisionCount,
      ...draftEvidence,
      counters: {
        expected: draftEvidence!.expectedAppliedCount,
        applied: applicationOutputCounters!.appliedCells,
        missing: applicationOutputCounters!.countMismatch,
        ambiguous: applicationOutputCounters!.unsafeCells,
        failed: applicationOutputCounters!.errors + applicationOutputCounters!.partialErrors,
        skipped: applicationOutputCounters!.skippedTargets,
      },
      applicationOutput: {
        text: data.applicationOutput,
        sha256: sha256Bytes(Buffer.from(data.applicationOutput!, "utf8")),
        parsedCounters: applicationOutputCounters,
      },
      manualCoverageResolutions: data.manualCoverageResolutions,
      operationalVerification: data.operationalVerification,
    } : {};
    await writeFileToObjectStorage(stagedName, file.buffer);
    const saved = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id)).limit(1);
      if (
        !currentJob
        || currentJob.sourceFormat !== "dxf"
        || currentJob.status !== job.status
        || currentJob.revisionCount !== job.revisionCount
        || currentJob.approvedRevision !== job.approvedRevision
        || currentJob.outputStoredName !== job.outputStoredName
        || currentJob.sourceStoredName !== job.sourceStoredName
        || currentJob.ledgerStoredName !== job.ledgerStoredName
        || currentJob.preservationStoredName !== job.preservationStoredName
      ) return null;
      const currentDraftEvidence = hybridDraft
        ? await readNativeDxfDraftEvidence(currentJob) : null;
      const verifiedAssets = hybridDraft ? [Buffer.of(1), Buffer.of(1), Buffer.of(1), Buffer.of(1)]
        : await Promise.all([
          readVerifiedNativeDxfReleaseAsset(currentJob, "source"),
          readVerifiedNativeDxfReleaseAsset(currentJob, "output"),
          readVerifiedNativeDxfReleaseAsset(currentJob, "ledger"),
          readVerifiedNativeDxfReleaseAsset(currentJob, "preservation-report"),
        ]);
      const [verifiedSource, verifiedOutput, verifiedLedger, verifiedReport] = verifiedAssets;
      const stagedBytes = await readFileFromObjectStorage(stagedName!);
      if (
        !verifiedSource.length
        || !verifiedLedger.length
        || !verifiedReport.length
        || (!hybridDraft && sha256Bytes(verifiedOutput) !== approval!.translatedOutputSha256)
        || (hybridDraft && !isDeepStrictEqual(currentDraftEvidence, draftEvidence))
        || !stagedBytes
        || sha256Bytes(stagedBytes) !== derivativeSha256
      ) return null;
      const [row] = await tx.insert(cworksTranslationCadDerivatives).values({
        id,
        jobId: job.id,
        sourceRevision: hybridDraft ? job.revisionCount : job.approvedRevision!,
        sourceOutputSha256: hybridDraft
          ? draftEvidence!.translatedOutputSha256 : approval!.translatedOutputSha256!,
        sourceApprovalEventId: approval?.id ?? null,
        lineageKind: data.lineageKind,
        evidence: recordedEvidence,
        originalFilename,
        format,
        storedName: stagedName!,
        sha256: derivativeSha256,
        operatorName: data.operatorName,
        operatorQualification: data.operatorQualification,
        operatorUserId: operatorAccount.id,
        operatorNotes: data.notes,
        operatorAttestation: data.attestation,
      }).returning();
      return row;
    });
    if (!saved) {
      await deleteFromObjectStorageStrict(stagedName);
      stagedName = null;
      return res.status(409).json({ error: "The approved source revision changed during upload" });
    }
    stagedName = null;
    ((req as any).log || logger).info({
      jobId: job.id,
      derivativeId: saved.id,
      sourceRevision: saved.sourceRevision,
      format: saved.format,
      sha256: saved.sha256,
    }, "Human-edited CAD derivative appended");
    res.status(201).json({ derivative: publicCadDerivative(saved) });
  } catch (err: any) {
    if (stagedName) {
      try {
        await deleteFromObjectStorageStrict(stagedName);
      } catch (cleanupErr: any) {
        await db.insert(cworksTranslationCleanup).values({
          storedName: stagedName,
          jobId: String(req.params.id),
          lastError: String(cleanupErr?.message || cleanupErr).slice(0, 800),
          nextAttemptAt: new Date(Date.now() + 30_000),
        }).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Operator identity, qualification, notes, and explicit attestation are required" });
    }
    if (err?.message === "CAD_DERIVATIVE_CONTENT_INVALID") {
      return res.status(400).json({ error: "The uploaded file does not pass DXF or DWG content sanity checks" });
    }
    if (err?.message === "DXF_RELEASE_ATTESTATION_INVALID") {
      return res.status(409).json({ error: "The approved native DXF evidence is missing or no longer matches its approval attestation" });
    }
    if (err?.message === "DXF_DRAFT_EVIDENCE_INVALID") {
      return res.status(409).json({ error: "The hybrid draft evidence is invalid, tampered, or no longer matches the current source" });
    }
    if (err?.message === "CAD_APPLICATION_OUTPUT_INVALID") {
      return res.status(400).json({ error: "The AutoCAD output must contain exactly one complete Cworks table translations counter line" });
    }
    if (err?.message === "CAD_APPLICATION_OUTPUT_COUNTERS_MISMATCH") {
      return res.status(409).json({ error: "The AutoCAD output counters do not match the bound table script manifest or report a non-successful application" });
    }
    ((req as any).log || logger).error({ err, jobId: req.params.id }, "CAD derivative upload failed");
    res.status(500).json({ error: "Could not store the CAD derivative" });
  }
});

router.get("/jobs/:id/cad-derivatives", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    const [derivatives, reviewEvents] = await Promise.all([
      db.select().from(cworksTranslationCadDerivatives)
        .where(eq(cworksTranslationCadDerivatives.jobId, job.id))
        .orderBy(asc(cworksTranslationCadDerivatives.createdAt)),
      db.select().from(cworksTranslationReviewEvents)
        .where(eq(cworksTranslationReviewEvents.jobId, job.id))
        .orderBy(
          desc(cworksTranslationReviewEvents.createdAt),
          desc(cworksTranslationReviewEvents.id),
        ),
    ]);
    res.json({
      derivatives: derivatives.map((derivative) => {
        const latest = reviewEvents.find((event) => event.derivativeId === derivative.id);
        return publicCadDerivative(
          derivative,
          latest?.decision === "derivative_approve" ? "approved"
            : latest?.decision === "derivative_revise" ? "revision_requested"
              : "pending_review",
        );
      }),
    });
  } catch (err: any) {
    ((req as any).log || logger).error({ err, jobId: req.params.id }, "CAD derivative listing failed");
    res.status(500).json({ error: "Could not list CAD derivatives" });
  }
});

async function readVerifiedHybridDraftDerivative(
  job: typeof cworksTranslationJobs.$inferSelect,
  derivative: typeof cworksTranslationCadDerivatives.$inferSelect,
): Promise<{ bytes: Buffer; evidence: NativeDxfDraftEvidence }> {
  if (
    job.status !== "awaiting_review"
    || job.approvedRevision !== null
    || !["passed", "findings"].includes(job.machineAuditStatus)
    || derivative.lineageKind !== "hybrid_draft_completion"
    || derivative.sourceRevision !== job.revisionCount
  ) throw new Error("CAD_DERIVATIVE_DRAFT_UNAVAILABLE");
  const [bytes, firstEvidence, secondEvidence] = await Promise.all([
    readFileFromObjectStorage(derivative.storedName),
    readNativeDxfDraftEvidence(job),
    readNativeDxfDraftEvidence(job),
  ]);
  if (
    !bytes
    || sha256Bytes(bytes) !== derivative.sha256
    || firstEvidence.machineDefectCount !== 0
    || job.machineAuditModel !== firstEvidence.independentAuditModel
    || !isDeepStrictEqual(firstEvidence, secondEvidence)
    || !hybridRecordedEvidenceMatches(
      derivative.evidence,
      firstEvidence,
      derivative.sha256,
      derivative.sourceRevision,
    )
  ) throw new Error("CAD_DERIVATIVE_EVIDENCE_STALE");
  return { bytes, evidence: secondEvidence };
}

router.get("/jobs/:id/cad-derivatives/:derivativeId/draft-download", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    const [derivative] = await db.select().from(cworksTranslationCadDerivatives)
      .where(and(
        eq(cworksTranslationCadDerivatives.id, String(req.params.derivativeId)),
        eq(cworksTranslationCadDerivatives.jobId, job.id),
      )).limit(1);
    if (!derivative) return res.status(404).json({ error: "CAD derivative not found" });
    const { bytes } = await readVerifiedHybridDraftDerivative(job, derivative);
    res.setHeader("Cache-Control", "no-store");
    sendVerifiedDownload(
      res,
      bytes,
      `DRAFT-NOT-RELEASED-${derivative.originalFilename}`,
      derivative.format === "dxf" ? "application/dxf" : "application/acad",
    );
  } catch (err: any) {
    if (
      err?.message === "CAD_DERIVATIVE_DRAFT_UNAVAILABLE"
      || err?.message === "CAD_DERIVATIVE_EVIDENCE_STALE"
      || err?.message === "DXF_DRAFT_EVIDENCE_INVALID"
    ) return res.status(409).json({
      error: "This draft derivative is unavailable, stale, or no longer matches the active source evidence",
    });
    if (!res.headersSent) res.status(500).json({ error: "Could not download the draft CAD derivative" });
  }
});

router.get("/jobs/:id/cad-derivatives/:derivativeId/draft-lineage-report", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    const [derivative] = await db.select().from(cworksTranslationCadDerivatives)
      .where(and(
        eq(cworksTranslationCadDerivatives.id, String(req.params.derivativeId)),
        eq(cworksTranslationCadDerivatives.jobId, job.id),
      )).limit(1);
    if (!derivative) return res.status(404).json({ error: "CAD derivative not found" });
    const { evidence } = await readVerifiedHybridDraftDerivative(job, derivative);
    const report = Buffer.from(`${JSON.stringify({
      format: "cworks-hybrid-cad-draft-lineage-v1",
      releaseStatus: "pending_qualified_derivative_review",
      warning: "DRAFT — NOT APPROVED OR RELEASED",
      job: { id: job.id, title: job.title },
      machineCleanSource: {
        revision: derivative.sourceRevision,
        approved: false,
        sourceSha256: evidence.sourceSha256,
        translatedOutputSha256: evidence.translatedOutputSha256,
        preservationReportSha256: evidence.preservationReportSha256,
        ledgerSha256: evidence.ledgerSha256,
        statement: "The machine-clean hybrid DXF is an immutable review input and will not be approved.",
      },
      derivative: {
        id: derivative.id,
        filename: derivative.originalFilename,
        format: derivative.format,
        sha256: derivative.sha256,
        evidence: derivative.evidence,
      },
      operator: {
        name: derivative.operatorName,
        qualification: derivative.operatorQualification,
        notes: derivative.operatorNotes,
        attestation: derivative.operatorAttestation,
      },
      claims: {
        qualifiedReviewPending: true,
        releasable: false,
        inheritedPreservationProof: false,
        bytePreservationClaim: false,
      },
    }, null, 2)}\n`, "utf8");
    res.setHeader("Cache-Control", "no-store");
    sendVerifiedDownload(
      res,
      report,
      `DRAFT-NOT-RELEASED-${path.parse(derivative.originalFilename).name}-lineage.json`,
      "application/json; charset=utf-8",
    );
  } catch (err: any) {
    if (
      err?.message === "CAD_DERIVATIVE_DRAFT_UNAVAILABLE"
      || err?.message === "CAD_DERIVATIVE_EVIDENCE_STALE"
      || err?.message === "DXF_DRAFT_EVIDENCE_INVALID"
    ) return res.status(409).json({
      error: "This draft lineage is unavailable, stale, or no longer matches the active source evidence",
    });
    if (!res.headersSent) res.status(500).json({ error: "Could not create the draft lineage report" });
  }
});

const cadDerivativeReviewSchema = z.object({
  decision: z.enum(["approve", "revise"]),
  declaration: z.boolean(),
  notes: z.string().trim().max(5000).optional().default(""),
}).strict();

router.post("/jobs/:id/cad-derivatives/:derivativeId/review", async (req, res) => {
  try {
    const data = cadDerivativeReviewSchema.parse(req.body);
    const reviewerUserId = req.session.userId;
    const reviewerRole = req.session.role;
    if (!reviewerUserId || !reviewerRole) {
      return res.status(401).json({ error: "Sign in with an authorized reviewer account to review CAD derivatives" });
    }
    if (data.decision === "approve" && !data.declaration) {
      return res.status(400).json({ error: "Confirm the qualified derivative-review declaration before release" });
    }
    if (data.decision === "revise" && !data.notes) {
      return res.status(400).json({ error: "Revision notes are required" });
    }
    const job = await loadJob(req, res);
    if (!job) return;
    const reopeningReleasedDerivative = data.decision === "revise" && job.status === "done";
    if (
      (job.status !== "awaiting_review" && !reopeningReleasedDerivative)
      || job.approvedRevision !== null
    ) {
      return res.status(409).json({ error: "Only an active hybrid draft, or its released derivative being returned for revision, can receive derivative review" });
    }
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const reviewed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [reviewer] = await tx.select({
        id: users.id,
        username: users.username,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
      }).from(users).where(eq(users.id, reviewerUserId)).for("update").limit(1);
      if (!reviewer || reviewer.status !== "active") {
        throw new Error("CAD_DERIVATIVE_REVIEWER_INACTIVE");
      }
      if (!CAD_DERIVATIVE_REVIEWER_ROLES.has(reviewer.role)) {
        throw new Error("CAD_DERIVATIVE_REVIEWER_UNAUTHORIZED");
      }
      const reviewerName = reviewer.displayName?.trim()
        || reviewer.email?.trim()
        || reviewer.username;
      const reviewerQualification = `Authorized ${reviewer.role} CAD release reviewer`;
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id)).limit(1);
      const [derivative] = await tx.select().from(cworksTranslationCadDerivatives)
        .where(and(
          eq(cworksTranslationCadDerivatives.id, String(req.params.derivativeId)),
          eq(cworksTranslationCadDerivatives.jobId, job.id),
        )).limit(1);
      if (
        !currentJob
        || !derivative
        || currentJob.status !== job.status
        || currentJob.approvedRevision !== null
        || currentJob.revisionCount !== job.revisionCount
        || derivative.lineageKind !== "hybrid_draft_completion"
        || derivative.sourceRevision !== currentJob.revisionCount
      ) return null;
      if (data.decision === "approve" && derivative.operatorUserId === reviewer.id) {
        throw new Error("CAD_DERIVATIVE_SELF_APPROVAL");
      }
      if (data.decision === "approve" && !derivative.operatorUserId) {
        throw new Error("CAD_DERIVATIVE_OPERATOR_IDENTITY_REQUIRED");
      }
      if (
        data.decision === "approve"
        && (derivative.evidence as any)?.format !== "cworks-hybrid-derivative-evidence-v2"
      ) throw new Error("CAD_DERIVATIVE_APPLICATION_OUTPUT_REQUIRED");
      if (currentJob.status === "done") {
        const [priorRelease] = await tx.select({
          id: cworksTranslationReviewEvents.id,
          decision: cworksTranslationReviewEvents.decision,
        })
          .from(cworksTranslationReviewEvents).where(and(
            eq(cworksTranslationReviewEvents.jobId, currentJob.id),
            eq(cworksTranslationReviewEvents.derivativeId, derivative.id),
          )).orderBy(
            desc(cworksTranslationReviewEvents.createdAt),
            desc(cworksTranslationReviewEvents.id),
          ).limit(1);
        if (
          data.decision !== "revise"
          || priorRelease?.decision !== "derivative_approve"
        ) return null;
      }
      const [firstEvidence, secondEvidence, derivativeBytes] = await Promise.all([
        readNativeDxfDraftEvidence(currentJob),
        readNativeDxfDraftEvidence(currentJob),
        readFileFromObjectStorage(derivative.storedName),
      ]);
      const expectedRecordedEvidence = derivative.evidence as any;
      if (
        firstEvidence.machineDefectCount !== 0
        || !["passed", "findings"].includes(currentJob.machineAuditStatus)
        || currentJob.machineAuditModel !== firstEvidence.independentAuditModel
        || !isDeepStrictEqual(firstEvidence, secondEvidence)
        || !derivativeBytes
        || sha256Bytes(derivativeBytes) !== derivative.sha256
        || !hybridRecordedEvidenceMatches(
          expectedRecordedEvidence,
          firstEvidence,
          derivative.sha256,
          currentJob.revisionCount,
        )
      ) throw new Error("CAD_DERIVATIVE_EVIDENCE_STALE");
      const [pages, pageReviews] = await Promise.all([
        tx.select().from(cworksTranslationPages)
          .where(eq(cworksTranslationPages.jobId, currentJob.id))
          .orderBy(asc(cworksTranslationPages.pageNumber)),
        tx.select().from(cworksTranslationPageReviews).where(and(
          eq(cworksTranslationPageReviews.jobId, currentJob.id),
          eq(cworksTranslationPageReviews.revisionCount, currentJob.revisionCount),
        )),
      ]);
      const reviewsByPage = new Map(pageReviews.map((review) => [review.pageNumber, review]));
      const snapshot = pages.map((page) => {
        const review = reviewsByPage.get(page.pageNumber);
        const findings = Array.isArray(page.machineAuditFindings) ? page.machineAuditFindings : [];
        const resolved = new Set(Array.isArray(review?.resolvedFindingIndexes)
          ? review.resolvedFindingIndexes.filter((value): value is number => Number.isInteger(value))
          : []);
        return {
          pageNumber: page.pageNumber,
          checked: review?.checked === true,
          notes: review?.notes || null,
          machineAuditStatus: page.machineAuditStatus,
          findings,
          findingCount: findings.length,
          resolvedFindingIndexes: [...resolved].sort((a, b) => a - b),
          allFindingsResolved: findings.every((_finding, index) => resolved.has(index)),
        };
      });
      if (
        data.decision === "approve"
        && (pages.length !== currentJob.pageCount
          || snapshot.some((page) =>
            page.machineAuditStatus === "pending"
            || !page.checked
            || !page.allFindingsResolved))
      ) throw new Error("CAD_DERIVATIVE_REVIEW_INCOMPLETE");
      const [event] = await tx.insert(cworksTranslationReviewEvents).values({
        jobId: currentJob.id,
        revisionCount: currentJob.revisionCount,
        decision: data.decision === "approve" ? "derivative_approve" : "derivative_revise",
        reviewerName,
        reviewerQualification,
        reviewerUserId: reviewer.id,
        reviewerRole: reviewer.role,
        reviewerSessionId,
        declaration: data.decision === "approve"
          ? CAD_DERIVATIVE_REVIEW_DECLARATION
          : "I reviewed the exact CAD derivative and returned it for revision without authorizing release.",
        derivativeId: derivative.id,
        derivativeEvidenceSnapshot: {
          derivativeId: derivative.id,
          derivativeSha256: derivative.sha256,
          sourceRevision: derivative.sourceRevision,
          evidence: derivative.evidence,
        },
        pageReviewSnapshot: snapshot,
        notes: data.notes || null,
      }).returning();
      if (data.decision === "approve") {
        await tx.update(cworksTranslationJobs).set({
          status: "done",
          progressNote: "Qualified human review complete — hybrid CAD derivative is ready",
          feedbackNotes: data.notes || null,
          completedAt: new Date(),
          // The machine-clean hybrid parent is deliberately never approved.
          approvedRevision: null,
          approvedAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(cworksTranslationJobs.id, currentJob.id),
          eq(cworksTranslationJobs.status, "awaiting_review"),
          eq(cworksTranslationJobs.revisionCount, currentJob.revisionCount),
        ));
      } else if (currentJob.status === "done") {
        await tx.update(cworksTranslationJobs).set({
          status: "awaiting_review",
          progressNote: "Released hybrid CAD derivative returned for correction",
          feedbackNotes: data.notes,
          completedAt: null,
          approvedRevision: null,
          approvedAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(cworksTranslationJobs.id, currentJob.id),
          eq(cworksTranslationJobs.status, "done"),
          eq(cworksTranslationJobs.revisionCount, currentJob.revisionCount),
        ));
      }
      return { event, derivative };
    });
    if (!reviewed) return res.status(409).json({ error: "The hybrid draft or derivative changed during review" });
    res.json({
      decision: reviewed.event.decision,
      derivative: publicCadDerivative(
        reviewed.derivative,
        reviewed.event.decision === "derivative_approve"
          ? "approved" : "revision_requested",
      ),
      reviewEventId: reviewed.event.id,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid derivative review" });
    if (err?.message === "CAD_DERIVATIVE_REVIEWER_INACTIVE") {
      return res.status(403).json({ error: "The authenticated reviewer account is not active" });
    }
    if (err?.message === "CAD_DERIVATIVE_REVIEWER_UNAUTHORIZED") {
      return res.status(403).json({ error: "Your account is not authorized to approve CAD derivative releases" });
    }
    if (err?.message === "CAD_DERIVATIVE_SELF_APPROVAL") {
      return res.status(403).json({ error: "The CAD operator who submitted this derivative cannot approve its release" });
    }
    if (err?.message === "CAD_DERIVATIVE_OPERATOR_IDENTITY_REQUIRED") {
      return res.status(409).json({ error: "This historical derivative has no authenticated operator identity and must be resubmitted before approval" });
    }
    if (err?.message === "CAD_DERIVATIVE_REVIEW_INCOMPLETE") {
      return res.status(409).json({ error: "Derivative release is blocked until every review page is checked and every finding is resolved" });
    }
    if (err?.message === "CAD_DERIVATIVE_APPLICATION_OUTPUT_REQUIRED") {
      return res.status(409).json({
        error: "This candidate predates captured AutoCAD output and must be resubmitted with the complete command output before approval",
      });
    }
    if (err?.message === "CAD_DERIVATIVE_EVIDENCE_STALE" || err?.message === "DXF_DRAFT_EVIDENCE_INVALID") {
      return res.status(409).json({ error: "The derivative evidence is invalid, tampered, or no longer matches the source revision" });
    }
    res.status(500).json({ error: "Could not review the CAD derivative" });
  }
});

router.get("/jobs/:id/cad-derivatives/:derivativeId/download", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    const [derivative] = await db.select().from(cworksTranslationCadDerivatives)
      .where(and(
        eq(cworksTranslationCadDerivatives.id, String(req.params.derivativeId)),
        eq(cworksTranslationCadDerivatives.jobId, job.id),
      )).limit(1);
    if (!derivative) return res.status(404).json({ error: "CAD derivative not found" });
    if (derivative.lineageKind === "hybrid_draft_completion") {
      const [release] = await db.select().from(cworksTranslationReviewEvents)
        .where(and(
          eq(cworksTranslationReviewEvents.jobId, job.id),
          eq(cworksTranslationReviewEvents.derivativeId, derivative.id),
        )).orderBy(
          desc(cworksTranslationReviewEvents.createdAt),
          desc(cworksTranslationReviewEvents.id),
        ).limit(1);
      if (
        !release
        || release.decision !== "derivative_approve"
        || job.status !== "done"
        || job.revisionCount !== derivative.sourceRevision
      ) {
        return res.status(409).json({ error: "This hybrid CAD derivative is locked until qualified derivative review" });
      }
      const currentEvidence = await readNativeDxfDraftEvidence(job);
      const recorded = derivative.evidence as any;
      if (
        currentEvidence.machineDefectCount !== 0
        || !["passed", "findings"].includes(job.machineAuditStatus)
        || job.machineAuditModel !== currentEvidence.independentAuditModel
        || (release.derivativeEvidenceSnapshot as any)?.derivativeId !== derivative.id
        || (release.derivativeEvidenceSnapshot as any)?.derivativeSha256 !== derivative.sha256
        || !isDeepStrictEqual(
          (release.derivativeEvidenceSnapshot as any)?.evidence,
          derivative.evidence,
        )
        || !hybridRecordedEvidenceMatches(
          recorded,
          currentEvidence,
          derivative.sha256,
          derivative.sourceRevision,
        )
      ) return res.status(409).json({ error: "This derivative release is stale or no longer matches its source evidence" });
    }
    const bytes = await readFileFromObjectStorage(derivative.storedName);
    if (!bytes || sha256Bytes(bytes) !== derivative.sha256) {
      return res.status(409).json({ error: "The CAD derivative is missing or no longer matches its recorded SHA-256" });
    }
    sendVerifiedDownload(
      res,
      bytes,
      derivative.originalFilename,
      derivative.format === "dxf" ? "application/dxf" : "application/acad",
    );
  } catch (err: any) {
    ((req as any).log || logger).error({ err, jobId: req.params.id }, "CAD derivative download failed");
    if (!res.headersSent) res.status(500).json({ error: "Could not download the CAD derivative" });
  }
});

router.get("/jobs/:id/cad-derivatives/:derivativeId/lineage-report", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    const [derivative] = await db.select().from(cworksTranslationCadDerivatives)
      .where(and(
        eq(cworksTranslationCadDerivatives.id, String(req.params.derivativeId)),
        eq(cworksTranslationCadDerivatives.jobId, job.id),
      )).limit(1);
    if (!derivative) return res.status(404).json({ error: "CAD derivative not found" });
    const hybridDraft = derivative.lineageKind === "hybrid_draft_completion";
    const [approval] = await db.select().from(cworksTranslationReviewEvents)
      .where(hybridDraft ? and(
        eq(cworksTranslationReviewEvents.jobId, job.id),
        eq(cworksTranslationReviewEvents.derivativeId, derivative.id),
      ) : and(
        eq(cworksTranslationReviewEvents.id, derivative.sourceApprovalEventId!),
        eq(cworksTranslationReviewEvents.jobId, job.id),
        eq(cworksTranslationReviewEvents.revisionCount, derivative.sourceRevision),
        eq(cworksTranslationReviewEvents.decision, "approve"),
      )).orderBy(
        desc(cworksTranslationReviewEvents.createdAt),
        desc(cworksTranslationReviewEvents.id),
      ).limit(1);
    const bytes = await readFileFromObjectStorage(derivative.storedName);
    if (
      !approval
      || (hybridDraft && approval.decision !== "derivative_approve")
      || (!hybridDraft && approval.translatedOutputSha256 !== derivative.sourceOutputSha256)
      || !bytes
      || sha256Bytes(bytes) !== derivative.sha256
    ) {
      return res.status(409).json({
        error: "The CAD derivative or its reviewed source lineage no longer matches the recorded evidence",
      });
    }
    if (hybridDraft) {
      const currentEvidence = await readNativeDxfDraftEvidence(job);
      const recorded = derivative.evidence as any;
      if (
        job.status !== "done"
        || job.revisionCount !== derivative.sourceRevision
        || currentEvidence.machineDefectCount !== 0
        || !["passed", "findings"].includes(job.machineAuditStatus)
        || job.machineAuditModel !== currentEvidence.independentAuditModel
        || (approval.derivativeEvidenceSnapshot as any)?.derivativeId !== derivative.id
        || (approval.derivativeEvidenceSnapshot as any)?.derivativeSha256 !== derivative.sha256
        || !isDeepStrictEqual(
          (approval.derivativeEvidenceSnapshot as any)?.evidence,
          derivative.evidence,
        )
        || !hybridRecordedEvidenceMatches(
          recorded,
          currentEvidence,
          derivative.sha256,
          derivative.sourceRevision,
        )
      ) return res.status(409).json({ error: "The hybrid derivative source evidence is stale" });
    }
    const report = Buffer.from(`${JSON.stringify({
      format: "cworks-human-edited-cad-lineage-v1",
      artifactClass: "human_edited_cad_derivative",
      job: {
        id: job.id,
        title: job.title,
      },
      machineCleanSource: {
        revision: derivative.sourceRevision,
        translatedOutputSha256: derivative.sourceOutputSha256,
        approvalEventId: derivative.sourceApprovalEventId,
        approved: !hybridDraft,
        preservationScope: hybridDraft
          ? "The machine-clean hybrid DXF remains an unapproved draft; its byte proof does not authorize release."
          : "Surgical preservation proof applies only to the approved machine-clean DXF and its preservation report.",
      },
      approvedMachineCleanSource: hybridDraft ? null : {
        revision: derivative.sourceRevision,
        translatedOutputSha256: derivative.sourceOutputSha256,
        approvalEventId: derivative.sourceApprovalEventId,
        preservationScope: "Surgical preservation proof applies only to the approved machine-clean DXF and its preservation report.",
      },
      humanEditedDerivative: {
        id: derivative.id,
        filename: derivative.originalFilename,
        format: derivative.format,
        sha256: derivative.sha256,
        createdAt: derivative.createdAt.toISOString(),
      },
      operator: {
        name: derivative.operatorName,
        qualification: derivative.operatorQualification,
        notes: derivative.operatorNotes,
        attestation: derivative.operatorAttestation,
      },
      hybridCompletionEvidence: hybridDraft ? derivative.evidence : null,
      derivativeReview: hybridDraft ? {
        eventId: approval.id,
        reviewerName: approval.reviewerName,
        reviewerQualification: approval.reviewerQualification,
        declaration: approval.declaration,
        evidenceSnapshot: approval.derivativeEvidenceSnapshot,
        createdAt: approval.createdAt.toISOString(),
      } : null,
      claims: {
        separatelyAttested: true,
        inheritedPreservationProof: false,
        bytePreservationClaim: false,
        statement: "This human-edited derivative has its own integrity hash and lineage record. It does not inherit surgical or byte-preservation claims.",
      },
    }, null, 2)}\n`, "utf8");
    sendVerifiedDownload(
      res,
      report,
      `${path.parse(derivative.originalFilename).name}-lineage-report.json`,
      "application/json; charset=utf-8",
    );
  } catch (err: any) {
    ((req as any).log || logger).error({ err, jobId: req.params.id }, "CAD derivative lineage report failed");
    if (!res.headersSent) res.status(500).json({ error: "Could not create the CAD derivative lineage report" });
  }
});

const pageReviewSchema = z.object({
  checked: z.boolean(),
  resolvedFindingIndexes: z.array(z.number().int().min(0).max(999)).max(100).default([]),
  notes: z.string().trim().max(2000).optional().default(""),
});

router.put("/jobs/:id/pages/:pageNumber/review", async (req, res) => {
  try {
    const data = pageReviewSchema.parse(req.body);
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.status !== "awaiting_review") {
      return res.status(409).json({ error: "Only the active draft revision can be checked" });
    }
    const pageNumber = Number(req.params.pageNumber);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: "Invalid page number" });
    }
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const review = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [activeJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id))
        .limit(1);
      if (!activeJob || activeJob.status !== "awaiting_review") return null;
      const [page] = await tx.select().from(cworksTranslationPages)
        .where(and(
          eq(cworksTranslationPages.jobId, job.id),
          eq(cworksTranslationPages.pageNumber, pageNumber),
        ))
        .limit(1);
      if (!page) return undefined;
      const findings = Array.isArray(page.machineAuditFindings) ? page.machineAuditFindings : [];
      const resolvedFindingIndexes = Array.from(new Set(data.resolvedFindingIndexes)).sort((a, b) => a - b);
      if (resolvedFindingIndexes.some((index) => index >= findings.length)) {
        throw new Error("INVALID_FINDING_INDEX");
      }
      const [saved] = await tx.insert(cworksTranslationPageReviews).values({
        jobId: job.id,
        revisionCount: activeJob.revisionCount,
        pageNumber,
        checked: data.checked,
        resolvedFindingIndexes,
        notes: data.notes || null,
        reviewerSessionId,
        checkedAt: data.checked ? new Date() : null,
      }).onConflictDoUpdate({
        target: [
          cworksTranslationPageReviews.jobId,
          cworksTranslationPageReviews.revisionCount,
          cworksTranslationPageReviews.pageNumber,
        ],
        set: {
          checked: data.checked,
          resolvedFindingIndexes,
          notes: data.notes || null,
          reviewerSessionId,
          checkedAt: data.checked ? new Date() : null,
          updatedAt: new Date(),
        },
      }).returning();
      return saved;
    });
    if (review === null) return res.status(409).json({ error: "Only the active draft revision can be checked" });
    if (review === undefined) return res.status(404).json({ error: "Review page not found" });
    res.json({ review });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid page review" });
    if (err?.message === "INVALID_FINDING_INDEX") {
      return res.status(400).json({ error: "A resolved finding does not belong to this page" });
    }
    res.status(500).json({ error: err.message });
  }
});

const manualTouchupPreviewSchema = z.object({
  revisionCount: z.number().int().min(0),
  blockId: z.string().trim().min(1).max(160),
  translation: z.string().trim().min(1).max(600),
  reason: z.string().trim().min(3).max(1000),
});

router.post("/jobs/:id/pages/:pageNumber/touchups/preview", async (req, res) => {
  let stagedPreview: string | null = null;
  try {
    const data = manualTouchupPreviewSchema.parse(req.body);
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat === "dxf") return res.status(409).json({ error: "Manual PDF touch-up previews cannot be used for native DXF drawings" });
    const requestedTargetLanguage = job.targetLanguage === "ja" ? "ja" : "en";
    if (!isCworksTargetLanguageText(data.translation, requestedTargetLanguage)) {
      return res.status(422).json({
        error: `The replacement must be written in ${requestedTargetLanguage === "ja" ? "Japanese" : "English"}.`,
      });
    }
    const pageNumber = Number(req.params.pageNumber);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: "Invalid page number" });
    }
    if (job.status !== "awaiting_review" || job.revisionCount !== data.revisionCount) {
      return res.status(409).json({ error: "This draft changed. Reload it before previewing a touch-up." });
    }
    const preview = await previewCworksManualTouchup(job, pageNumber, data.blockId, data.translation);
    const blockWarning = preview.meta.warnings.find((warning) => warning.blockId === data.blockId);
    if (blockWarning) {
      return res.status(422).json({
        error: `This text still cannot be placed safely: ${blockWarning.rejectionCategory.replaceAll("_", " ")}.`,
        warning: blockWarning,
      });
    }
    const previewId = randomUUID();
    stagedPreview = `cworks-translator/${job.id}/touchup-previews/${previewId}.jpg`;
    await writeFileToObjectStorage(stagedPreview, preview.thumbnail);
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const saved = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id)).limit(1);
      if (
        !currentJob
        || currentJob.status !== "awaiting_review"
        || currentJob.revisionCount !== data.revisionCount
      ) return null;
      const [row] = await tx.insert(cworksTranslationTouchups).values({
        id: previewId,
        jobId: job.id,
        sourceRevision: data.revisionCount,
        pageNumber,
        blockId: data.blockId,
        sourceText: preview.sourceText,
        beforeTranslation: preview.beforeTranslation,
        afterTranslation: data.translation,
        reason: data.reason,
        status: "previewed",
        reviewerSessionId,
        previewStoredName: stagedPreview,
        previewWarnings: preview.meta.warnings,
        renderFingerprint: preview.renderFingerprint,
        renderLayoutVersion: preview.renderLayoutVersion,
        expiresAt,
      }).returning();
      return row;
    });
    if (!saved) {
      await deleteFromObjectStorageStrict(stagedPreview);
      stagedPreview = null;
      return res.status(409).json({ error: "This draft changed while the preview was rendering. Reload and try again." });
    }
    stagedPreview = null;
    res.json({
      preview: {
        id: saved.id,
        expiresAt: saved.expiresAt,
        thumbnailUrl: `/api/cworks-translator/jobs/${job.id}/touchups/${saved.id}/thumbnail`,
        message: "The replacement passed clipping, readability, overlap, and drawing-linework checks.",
      },
    });
  } catch (err: any) {
    if (stagedPreview) {
      try {
        await deleteFromObjectStorageStrict(stagedPreview);
      } catch {
        await db.insert(cworksTranslationCleanup).values({
          storedName: stagedPreview,
          jobId: req.params.id,
        }).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
    }
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Enter a translation and a neutral reason" });
    if (err?.message === "MANUAL_BLOCK_NOT_FOUND") {
      return res.status(404).json({ error: "That translated block is not part of this revision" });
    }
    if (err?.message === "MANUAL_SOURCE_MISSING") {
      return res.status(409).json({ error: "The original PDF is unavailable for safe preview" });
    }
    res.status(500).json({ error: "Could not render the manual touch-up preview" });
  }
});

router.get("/jobs/:id/touchups/:touchupId/thumbnail", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    const [touchup] = await db.select().from(cworksTranslationTouchups).where(and(
      eq(cworksTranslationTouchups.id, req.params.touchupId),
      eq(cworksTranslationTouchups.jobId, job.id),
    )).limit(1);
    const reviewerSessionId = req.session.cworksReviewerSessionId || "";
    if (
      !touchup?.previewStoredName
      || touchup.status !== "previewed"
      || touchup.reviewerSessionId !== reviewerSessionId
      || touchup.expiresAt.getTime() <= Date.now()
    ) {
      return res.status(404).json({ error: "Touch-up preview not found" });
    }
    const ok = await streamFromObjectStorage(touchup.previewStoredName, res, {
      contentType: "image/jpeg",
      disposition: "inline",
      filename: `touchup-page-${touchup.pageNumber}.jpg`,
      req,
    });
    if (!ok && !res.headersSent) res.status(404).json({ error: "Touch-up preview missing" });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.delete("/jobs/:id/touchups/:touchupId", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat === "dxf") return res.status(409).json({ error: "Manual PDF touch-up commits cannot be used for native DXF drawings" });
    const reviewerSessionId = req.session.cworksReviewerSessionId || "";
    const discarded = await db.transaction(async (tx) => {
      const [row] = await tx.update(cworksTranslationTouchups).set({
        status: "discarded",
      }).where(and(
        eq(cworksTranslationTouchups.id, req.params.touchupId),
        eq(cworksTranslationTouchups.jobId, job.id),
        eq(cworksTranslationTouchups.reviewerSessionId, reviewerSessionId),
        eq(cworksTranslationTouchups.status, "previewed"),
      )).returning();
      if (row?.previewStoredName) {
        await tx.insert(cworksTranslationCleanup).values({
          storedName: row.previewStoredName,
          jobId: job.id,
        }).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
      return row;
    });
    if (!discarded) return res.status(404).json({ error: "Active touch-up preview not found" });
    if (discarded.previewStoredName) {
      try {
        await deleteFromObjectStorageStrict(discarded.previewStoredName);
        await db.delete(cworksTranslationCleanup).where(
          eq(cworksTranslationCleanup.storedName, discarded.previewStoredName),
        );
      } catch {
        // The durable cleanup outbox retries transient private-storage failures.
      }
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/jobs/:id/touchups/:touchupId/commit", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat === "dxf") return res.status(409).json({ error: "Manual PDF touch-up commits cannot be used for native DXF drawings" });
    const reviewerSessionId = req.session.cworksReviewerSessionId || "";
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id)).limit(1);
      const [touchup] = await tx.select().from(cworksTranslationTouchups).where(and(
        eq(cworksTranslationTouchups.id, req.params.touchupId),
        eq(cworksTranslationTouchups.jobId, job.id),
      )).limit(1);
      const requestedTargetLanguage = currentJob?.targetLanguage === "ja" ? "ja" : "en";
      if (
        touchup
        && !isCworksTargetLanguageText(touchup.afterTranslation, requestedTargetLanguage)
      ) {
        throw new Error("MANUAL_TOUCHUP_WRONG_TARGET_LANGUAGE");
      }
      if (
        !currentJob
        || !touchup
        || currentJob.status !== "awaiting_review"
        || currentJob.revisionCount !== touchup.sourceRevision
        || touchup.status !== "previewed"
        || touchup.reviewerSessionId !== reviewerSessionId
        || touchup.expiresAt.getTime() <= Date.now()
        || touchup.renderLayoutVersion !== cworksRenderLayoutVersion
        || !touchup.renderFingerprint
      ) return null;
      const nextRevision = currentJob.revisionCount + 1;
      const [changed] = await tx.update(cworksTranslationJobs).set({
        status: "revising",
        progress: 0,
        pagesDone: 0,
        progressNote: `Manual translated-text touch-up queued for page ${touchup.pageNumber}`,
        feedbackNotes: `Manual translated-text touch-up: ${touchup.reason}`,
        repairBrief: {
          kind: "cworks-manual-touchup",
          sourceRevision: currentJob.revisionCount,
          previewRenderFingerprint: touchup.renderFingerprint,
          previewRenderLayoutVersion: touchup.renderLayoutVersion,
          requestedAt: new Date().toISOString(),
          pages: [{
            pageNumber: touchup.pageNumber,
            unsafePlacementBlockIds: [touchup.blockId],
            placementFailures: [],
            retryWholePage: false,
            findings: [],
            reviewerNotes: touchup.reason,
          }],
          overrides: [{
            pageNumber: touchup.pageNumber,
            blockId: touchup.blockId,
            translation: touchup.afterTranslation,
          }],
        },
        revisionCount: nextRevision,
        machineAuditStatus: "pending",
        machineAuditModel: null,
        approvedRevision: null,
        approvedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "awaiting_review"),
        eq(cworksTranslationJobs.revisionCount, touchup.sourceRevision),
      )).returning();
      if (!changed) return null;
      await tx.update(cworksTranslationTouchups).set({
        status: "committed",
        committedRevision: nextRevision,
        committedAt: new Date(),
      }).where(eq(cworksTranslationTouchups.id, touchup.id));
      await tx.insert(cworksTranslationReviewEvents).values({
        jobId: job.id,
        revisionCount: touchup.sourceRevision,
        decision: "manual_touchup",
        reviewerName: "Authenticated reviewer",
        reviewerQualification: "Manual translated-text editor session",
        reviewerSessionId,
        declaration: "The reviewer proposed a translated-text-only correction that passed renderer preflight. No approval or correctness attestation was granted.",
        pageReviewSnapshot: [{
          pageNumber: touchup.pageNumber,
          blockId: touchup.blockId,
          sourceText: touchup.sourceText,
          beforeTranslation: touchup.beforeTranslation,
          afterTranslation: touchup.afterTranslation,
          reason: touchup.reason,
          previewRenderFingerprint: touchup.renderFingerprint,
          previewRenderLayoutVersion: touchup.renderLayoutVersion,
        }],
        notes: touchup.reason,
      });
      return changed;
    });
    if (!updated) {
      return res.status(409).json({ error: "This preview expired or the draft changed. Preview the touch-up again." });
    }
    kickCworksTranslationWorker();
    res.json({ job: publicJob(updated) });
  } catch (err: any) {
    if (err?.message === "MANUAL_TOUCHUP_WRONG_TARGET_LANGUAGE") {
      return res.status(422).json({ error: "The replacement does not match this job's target language." });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post("/jobs/:id/restore-previous-revision", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat === "dxf") return res.status(409).json({ error: "Native DXF revisions require a CAD operator review; PDF restore is not applicable" });
    if (!["awaiting_review", "done"].includes(job.status) || job.revisionCount < 1) {
      return res.status(409).json({ error: "There is no previous completed revision to restore" });
    }
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id)).limit(1);
      if (
        !currentJob
        || currentJob.status !== job.status
        || currentJob.revisionCount !== job.revisionCount
      ) return null;
      const checkpoints = await tx.select().from(cworksTranslationCheckpoints).where(and(
        eq(cworksTranslationCheckpoints.jobId, job.id),
        sql`${cworksTranslationCheckpoints.revisionCount} IN (${currentJob.revisionCount}, ${currentJob.revisionCount - 1})`,
      ));
      const currentRows = checkpoints.filter((row) => row.revisionCount === currentJob.revisionCount);
      const previousRows = checkpoints.filter((row) => row.revisionCount === currentJob.revisionCount - 1);
      if (!currentRows.length || previousRows.length !== currentRows.length) {
        throw new Error("RESTORE_CHECKPOINTS_MISSING");
      }
      const currentByPage = new Map(currentRows.map((row) => [row.pageNumber, row]));
      const overrides: Array<{ pageNumber: number; blockId: string; translation: string }> = [];
      for (const priorRow of previousRows) {
        const currentTranslations = Array.isArray(currentByPage.get(priorRow.pageNumber)?.translations)
          ? currentByPage.get(priorRow.pageNumber)!.translations as any[]
          : [];
        const currentById = new Map(currentTranslations.map((item) => [item?.id, item]));
        for (const previous of Array.isArray(priorRow.translations) ? priorRow.translations as any[] : []) {
          const current = currentById.get(previous?.id);
          if (
            current
            && current.source === previous.source
            && current.translation !== previous.translation
            && typeof previous.translation === "string"
          ) {
            overrides.push({
              pageNumber: priorRow.pageNumber,
              blockId: previous.id,
              translation: previous.translation,
            });
          }
        }
      }
      if (!overrides.length) throw new Error("NOTHING_TO_RESTORE");
      const changedPages = Array.from(new Set(overrides.map((item) => item.pageNumber))).sort((a, b) => a - b);
      const nextRevision = currentJob.revisionCount + 1;
      const [changed] = await tx.update(cworksTranslationJobs).set({
        status: "revising",
        progress: 0,
        pagesDone: 0,
        progressNote: `Restoring translations from revision ${currentJob.revisionCount - 1}`,
        feedbackNotes: `Restore the previous translated text as a new auditable revision.`,
        repairBrief: {
          kind: "cworks-manual-touchup",
          sourceRevision: currentJob.revisionCount,
          restoredFromRevision: currentJob.revisionCount - 1,
          requestedAt: new Date().toISOString(),
          pages: changedPages.map((pageNumber) => ({
            pageNumber,
            unsafePlacementBlockIds: overrides
              .filter((item) => item.pageNumber === pageNumber)
              .map((item) => item.blockId),
            placementFailures: [],
            retryWholePage: false,
            findings: [],
            reviewerNotes: "Restore previous revision",
          })),
          overrides,
        },
        revisionCount: nextRevision,
        machineAuditStatus: "pending",
        machineAuditModel: null,
        approvedRevision: null,
        approvedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, currentJob.status),
        eq(cworksTranslationJobs.revisionCount, currentJob.revisionCount),
      )).returning();
      if (!changed) return null;
      await tx.insert(cworksTranslationReviewEvents).values({
        jobId: job.id,
        revisionCount: currentJob.revisionCount,
        decision: "restore_revision",
        reviewerName: "Authenticated reviewer",
        reviewerQualification: "Revision recovery control",
        reviewerSessionId,
        declaration: "The reviewer restored the immediately previous translated text into a new draft. The original PDF was not altered and no approval was granted.",
        pageReviewSnapshot: { restoredFromRevision: currentJob.revisionCount - 1, changedPages },
        notes: "Previous translated text restored into a new auditable revision.",
      });
      return changed;
    });
    if (!updated) return res.status(409).json({ error: "Another reviewer already changed this job" });
    kickCworksTranslationWorker();
    res.json({ job: publicJob(updated) });
  } catch (err: any) {
    if (err?.message === "RESTORE_CHECKPOINTS_MISSING") {
      return res.status(409).json({ error: "The previous revision is not fully recoverable" });
    }
    if (err?.message === "NOTHING_TO_RESTORE") {
      return res.status(409).json({ error: "The previous revision has the same translated text" });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post("/jobs/:id/fix-unresolved", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat === "dxf") return res.status(409).json({ error: "Native DXF fit failures must be resolved without automatic geometry repair" });
    if (job.status !== "awaiting_review") {
      return res.status(409).json({ error: "Only the active draft can start an automatic repair pass" });
    }
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id))
        .limit(1);
      if (
        !currentJob
        || currentJob.status !== "awaiting_review"
        || currentJob.revisionCount !== job.revisionCount
      ) return null;
      const pages = await tx.select().from(cworksTranslationPages)
        .where(eq(cworksTranslationPages.jobId, job.id))
        .orderBy(asc(cworksTranslationPages.pageNumber));
      const reviews = await tx.select().from(cworksTranslationPageReviews)
        .where(and(
          eq(cworksTranslationPageReviews.jobId, job.id),
          eq(cworksTranslationPageReviews.revisionCount, currentJob.revisionCount),
        ));
      const checkpoints = await tx.select().from(cworksTranslationCheckpoints)
        .where(and(
          eq(cworksTranslationCheckpoints.jobId, job.id),
          eq(cworksTranslationCheckpoints.revisionCount, currentJob.revisionCount),
        ));
      const reviewsByPage = new Map(reviews.map((review) => [review.pageNumber, review]));
      const blockIdsByPage = new Map(checkpoints.map((checkpoint) => [
        checkpoint.pageNumber,
        new Set(
          (Array.isArray(checkpoint.translations) ? checkpoint.translations : [])
            .map((translation: any) => translation?.id)
            .filter((id): id is string => typeof id === "string"),
        ),
      ]));
      const repairPages = pages.map((page) => {
        const review = reviewsByPage.get(page.pageNumber);
        const resolved = new Set(
          Array.isArray(review?.resolvedFindingIndexes)
            ? review.resolvedFindingIndexes.filter((value): value is number => Number.isInteger(value))
            : [],
        );
        const findings = (Array.isArray(page.machineAuditFindings) ? page.machineAuditFindings : [])
          .map((finding: any, index) => ({
            index,
            type: String(finding?.type || "audit"),
            message: String(finding?.message || "Independent audit finding").slice(0, 2000),
            sourceBlockId: typeof finding?.sourceBlockId === "string" ? finding.sourceBlockId : undefined,
          }))
          .filter((finding) => !resolved.has(finding.index));
        const placementDeficit = Math.max(0, page.sourceBlockCount - page.translatedBlockCount);
        const validBlockIds = blockIdsByPage.get(page.pageNumber) || new Set<string>();
        const placementFailures = (Array.isArray(page.warnings) ? page.warnings : [])
          .flatMap((warning: any) => {
            if (!warning || typeof warning !== "object" || typeof warning.blockId !== "string") return [];
            const bbox = Array.isArray(warning.bbox)
              && warning.bbox.length === 4
              && warning.bbox.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
              ? warning.bbox.map(Number)
              : undefined;
            const rejectionCategory = typeof warning.rejectionCategory === "string"
              ? warning.rejectionCategory.slice(0, 80)
              : "placement";
            return validBlockIds.has(warning.blockId)
              ? [{
                  blockId: warning.blockId,
                  rejectionCategory,
                  ...(bbox ? { bbox } : {}),
                }]
              : [];
          });
        const reportedPlacementIds = Array.from(new Set(
          (Array.isArray(page.warnings) ? page.warnings : [])
            .map((warning: any) =>
              warning && typeof warning === "object" && typeof warning.blockId === "string"
                ? warning.blockId
                : String(warning))
            .filter((warning) => /^p\d+-(?:l|ocr)\d+/i.test(warning)),
        ));
        const unsafePlacementBlockIds = Array.from(new Set(
          reportedPlacementIds.filter((warning) => validBlockIds.has(warning)),
        )).slice(0, placementDeficit || undefined);
        const unlocatedPlacementCount = Math.max(0, placementDeficit - unsafePlacementBlockIds.length);
        const hasUnlocatedFinding = findings.some((finding) =>
          !finding.sourceBlockId || !validBlockIds.has(finding.sourceBlockId));
        if (!findings.length && placementDeficit === 0) return null;
        return {
          pageNumber: page.pageNumber,
          unsafePlacementBlockIds,
          placementFailures: placementFailures
            .filter((failure) => unsafePlacementBlockIds.includes(failure.blockId))
            .slice(0, placementDeficit || undefined),
          unlocatedPlacementCount,
          retryWholePage: unlocatedPlacementCount > 0 || hasUnlocatedFinding,
          findings,
          reviewerNotes: review?.notes || null,
        };
      }).filter((page): page is NonNullable<typeof page> => page !== null);
      if (!repairPages.length) throw new Error("NOTHING_TO_REPAIR");
      const repairBrief = {
        kind: "cworks-unresolved-repair",
        sourceRevision: currentJob.revisionCount,
        requestedAt: new Date().toISOString(),
        pages: repairPages,
      };
      const snapshot = pages.map((page) => {
        const review = reviewsByPage.get(page.pageNumber);
        return {
          pageNumber: page.pageNumber,
          checked: review?.checked === true,
          notes: review?.notes || null,
          resolvedFindingIndexes: Array.isArray(review?.resolvedFindingIndexes)
            ? review.resolvedFindingIndexes
            : [],
        };
      });
      const [changed] = await tx.update(cworksTranslationJobs).set({
        status: "revising",
        progress: 0,
        pagesDone: 0,
        progressNote: "Automatic unresolved-finding repair queued",
        feedbackNotes: `Automatically retry unresolved placements and unchecked audit findings on ${repairPages.length} page(s).`,
        repairBrief,
        revisionCount: sql`${cworksTranslationJobs.revisionCount} + 1`,
        machineAuditStatus: "pending",
        machineAuditModel: null,
        approvedRevision: null,
        approvedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "awaiting_review"),
        eq(cworksTranslationJobs.revisionCount, currentJob.revisionCount),
      )).returning();
      if (!changed) return null;
      await tx.insert(cworksTranslationReviewEvents).values({
        jobId: job.id,
        revisionCount: currentJob.revisionCount,
        decision: "automatic_repair",
        reviewerName: "Automatic repair",
        reviewerQualification: "Server-generated unresolved-finding pass",
        reviewerSessionId,
        declaration: "The authenticated reviewer requested a new draft from unresolved placements and unchecked audit findings. No approval was granted.",
        pageReviewSnapshot: snapshot,
        notes: changed.feedbackNotes,
      });
      return changed;
    });
    if (!updated) return res.status(409).json({ error: "Another reviewer already changed this job" });
    kickCworksTranslationWorker();
    res.json({ job: publicJob(updated) });
  } catch (err: any) {
    if (err?.message === "NOTHING_TO_REPAIR") {
      return res.status(409).json({ error: "There are no unresolved placements or unchecked audit findings to repair" });
    }
    res.status(500).json({ error: err.message });
  }
});

const nativeDxfTargetedCorrectionSchema = z.object({
  // This is intentionally not an implicit consequence of clicking a generic
  // "fix" control: it creates a chargeable, independently re-audited revision.
  consentToTargetedDxfCorrection: z.literal(true),
  // Bind consent to the revision the reviewer inspected. A delayed duplicate
  // may never spend correction work against a later draft.
  expectedSourceRevision: z.number().int().min(0),
});

/**
 * POST /jobs/:id/correct-unresolved
 * { consentToTargetedDxfCorrection: true, expectedSourceRevision: number }
 *
 * Creates a new revision seeded from the immutable current DXF checkpoint.
 * The worker can translate only its targetIds once, then independently
 * re-audits the complete drawing.  It never means "restart translation".
 */
router.post("/jobs/:id/correct-unresolved", async (req, res) => {
  try {
    const request = nativeDxfTargetedCorrectionSchema.parse(req.body || {});
    const reviewerUserId = req.session.userId;
    const reviewerRole = req.session.role;
    if (!reviewerUserId || !reviewerRole) {
      return res.status(401).json({ error: "Sign in with an authorized owner account before starting a targeted DXF correction" });
    }
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.sourceFormat !== "dxf") {
      return res.status(409).json({ error: "Targeted native correction is available only for DXF drafts" });
    }
    if (job.revisionCount !== request.expectedSourceRevision) {
      return res.status(409).json({ error: "This DXF draft changed before correction consent was submitted. Refresh the review and try again." });
    }
    if (job.status !== "awaiting_review") {
      return res.status(409).json({ error: "Only the active DXF draft can start a targeted correction revision" });
    }
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [reviewer] = await tx.select({
        id: users.id,
        username: users.username,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
      }).from(users).where(eq(users.id, reviewerUserId)).for("update").limit(1);
      if (
        !reviewer
        || reviewer.status !== "active"
        || reviewer.role !== reviewerRole
        || !CAD_DERIVATIVE_REVIEWER_ROLES.has(reviewer.role)
      ) throw new Error("TARGETED_DXF_CORRECTION_UNAUTHORIZED");
      const [current] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id)).limit(1);
      if (
        !current
        || current.status !== "awaiting_review"
        || current.revisionCount !== request.expectedSourceRevision
      ) {
        return null;
      }
      const [checkpoint] = await tx.select().from(cworksTranslationCheckpoints).where(and(
        eq(cworksTranslationCheckpoints.jobId, job.id),
        eq(cworksTranslationCheckpoints.revisionCount, current.revisionCount),
        eq(cworksTranslationCheckpoints.pageNumber, 1),
      )).limit(1);
      const [pages, reviews] = await Promise.all([
        tx.select().from(cworksTranslationPages)
          .where(eq(cworksTranslationPages.jobId, job.id))
          .orderBy(asc(cworksTranslationPages.pageNumber)),
        tx.select().from(cworksTranslationPageReviews).where(and(
          eq(cworksTranslationPageReviews.jobId, job.id),
          eq(cworksTranslationPageReviews.revisionCount, current.revisionCount),
        )),
      ]);
      const reviewsByPage = new Map(reviews.map((review) => [review.pageNumber, review]));
      // Page-review finding indexes are user decisions for this exact source
      // revision. Do not re-send a finding explicitly resolved by the reviewer.
      const resolvedFindingTargetIds = new Set<string>();
      const unresolvedPageFindings = pages.map((page) => {
        const resolved = new Set(
          Array.isArray(reviewsByPage.get(page.pageNumber)?.resolvedFindingIndexes)
            ? reviewsByPage.get(page.pageNumber)!.resolvedFindingIndexes
              .filter((index): index is number => Number.isInteger(index))
            : [],
        );
        const findings = Array.isArray(page.machineAuditFindings) ? page.machineAuditFindings : [];
        findings.forEach((finding, index) => {
          if (!resolved.has(index)) return;
          findingTargetIds(finding).forEach((targetId) => resolvedFindingTargetIds.add(targetId));
        });
        return findings.filter((_finding, index) => !resolved.has(index));
      });
      const repairBrief = buildNativeDxfTargetedCorrectionBrief({
        sourceRevision: current.revisionCount,
        targetLanguage: current.targetLanguage,
        checkpoint: checkpointExcludingResolvedAuditFindings(
          checkpoint?.translations,
          resolvedFindingTargetIds,
        ),
        pageFindings: unresolvedPageFindings,
      });
      if (!repairBrief) throw new Error("NO_TARGETED_DXF_CORRECTION_CANDIDATES");
      const archive = await archiveCworksArtifactsForRevision(current, pages);
      const [changed] = await tx.update(cworksTranslationJobs).set({
        status: "revising",
        progress: 0,
        pagesDone: 0,
        progressNote: `Consented targeted DXF correction queued for ${repairBrief.targetIds.length} audited unresolved target(s)`,
        feedbackNotes: `Consented targeted native DXF correction of ${repairBrief.targetIds.length} unresolved/audit-affected target(s); complete independent re-audit required.`,
        repairBrief,
        revisionCount: sql`${cworksTranslationJobs.revisionCount} + 1`,
        retryCount: 0,
        machineAuditStatus: "pending",
        machineAuditModel: null,
        approvedRevision: null,
        approvedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "awaiting_review"),
        eq(cworksTranslationJobs.revisionCount, current.revisionCount),
      )).returning();
      if (!changed) return null;
      await tx.insert(cworksTranslationReviewEvents).values({
        jobId: job.id,
        revisionCount: current.revisionCount,
        decision: "native_dxf_correction",
        reviewerName: reviewer.displayName?.trim() || reviewer.email?.trim() || reviewer.username,
        reviewerQualification: `Authorized ${reviewer.role} native DXF correction reviewer`,
        reviewerUserId: reviewer.id,
        reviewerRole: reviewer.role,
        reviewerSessionId,
        declaration: "The reviewer explicitly consented to one targeted native DXF correction pass for unresolved and independent-audit-affected target IDs. A new revision and full independent re-audit are required; no approval was granted.",
        pageReviewSnapshot: {
          successorRevision: current.revisionCount + 1,
          targetIds: repairBrief.targetIds,
          correctionBudget: repairBrief.correctionBudget,
          ...archive,
        },
        notes: changed.feedbackNotes,
      });
      return changed;
    });
    if (!updated) return res.status(409).json({ error: "Another reviewer already changed this job" });
    kickCworksTranslationWorker();
    res.json({
      job: publicJob(updated),
      correction: {
        targeted: true,
        correctionBudget: 1,
        reAudit: "complete_drawing",
      },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Explicit targeted DXF correction consent and the reviewed source revision are required" });
    }
    if (err?.message === "TARGETED_DXF_CORRECTION_UNAUTHORIZED") {
      return res.status(403).json({ error: "Only an active workspace owner or administrator can start a targeted DXF correction" });
    }
    if (err?.message === "NO_TARGETED_DXF_CORRECTION_CANDIDATES") {
      return res.status(409).json({ error: "No patchable unresolved or audit-affected DXF target is available for correction" });
    }
    res.status(500).json({ error: err.message });
  }
});

const feedbackSchema = z.object({
  decision: z.enum(["approve", "revise"]),
  notes: z.string().max(5000).optional().default(""),
  reviewerName: z.string().trim().min(2).max(120),
  reviewerQualification: z.string().trim().min(3).max(500),
  declaration: z.boolean().default(false),
  cadOperatorDeclaration: z.boolean().optional().default(false),
  cadOperatorName: z.string().trim().min(2).max(120).optional(),
  cadOperatorQualification: z.string().trim().min(3).max(500).optional(),
});

router.post("/jobs/:id/feedback", async (req, res) => {
  try {
    const data = feedbackSchema.parse(req.body);
    const job = await loadJob(req, res);
    if (!job) return;
    if (
      job.sourceFormat === "dxf"
      && data.decision === "approve"
      && (
        !data.cadOperatorDeclaration
        || !data.cadOperatorName
        || !data.cadOperatorQualification
      )
    ) {
      return res.status(400).json({ error: "DXF approval requires a separate CAD operator name, qualification, and explicit declaration" });
    }
    const revisingApprovedRevision = data.decision === "revise" && job.status === "done";
    if (job.status !== "awaiting_review" && !revisingApprovedRevision) {
      return res.status(409).json({
        error: data.decision === "approve"
          ? "Only a draft waiting for review can be approved"
          : "This job cannot be revised from its current state",
      });
    }
    if (data.decision === "revise" && !data.notes.trim()) {
      return res.status(400).json({ error: "Add page-specific notes for the revision" });
    }
    const [pages, pageReviews] = await Promise.all([
      db.select().from(cworksTranslationPages)
        .where(eq(cworksTranslationPages.jobId, job.id))
        .orderBy(asc(cworksTranslationPages.pageNumber)),
      db.select().from(cworksTranslationPageReviews)
        .where(and(
          eq(cworksTranslationPageReviews.jobId, job.id),
          eq(cworksTranslationPageReviews.revisionCount, job.revisionCount),
        )),
    ]);
    const coverage = publicCoverage(pages, job.sourceFormat);
    const reviewsByPage = new Map(pageReviews.map((review) => [review.pageNumber, review]));
    const reviewSnapshot = pages.map((page) => {
      const review = reviewsByPage.get(page.pageNumber);
      const findings = Array.isArray(page.machineAuditFindings) ? page.machineAuditFindings : [];
      const resolved = new Set(
        Array.isArray(review?.resolvedFindingIndexes)
          ? review.resolvedFindingIndexes.filter((value): value is number => Number.isInteger(value))
          : [],
      );
      return {
        pageNumber: page.pageNumber,
        checked: review?.checked === true,
        notes: review?.notes || null,
        machineAuditStatus: page.machineAuditStatus,
        findingCount: findings.length,
        resolvedFindingIndexes: Array.from(resolved).sort((a, b) => a - b),
        allFindingsResolved: findings.every((_finding, index) => resolved.has(index)),
      };
    });
    if (data.decision === "approve") {
      if (!data.declaration) {
        return res.status(400).json({ error: "Confirm the qualified-reviewer declaration before approval" });
      }
      if (!coverage.complete) {
        return res.status(409).json({
          error: `Approval is blocked: ${coverage.unresolvedLineCount} target lines remain unresolved. Request a revision instead.`,
          coverage,
        });
      }
      if (job.machineAuditStatus === "pending") {
        return res.status(409).json({
          error: "Approval is blocked until the independent page audit has completed",
        });
      }
      if (job.sourceFormat === "dxf" && job.machineAuditStatus !== "passed") {
        return res.status(409).json({
          error: "Native DXF approval is blocked until the independent source/plain/replacement/accounting audit passes without findings",
        });
      }
      if (
        pages.length !== job.pageCount
        || reviewSnapshot.some((page) => !page.checked || !page.allFindingsResolved)
      ) {
        return res.status(409).json({
          error: "Approval is blocked until every page is checked and every independent-audit finding is resolved",
          pages: reviewSnapshot,
        });
      }
    }
    if (data.decision === "approve" && job.sourceFormat === "dxf") {
      // Fast preflight avoids taking the transaction lock for plainly invalid
      // evidence. Only the later locked reads authorize release.
      await readNativeDxfApprovalEvidence(job);
    }
    const declaration = data.decision === "approve"
      ? "I confirm that I am qualified to review this source-language engineering drawing and that I checked every page, resolved every listed finding, and accept responsibility for releasing this revision."
      : "I reviewed this draft and am returning it for revision.";
    const reviewerSessionId = req.session.cworksReviewerSessionId || randomUUID();
    req.session.cworksReviewerSessionId = reviewerSessionId;
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id))
        .limit(1);
      if (
        !currentJob
        || currentJob.status !== job.status
        || currentJob.revisionCount !== job.revisionCount
        || (
          job.sourceFormat === "dxf"
          && data.decision === "approve"
          && (
            currentJob.sourceStoredName !== job.sourceStoredName
            || currentJob.outputStoredName !== job.outputStoredName
            || currentJob.preservationStoredName !== job.preservationStoredName
            || currentJob.ledgerStoredName !== job.ledgerStoredName
          )
        )
      ) return null;
      let lockedCadEvidence: NativeDxfApprovalEvidence | null = null;
      if (data.decision === "approve" && currentJob.sourceFormat === "dxf") {
        const firstLockedRead = await readNativeDxfApprovalEvidence(currentJob);
        const secondLockedRead = await readNativeDxfApprovalEvidence(currentJob);
        if (!isDeepStrictEqual(firstLockedRead, secondLockedRead)) {
          throw new Error("DXF_APPROVAL_EVIDENCE_INVALID");
        }
        lockedCadEvidence = secondLockedRead;
      }
      const lockedPages = await tx.select().from(cworksTranslationPages)
        .where(eq(cworksTranslationPages.jobId, job.id))
        .orderBy(asc(cworksTranslationPages.pageNumber));
      const lockedReviews = await tx.select().from(cworksTranslationPageReviews)
        .where(and(
          eq(cworksTranslationPageReviews.jobId, job.id),
          eq(cworksTranslationPageReviews.revisionCount, currentJob.revisionCount),
        ));
      const lockedCoverage = publicCoverage(lockedPages, currentJob.sourceFormat);
      const lockedReviewsByPage = new Map(lockedReviews.map((review) => [review.pageNumber, review]));
      const lockedSnapshot = lockedPages.map((page) => {
        const review = lockedReviewsByPage.get(page.pageNumber);
        const findings = Array.isArray(page.machineAuditFindings) ? page.machineAuditFindings : [];
        const resolved = new Set(
          Array.isArray(review?.resolvedFindingIndexes)
            ? review.resolvedFindingIndexes.filter((value): value is number => Number.isInteger(value))
            : [],
        );
        return {
          pageNumber: page.pageNumber,
          checked: review?.checked === true,
          notes: review?.notes || null,
          machineAuditStatus: page.machineAuditStatus,
          findingCount: findings.length,
          resolvedFindingIndexes: Array.from(resolved).sort((a, b) => a - b),
          allFindingsResolved: findings.every((_finding, index) => resolved.has(index)),
        };
      });
      if (data.decision === "approve") {
        if (!lockedCoverage.complete) throw new Error("APPROVAL_COVERAGE_CHANGED");
        if (
          currentJob.machineAuditStatus === "pending"
          || (currentJob.sourceFormat === "dxf" && currentJob.machineAuditStatus !== "passed")
          || lockedPages.length !== currentJob.pageCount
          || lockedSnapshot.some((page) =>
            page.machineAuditStatus === "pending"
            || !page.checked
            || !page.allFindingsResolved)
        ) throw new Error("APPROVAL_REVIEW_CHANGED");
      }
      const [changed] = await tx.update(cworksTranslationJobs).set(data.decision === "approve" ? {
        status: "done",
        progressNote: "Qualified human review complete — final translated drawing set is ready",
        feedbackNotes: data.notes.trim() || null,
        repairBrief: null,
        approvedRevision: currentJob.revisionCount,
        approvedAt: new Date(),
        completedAt: new Date(),
        updatedAt: new Date(),
      } : {
        status: "revising",
        progress: 0,
        pagesDone: 0,
        progressNote: "Revision queued",
        feedbackNotes: data.notes.trim(),
        repairBrief: null,
        revisionCount: sql`${cworksTranslationJobs.revisionCount} + 1`,
        machineAuditStatus: "pending",
        machineAuditModel: null,
        approvedRevision: null,
        approvedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, currentJob.status),
        eq(cworksTranslationJobs.revisionCount, currentJob.revisionCount),
      )).returning();
      if (!changed) return null;
      await tx.insert(cworksTranslationReviewEvents).values({
        jobId: job.id,
        revisionCount: currentJob.revisionCount,
        decision: data.decision,
        reviewerName: data.reviewerName,
        reviewerQualification: data.reviewerQualification,
        reviewerSessionId,
        declaration,
        cadOperatorName: data.decision === "approve" && job.sourceFormat === "dxf"
          ? data.cadOperatorName
          : null,
        cadOperatorQualification: data.decision === "approve" && job.sourceFormat === "dxf"
          ? data.cadOperatorQualification
          : null,
        cadOperatorAttestation: data.decision === "approve" && job.sourceFormat === "dxf"
          ? CAD_OPERATOR_ATTESTATION
          : null,
        sourceSha256: data.decision === "approve" && job.sourceFormat === "dxf"
          ? lockedCadEvidence?.sourceSha256
          : null,
        translatedOutputSha256: data.decision === "approve" && job.sourceFormat === "dxf"
          ? lockedCadEvidence?.translatedOutputSha256
          : null,
        preservationReportSha256: data.decision === "approve" && job.sourceFormat === "dxf"
          ? lockedCadEvidence?.preservationReportSha256
          : null,
        ledgerSha256: data.decision === "approve" && job.sourceFormat === "dxf"
          ? lockedCadEvidence?.ledgerSha256
          : null,
        pageReviewSnapshot: lockedSnapshot,
        notes: data.notes.trim() || null,
      });
      return changed;
    });
    if (!updated) {
      return res.status(409).json({ error: "Another reviewer already changed this job" });
    }
    if (data.decision === "revise") kickCworksTranslationWorker();
    res.json({ job: publicJob(updated) });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid feedback" });
    if (err?.message === "APPROVAL_COVERAGE_CHANGED") {
      return res.status(409).json({ error: "Approval is blocked because translation coverage changed during review" });
    }
    if (err?.message === "APPROVAL_REVIEW_CHANGED") {
      return res.status(409).json({ error: "Approval is blocked because page-review or audit state changed during approval" });
    }
    if (err?.message === "DXF_APPROVAL_EVIDENCE_INVALID") {
      return res.status(409).json({ error: "Native DXF approval evidence is missing, invalid, or no longer matches the translated output" });
    }
    res.status(500).json({ error: err.message });
  }
});

const retryRequestSchema = z.object({
  mode: z.enum(["resume", "restart", "full_restart"]).default("resume"),
  confirmRepeatAiUsage: z.boolean().optional(),
});

router.post("/jobs/:id/retry", async (req, res) => {
  try {
    const request = retryRequestSchema.parse(req.body || {});
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.status !== "failed") {
      return res.status(409).json({ error: "Only failed jobs can be retried" });
    }
    if (hasUnsettledCworksProviderRequest(job.id)) {
      return res.status(409).json({
        error: "The previous translation request is still shutting down. Wait a moment before retrying so two provider requests cannot overlap.",
      });
    }
    const retryMetadata = await retryMetadataForJob(job);
    const fullRestart = request.mode === "restart" || request.mode === "full_restart";
    if (request.mode === "resume" && !retryMetadata.resumeAvailable) {
      return res.status(409).json({
        error: `Resume is unavailable: ${retryMetadata.resumeReason}. Choose full restart to repeat AI work.`,
        retryMetadata,
      });
    }
    if (fullRestart && request.confirmRepeatAiUsage !== true) {
      return res.status(400).json({
        error: "Full restart requires explicit confirmation that AI translation and audit usage may be repeated.",
        retryMetadata,
      });
    }
    const updated = await db.transaction(async (tx) => {
      const [changed] = await tx.update(cworksTranslationJobs).set({
        status: "queued",
        progress: fullRestart ? 0 : job.progress,
        pagesDone: fullRestart ? 0 : job.pagesDone,
        repairBrief: retryRepairBriefForRequest(
          job,
          fullRestart ? "full_restart" : "resume",
        ),
        progressNote: fullRestart
          ? "Full restart queued — saved checkpoints will not be reused"
          : "Resume queued from validated saved translation and placement checkpoints",
        errorMessage: null,
        retryCount: 0,
        runToken: null,
        leaseExpiresAt: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "failed"),
      )).returning();
      if (!changed) return null;
      if (fullRestart) {
        // Only the active failed revision is reset. Checkpoints and private
        // objects belonging to prior revisions are immutable review evidence.
        await tx.delete(cworksTranslationCheckpoints).where(and(
          eq(cworksTranslationCheckpoints.jobId, job.id),
          eq(cworksTranslationCheckpoints.revisionCount, job.revisionCount),
        ));
        await tx.delete(cworksTranslationRenderCheckpoints).where(and(
          eq(cworksTranslationRenderCheckpoints.jobId, job.id),
          eq(cworksTranslationRenderCheckpoints.revisionCount, job.revisionCount),
        ));
      }
      return changed;
    });
    if (!updated) return res.status(409).json({ error: "Only failed jobs can be retried" });
    kickCworksTranslationWorker();
    res.json({
      job: publicJob(updated),
      retryMode: request.mode as RetryMode,
      repeatedAiUsageWarning: fullRestart
        ? retryMetadata.fullRestartWarning
        : null,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid retry mode. Choose resume or restart." });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete("/jobs/:id", async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    // Changing the status fences an active worker before the row is removed.
    // The advisory lock also serializes derivative uploads so their object key
    // cannot appear after this transaction snapshots cleanup metadata.
    const queued = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.id}))`);
      const [currentJob] = await tx.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, job.id))
        .limit(1);
      if (!currentJob || currentJob.status !== job.status) return null;
      const [deleting] = await tx.update(cworksTranslationJobs)
        .set({ status: "deleting", progressNote: "Deleting private job files", updatedAt: new Date() })
        .where(and(eq(cworksTranslationJobs.id, currentJob.id), eq(cworksTranslationJobs.status, currentJob.status)))
        .returning({ id: cworksTranslationJobs.id });
      if (!deleting) return null;
      const pages = await tx.select().from(cworksTranslationPages)
        .where(eq(cworksTranslationPages.jobId, currentJob.id));
      const renderCheckpoints = await tx.select().from(cworksTranslationRenderCheckpoints)
        .where(eq(cworksTranslationRenderCheckpoints.jobId, currentJob.id));
      const touchups = await tx.select().from(cworksTranslationTouchups)
        .where(eq(cworksTranslationTouchups.jobId, currentJob.id));
      const cadDerivatives = await tx.select().from(cworksTranslationCadDerivatives)
        .where(eq(cworksTranslationCadDerivatives.jobId, currentJob.id));
      const reviewEvents = await tx.select().from(cworksTranslationReviewEvents)
        .where(eq(cworksTranslationReviewEvents.jobId, currentJob.id));
      const objectNames = Array.from(new Set([
        currentJob.sourceStoredName,
        currentJob.outputStoredName,
        currentJob.summaryStoredName,
        currentJob.ledgerStoredName,
        currentJob.preservationStoredName,
        ...pages.map((p) => p.thumbnailStoredName),
        ...pages.map((p) => p.sourceThumbnailStoredName),
        ...renderCheckpoints.flatMap((checkpoint) => [
          checkpoint.fragmentStoredName,
          checkpoint.thumbnailStoredName,
        ]),
        ...touchups.map((touchup) => touchup.previewStoredName),
        ...cadDerivatives.map((derivative) => derivative.storedName),
        ...reviewEvents.flatMap((event) => {
          const snapshot = event.pageReviewSnapshot as any;
          return [
            typeof snapshot?.archivedTableScriptStoredName === "string"
              ? snapshot.archivedTableScriptStoredName
              : null,
            ...(Array.isArray(snapshot?.priorArtifacts)
              ? snapshot.priorArtifacts.map((artifact: any) =>
                typeof artifact?.storedName === "string" ? artifact.storedName : null)
              : []),
          ];
        }),
      ].filter((name): name is string => Boolean(name))));
      // Cleanup rows have no job FK, so they survive the cascading job delete
      // and are retried by the worker after transient storage failures.
      if (objectNames.length) {
        await tx.insert(cworksTranslationCleanup).values(objectNames.map((storedName) => ({
          storedName,
          jobId: job.id,
        }))).onConflictDoNothing({ target: cworksTranslationCleanup.storedName });
      }
      // Native DXF inspection caches register themselves in the same outbox
      // while their job is alive, but are deferred from deletion until this
      // transaction removes that job. Bring those existing rows forward so
      // deletion does not leave a job-scoped cache waiting for its defer TTL.
      await tx.update(cworksTranslationCleanup).set({ nextAttemptAt: new Date() })
        .where(eq(cworksTranslationCleanup.jobId, job.id));
      const removed = await tx.delete(cworksTranslationJobs).where(and(
        eq(cworksTranslationJobs.id, job.id),
        eq(cworksTranslationJobs.status, "deleting"),
      )).returning({ id: cworksTranslationJobs.id });
      if (!removed.length) throw new Error("Job deletion could not be finalized");
      return objectNames.length;
    });
    if (queued === null) {
      return res.status(409).json({ error: "The job changed while deletion was starting; refresh and try again" });
    }
    kickCworksTranslationWorker();
    res.json({ ok: true, cleanupQueued: queued });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
