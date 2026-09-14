// Route tests proving the Cworks drawing translator review screen can never
// leak half-finished translations:
//   - page listings and thumbnails appear for review, while translated assets
//     remain locked until the active revision has qualified-human approval
//   - approval requires every page check and every machine finding resolution
//   - repeated wrong passwords on /auth/login get rate limited
//
// Run with: node --import tsx --test artifacts/api-server/src/routes/cworks-review-visibility.test.ts
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  cworksTranslationJobs,
  cworksTranslationCadDerivatives,
  cworksTranslationCheckpoints,
  cworksTranslationPageReviews,
  cworksTranslationPages,
  cworksTranslationReviewEvents,
  cworksTranslationTouchups,
  users,
} from "@workspace/db/schema";
import {
  deleteFromObjectStorageStrict,
  readFileFromObjectStorage,
  writeFileToObjectStorage,
} from "../object-storage-helper";
import cworksTranslationRouter, {
  publicCoverageWithTranslations,
} from "./cworksTranslation";
import { buildNativeDxfTableScript, nativeDxfCheckpointMethodologyHash } from "../cworks-translator/worker";

const CAD_DERIVATIVE_ATTESTATION =
  "I attest that I am the identified qualified CAD operator, that I created and checked this human-edited CAD derivative from the linked approved native DXF revision, and that this derivative is not preservation proof and makes no byte-preservation claim.";
const CAD_HYBRID_DERIVATIVE_ATTESTATION =
  "I attest that I am the identified qualified CAD operator, that this derivative was created from the exact source-bound hybrid DXF revision in Windows AutoCAD with Unicode LISPSYS enabled, that I verified the source, script, and manifest hashes before applying, discarded any partial-application artifact, saved, closed, reopened, and inspected the derivative DWG, that the recorded script counters and manual coverage resolutions are complete and accurate, and that this derivative does not inherit byte-preservation proof.";

// ---------------------------------------------------------------------------
// Test app: mounts the REAL router. Sessions are faked from a header so tests
// can act as an authenticated reviewer without a real session store.
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).session = {
      cworksAuthed: req.header("x-test-authed") === "1",
      userId: req.header("x-test-user-id") || undefined,
      role: req.header("x-test-role") || undefined,
      regenerate: (cb: (err?: unknown) => void) => cb(),
      save: (cb: (err?: unknown) => void) => cb(),
    };
    next();
  });
  app.use("/api/cworks-translator", cworksTranslationRouter);
  return app;
}

async function get(path: string): Promise<{
  status: number;
  json: any;
  body: Buffer;
  headers: Headers;
}> {
  const res = await fetch(`${baseUrl}/api/cworks-translator${path}`, {
    headers: {
      "x-test-authed": "1",
      "x-test-user-id": REVIEWER_USER_ID,
      "x-test-role": "admin",
    },
  });
  let json: any = null;
  let body = Buffer.alloc(0);
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      body = Buffer.from(await res.arrayBuffer());
      json = JSON.parse(body.toString("utf8"));
    } catch { /* empty */ }
  } else {
    body = Buffer.from(await res.arrayBuffer());
  }
  return { status: res.status, json, body, headers: res.headers };
}

async function request(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  actor: { userId: string; role: string } = { userId: REVIEWER_USER_ID, role: "admin" },
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/cworks-translator${path}`, {
    method,
    headers: {
      "x-test-authed": "1",
      "x-test-user-id": actor.userId,
      "x-test-role": actor.role,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

async function uploadCadDerivative(
  jobId: string,
  filename: string,
  bytes: Buffer,
  fields: Record<string, string> = {},
): Promise<{ status: number; json: any; body: Buffer }> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  form.append("operatorName", fields.operatorName || "Derivative Operator");
  form.append("operatorQualification", fields.operatorQualification || "Qualified AutoCAD operator");
  form.append("notes", fields.notes || "Checked layouts and title blocks after the requested human CAD edits.");
  form.append("attestation", fields.attestation || CAD_DERIVATIVE_ATTESTATION);
  const res = await fetch(`${baseUrl}/api/cworks-translator/jobs/${jobId}/cad-derivatives`, {
    method: "POST",
    headers: {
      "x-test-authed": "1",
      "x-test-user-id": OPERATOR_USER_ID,
      "x-test-role": "admin",
    },
    body: form,
  });
  const body = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(body.toString("utf8")); } catch { /* binary/empty */ }
  return { status: res.status, json, body };
}

async function uploadHybridDerivative(
  jobId: string,
  bytes: Buffer,
  binding: any,
  overrides: Record<string, unknown> = {},
  authed = true,
): Promise<{ status: number; json: any; body: Buffer }> {
  const values: Record<string, unknown> = {
    lineageKind: "hybrid_draft_completion",
    sourceRevision: binding.sourceRevision,
    sourceSha256: binding.sourceSha256,
    sourceOutputSha256: binding.sourceOutputSha256,
    preservationReportSha256: binding.preservationReportSha256,
    ledgerSha256: binding.ledgerSha256,
    placementManifestSha256: binding.placementManifestSha256,
    tableScriptSha256: binding.tableScriptSha256,
    tableManifestSha256: binding.tableManifestSha256,
    applicationOutput: successfulApplicationOutput(binding),
    manualCoverageResolutions: binding.manualRequirementIds.map((requirementId: string) => ({
      requirementId,
      resolution: `Qualified operator inspected and resolved ${requirementId}.`,
    })),
    operationalVerification: {
      platform: "windows_autocad",
      autoCadMajorVersion: 2024,
      lispSys: 1,
      sourceScriptManifestHashesVerified: true,
      partialApplicationEvidenceDisposition: "discarded",
      savedClosedReopened: true,
      reopenedInspectionNotes: "Closed, reopened, and inspected both translated complex table cells.",
    },
    operatorName: "Hybrid CAD Operator",
    operatorQualification: "Qualified AutoCAD operator",
    notes: "Applied the bound script and checked all manual CAD coverage requirements.",
    attestation: CAD_HYBRID_DERIVATIVE_ATTESTATION,
    ...overrides,
  };
  const form = new FormData();
  form.append("file", new Blob([bytes]), "hybrid-completion.dwg");
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const res = await fetch(`${baseUrl}/api/cworks-translator/jobs/${jobId}/cad-derivatives`, {
    method: "POST",
    headers: authed ? {
      "x-test-authed": "1",
      "x-test-user-id": OPERATOR_USER_ID,
      "x-test-role": "admin",
    } : {},
    body: form,
  });
  const body = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(body.toString("utf8")); } catch { /* binary/empty */ }
  return { status: res.status, json, body };
}

function successfulApplicationOutput(
  binding: any,
  overrides: Partial<Record<"matchedTargets" | "appliedCells" | "skippedTargets" | "countMismatch" | "unsafeCells" | "partialErrors" | "errors", number>> = {},
  manifestSha256 = binding.tableManifestSha256,
): string {
  const counters = {
    matchedTargets: binding.tableTargetCount,
    appliedCells: binding.expectedCounters.applied,
    skippedTargets: 0,
    countMismatch: 0,
    unsafeCells: 0,
    partialErrors: 0,
    errors: 0,
    ...overrides,
  };
  return `Command: CWORKS_APPLY_TABLE_TRANSLATIONS
CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=${manifestSha256}
Cworks table translations: matchedTargets=${counters.matchedTargets} appliedCells=${counters.appliedCells} skippedTargets=${counters.skippedTargets} countMismatch=${counters.countMismatch} unsafeCells=${counters.unsafeCells} partialErrors=${counters.partialErrors} errors=${counters.errors}
CWORKS_APPLY_TABLE_TRANSLATIONS_END manifestSha256=${manifestSha256}
Command:`;
}

// ---------------------------------------------------------------------------
// Fixtures — all rows and stored objects created here are removed in after().
// ---------------------------------------------------------------------------

const run = randomUUID().slice(0, 8);
const OPERATOR_USER_ID = `cworks-operator-${run}`;
const REVIEWER_USER_ID = `cworks-reviewer-${run}`;
const VIEWER_USER_ID = `cworks-viewer-${run}`;
const testUserIds = [OPERATOR_USER_ID, REVIEWER_USER_ID, VIEWER_USER_ID];
const jobIds: string[] = [];
const storedNames: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function databaseErrorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: any = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(String(current.message || ""))) return true;
    current = current.cause;
  }
  return false;
}

function nativePreservationReport(
  source: Buffer,
  output: Buffer,
  targetCount = 106,
  targetLanguage: "en" | "ja" = "en",
): Buffer {
  const placementManifestSha256 = sha256(Buffer.from("test-placement-manifest"));
  return Buffer.from(JSON.stringify({
    format: "cworks-dxf-preservation-v1",
    targetLanguage,
    sourceSha256: sha256(source),
    placementManifestSha256,
    placementCount: targetCount,
    preserved: [],
    patch: {
      format: "dxf-surgical-patch-v1",
      targetLanguage,
      sourceSha256: sha256(source),
      outputSha256: sha256(output),
      approvedChanges: Array.from({ length: targetCount }, (_, index) => ({
        handle: `T${index}`,
      })),
      accountedMtextCount: targetCount,
      placementManifestSha256,
      placementCount: targetCount,
      unresolved: [],
      unchangedEntityPropertiesVerified: true,
      metadataIdentical: true,
      nonTextRecordsIdentical: true,
      reparsedCleanly: true,
      lineEndingPreserved: true,
      nonApprovedSegmentsIdentical: true,
    },
  }));
}

function nativeLedger(
  reportBytes: Buffer,
  targetCount = 106,
  targetLanguage: "en" | "ja" = "en",
): Buffer {
  const report = JSON.parse(reportBytes.toString("utf8"));
  const tableScript = buildNativeDxfTableScript([]);
  return Buffer.from(JSON.stringify({
    format: "cworks-native-dxf-ledger-v1",
    targetLanguage,
    sourceSha256: report.sourceSha256,
    placementManifestSha256: report.placementManifestSha256,
    placementCount: targetCount,
    tableTargets: [],
    tableScript,
    scriptAccounting: {
      sha256: tableScript.sha256,
      manifestSha256: tableScript.manifestSha256,
      targetCount: 0,
      expectedAppliedCount: 0,
      pendingManualApplicationCount: 0,
      blockingCount: 0,
    },
    entries: Array.from({ length: targetCount }, (_, index) => ({
      handle: `T${index}`,
      plain: `Цель ${index}`,
      isCyrillicTarget: true,
      replacement: targetLanguage === "ja" ? `対象${index}` : `Target ${index}`,
      accounting: "translated_and_patched",
      preservationReason: null,
      placementCount: 1,
      placements: [{
        placementId: `T${index}:direct`,
        x: index,
        y: index,
        insertPath: [],
      }],
    })),
    unresolved: [],
    blockingFindings: [],
    patch: report.patch,
  }));
}

async function makeReviewableDxf(
  suffix: string,
  patchedCount = 106,
  targetLanguage: "en" | "ja" = "en",
) {
  const id = `cworks-review-test-dxf-${suffix}-${run}`;
  jobIds.push(id);
  const source = Buffer.from(`DXF source ${id}`);
  const output = Buffer.from(`DXF translated output ${id}`);
  const report = nativePreservationReport(source, output, 106, targetLanguage);
  const ledger = nativeLedger(report, 106, targetLanguage);
  const sourceStoredName = `cworks-translator/${id}/source.dxf`;
  const outputStoredName = `cworks-translator/${id}/translated.dxf`;
  const preservationStoredName = `cworks-translator/${id}/preservation-report.json`;
  const ledgerStoredName = `cworks-translator/${id}/ledger.json`;
  const thumbnailStoredName = `cworks-translator/${id}/translated.svg`;
  storedNames.push(
    sourceStoredName,
    outputStoredName,
    preservationStoredName,
    ledgerStoredName,
    thumbnailStoredName,
  );
  await Promise.all([
    writeFileToObjectStorage(sourceStoredName, source),
    writeFileToObjectStorage(outputStoredName, output),
    writeFileToObjectStorage(preservationStoredName, report),
    writeFileToObjectStorage(ledgerStoredName, ledger),
    writeFileToObjectStorage(thumbnailStoredName, Buffer.from("<svg/>")),
  ]);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Native approval ${suffix} ${run}`,
    sourceFormat: "dxf",
    status: "awaiting_review",
    originalFilename: "drawing.dxf",
    targetLanguage,
    sourceStoredName,
    outputStoredName,
    preservationStoredName,
    ledgerStoredName,
    pageCount: 1,
    pagesDone: 1,
    machineAuditStatus: "passed",
  });
  await db.insert(cworksTranslationPages).values({
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName,
    sourceBlockCount: 106,
    translatedBlockCount: patchedCount,
    machineAuditStatus: "passed",
    machineAuditFindings: [],
  });
  await db.insert(cworksTranslationPageReviews).values({
    jobId: id,
    revisionCount: 0,
    pageNumber: 1,
    checked: true,
    resolvedFindingIndexes: [],
    reviewerSessionId: randomUUID(),
    checkedAt: new Date(),
  });
  return {
    id,
    source,
    output,
    report,
    ledger,
    sourceStoredName,
    outputStoredName,
    preservationStoredName,
    ledgerStoredName,
  };
}

function asLegacyPreCapturedOutputTableScript(tableScript: ReturnType<typeof buildNativeDxfTableScript>) {
  const script = tableScript.script
    .split("\n")
    .filter((line) =>
      !line.includes("CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN")
      && !line.includes("CWORKS_APPLY_TABLE_TRANSLATIONS_END"))
    .map((line) => line.includes("Cworks table translations:")
      ? line.replace("(itoa errors)))", "(itoa errors)))))")
      : line)
    .join("\n");
  assert.doesNotMatch(script, /CWORKS_APPLY_TABLE_TRANSLATIONS_(?:BEGIN|END)/);
  return {
    ...tableScript,
    script,
    sha256: sha256(Buffer.from(script, "utf8")),
  };
}

async function makeHybridReviewableDxf(
  suffix: string,
  options: {
    legacyPreCapturedOutputScript?: boolean;
    targetLanguage?: "en" | "ja";
  } = {},
) {
  const targetLanguage = options.targetLanguage ?? "en";
  const fixture = await makeReviewableDxf(`hybrid-${suffix}`, 106, targetLanguage);
  const sourceText = "Таблица";
  const sourceSha256 = sha256(Buffer.from(sourceText));
  const targetId = `ACAD_TABLE:AB:0:${sourceSha256}`;
  const tableTargets = [{
    targetId,
    tableHandle: "AB",
    sourceOrdinal: 0,
    sourceOccurrenceCount: 2,
    source: sourceText,
    sourceSha256,
    translation: targetLanguage === "ja" ? "表" : "Table",
    replacement: targetLanguage === "ja" ? "表" : "Table",
    accounting: "translated_pending_table_script",
  }];
  const generatedTableScript = buildNativeDxfTableScript(tableTargets.map((target) => ({
    targetId: target.targetId,
    tableHandle: target.tableHandle,
    sourceOrdinal: target.sourceOrdinal,
    sourceOccurrenceCount: target.sourceOccurrenceCount,
    source: target.source,
    translation: target.replacement,
  })));
  const tableScript = options.legacyPreCapturedOutputScript
    ? asLegacyPreCapturedOutputTableScript(generatedTableScript)
    : generatedTableScript;
  const baseLedger = JSON.parse(fixture.ledger.toString("utf8"));
  const manualRequirements = {
    kind: "source-bound-table-application",
    explicitConfirmationRequired: true,
    derivativeExtension: ".dwg",
    unicodeLispsysRequired: true,
    windowsActiveXRequired: true,
    sourceSha256: sha256(fixture.source),
    tableScriptSha256: tableScript.sha256,
    tableManifestSha256: tableScript.manifestSha256,
    placementManifestSha256: baseLedger.patch.placementManifestSha256,
    targets: [{
      targetId,
      tableHandle: "AB",
      sourceSha256,
      sourceOccurrenceCount: 2,
    }],
  };
  const hybridCoverage = {
    pendingTableTargetCount: 1,
    pendingTableCellCount: 2,
    unresolvedVisibleTextCount: 1,
    unplacedTargetCount: 0,
    opaqueReviewRequired: true,
  };
  const ledger = {
    ...baseLedger,
    targetLanguage,
    placementCount: baseLedger.patch.placementCount,
    tableTargets,
    tableScript,
    scriptAccounting: {
      sha256: tableScript.sha256,
      manifestSha256: tableScript.manifestSha256,
      targetCount: 1,
      expectedAppliedCount: 2,
      pendingManualApplicationCount: 1,
      blockingCount: 0,
    },
    hybridCoverage,
    manualRequirements,
    independentAudit: {
      format: "cworks-native-dxf-independent-audit-v1",
      model: "gpt-5.4",
      rawStatus: "findings",
      terminalStatus: "passed",
      rawFindings: [{
        type: "placement",
        message: "Deferred table content requires script application.",
        sourceBlockId: targetId,
      }],
      deferredFindings: [{
        type: "placement",
        message: "Deferred table content requires script application.",
        sourceBlockId: targetId,
      }],
      deferredTableFindingCount: 1,
      findings: [],
    },
    unresolvedVisibleText: [{
      targetId: "MANUAL:VISIBLE:1",
      handle: "visible-text",
      reason: "requires_manual_cad_edit",
    }],
    blockingFindings: [{
      targetId: "MANUAL:VISIBLE:1",
      handle: "visible-text",
      reason: "requires_manual_cad_edit",
    }],
  };
  const report = {
    ...JSON.parse(fixture.report.toString("utf8")),
    targetLanguage,
    hybridCoverage,
    manualRequirements,
    independentAudit: ledger.independentAudit,
  };
  const ledgerBytes = Buffer.from(JSON.stringify(ledger));
  const reportBytes = Buffer.from(JSON.stringify(report));
  await Promise.all([
    writeFileToObjectStorage(fixture.ledgerStoredName, ledgerBytes),
    writeFileToObjectStorage(fixture.preservationStoredName, reportBytes),
  ]);
  const manualPageFinding = {
    type: "placement",
    message: "visible_text_not_safely_patchable",
    sourceBlockId: "MANUAL:VISIBLE:1",
  };
  await db.update(cworksTranslationJobs).set({
    machineAuditStatus: "findings",
    machineAuditModel: ledger.independentAudit.model,
  })
    .where(eq(cworksTranslationJobs.id, fixture.id));
  await db.update(cworksTranslationPages).set({
    machineAuditStatus: "findings",
    machineAuditFindings: [manualPageFinding],
    warnings: [manualPageFinding],
  }).where(eq(cworksTranslationPages.jobId, fixture.id));
  await db.update(cworksTranslationPageReviews).set({ resolvedFindingIndexes: [0] })
    .where(eq(cworksTranslationPageReviews.jobId, fixture.id));
  return { ...fixture, ledger: ledgerBytes, report: reportBytes };
}

async function makeJob(
  status: string,
  opts: { withAssets?: boolean; idSuffix?: string } = {},
): Promise<string> {
  const id = `cworks-review-test-${status}${opts.idSuffix ? `-${opts.idSuffix}` : ""}-${run}`;
  jobIds.push(id);
  let outputStoredName: string | null = null;
  let summaryStoredName: string | null = null;
  if (opts.withAssets) {
    outputStoredName = `cworks-translator/${id}/translated.pdf`;
    summaryStoredName = `cworks-translator/${id}/summary.md`;
    const thumbnailStoredName = `cworks-translator/${id}/page-1.jpg`;
    storedNames.push(outputStoredName, summaryStoredName, thumbnailStoredName);
    await Promise.all([
      writeFileToObjectStorage(outputStoredName, Buffer.from("%PDF-1.4 test output")),
      writeFileToObjectStorage(summaryStoredName, "# test summary"),
      writeFileToObjectStorage(thumbnailStoredName, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    ]);
    await db.insert(cworksTranslationJobs).values({
      id,
      title: `Review visibility ${status} ${run}`,
      status,
      originalFilename: "review-test.pdf",
      sourceStoredName: `cworks-translator/${id}/source.pdf`,
      outputStoredName,
      summaryStoredName,
      pageCount: 1,
      pagesDone: 1,
      machineAuditStatus: "passed",
      approvedRevision: status === "done" ? 0 : null,
      approvedAt: status === "done" ? new Date() : null,
    });
    await db.insert(cworksTranslationPages).values({
      jobId: id,
      pageNumber: 1,
      thumbnailStoredName,
      sourceBlockCount: 1,
      translatedBlockCount: 1,
      machineAuditStatus: "passed",
      machineAuditFindings: [],
    });
  } else {
    await db.insert(cworksTranslationJobs).values({
      id,
      title: `Review visibility ${status} ${run}`,
      status,
      originalFilename: "review-test.pdf",
      sourceStoredName: `cworks-translator/${id}/source.pdf`,
      // Simulate a mid-revision job that still has a previously published
      // output on record: the status alone must fence it off.
      outputStoredName: `cworks-translator/${id}/stale-translated.pdf`,
      summaryStoredName: `cworks-translator/${id}/stale-summary.md`,
    });
    await db.insert(cworksTranslationPages).values({
      jobId: id,
      pageNumber: 1,
      thumbnailStoredName: `cworks-translator/${id}/stale-page-1.jpg`,
    });
  }
  return id;
}

before(async () => {
  process.env.CWORKS_APP_PASSWORD = `review-test-password-${run}`;
  await db.insert(users).values([
    {
      id: OPERATOR_USER_ID,
      username: `cworks-operator-${run}`,
      password: "test-only",
      displayName: "Authenticated CAD Operator",
      role: "admin",
      status: "active",
    },
    {
      id: REVIEWER_USER_ID,
      username: `cworks-reviewer-${run}`,
      password: "test-only",
      displayName: "Authorized CAD Reviewer",
      role: "admin",
      status: "active",
    },
    {
      id: VIEWER_USER_ID,
      username: `cworks-viewer-${run}`,
      password: "test-only",
      displayName: "Unauthorized Viewer",
      role: "viewer",
      status: "active",
    },
  ]);
  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server?.close();
  if (jobIds.length) {
    await db.delete(cworksTranslationTouchups).where(inArray(cworksTranslationTouchups.jobId, jobIds));
    await db.delete(cworksTranslationPageReviews).where(inArray(cworksTranslationPageReviews.jobId, jobIds));
    await db.delete(cworksTranslationPages).where(inArray(cworksTranslationPages.jobId, jobIds));
    // Review events are append-only. Let the job FK cascade perform the
    // lifecycle delete rather than issuing a forbidden direct event delete.
    await db.delete(cworksTranslationJobs).where(inArray(cworksTranslationJobs.id, jobIds));
  }
  await db.delete(users).where(inArray(users.id, testUserIds));
  await Promise.allSettled(storedNames.map((name) => deleteFromObjectStorageStrict(name)));
});

// ---------------------------------------------------------------------------
// In-progress jobs must never expose pages, thumbnails, or downloads
// ---------------------------------------------------------------------------

test("large drawing uploads go directly to private storage before job creation", async () => {
  const source = Buffer.from("%PDF-1.4\n%%EOF\n");
  const authorization = await request("POST", "/uploads/request-url", {
    filename: "large-drawing.pdf",
    size: source.length,
  });
  assert.equal(authorization.status, 200);
  assert.equal(typeof authorization.json.uploadURL, "string");
  assert.equal(typeof authorization.json.uploadToken, "string");

  const uploaded = await fetch(authorization.json.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: source,
  });
  assert.equal(uploaded.status, 200);

  const created = await request("POST", "/jobs/from-upload", {
    uploadToken: authorization.json.uploadToken,
    title: `Direct upload ${run}`,
    sourceLanguage: "ru",
    targetLanguage: "ja",
    scope: "full",
    drawingDepth: "everything",
  });
  assert.equal(created.status, 202);
  assert.equal(created.json.job.originalFilename, "large-drawing.pdf");
  assert.equal(created.json.job.targetLanguage, "ja");
  jobIds.push(created.json.job.id);
  storedNames.push(`cworks-translator/${created.json.job.id}/source.pdf`);
});

for (const status of ["queued", "running", "revising"]) {
  test(`${status} job: thumbnails, downloads, and summaries return 409`, async () => {
    const id = await makeJob(status);

    const thumb = await get(`/jobs/${id}/pages/1/thumbnail`);
    assert.equal(thumb.status, 409, "thumbnail must be blocked");

    const download = await get(`/jobs/${id}/download`);
    assert.equal(download.status, 409, "translated download must be blocked");

    const summary = await get(`/jobs/${id}/summary`);
    assert.equal(summary.status, 409, "summary download must be blocked");
  });

  test(`${status} job: job detail hides the page list`, async () => {
    const id = `cworks-review-test-${status}-${run}`;
    const detail = await get(`/jobs/${id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.pages, [], "no page rows may be exposed mid-run");
  });
}

// ---------------------------------------------------------------------------
// Reviewable jobs expose pages, but only approved revisions expose final files
// ---------------------------------------------------------------------------

test("coverage is format-aware for native DXF and unchanged for PDF", () => {
  const completePage = [{ sourceBlockCount: 106, translatedBlockCount: 106 }] as any;
  const missingPage = [{ sourceBlockCount: 106, translatedBlockCount: 105 }] as any;
  const dxfComplete = publicCoverageWithTranslations(completePage, [], null, "dxf");
  assert.equal(dxfComplete.translatedLineCount, 106);
  assert.equal(dxfComplete.placedLineCount, 106);
  assert.equal(dxfComplete.complete, true);
  const dxfMissing = publicCoverageWithTranslations(missingPage, [], null, "dxf");
  assert.equal(dxfMissing.unresolvedLineCount, 1);
  assert.equal(dxfMissing.complete, false);

  const pdfWithoutCheckpoints = publicCoverageWithTranslations(completePage, [], null, "pdf");
  assert.equal(pdfWithoutCheckpoints.translatedLineCount, 0);
  assert.equal(pdfWithoutCheckpoints.complete, false);
  const pdfWithTranslation = publicCoverageWithTranslations(
    [{ sourceBlockCount: 1, translatedBlockCount: 1 }] as any,
    [{ translation: "Translated", uncertain: false }],
    null,
    "pdf",
  );
  assert.equal(pdfWithTranslation.complete, true);
});

test("native DXF approval requires and durably stores CAD operator evidence", async () => {
  const fixture = await makeReviewableDxf("attestation");
  const baseAttestation = {
    decision: "approve",
    notes: "",
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: true,
    cadOperatorDeclaration: true,
  };
  const lockedDownload = await get(`/jobs/${fixture.id}/download`);
  assert.equal(lockedDownload.status, 409);
  const draftTableScript = await get(`/jobs/${fixture.id}/table-script`);
  const draftDxf = await get(`/jobs/${fixture.id}/draft-dxf`);
  assert.equal(draftDxf.status, 200, "a preserved draft must be available for CAD derivative review");
  assert.equal(draftDxf.headers.get("x-cworks-review-status"), "draft-not-for-construction");
  assert.match(draftDxf.headers.get("content-disposition") || "", /DRAFT-machine-clean\.dxf/);
  const anonymousDraft = await fetch(`${baseUrl}/api/cworks-translator/jobs/${fixture.id}/draft-dxf`);
  assert.equal(anonymousDraft.status, 401, "drafts must remain authenticated");
  assert.equal(draftTableScript.status, 200);
  assert.equal(draftTableScript.headers.get("content-type"), "application/x-autolisp");
  assert.match(draftTableScript.headers.get("content-disposition") || "", /\.lsp"/);
  assert.match(draftTableScript.body.toString("utf8"), /CWORKS_APPLY_TABLE_TRANSLATIONS/);

  const omitted = await request("POST", `/jobs/${fixture.id}/feedback`, baseAttestation);
  assert.equal(omitted.status, 400);

  const operatorAttestation = {
    ...baseAttestation,
    cadOperatorName: "CAD Operator",
    cadOperatorQualification: "Qualified AutoCAD operator",
  };
  await db.update(cworksTranslationJobs)
    .set({ ledgerStoredName: null })
    .where(eq(cworksTranslationJobs.id, fixture.id));
  const missingLedger = await request("POST", `/jobs/${fixture.id}/feedback`, operatorAttestation);
  assert.equal(missingLedger.status, 409);
  await db.update(cworksTranslationJobs)
    .set({ ledgerStoredName: fixture.ledgerStoredName })
    .where(eq(cworksTranslationJobs.id, fixture.id));

  const validLedger = JSON.parse(fixture.ledger.toString("utf8"));
  await writeFileToObjectStorage(fixture.ledgerStoredName, Buffer.from(JSON.stringify({
    ...validLedger,
    sourceSha256: "0".repeat(64),
  })));
  const staleLedger = await request("POST", `/jobs/${fixture.id}/feedback`, operatorAttestation);
  assert.equal(staleLedger.status, 409);

  await writeFileToObjectStorage(fixture.ledgerStoredName, Buffer.from(JSON.stringify({
    ...validLedger,
    entries: [...validLedger.entries, validLedger.entries[0]],
  })));
  const duplicateLedger = await request("POST", `/jobs/${fixture.id}/feedback`, operatorAttestation);
  assert.equal(duplicateLedger.status, 409);

  await writeFileToObjectStorage(fixture.ledgerStoredName, Buffer.from(JSON.stringify({
    ...validLedger,
    entries: validLedger.entries.map((entry: any, index: number) =>
      index === 0 ? { ...entry, accounting: "preserved", preservationReason: "" } : entry),
  })));
  const misaccountedLedger = await request("POST", `/jobs/${fixture.id}/feedback`, operatorAttestation);
  assert.equal(misaccountedLedger.status, 409);

  await writeFileToObjectStorage(fixture.ledgerStoredName, Buffer.from(JSON.stringify({
    ...validLedger,
    patch: { ...validLedger.patch, outputSha256: "f".repeat(64) },
  })));
  const patchMismatch = await request("POST", `/jobs/${fixture.id}/feedback`, operatorAttestation);
  assert.equal(patchMismatch.status, 409);
  await writeFileToObjectStorage(fixture.ledgerStoredName, fixture.ledger);

  await writeFileToObjectStorage(
    fixture.preservationStoredName,
    Buffer.from(JSON.stringify({
      ...JSON.parse(fixture.report.toString("utf8")),
      patch: {
        ...JSON.parse(fixture.report.toString("utf8")).patch,
        outputSha256: "0".repeat(64),
      },
    })),
  );
  const mismatch = await request("POST", `/jobs/${fixture.id}/feedback`, operatorAttestation);
  assert.equal(mismatch.status, 409);

  await writeFileToObjectStorage(fixture.preservationStoredName, fixture.report);
  const approved = await request("POST", `/jobs/${fixture.id}/feedback`, operatorAttestation);
  assert.equal(approved.status, 200);
  const [event] = await db.select().from(cworksTranslationReviewEvents)
    .where(eq(cworksTranslationReviewEvents.jobId, fixture.id));
  assert.equal(event.cadOperatorName, "CAD Operator");
  assert.equal(event.cadOperatorQualification, "Qualified AutoCAD operator");
  assert.match(event.cadOperatorAttestation || "", /opened without repair warnings/);
  assert.equal(event.sourceSha256, sha256(fixture.source));
  assert.equal(event.translatedOutputSha256, sha256(fixture.output));
  assert.equal(event.preservationReportSha256, sha256(fixture.report));
  assert.equal(event.ledgerSha256, sha256(fixture.ledger));
  assert.equal((event.translatedOutputSha256 || "").includes("cworks-translator/"), false);
  const releasedRoutes = [
    ["/original", fixture.sourceStoredName],
    ["/download", fixture.outputStoredName],
    ["/ledger", fixture.ledgerStoredName],
    ["/preservation-report", fixture.preservationStoredName],
  ] as const;
  for (const [route] of releasedRoutes) {
    const unchanged = await get(`/jobs/${fixture.id}${route}`);
    assert.equal(unchanged.status, 200, `${route} must serve unchanged attested bytes`);
  }
  const releasedTableScript = await get(`/jobs/${fixture.id}/table-script`);
  assert.equal(releasedTableScript.status, 200);
  assert.deepEqual(
    releasedTableScript.body,
    Buffer.from(JSON.parse(fixture.ledger.toString("utf8")).tableScript.script),
  );
  for (const [route, storedName] of releasedRoutes) {
    await writeFileToObjectStorage(storedName, Buffer.from(`same-key tamper ${route}`));
    const tampered = await get(`/jobs/${fixture.id}${route}`);
    assert.equal(tampered.status, 409, `${route} must refuse same-key overwritten bytes`);
  }
});

test("reviewer can download a valid table script while unrelated draft findings remain", async () => {
  const fixture = await makeReviewableDxf("draft-table-script");
  const ledger = JSON.parse(fixture.ledger.toString("utf8"));
  ledger.blockingFindings = [{
    targetId: "TEXT:FIT",
    handle: "FIT",
    reason: "replacement_does_not_fit",
  }];
  ledger.patch = {
    ...ledger.patch,
    unresolved: [{
      targetId: "TEXT:FIT",
      handle: "FIT",
      reason: "replacement_does_not_fit",
    }],
  };
  await writeFileToObjectStorage(fixture.ledgerStoredName, Buffer.from(JSON.stringify(ledger)));

  const response = await get(`/jobs/${fixture.id}/table-script`);
  assert.equal(response.status, 200);
  assert.match(response.body.toString("utf8"), /CWORKS_APPLY_TABLE_TRANSLATIONS/);
});

test("legacy table scripts upgrade through a new auditable revision before captured-output submission", async () => {
  const fixture = await makeHybridReviewableDxf("legacy-output-upgrade", {
    legacyPreCapturedOutputScript: true,
  });
  const legacyLedger = JSON.parse(fixture.ledger.toString("utf8"));
  const legacyReport = JSON.parse(fixture.report.toString("utf8"));
  const upgradedTableScript = buildNativeDxfTableScript(legacyLedger.tableTargets.map((target: any) => ({
    targetId: target.targetId,
    tableHandle: target.tableHandle,
    sourceOrdinal: target.sourceOrdinal,
    sourceOccurrenceCount: target.sourceOccurrenceCount,
    source: target.source,
    translation: target.replacement,
  })));
  const upgradedManualRequirements = {
    ...legacyLedger.manualRequirements,
    tableScriptSha256: upgradedTableScript.sha256,
    tableManifestSha256: upgradedTableScript.manifestSha256,
  };
  const upgradedLedger = {
    ...legacyLedger,
    tableScript: upgradedTableScript,
    scriptAccounting: {
      ...legacyLedger.scriptAccounting,
      sha256: upgradedTableScript.sha256,
      manifestSha256: upgradedTableScript.manifestSha256,
    },
    manualRequirements: upgradedManualRequirements,
  };
  const upgradedReport = {
    ...legacyReport,
    manualRequirements: upgradedManualRequirements,
  };

  const legacyRequirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(legacyRequirements.status, 200);
  assert.equal(legacyRequirements.json.applicationOutputCaptureSupported, false);
  assert.equal(legacyRequirements.json.submissionAllowed, false);
  const legacyScriptDownload = await get(`/jobs/${fixture.id}/table-script`);
  assert.equal(legacyScriptDownload.status, 200);
  assert.doesNotMatch(legacyScriptDownload.body.toString("utf8"), /CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN/);
  const legacyCandidate = Buffer.alloc(128);
  legacyCandidate.write("AC1032", 0, "ascii");
  legacyCandidate.write("legacy derivative candidate", 16, "ascii");
  const blockedLegacySubmission = await uploadHybridDerivative(
    fixture.id,
    legacyCandidate,
    legacyRequirements.json,
  );
  assert.equal(blockedLegacySubmission.status, 409);

  const upgrade = await request("POST", `/jobs/${fixture.id}/upgrade-table-script-evidence`, {});
  assert.equal(upgrade.status, 200, JSON.stringify(upgrade.json));
  assert.equal(upgrade.json.job.status, "revising");
  assert.equal(upgrade.json.job.revisionCount, 1);
  const [upgradeEvent] = await db.select().from(cworksTranslationReviewEvents).where(and(
    eq(cworksTranslationReviewEvents.jobId, fixture.id),
    eq(cworksTranslationReviewEvents.decision, "script_evidence_upgrade"),
  ));
  assert.ok(upgradeEvent);
  assert.equal(upgradeEvent.revisionCount, 0);
  const upgradeSnapshot = upgradeEvent.pageReviewSnapshot as any;
  assert.equal(upgradeSnapshot.priorTableScriptSha256, legacyLedger.tableScript.sha256);
  assert.equal(upgradeSnapshot.archivedTableScriptSha256, legacyLedger.tableScript.sha256);
  storedNames.push(upgradeSnapshot.archivedTableScriptStoredName);

  const upgradedLedgerStoredName = `cworks-translator/${fixture.id}/revision-1-ledger.json`;
  const upgradedReportStoredName = `cworks-translator/${fixture.id}/revision-1-preservation.json`;
  storedNames.push(upgradedLedgerStoredName, upgradedReportStoredName);
  await db.update(cworksTranslationJobs).set({
    status: "awaiting_review",
    progress: 100,
    pagesDone: 1,
    progressNote: "Ready for review",
    ledgerStoredName: upgradedLedgerStoredName,
    preservationStoredName: upgradedReportStoredName,
    machineAuditStatus: "findings",
    machineAuditModel: upgradedLedger.independentAudit.model,
    updatedAt: new Date(),
  }).where(eq(cworksTranslationJobs.id, fixture.id));
  await Promise.all([
    writeFileToObjectStorage(upgradedLedgerStoredName, Buffer.from(JSON.stringify(upgradedLedger))),
    writeFileToObjectStorage(upgradedReportStoredName, Buffer.from(JSON.stringify(upgradedReport))),
    db.insert(cworksTranslationPageReviews).values({
      jobId: fixture.id,
      revisionCount: 1,
      pageNumber: 1,
      checked: true,
      resolvedFindingIndexes: [0],
      reviewerSessionId: randomUUID(),
      checkedAt: new Date(),
    }),
  ]);
  await deleteFromObjectStorageStrict(fixture.ledgerStoredName);
  const archivedLegacyScript = await readFileFromObjectStorage(
    upgradeSnapshot.archivedTableScriptStoredName,
  );
  assert.ok(archivedLegacyScript);
  assert.equal(sha256(archivedLegacyScript), legacyLedger.tableScript.sha256);
  assert.equal(archivedLegacyScript.toString("utf8"), legacyLedger.tableScript.script);

  const upgradedRequirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(upgradedRequirements.status, 200);
  assert.equal(upgradedRequirements.json.sourceRevision, 1);
  assert.equal(upgradedRequirements.json.applicationOutputCaptureSupported, true);
  assert.equal(upgradedRequirements.json.submissionAllowed, true);
  const upgradedCandidate = Buffer.alloc(128);
  upgradedCandidate.write("AC1032", 0, "ascii");
  upgradedCandidate.write("upgraded derivative candidate", 16, "ascii");
  const replacement = await uploadHybridDerivative(
    fixture.id,
    upgradedCandidate,
    upgradedRequirements.json,
  );
  assert.equal(replacement.status, 201);

});

test("approved native DXF accepts immutable, explicitly non-preservation CAD derivatives", async () => {
  const fixture = await makeReviewableDxf("cad-derivative");
  const approval = await request("POST", `/jobs/${fixture.id}/feedback`, {
    decision: "approve",
    notes: "",
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: true,
    cadOperatorDeclaration: true,
    cadOperatorName: "Approval Operator",
    cadOperatorQualification: "Qualified AutoCAD operator",
  });
  assert.equal(approval.status, 200);

  const dwg = Buffer.alloc(128);
  dwg.write("AC1032", 0, "ascii");
  dwg.write("human edited test derivative", 16, "ascii");
  const uploaded = await uploadCadDerivative(fixture.id, "human-edited.dwg", dwg);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.json.derivative.sha256, sha256(dwg));
  assert.equal(uploaded.json.derivative.source.revision, 0);
  assert.equal(uploaded.json.derivative.source.translatedOutputSha256, sha256(fixture.output));
  assert.equal(uploaded.json.derivative.artifactClass, "human_edited_cad_derivative");
  assert.equal(uploaded.json.derivative.preservationProof, false);
  assert.equal(uploaded.json.derivative.bytePreservationClaim, false);
  assert.equal("storedName" in uploaded.json.derivative, false);
  const derivativeId = uploaded.json.derivative.id;

  const [stored] = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.id, derivativeId));
  storedNames.push(stored.storedName);
  assert.match(stored.operatorAttestation, /not preservation proof/);
  assert.match(stored.operatorAttestation, /I created and checked/);
  assert.doesNotMatch(stored.operatorAttestation, /supervis/i);
  assert.equal(stored.operatorNotes.includes("Checked layouts"), true);

  const listed = await get(`/jobs/${fixture.id}/cad-derivatives`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.derivatives.some((row: any) => row.id === derivativeId), true);
  assert.equal(listed.json.derivatives[0].preservationProof, false);

  const detail = await get(`/jobs/${fixture.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.derivatives.some((row: any) => row.id === derivativeId), true);

  const download = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/download`);
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, dwg);

  const report = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/lineage-report`);
  assert.equal(report.status, 200);
  const lineage = JSON.parse(report.body.toString("utf8"));
  assert.equal(lineage.format, "cworks-human-edited-cad-lineage-v1");
  assert.equal(lineage.approvedMachineCleanSource.translatedOutputSha256, sha256(fixture.output));
  assert.equal(lineage.humanEditedDerivative.sha256, sha256(dwg));
  assert.equal(lineage.claims.separatelyAttested, true);
  assert.equal(lineage.claims.inheritedPreservationProof, false);
  assert.equal(lineage.claims.bytePreservationClaim, false);
  assert.equal(lineage.operator.attestation, CAD_DERIVATIVE_ATTESTATION);
  assert.doesNotMatch(lineage.operator.attestation, /supervis/i);

  await writeFileToObjectStorage(stored.storedName, Buffer.from("same-key derivative tamper"));
  const tampered = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/download`);
  assert.equal(tampered.status, 409, "same-key replacement must never be served");
  const tamperedReport = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/lineage-report`);
  assert.equal(tamperedReport.status, 409, "tampered derivatives must not receive a lineage report");
  const sourceStillReleased = await get(`/jobs/${fixture.id}/original`);
  assert.equal(sourceStillReleased.status, 200, "derivative tampering cannot affect approved source release");
});

test("CAD derivative upload rejects unapproved jobs, weak content, and missing attestation", async () => {
  const unapproved = await makeReviewableDxf("cad-derivative-negative");
  const plausibleDwg = Buffer.alloc(128);
  plausibleDwg.write("AC1032", 0, "ascii");
  const locked = await uploadCadDerivative(unapproved.id, "edit.dwg", plausibleDwg);
  assert.equal(locked.status, 409);

  await db.update(cworksTranslationJobs).set({
    status: "done",
    approvedRevision: 0,
    approvedAt: new Date(),
  }).where(eq(cworksTranslationJobs.id, unapproved.id));
  // No matching approval event exists: changing status fields cannot authorize
  // derivative attachment.
  const forgedApproval = await uploadCadDerivative(unapproved.id, "edit.dwg", plausibleDwg);
  assert.equal(forgedApproval.status, 409);

  const fixture = await makeReviewableDxf("cad-derivative-validation");
  const approval = await request("POST", `/jobs/${fixture.id}/feedback`, {
    decision: "approve",
    notes: "",
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: true,
    cadOperatorDeclaration: true,
    cadOperatorName: "Approval Operator",
    cadOperatorQualification: "Qualified AutoCAD operator",
  });
  assert.equal(approval.status, 200);
  const badExtension = await uploadCadDerivative(fixture.id, "edit.txt", plausibleDwg);
  assert.equal(badExtension.status, 400);
  const fakeDwg = await uploadCadDerivative(fixture.id, "edit.dwg", Buffer.alloc(128));
  assert.equal(fakeDwg.status, 400);
  const noAttestation = await uploadCadDerivative(
    fixture.id,
    "edit.dwg",
    plausibleDwg,
    { attestation: "false" },
  );
  assert.equal(noAttestation.status, 400);
  const supervisorAttestation = await uploadCadDerivative(
    fixture.id,
    "edit.dwg",
    plausibleDwg,
    {
      attestation: "I attest that I made or supervised these adjustments and understand that preservation proof does not transfer.",
    },
  );
  assert.equal(supervisorAttestation.status, 400, "a supervisor cannot be recorded as the derivative creator");
});

test("pending hybrid draft releases only its immutable derivative after separate qualified review", async () => {
  const fixture = await makeHybridReviewableDxf("release");
  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(requirements.status, 200);
  assert.equal(requirements.json.lineageKind, "hybrid_draft_completion");
  assert.equal(requirements.json.sourceRevision, 0);
  assert.equal(requirements.json.expectedCounters.applied, 2);
  assert.deepEqual(
    requirements.json.manualRequirementIds,
    ["opaque-visibility-review", "visible:MANUAL:VISIBLE:1"],
  );

  const dwg = Buffer.alloc(128);
  dwg.write("AC1032", 0, "ascii");
  dwg.write("reviewed hybrid derivative", 16, "ascii");
  const uploaded = await uploadHybridDerivative(fixture.id, dwg, requirements.json);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.json.derivative.lineageKind, "hybrid_draft_completion");
  assert.equal(uploaded.json.derivative.reviewStatus, "pending_review");
  assert.equal(uploaded.json.derivative.source.approvalEventId, null);
  const derivativeId = uploaded.json.derivative.id;
  const [stored] = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.id, derivativeId));
  storedNames.push(stored.storedName);
  assert.equal(stored.sourceRevision, 0);
  assert.equal(stored.operatorUserId, OPERATOR_USER_ID);
  assert.equal((stored.evidence as any).derivativeSha256, sha256(dwg));
  assert.equal((stored.evidence as any).format, "cworks-hybrid-derivative-evidence-v2");
  assert.equal((stored.evidence as any).tableScriptSha256, requirements.json.tableScriptSha256);
  const applicationOutput = (stored.evidence as any).applicationOutput;
  assert.match(applicationOutput.text, /CWORKS_APPLY_TABLE_TRANSLATIONS/);
  assert.equal(applicationOutput.sha256, sha256(Buffer.from(applicationOutput.text, "utf8")));
  assert.deepEqual(applicationOutput.parsedCounters, {
    matchedTargets: requirements.json.tableTargetCount,
    appliedCells: requirements.json.expectedCounters.applied,
    skippedTargets: 0,
    countMismatch: 0,
    unsafeCells: 0,
    partialErrors: 0,
    errors: 0,
  });
  assert.deepEqual((stored.evidence as any).operationalVerification, {
    platform: "windows_autocad",
    autoCadMajorVersion: 2024,
    lispSys: 1,
    sourceScriptManifestHashesVerified: true,
    partialApplicationEvidenceDisposition: "discarded",
    savedClosedReopened: true,
    reopenedInspectionNotes: "Closed, reopened, and inspected both translated complex table cells.",
  });

  assert.equal(
    (await get(`/jobs/${fixture.id}/download`)).status,
    409,
    "the machine-clean source DXF is not a releasable final asset",
  );
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/download`)).status,
    409,
    "submitted derivatives stay private until their own review",
  );
  const reviewDraft = await get(
    `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/draft-download`,
  );
  assert.equal(reviewDraft.status, 200);
  assert.deepEqual(reviewDraft.body, dwg);
  assert.match(
    reviewDraft.headers.get("content-disposition") || "",
    /DRAFT-NOT-RELEASED-hybrid-completion\.dwg/,
  );

  const reviewed = await request(
    "POST",
    `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
    {
      decision: "approve",
      declaration: true,
      notes: "Checked the exact derivative and all bound evidence.",
    },
  );
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json.decision, "derivative_approve");
  const released = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/download`);
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, dwg);
  assert.equal(
    (await get(`/jobs/${fixture.id}/download`)).status,
    409,
    "derivative approval must not approve the incomplete machine-clean source DXF",
  );
  assert.equal((await get(`/jobs/${fixture.id}/original`)).status, 409);

  const [event] = await db.select().from(cworksTranslationReviewEvents)
    .where(and(
      eq(cworksTranslationReviewEvents.jobId, fixture.id),
      eq(cworksTranslationReviewEvents.derivativeId, derivativeId),
    ));
  assert.equal(event.decision, "derivative_approve");
  assert.equal(event.reviewerUserId, REVIEWER_USER_ID);
  assert.equal(event.reviewerName, "Authorized CAD Reviewer");
  assert.equal(event.reviewerQualification, "Authorized admin CAD release reviewer");
  assert.equal(event.reviewerRole, "admin");
  assert.equal((event.derivativeEvidenceSnapshot as any).derivativeSha256, sha256(dwg));
  assert.equal(
    (event.derivativeEvidenceSnapshot as any).evidence.applicationOutput.sha256,
    applicationOutput.sha256,
    "release evidence must bind the preserved command output hash",
  );
  assert.match(event.declaration, /qualified to review/);
  assert.deepEqual(event.pageReviewSnapshot, [{
    pageNumber: 1,
    checked: true,
    notes: null,
    machineAuditStatus: "findings",
    findings: [{
      type: "placement",
      message: "visible_text_not_safely_patchable",
      sourceBlockId: "MANUAL:VISIBLE:1",
    }],
    findingCount: 1,
    resolvedFindingIndexes: [0],
    allFindingsResolved: true,
  }], "the append-only decision must preserve the full page/finding review snapshot");
  await assert.rejects(
    db.update(cworksTranslationReviewEvents).set({ pageReviewSnapshot: [] })
      .where(eq(cworksTranslationReviewEvents.id, event.id)),
    (error) => databaseErrorChainMatches(error, /append.only/i),
    "the complete review snapshot must be database-immutable",
  );

  await writeFileToObjectStorage(stored.storedName, Buffer.from("same-key hybrid derivative tamper"));
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/download`)).status,
    409,
    "released derivative bytes remain immutable",
  );
});

test("historical released v1 hybrid evidence remains downloadable after captured-output rollout", async () => {
  const fixture = await makeHybridReviewableDxf("released-v1-compatibility");
  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(requirements.status, 200);
  const dwg = Buffer.alloc(128);
  dwg.write("AC1032", 0, "ascii");
  dwg.write("historical released derivative", 16, "ascii");
  const derivativeId = randomUUID();
  const derivativeStoredName = `cworks-translator/${fixture.id}/derivatives/${derivativeId}.dwg`;
  const derivativeSha256 = sha256(dwg);
  storedNames.push(derivativeStoredName);
  await writeFileToObjectStorage(derivativeStoredName, dwg);
  const legacyEvidence = {
    format: "cworks-hybrid-derivative-evidence-v1",
    derivativeSha256,
    sourceRevision: 0,
    sourceSha256: requirements.json.sourceSha256,
    translatedOutputSha256: requirements.json.sourceOutputSha256,
    preservationReportSha256: requirements.json.preservationReportSha256,
    ledgerSha256: requirements.json.ledgerSha256,
    placementManifestSha256: requirements.json.placementManifestSha256,
    tableScriptSha256: requirements.json.tableScriptSha256,
    tableManifestSha256: requirements.json.tableManifestSha256,
    tableTargetCount: requirements.json.tableTargetCount,
    expectedAppliedCount: requirements.json.expectedCounters.expected,
    manualRequirementIds: requirements.json.manualRequirementIds,
    machineDefectCount: requirements.json.machineDefectCount,
    independentAuditModel: requirements.json.independentAuditModel,
    counters: requirements.json.expectedCounters,
    manualCoverageResolutions: requirements.json.manualRequirementIds.map((requirementId: string) => ({
      requirementId,
      resolution: `Historical qualified operator resolved ${requirementId}.`,
    })),
    operationalVerification: {
      platform: "windows_autocad",
      autoCadMajorVersion: 2024,
      lispSys: 1,
      sourceScriptManifestHashesVerified: true,
      partialApplicationEvidenceDisposition: "discarded",
      savedClosedReopened: true,
      reopenedInspectionNotes: "Historical operator closed, reopened, and inspected the derivative.",
    },
  };
  await db.insert(cworksTranslationCadDerivatives).values({
    id: derivativeId,
    jobId: fixture.id,
    sourceRevision: 0,
    sourceOutputSha256: requirements.json.sourceOutputSha256,
    sourceApprovalEventId: null,
    lineageKind: "hybrid_draft_completion",
    evidence: legacyEvidence,
    originalFilename: "historical-release.dwg",
    format: "dwg",
    storedName: derivativeStoredName,
    sha256: derivativeSha256,
    operatorName: "Historical CAD operator",
    operatorQualification: "Qualified AutoCAD operator",
    operatorNotes: "Historical release created before captured command output was required.",
    operatorAttestation: CAD_HYBRID_DERIVATIVE_ATTESTATION,
  });
  await db.insert(cworksTranslationReviewEvents).values({
    jobId: fixture.id,
    revisionCount: 0,
    decision: "derivative_approve",
    reviewerName: "Historical qualified reviewer",
    reviewerQualification: "Qualified CAD release reviewer",
    reviewerSessionId: randomUUID(),
    declaration: "Historical qualified derivative approval recorded before captured command output was required.",
    derivativeId,
    derivativeEvidenceSnapshot: {
      derivativeId,
      derivativeSha256,
      evidence: legacyEvidence,
    },
    pageReviewSnapshot: [],
    notes: "Historical v1 compatibility fixture",
  });
  await db.update(cworksTranslationJobs).set({
    status: "done",
    progress: 100,
    progressNote: "Historical derivative release complete",
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(cworksTranslationJobs.id, fixture.id));

  const released = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/download`);
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, dwg);
  const lineage = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/lineage-report`);
  assert.equal(lineage.status, 200);
  assert.equal(
    JSON.parse(lineage.body.toString("utf8")).hybridCompletionEvidence.format,
    "cworks-hybrid-derivative-evidence-v1",
  );
});

test("Japanese complex-table evidence releases only the exact reopened DWG derivative", async () => {
  const fixture = await makeHybridReviewableDxf("japanese-release", {
    targetLanguage: "ja",
  });
  const ledger = JSON.parse(fixture.ledger.toString("utf8"));
  assert.equal(ledger.targetLanguage, "ja");
  assert.equal(ledger.tableTargets.length, 1);
  assert.equal(ledger.tableTargets[0].replacement, "表");
  assert.equal(ledger.scriptAccounting.expectedAppliedCount, 2);

  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(requirements.status, 200);
  assert.equal(requirements.json.tableTargetCount, 1);
  assert.deepEqual(requirements.json.expectedCounters, {
    expected: 2,
    applied: 2,
    missing: 0,
    ambiguous: 0,
    failed: 0,
    skipped: 0,
  });

  const dwg = Buffer.alloc(128);
  dwg.write("AC1032", 0, "ascii");
  dwg.write("Japanese table derivative", 16, "ascii");
  const uploaded = await uploadHybridDerivative(fixture.id, dwg, requirements.json);
  assert.equal(uploaded.status, 201);
  const derivativeId = uploaded.json.derivative.id;
  const [stored] = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.id, derivativeId));
  storedNames.push(stored.storedName);
  assert.equal(stored.sha256, sha256(dwg));
  assert.equal((stored.evidence as any).derivativeSha256, sha256(dwg));
  assert.equal((stored.evidence as any).counters.applied, 2);
  assert.equal((stored.evidence as any).operationalVerification.lispSys, 1);
  assert.equal((stored.evidence as any).operationalVerification.savedClosedReopened, true);
  assert.match(
    (stored.evidence as any).operationalVerification.reopenedInspectionNotes,
    /reopened.*translated complex table cells/i,
  );

  const reviewed = await request(
    "POST",
    `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
    {
      decision: "approve",
      declaration: true,
      notes: "Checked the exact Japanese derivative and its source-bound evidence.",
    },
  );
  assert.equal(reviewed.status, 200);
  const released = await get(`/jobs/${fixture.id}/cad-derivatives/${derivativeId}/download`);
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, dwg);
  assert.equal(sha256(released.body), sha256(dwg));
});

test("Japanese hybrid requirements reject coherent English-only table evidence", async () => {
  const fixture = await makeHybridReviewableDxf("japanese-wrong-language", {
    targetLanguage: "ja",
  });
  const ledger = JSON.parse(fixture.ledger.toString("utf8"));
  ledger.tableTargets[0].translation = "Table";
  ledger.tableTargets[0].replacement = "Table";
  ledger.tableScript = buildNativeDxfTableScript(ledger.tableTargets.map((target: any) => ({
    targetId: target.targetId,
    tableHandle: target.tableHandle,
    sourceOrdinal: target.sourceOrdinal,
    sourceOccurrenceCount: target.sourceOccurrenceCount,
    source: target.source,
    translation: target.replacement,
  })));
  ledger.scriptAccounting.sha256 = ledger.tableScript.sha256;
  ledger.scriptAccounting.manifestSha256 = ledger.tableScript.manifestSha256;
  ledger.manualRequirements.tableScriptSha256 = ledger.tableScript.sha256;
  ledger.manualRequirements.tableManifestSha256 = ledger.tableScript.manifestSha256;
  await writeFileToObjectStorage(
    fixture.ledgerStoredName,
    Buffer.from(JSON.stringify(ledger)),
  );

  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(requirements.status, 409);
});

test("hybrid submission rejects unauthorized, stale, tampered, incomplete, and failed evidence", async () => {
  const fixture = await makeHybridReviewableDxf("submission-negative");
  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(requirements.status, 200);
  const dwg = Buffer.alloc(128);
  dwg.write("AC1032", 0, "ascii");

  const anonymousRequirements = await fetch(
    `${baseUrl}/api/cworks-translator/jobs/${fixture.id}/cad-derivative-requirements`,
  );
  assert.equal(anonymousRequirements.status, 401);
  assert.equal((await uploadHybridDerivative(fixture.id, dwg, requirements.json, {}, false)).status, 401);

  const invalidBindings: Array<[string, Record<string, unknown>]> = [
    ["stale revision", { sourceRevision: requirements.json.sourceRevision + 1 }],
    ["source output hash", { sourceOutputSha256: "0".repeat(64) }],
    ["script hash", { tableScriptSha256: "1".repeat(64) }],
    ["manifest hash", { tableManifestSha256: "2".repeat(64) }],
    ["missing application output", { applicationOutput: undefined }],
    ["missing manual resolution", { manualCoverageResolutions: [] }],
    ["missing operational verification", { operationalVerification: undefined }],
    ["duplicate manual resolution", {
      manualCoverageResolutions: requirements.json.manualRequirementIds.map((requirementId: string) => ({
        requirementId: requirements.json.manualRequirementIds[0],
        resolution: `Resolved ${requirementId}`,
      })),
    }],
  ];
  for (const [label, overrides] of invalidBindings) {
    const rejected = await uploadHybridDerivative(fixture.id, dwg, requirements.json, overrides);
    assert.equal(rejected.status, label === "missing application output" ? 400 : 409, `${label} must be rejected`);
  }
  for (const [label, applicationOutput] of [
    ["summary only", `Cworks table translations: matchedTargets=${requirements.json.tableTargetCount} appliedCells=${requirements.json.expectedCounters.applied} skippedTargets=0 countMismatch=0 unsafeCells=0 partialErrors=0 errors=0`],
    ["wrong manifest", successfulApplicationOutput(requirements.json, {}, "3".repeat(64))],
    ["wrong matched target count", successfulApplicationOutput(requirements.json, { matchedTargets: requirements.json.tableTargetCount + 1 })],
    ["wrong applied cell count", successfulApplicationOutput(requirements.json, { appliedCells: requirements.json.expectedCounters.applied - 1 })],
    ["aborted transcript", `${successfulApplicationOutput(requirements.json)}
Cworks aborted: Windows AutoCAD ActiveX is unavailable.`],
    ["duplicate summaries", successfulApplicationOutput(requirements.json).replace(
      "CWORKS_APPLY_TABLE_TRANSLATIONS_END",
      `Cworks table translations: matchedTargets=${requirements.json.tableTargetCount} appliedCells=${requirements.json.expectedCounters.applied} skippedTargets=0 countMismatch=0 unsafeCells=0 partialErrors=0 errors=0
CWORKS_APPLY_TABLE_TRANSLATIONS_END`,
    )],
  ] as const) {
    const rejected = await uploadHybridDerivative(fixture.id, dwg, requirements.json, { applicationOutput });
    assert.equal(
      rejected.status,
      ["wrong manifest", "wrong matched target count", "wrong applied cell count"].includes(label) ? 409 : 400,
      `${label} must be rejected`,
    );
  }
  for (const counter of ["skippedTargets", "countMismatch", "unsafeCells", "partialErrors", "errors"] as const) {
    const rejected = await uploadHybridDerivative(fixture.id, dwg, requirements.json, {
      applicationOutput: successfulApplicationOutput(requirements.json, { [counter]: 1 }),
    });
    assert.equal(rejected.status, 409, `${counter} application count must block submission`);
  }
  for (const [label, operationalVerification] of [
    ["unsupported LISPSYS", {
      platform: "windows_autocad",
      autoCadMajorVersion: 2024,
      lispSys: 0,
      sourceScriptManifestHashesVerified: true,
      partialApplicationEvidenceDisposition: "discarded",
      savedClosedReopened: true,
      reopenedInspectionNotes: "Inspected after reopening.",
    }],
    ["retained partial artifact", {
      platform: "windows_autocad",
      autoCadMajorVersion: 2024,
      lispSys: 1,
      sourceScriptManifestHashesVerified: true,
      partialApplicationEvidenceDisposition: "retained",
      savedClosedReopened: true,
      reopenedInspectionNotes: "Inspected after reopening.",
    }],
    ["not reopened", {
      platform: "windows_autocad",
      autoCadMajorVersion: 2024,
      lispSys: 1,
      sourceScriptManifestHashesVerified: true,
      partialApplicationEvidenceDisposition: "discarded",
      savedClosedReopened: false,
      reopenedInspectionNotes: "Not inspected.",
    }],
  ] as const) {
    const rejected = await uploadHybridDerivative(fixture.id, dwg, requirements.json, {
      operationalVerification,
    });
    assert.equal(rejected.status, 400, `${label} must fail schema validation`);
  }

  await writeFileToObjectStorage(fixture.sourceStoredName, Buffer.from("tampered hybrid source"));
  assert.equal(
    (await uploadHybridDerivative(fixture.id, dwg, requirements.json)).status,
    409,
    "same-key source replacement must invalidate draft evidence",
  );
  await writeFileToObjectStorage(fixture.sourceStoredName, fixture.source);

  let evidenceVariant = 0;
  async function installEvidenceVariant(ledger: any, report?: any) {
    evidenceVariant += 1;
    const ledgerStoredName =
      `cworks-translator/${fixture.id}/evidence-variant-${evidenceVariant}-ledger.json`;
    const preservationStoredName =
      `cworks-translator/${fixture.id}/evidence-variant-${evidenceVariant}-report.json`;
    storedNames.push(ledgerStoredName, preservationStoredName);
    await Promise.all([
      writeFileToObjectStorage(ledgerStoredName, Buffer.from(JSON.stringify(ledger))),
      writeFileToObjectStorage(
        preservationStoredName,
        report === undefined ? fixture.report : Buffer.from(JSON.stringify(report)),
      ),
    ]);
    await db.update(cworksTranslationJobs).set({
      ledgerStoredName,
      preservationStoredName,
    }).where(eq(cworksTranslationJobs.id, fixture.id));
  }
  async function restoreEvidencePointers() {
    await db.update(cworksTranslationJobs).set({
      ledgerStoredName: fixture.ledgerStoredName,
      preservationStoredName: fixture.preservationStoredName,
    }).where(eq(cworksTranslationJobs.id, fixture.id));
  }

  const tamperedLedger = JSON.parse(fixture.ledger.toString("utf8"));
  tamperedLedger.tableScript.script += "\n; injected";
  await installEvidenceVariant(tamperedLedger);
  assert.equal(
    (await uploadHybridDerivative(fixture.id, dwg, requirements.json)).status,
    409,
    "a script whose bytes no longer match its hash must be rejected",
  );
  await restoreEvidencePointers();

  for (const terminalStatus of ["failed", "unavailable"]) {
    const auditLedger = JSON.parse(fixture.ledger.toString("utf8"));
    const auditReport = JSON.parse(fixture.report.toString("utf8"));
    auditLedger.independentAudit = {
      ...auditLedger.independentAudit,
      terminalStatus,
      findings: [],
    };
    auditReport.independentAudit = auditLedger.independentAudit;
    await installEvidenceVariant(auditLedger, auditReport);
    assert.equal(
      (await get(`/jobs/${fixture.id}/cad-derivative-requirements`)).status,
      409,
      `${terminalStatus} independent audit cannot pass merely because its findings are empty`,
    );
    await restoreEvidencePointers();
  }

  const badCoverageLedger = JSON.parse(fixture.ledger.toString("utf8"));
  const badCoverageReport = JSON.parse(fixture.report.toString("utf8"));
  badCoverageLedger.hybridCoverage.pendingTableCellCount += 1;
  badCoverageReport.hybridCoverage = badCoverageLedger.hybridCoverage;
  await installEvidenceVariant(badCoverageLedger, badCoverageReport);
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivative-requirements`)).status,
    409,
    "coverage counters must be derived from the bound script rather than trusted",
  );
  await restoreEvidencePointers();

  const badProofLedger = JSON.parse(fixture.ledger.toString("utf8"));
  const badProofReport = JSON.parse(fixture.report.toString("utf8"));
  badProofLedger.patch.metadataIdentical = false;
  badProofReport.patch = badProofLedger.patch;
  await installEvidenceVariant(badProofLedger, badProofReport);
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivative-requirements`)).status,
    409,
    "a failed byte-preservation proof flag must block hybrid submission",
  );
  await restoreEvidencePointers();

  const badPlacementLedger = JSON.parse(fixture.ledger.toString("utf8"));
  badPlacementLedger.patch.placementManifestSha256 = "3".repeat(64);
  await installEvidenceVariant(badPlacementLedger);
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivative-requirements`)).status,
    409,
    "placement-manifest tampering must invalidate the draft",
  );
  await restoreEvidencePointers();

  const semanticDefectLedger = JSON.parse(fixture.ledger.toString("utf8"));
  semanticDefectLedger.blockingFindings.push({
    targetId: "AUDIT:SEMANTIC:1",
    handle: "audit",
    reason: "independent audit found a semantic mismatch",
  });
  await installEvidenceVariant(semanticDefectLedger);
  const defectiveRequirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(defectiveRequirements.status, 200);
  assert.equal(defectiveRequirements.json.machineDefectCount, 1);
  assert.equal(defectiveRequirements.json.submissionAllowed, false);
  assert.equal(
    (await uploadHybridDerivative(fixture.id, dwg, defectiveRequirements.json)).status,
    409,
    "independent semantic defects cannot be treated as resolvable manual CAD coverage",
  );
  await restoreEvidencePointers();

  const blockerCollisionLedger = JSON.parse(fixture.ledger.toString("utf8"));
  blockerCollisionLedger.blockingFindings.push({
    targetId: "MANUAL:VISIBLE:1",
    handle: "visible-text",
    reason: "independent semantic mismatch on the same target",
  });
  await installEvidenceVariant(blockerCollisionLedger);
  const collisionRequirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(collisionRequirements.status, 200);
  assert.equal(collisionRequirements.json.machineDefectCount, 1);
  assert.equal(collisionRequirements.json.submissionAllowed, false);
  assert.equal(
    (await uploadHybridDerivative(fixture.id, dwg, collisionRequirements.json)).status,
    409,
    "a semantic blocker cannot hide behind a manual blocker with the same target",
  );
  await restoreEvidencePointers();
});

test("hybrid review rejects authorization failures, open page findings, and tampered evidence", async () => {
  const fixture = await makeHybridReviewableDxf("review-negative");
  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  const dwg = Buffer.alloc(128);
  dwg.write("AC1032", 0, "ascii");
  const uploaded = await uploadHybridDerivative(fixture.id, dwg, requirements.json);
  assert.equal(uploaded.status, 201);
  const derivativeId = uploaded.json.derivative.id;
  const [stored] = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.id, derivativeId));
  storedNames.push(stored.storedName);
  const reviewBody = {
    decision: "approve",
    declaration: true,
    notes: "Reviewed exact derivative.",
  };
  const anonymous = await fetch(
    `${baseUrl}/api/cworks-translator/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reviewBody),
    },
  );
  assert.equal(anonymous.status, 401);
  const passwordOnly = await fetch(
    `${baseUrl}/api/cworks-translator/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
    {
      method: "POST",
      headers: { "x-test-authed": "1", "content-type": "application/json" },
      body: JSON.stringify(reviewBody),
    },
  );
  assert.equal(passwordOnly.status, 401, "the product password alone is not a reviewer identity");
  assert.equal(
    (await request(
      "POST",
      `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
      { ...reviewBody, reviewerName: "Forged Reviewer" },
    )).status,
    400,
    "caller-supplied reviewer identity must be rejected",
  );
  assert.equal(
    (await request(
      "POST",
      `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
      reviewBody,
      { userId: VIEWER_USER_ID, role: "viewer" },
    )).status,
    403,
    "a signed-in user without an authorized release role must be rejected",
  );
  assert.equal(
    (await request(
      "POST",
      `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
      reviewBody,
      { userId: OPERATOR_USER_ID, role: "admin" },
    )).status,
    403,
    "the authenticated submitting operator must not approve their own derivative",
  );
  assert.equal(
    (await request(
      "POST",
      `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`,
      reviewBody,
      { userId: `missing-reviewer-${run}`, role: "admin" },
    )).status,
    403,
    "a session identity without an active database account must be rejected",
  );
  await db.update(users).set({ status: "disabled" }).where(eq(users.id, REVIEWER_USER_ID));
  assert.equal(
    (await request("POST", `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`, reviewBody)).status,
    403,
    "a disabled reviewer must be rejected",
  );
  await db.update(users).set({ status: "active" }).where(eq(users.id, REVIEWER_USER_ID));

  await db.update(cworksTranslationPageReviews).set({ checked: false })
    .where(eq(cworksTranslationPageReviews.jobId, fixture.id));
  assert.equal(
    (await request("POST", `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`, reviewBody)).status,
    409,
  );
  await db.update(cworksTranslationPageReviews).set({
    checked: true,
    resolvedFindingIndexes: [],
  }).where(eq(cworksTranslationPageReviews.jobId, fixture.id));
  assert.equal(
    (await request("POST", `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`, reviewBody)).status,
    409,
    "the representative unresolvedVisibleText page finding must be resolved",
  );

  await db.update(cworksTranslationPageReviews).set({ resolvedFindingIndexes: [0] })
    .where(eq(cworksTranslationPageReviews.jobId, fixture.id));
  await writeFileToObjectStorage(stored.storedName, Buffer.from("tampered before review"));
  assert.equal(
    (await request("POST", `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`, reviewBody)).status,
    409,
  );
  await writeFileToObjectStorage(stored.storedName, dwg);

  await assert.rejects(
    db.update(cworksTranslationCadDerivatives).set({
      evidence: { ...(stored.evidence as any), tableManifestSha256: "f".repeat(64) },
    }).where(eq(cworksTranslationCadDerivatives.id, derivativeId)),
    (error) => databaseErrorChainMatches(
      error,
      /immutable|append.only|cannot update/i,
    ),
    "database enforcement must reject mutation of recorded derivative evidence",
  );
  assert.equal(
    (await request("POST", `/jobs/${fixture.id}/cad-derivatives/${derivativeId}/review`, reviewBody)).status,
    200,
  );
});

test("a prior derivative approval stays stale after revise and replacement approval", async () => {
  const fixture = await makeHybridReviewableDxf("revised-release");
  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(requirements.status, 200);
  const firstBytes = Buffer.alloc(128);
  firstBytes.write("AC1032", 0, "ascii");
  firstBytes.write("first derivative", 16, "ascii");
  const firstUpload = await uploadHybridDerivative(fixture.id, firstBytes, requirements.json);
  assert.equal(firstUpload.status, 201);
  const firstId = firstUpload.json.derivative.id;
  const [firstStored] = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.id, firstId));
  storedNames.push(firstStored.storedName);
  const approvalBody = {
    decision: "approve",
    declaration: true,
    notes: "Reviewed the exact derivative.",
  };
  assert.equal(
    (await request("POST", `/jobs/${fixture.id}/cad-derivatives/${firstId}/review`, approvalBody)).status,
    200,
  );
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivatives/${firstId}/download`)).status,
    200,
  );

  const revised = await request(
    "POST",
    `/jobs/${fixture.id}/cad-derivatives/${firstId}/review`,
    {
      decision: "revise",
      declaration: false,
      notes: "Replace this derivative after a newly noticed layout defect.",
    },
  );
  assert.equal(revised.status, 200);
  assert.equal(revised.json.decision, "derivative_revise");
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivatives/${firstId}/download`)).status,
    409,
  );

  const refreshedRequirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  assert.equal(refreshedRequirements.status, 200);
  const replacementBytes = Buffer.alloc(128);
  replacementBytes.write("AC1032", 0, "ascii");
  replacementBytes.write("replacement derivative", 16, "ascii");
  const replacementUpload = await uploadHybridDerivative(
    fixture.id,
    replacementBytes,
    refreshedRequirements.json,
  );
  assert.equal(replacementUpload.status, 201);
  const replacementId = replacementUpload.json.derivative.id;
  const [replacementStored] = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.id, replacementId));
  storedNames.push(replacementStored.storedName);
  assert.equal(
    (await request(
      "POST",
      `/jobs/${fixture.id}/cad-derivatives/${replacementId}/review`,
      approvalBody,
    )).status,
    200,
  );
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivatives/${replacementId}/download`)).status,
    200,
  );
  assert.equal(
    (await get(`/jobs/${fixture.id}/cad-derivatives/${firstId}/download`)).status,
    409,
    "an older approval followed by revise must never revive when another derivative is approved",
  );
});

test("hybrid upload loses a source-revision race under the evidence lock", async () => {
  const fixture = await makeHybridReviewableDxf("revision-race");
  const requirements = await get(`/jobs/${fixture.id}/cad-derivative-requirements`);
  const dwg = Buffer.alloc(128);
  dwg.write("AC1032", 0, "ascii");
  let releaseLock!: () => void;
  const lockRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
  let acquiredLock!: () => void;
  const acquired = new Promise<void>((resolve) => { acquiredLock = resolve; });
  const blocker = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${fixture.id}))`);
    acquiredLock();
    await lockRelease;
  });
  await acquired;
  const upload = uploadHybridDerivative(fixture.id, dwg, requirements.json);
  await new Promise((resolve) => setTimeout(resolve, 75));
  await db.update(cworksTranslationJobs).set({ revisionCount: 1 })
    .where(eq(cworksTranslationJobs.id, fixture.id));
  releaseLock();
  const result = await upload;
  await blocker;
  assert.equal(result.status, 409);
  const derivatives = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.jobId, fixture.id));
  assert.equal(derivatives.length, 0);
});

test("job deletion serializes with derivative creation and queues every private object", async () => {
  const fixture = await makeReviewableDxf("cad-derivative-delete-race");
  const approval = await request("POST", `/jobs/${fixture.id}/feedback`, {
    decision: "approve",
    notes: "",
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: true,
    cadOperatorDeclaration: true,
    cadOperatorName: "Approval Operator",
    cadOperatorQualification: "Qualified AutoCAD operator",
  });
  assert.equal(approval.status, 200);
  const [approvalEvent] = await db.select().from(cworksTranslationReviewEvents)
    .where(and(
      eq(cworksTranslationReviewEvents.jobId, fixture.id),
      eq(cworksTranslationReviewEvents.decision, "approve"),
    )).limit(1);
  assert.ok(approvalEvent);

  const derivativeId = randomUUID();
  const derivativeBytes = Buffer.alloc(128);
  derivativeBytes.write("AC1032", 0, "ascii");
  const derivativeStoredName = `cworks-translator/${fixture.id}/cad-derivatives/${derivativeId}.dwg`;
  storedNames.push(derivativeStoredName);
  await writeFileToObjectStorage(derivativeStoredName, derivativeBytes);

  let deletionSettled = false;
  let deletion!: Promise<{ status: number; json: any }>;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${fixture.id}))`);
    deletion = request("DELETE", `/jobs/${fixture.id}`);
    void deletion.finally(() => { deletionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(deletionSettled, false, "deletion must wait for the per-job evidence lock");
    await db.insert(cworksTranslationCadDerivatives).values({
      id: derivativeId,
      jobId: fixture.id,
      sourceRevision: 0,
      sourceOutputSha256: approvalEvent.translatedOutputSha256!,
      sourceApprovalEventId: approvalEvent.id,
      originalFilename: "late-operator-edit.dwg",
      format: "dwg",
      storedName: derivativeStoredName,
      sha256: sha256(derivativeBytes),
      operatorName: "Concurrent Operator",
      operatorQualification: "Qualified AutoCAD operator",
      operatorNotes: "Recorded while deletion was waiting for the evidence lock.",
      operatorAttestation: "This separately attested derivative makes no preservation claim.",
    });
  });

  const deleted = await deletion;
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.cleanupQueued, 6, "source, output, report, ledger, thumbnail, and derivative must all be queued");
  const [removedDerivative] = await db.select().from(cworksTranslationCadDerivatives)
    .where(eq(cworksTranslationCadDerivatives.id, derivativeId));
  assert.equal(removedDerivative, undefined);
});

for (const asset of ["source", "output", "preservation", "ledger"] as const) {
  test(`native DXF approval rejects same-key ${asset} overwrite after preflight`, async () => {
    const fixture = await makeReviewableDxf(`same-key-${asset}`);
    const storedName = asset === "source"
      ? fixture.sourceStoredName
      : asset === "output"
        ? fixture.outputStoredName
        : asset === "preservation"
          ? fixture.preservationStoredName
          : fixture.ledgerStoredName;
    let releaseLock!: () => void;
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let acquiredLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      acquiredLock = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${fixture.id}))`);
      acquiredLock();
      await lockRelease;
    });
    await acquired;
    const approvalPromise = request("POST", `/jobs/${fixture.id}/feedback`, {
      decision: "approve",
      notes: "",
      reviewerName: "Qualified Reviewer",
      reviewerQualification: "Chartered engineer and fluent source-language reviewer",
      declaration: true,
      cadOperatorDeclaration: true,
      cadOperatorName: "CAD Operator",
      cadOperatorQualification: "Qualified AutoCAD operator",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    await writeFileToObjectStorage(storedName, Buffer.from(`same-key approval tamper ${asset}`));
    releaseLock();
    const approval = await approvalPromise;
    await blocker;
    assert.equal(approval.status, 409);
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, fixture.id));
    assert.equal(job.status, "awaiting_review");
    const events = await db.select().from(cworksTranslationReviewEvents)
      .where(eq(cworksTranslationReviewEvents.jobId, fixture.id));
    assert.equal(events.length, 0);
  });
}

test("native DXF approval rejects an evidence-pointer race under the advisory lock", async () => {
  const fixture = await makeReviewableDxf("evidence-race");
  const alternateName = `cworks-translator/${fixture.id}/alternate-ledger.json`;
  storedNames.push(alternateName);
  await writeFileToObjectStorage(alternateName, fixture.ledger);

  let releaseLock!: () => void;
  const lockRelease = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let acquiredLock!: () => void;
  const acquired = new Promise<void>((resolve) => {
    acquiredLock = resolve;
  });
  const blocker = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${fixture.id}))`);
    acquiredLock();
    await lockRelease;
  });
  await acquired;
  const approvalPromise = request("POST", `/jobs/${fixture.id}/feedback`, {
    decision: "approve",
    notes: "",
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: true,
    cadOperatorDeclaration: true,
    cadOperatorName: "CAD Operator",
    cadOperatorQualification: "Qualified AutoCAD operator",
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  await db.update(cworksTranslationJobs)
    .set({ ledgerStoredName: alternateName })
    .where(eq(cworksTranslationJobs.id, fixture.id));
  releaseLock();
  const approval = await approvalPromise;
  await blocker;
  assert.equal(approval.status, 409);
  const [job] = await db.select().from(cworksTranslationJobs)
    .where(eq(cworksTranslationJobs.id, fixture.id));
  assert.equal(job.status, "awaiting_review");
  const events = await db.select().from(cworksTranslationReviewEvents)
    .where(eq(cworksTranslationReviewEvents.jobId, fixture.id));
  assert.equal(events.length, 0);
});

for (const status of ["awaiting_review", "done"]) {
  test(`${status} job: review pages are visible and final downloads follow approval`, async () => {
    const id = await makeJob(status, { withAssets: true });

    const detail = await get(`/jobs/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.pages.length, 1, "published page list must be visible");

    const thumb = await get(`/jobs/${id}/pages/1/thumbnail`);
    assert.equal(thumb.status, 200, "thumbnail must stream");

    const download = await get(`/jobs/${id}/download`);
    assert.equal(
      download.status,
      status === "done" ? 200 : 409,
      "translated download must require qualified-human approval",
    );

    const summary = await get(`/jobs/${id}/summary`);
    assert.equal(summary.status, status === "done" ? 200 : 409, "summary must require approval");
  });
}

test("review preview URLs and responses cannot reuse an older revision", async () => {
  const id = await makeJob("awaiting_review", {
    withAssets: true,
    idSuffix: "preview-cache",
  });
  const revisionZero = await get(`/jobs/${id}`);
  const firstUrl = revisionZero.json.pages[0].thumbnailUrl;
  assert.equal(firstUrl.endsWith("?revision=0"), true);

  const firstPreview = await get(firstUrl.replace("/api/cworks-translator", ""));
  assert.equal(firstPreview.status, 200);
  assert.equal(firstPreview.headers.get("cache-control"), "no-store");

  const revisionOneStoredName = `cworks-translator/${id}/page-1-revision-1.jpg`;
  const revisionOneBytes = Buffer.from("revision-one-preview");
  storedNames.push(revisionOneStoredName);
  await writeFileToObjectStorage(revisionOneStoredName, revisionOneBytes);
  await db.update(cworksTranslationJobs)
    .set({ revisionCount: 1 })
    .where(eq(cworksTranslationJobs.id, id));
  await db.update(cworksTranslationPages)
    .set({ thumbnailStoredName: revisionOneStoredName })
    .where(and(
      eq(cworksTranslationPages.jobId, id),
      eq(cworksTranslationPages.pageNumber, 1),
    ));

  const revisionOne = await get(`/jobs/${id}`);
  const secondUrl = revisionOne.json.pages[0].thumbnailUrl;
  assert.equal(secondUrl.endsWith("?revision=1"), true);
  assert.notEqual(secondUrl, firstUrl);

  const secondPreview = await get(secondUrl.replace("/api/cworks-translator", ""));
  assert.equal(secondPreview.status, 200);
  assert.deepEqual(secondPreview.body, revisionOneBytes);
  assert.equal(secondPreview.headers.get("cache-control"), "no-store");
});

test("approval requires every page checked and every audit finding resolved", async () => {
  const id = `cworks-review-test-attestation-${run}`;
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Qualified review ${run}`,
    status: "awaiting_review",
    originalFilename: "qualified-review.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    outputStoredName: `cworks-translator/${id}/translated.pdf`,
    summaryStoredName: `cworks-translator/${id}/summary.md`,
    pageCount: 1,
    pagesDone: 1,
    machineAuditStatus: "findings",
    machineAuditModel: "gpt-5.6-sol",
  });
  await db.insert(cworksTranslationPages).values({
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName: `cworks-translator/${id}/page-1.jpg`,
    sourceBlockCount: 1,
    translatedBlockCount: 1,
    machineAuditStatus: "findings",
    machineAuditFindings: [{
      type: "placement",
      message: "Check the translated heading position.",
    }],
  });

  const attestation = {
    decision: "approve",
    notes: "",
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: true,
  };
  const premature = await request("POST", `/jobs/${id}/feedback`, attestation);
  assert.equal(premature.status, 409, "unchecked page must block approval");

  const unresolved = await request("PUT", `/jobs/${id}/pages/1/review`, {
    checked: true,
    resolvedFindingIndexes: [],
    notes: "Compared both page images.",
  });
  assert.equal(unresolved.status, 200);
  const stillBlocked = await request("POST", `/jobs/${id}/feedback`, attestation);
  assert.equal(stillBlocked.status, 409, "unresolved audit finding must block approval");

  const resolved = await request("PUT", `/jobs/${id}/pages/1/review`, {
    checked: true,
    resolvedFindingIndexes: [0],
    notes: "Verified the heading against the source and confirmed placement.",
  });
  assert.equal(resolved.status, 200);
  const approved = await request("POST", `/jobs/${id}/feedback`, attestation);
  assert.equal(approved.status, 200);
  assert.equal(approved.json.job.status, "done");
  assert.equal(approved.json.job.approvedRevision, 0);

  const events = await db.select().from(cworksTranslationReviewEvents)
    .where(inArray(cworksTranslationReviewEvents.jobId, [id]));
  assert.equal(events.length, 1, "approval must append one immutable review event");
  assert.equal(events[0].reviewerName, "Qualified Reviewer");

  const revision = await request("POST", `/jobs/${id}/feedback`, {
    decision: "revise",
    notes: "Issue a new revision with the corrected title-block terminology.",
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: false,
  });
  assert.equal(revision.status, 200);
  assert.equal(revision.json.job.status, "revising");
  assert.equal(revision.json.job.revisionCount, 1);
  assert.equal(revision.json.job.approvedRevision, null);
  assert.equal(revision.json.job.approvedAt, null);
  const retainedEvents = await db.select().from(cworksTranslationReviewEvents)
    .where(inArray(cworksTranslationReviewEvents.jobId, [id]));
  assert.equal(retainedEvents.length, 2, "revision must retain prior approval history");
  assert.deepEqual(
    retainedEvents.map((event) => event.decision).sort(),
    ["approve", "revise"],
  );
});

test("authenticated job detail exposes structured unresolved-line evidence", async () => {
  const id = `cworks-review-test-unresolved-${run}`;
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Unresolved line evidence ${run}`,
    status: "awaiting_review",
    originalFilename: "unresolved-evidence.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    pageCount: 1,
    pagesDone: 1,
    machineAuditStatus: "passed",
  });
  await db.insert(cworksTranslationPages).values({
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName: `cworks-translator/${id}/page-1.jpg`,
    sourceBlockCount: 1,
    translatedBlockCount: 0,
    warnings: [{
      blockId: "p1-l0",
      sourceText: "КЛАПАН",
      bbox: [12.5, 24, 68.25, 38],
      rejectionCategory: "overlap",
    }],
    previewMetadata: {
      pixelWidth: 1210,
      pixelHeight: 935,
      pageWidthPoints: 792,
      pageHeightPoints: 612,
    },
    machineAuditStatus: "passed",
    machineAuditFindings: [],
  });

  const detail = await get(`/jobs/${id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.pages[0].unresolvedLines, [{
    blockId: "p1-l0",
    sourceText: "КЛАПАН",
    currentTranslation: "",
    pageNumber: 1,
    bbox: [12.5, 24, 68.25, 38],
    rejectionCategory: "overlap",
  }]);
  assert.deepEqual(detail.json.pages[0].previewMetadata, {
    pixelWidth: 1210,
    pixelHeight: 935,
    pageWidthPoints: 792,
    pageHeightPoints: 612,
  });
  assert.deepEqual(detail.json.pages[0].warnings, [
    "Completeness check: 1 target lines remain unresolved. Approval and final PDF download are blocked.",
  ]);
});

test("automatic repair collects only unresolved server-side evidence and creates one locked revision", async () => {
  const id = `cworks-review-test-auto-repair-${run}`;
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Automatic repair ${run}`,
    status: "awaiting_review",
    originalFilename: "automatic-repair.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    outputStoredName: `cworks-translator/${id}/translated.pdf`,
    summaryStoredName: `cworks-translator/${id}/summary.md`,
    pageCount: 2,
    pagesDone: 2,
    machineAuditStatus: "findings",
    approvedRevision: 0,
    approvedAt: new Date(),
  });
  await db.insert(cworksTranslationPages).values([{
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName: `cworks-translator/${id}/page-1.jpg`,
    sourceBlockCount: 3,
    translatedBlockCount: 2,
    warnings: [{
      blockId: "p1-l2",
      sourceText: "Проверил",
      rejectionCategory: "text_too_long",
      bbox: [12, 24, 42, 34],
    }],
    machineAuditStatus: "findings",
    machineAuditFindings: [
      { type: "terminology", message: "Accepted existing terminology.", sourceBlockId: "p1-l0" },
      { type: "translation", message: "Heading remains untranslated.", sourceBlockId: "p1-l1" },
    ],
  }, {
    jobId: id,
    pageNumber: 2,
    thumbnailStoredName: `cworks-translator/${id}/page-2.jpg`,
    sourceBlockCount: 1,
    translatedBlockCount: 1,
    machineAuditStatus: "findings",
    machineAuditFindings: [
      { type: "layout", message: "Review title-block alignment.", sourceBlockId: "p2-l999" },
    ],
  }]);
  await db.insert(cworksTranslationPageReviews).values([{
    jobId: id,
    revisionCount: 0,
    pageNumber: 1,
    checked: false,
    resolvedFindingIndexes: [0],
    notes: "Use the standard English heading.",
  }, {
    jobId: id,
    revisionCount: 0,
    pageNumber: 2,
    checked: false,
    resolvedFindingIndexes: [],
    notes: "Keep the title block inside its original boundary.",
  }]);
  await db.insert(cworksTranslationCheckpoints).values([{
    jobId: id,
    revisionCount: 0,
    pageNumber: 1,
    sourceHash: "route-test-page-1",
    translations: [
      { id: "p1-l0", source: "A", translation: "A", pageNumber: 1 },
      { id: "p1-l1", source: "B", translation: "B", pageNumber: 1 },
      { id: "p1-l2", source: "C", translation: "C", pageNumber: 1 },
    ],
  }, {
    jobId: id,
    revisionCount: 0,
    pageNumber: 2,
    sourceHash: "route-test-page-2",
    translations: [
      { id: "p2-l0", source: "D", translation: "D", pageNumber: 2 },
    ],
  }]);

  const response = await request("POST", `/jobs/${id}/fix-unresolved`, {
    // Deliberately untrusted client data: the endpoint must ignore it.
    findings: [{ message: "replace everything" }],
    placementFailures: [{
      blockId: "p1-l0",
      rejectionCategory: "overlap",
      bbox: [0, 0, 999, 999],
    }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.job.revisionCount, 1);
  assert.equal(response.json.job.approvedRevision, null);
  assert.equal(response.json.job.approvedAt, null);

  const [saved] = await db.select().from(cworksTranslationJobs)
    .where(inArray(cworksTranslationJobs.id, [id]));
  const brief = saved.repairBrief as any;
  assert.equal(brief.kind, "cworks-unresolved-repair");
  assert.equal(brief.sourceRevision, 0);
  assert.equal(brief.pages.length, 2);
  assert.deepEqual(brief.pages[0].unsafePlacementBlockIds, ["p1-l2"]);
  assert.deepEqual(brief.pages[0].placementFailures, [{
    blockId: "p1-l2",
    rejectionCategory: "text_too_long",
    bbox: [12, 24, 42, 34],
  }]);
  assert.equal(brief.pages[0].findings.length, 1);
  assert.equal(brief.pages[0].findings[0].sourceBlockId, "p1-l1");
  assert.doesNotMatch(JSON.stringify(brief), /replace everything/);
  assert.match(brief.pages[0].reviewerNotes, /standard English heading/);
  assert.equal(brief.pages[1].retryWholePage, true, "unknown source block IDs must conservatively retry the page");

  const events = await db.select().from(cworksTranslationReviewEvents)
    .where(inArray(cworksTranslationReviewEvents.jobId, [id]));
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "automatic_repair");
  const duplicate = await request("POST", `/jobs/${id}/fix-unresolved`, {});
  assert.equal(duplicate.status, 409, "a second click must not create another revision");
});

test("automatic repair rejects a clean draft", async () => {
  const id = `cworks-review-test-auto-repair-clean-${run}`;
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Clean automatic repair ${run}`,
    status: "awaiting_review",
    originalFilename: "clean.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    pageCount: 1,
    pagesDone: 1,
    machineAuditStatus: "passed",
  });
  await db.insert(cworksTranslationPages).values({
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName: `cworks-translator/${id}/page-1.jpg`,
    sourceBlockCount: 2,
    translatedBlockCount: 2,
    warnings: [],
    machineAuditStatus: "passed",
    machineAuditFindings: [],
  });
  const response = await request("POST", `/jobs/${id}/fix-unresolved`, {});
  assert.equal(response.status, 409);
  assert.match(response.json.error, /no unresolved/i);
});

test("targeted DXF correction is revision-bound, owner-authorized, archives evidence, and excludes resolved findings", async () => {
  const id = `cworks-review-test-targeted-correction-${run}`;
  jobIds.push(id);
  const artifactNames = {
    source: `cworks-translator/${id}/source.dxf`,
    output: `cworks-translator/${id}/translated-r4.dxf`,
    summary: `cworks-translator/${id}/summary-r4.md`,
    ledger: `cworks-translator/${id}/ledger-r4.json`,
    preservation: `cworks-translator/${id}/preservation-r4.json`,
    thumbnail: `cworks-translator/${id}/translated-r4.svg`,
  };
  storedNames.push(...Object.values(artifactNames));
  await Promise.all(Object.entries(artifactNames).map(([kind, storedName]) =>
    writeFileToObjectStorage(storedName, Buffer.from(`targeted-correction-${kind}-${id}`)),
  ));
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Targeted correction ${run}`,
    sourceFormat: "dxf",
    status: "awaiting_review",
    originalFilename: "targeted-correction.dxf",
    sourceStoredName: artifactNames.source,
    outputStoredName: artifactNames.output,
    summaryStoredName: artifactNames.summary,
    ledgerStoredName: artifactNames.ledger,
    preservationStoredName: artifactNames.preservation,
    pageCount: 1,
    pagesDone: 1,
    revisionCount: 4,
    retryCount: 3,
    machineAuditStatus: "findings",
  });
  await db.insert(cworksTranslationPages).values({
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName: artifactNames.thumbnail,
    sourceBlockCount: 2,
    translatedBlockCount: 2,
    machineAuditStatus: "findings",
    machineAuditFindings: [
      { type: "translation", message: "Reviewer resolved this finding.", sourceBlockId: "T-RESOLVED" },
      { type: "translation", message: "This finding remains unresolved.", sourceBlockId: "T-OPEN" },
    ],
  });
  await db.insert(cworksTranslationPageReviews).values({
    jobId: id,
    revisionCount: 4,
    pageNumber: 1,
    checked: true,
    resolvedFindingIndexes: [0],
    reviewerSessionId: randomUUID(),
    checkedAt: new Date(),
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id,
    revisionCount: 4,
    pageNumber: 1,
    sourceHash: "targeted-correction-checkpoint",
    translations: {
      format: "cworks-native-dxf-checkpoint-v1",
      sourceSha256: sha256(Buffer.from(`targeted-correction-source-${id}`)),
      sourceRevision: 4,
      revisionCount: 4,
      targetLanguage: "en",
      methodologyHash: nativeDxfCheckpointMethodologyHash("en"),
      placementManifestSha256: null,
      stage: "pre_patch",
      completedBatchCount: 1,
      translations: {
        "T-RESOLVED": "Resolved",
        "T-OPEN": "Open",
        "T-INDEPENDENT": "Independently unresolved",
      },
      ledger: {
        entries: [
          { targetId: "T-RESOLVED" },
          { targetId: "T-OPEN" },
          { targetId: "T-INDEPENDENT" },
        ],
        // This represents a separately unresolved translation reason and
        // remains eligible even when a reviewer resolves an audit finding.
        unresolved: [{ targetId: "T-INDEPENDENT", reason: "translation_unresolved" }],
        blockingFindings: [{ targetId: "T-RESOLVED" }],
        independentAudit: {
          findings: [{ sourceBlockId: "T-RESOLVED" }],
          rawFindings: [{ sourceBlockId: "T-RESOLVED" }],
        },
      },
    },
  });

  const missingRevision = await request("POST", `/jobs/${id}/correct-unresolved`, {
    consentToTargetedDxfCorrection: true,
  });
  assert.equal(missingRevision.status, 400);

  const viewer = await request("POST", `/jobs/${id}/correct-unresolved`, {
    consentToTargetedDxfCorrection: true,
    expectedSourceRevision: 4,
  }, { userId: VIEWER_USER_ID, role: "viewer" });
  assert.equal(viewer.status, 403);

  const stale = await request("POST", `/jobs/${id}/correct-unresolved`, {
    consentToTargetedDxfCorrection: true,
    expectedSourceRevision: 3,
  });
  assert.equal(stale.status, 409);

  const response = await request("POST", `/jobs/${id}/correct-unresolved`, {
    consentToTargetedDxfCorrection: true,
    expectedSourceRevision: 4,
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.job.revisionCount, 5);
  assert.equal(response.json.job.retryCount, 0);

  const [saved] = await db.select().from(cworksTranslationJobs)
    .where(eq(cworksTranslationJobs.id, id));
  assert.deepEqual(
    (saved.repairBrief as any).targetIds,
    ["T-INDEPENDENT", "T-OPEN"],
    "resolved audit IDs must be excluded even when duplicated in ledger evidence",
  );
  const [event] = await db.select().from(cworksTranslationReviewEvents)
    .where(eq(cworksTranslationReviewEvents.jobId, id));
  assert.equal(event.decision, "native_dxf_correction");
  assert.equal(event.reviewerName, "Authorized CAD Reviewer");
  assert.equal(event.reviewerUserId, REVIEWER_USER_ID);
  assert.equal(event.reviewerRole, "admin");
  const snapshot = event.pageReviewSnapshot as any;
  assert.deepEqual(snapshot.priorPageFindings, [{
    pageNumber: 1,
    machineAuditStatus: "findings",
    machineAuditFindings: [
      { type: "translation", message: "Reviewer resolved this finding.", sourceBlockId: "T-RESOLVED" },
      { type: "translation", message: "This finding remains unresolved.", sourceBlockId: "T-OPEN" },
    ],
  }]);
  const priorOutput = snapshot.priorArtifacts.find((artifact: any) =>
    artifact.storedName === artifactNames.output);
  assert.deepEqual(priorOutput, {
    kind: "translated_output",
    storedName: artifactNames.output,
    sha256: sha256(Buffer.from(`targeted-correction-output-${id}`)),
  });

  const duplicate = await request("POST", `/jobs/${id}/correct-unresolved`, {
    consentToTargetedDxfCorrection: true,
    expectedSourceRevision: 4,
  });
  assert.equal(duplicate.status, 409);

  // The correction failed before its successor checkpoint was created. Retry
  // must validate the predecessor checkpoint and retain the targeted brief.
  await db.update(cworksTranslationJobs).set({ status: "failed" })
    .where(eq(cworksTranslationJobs.id, id));
  const resumed = await request("POST", `/jobs/${id}/retry`, { mode: "resume" });
  assert.equal(resumed.status, 200);
  const [resumedJob] = await db.select().from(cworksTranslationJobs)
    .where(eq(cworksTranslationJobs.id, id));
  assert.deepEqual((resumedJob.repairBrief as any).targetIds, ["T-INDEPENDENT", "T-OPEN"]);

  // Simulate the successor replacing its output pointer. Deletion must still
  // collect the archived predecessor artifact named only in the event JSON.
  const successorOutput = `cworks-translator/${id}/translated-r5.dxf`;
  storedNames.push(successorOutput);
  await writeFileToObjectStorage(successorOutput, Buffer.from(`targeted-correction-successor-${id}`));
  await db.update(cworksTranslationJobs).set({ outputStoredName: successorOutput })
    .where(eq(cworksTranslationJobs.id, id));
  const deleted = await request("DELETE", `/jobs/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal(
    deleted.json.cleanupQueued,
    7,
    "deletion must queue the six current objects plus the archived predecessor output",
  );
});

test("manual touch-up commit is revision-locked, session-locked, and attestation-neutral", async () => {
  const id = `cworks-review-test-manual-touchup-${run}`;
  const touchupId = randomUUID();
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Manual touch-up ${run}`,
    status: "awaiting_review",
    originalFilename: "manual.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    pageCount: 1,
    pagesDone: 1,
    revisionCount: 1,
    machineAuditStatus: "findings",
  });
  await db.insert(cworksTranslationPages).values({
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName: `cworks-translator/${id}/page-1.jpg`,
    sourceBlockCount: 1,
    translatedBlockCount: 0,
    warnings: [{
      blockId: "p1-l0",
      sourceText: "Помещение",
      bbox: [10, 10, 40, 20],
      rejectionCategory: "text_too_long",
    }],
  });
  await db.insert(cworksTranslationTouchups).values({
    id: touchupId,
    jobId: id,
    sourceRevision: 1,
    pageNumber: 1,
    blockId: "p1-l0",
    sourceText: "Помещение",
    beforeTranslation: "Room designation",
    afterTranslation: "Room",
    reason: "Shorten the room label to fit.",
    status: "previewed",
    reviewerSessionId: "",
    previewWarnings: [],
    renderFingerprint: "test-fingerprint",
    renderLayoutVersion: 12,
    expiresAt: new Date(Date.now() + 60_000),
  });

  const committed = await request("POST", `/jobs/${id}/touchups/${touchupId}/commit`, {});
  assert.equal(committed.status, 200);
  assert.equal(committed.json.job.status, "revising");
  assert.equal(committed.json.job.revisionCount, 2);
  assert.equal(committed.json.job.approvedRevision, null);

  const [touchup] = await db.select().from(cworksTranslationTouchups)
    .where(eq(cworksTranslationTouchups.id, touchupId));
  assert.equal(touchup.status, "committed");
  assert.equal(touchup.committedRevision, 2);
  const events = await db.select().from(cworksTranslationReviewEvents)
    .where(eq(cworksTranslationReviewEvents.jobId, id));
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "manual_touchup");
  assert.match(events[0].declaration, /No approval/i);

  const duplicate = await request("POST", `/jobs/${id}/touchups/${touchupId}/commit`, {});
  assert.equal(duplicate.status, 409, "one preview cannot create two revisions");
});

test("Japanese PDF jobs reject English-only manual touch-ups before preview or commit", async () => {
  const id = `cworks-review-test-japanese-touchup-${run}`;
  const touchupId = randomUUID();
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Japanese touch-up ${run}`,
    sourceLanguage: "ru",
    targetLanguage: "ja",
    status: "awaiting_review",
    originalFilename: "japanese.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    pageCount: 1,
    pagesDone: 1,
    revisionCount: 1,
    machineAuditStatus: "findings",
  });

  const preview = await request(
    "POST",
    `/jobs/${id}/pages/1/touchups/preview`,
    {
      revisionCount: 1,
      blockId: "p1-l0",
      translation: "Room",
      reason: "Attempt an English-only correction.",
    },
  );
  assert.equal(preview.status, 422);
  assert.match(preview.json.error, /Japanese/i);

  await db.insert(cworksTranslationTouchups).values({
    id: touchupId,
    jobId: id,
    sourceRevision: 1,
    pageNumber: 1,
    blockId: "p1-l0",
    sourceText: "Помещение",
    beforeTranslation: "部屋",
    afterTranslation: "Room",
    reason: "Attempt an English-only correction.",
    status: "previewed",
    reviewerSessionId: "",
    previewWarnings: [],
    renderFingerprint: "wrong-language-fingerprint",
    renderLayoutVersion: 12,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const committed = await request(
    "POST",
    `/jobs/${id}/touchups/${touchupId}/commit`,
    {},
  );
  assert.equal(committed.status, 422);
  assert.match(committed.json.error, /target language/i);

  const [unchanged] = await db.select().from(cworksTranslationJobs)
    .where(eq(cworksTranslationJobs.id, id));
  assert.equal(unchanged.status, "awaiting_review");
  assert.equal(unchanged.revisionCount, 1);
});

test("a completed manual revision can restore its previous translations as a new draft", async () => {
  const id = `cworks-review-test-restore-${run}`;
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Restore revision ${run}`,
    status: "awaiting_review",
    originalFilename: "restore.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    pageCount: 1,
    pagesDone: 1,
    revisionCount: 1,
    machineAuditStatus: "findings",
  });
  const translationBase = {
    id: "p1-l0",
    source: "Помещение",
    pageNumber: 1,
    bbox: [10, 10, 40, 20],
  };
  await db.insert(cworksTranslationCheckpoints).values([
    {
      jobId: id,
      revisionCount: 0,
      pageNumber: 1,
      sourceHash: "same-source",
      translations: [{ ...translationBase, translation: "Room" }],
    },
    {
      jobId: id,
      revisionCount: 1,
      pageNumber: 1,
      sourceHash: "same-source",
      translations: [{ ...translationBase, translation: "Room designation" }],
    },
  ]);

  const restored = await request("POST", `/jobs/${id}/restore-previous-revision`, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.json.job.status, "revising");
  assert.equal(restored.json.job.revisionCount, 2);
  assert.equal(restored.json.job.approvedRevision, null);
  const events = await db.select().from(cworksTranslationReviewEvents)
    .where(eq(cworksTranslationReviewEvents.jobId, id));
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "restore_revision");
  assert.match(events[0].declaration, /no approval/i);
});

test("overlapping page review and approval serialize without releasing stale review state", async () => {
  const id = `cworks-review-test-concurrency-${run}`;
  jobIds.push(id);
  await db.insert(cworksTranslationJobs).values({
    id,
    title: `Concurrent qualified review ${run}`,
    status: "awaiting_review",
    originalFilename: "concurrent-review.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    outputStoredName: `cworks-translator/${id}/translated.pdf`,
    summaryStoredName: `cworks-translator/${id}/summary.md`,
    pageCount: 1,
    pagesDone: 1,
    machineAuditStatus: "passed",
  });
  await db.insert(cworksTranslationPages).values({
    jobId: id,
    pageNumber: 1,
    thumbnailStoredName: `cworks-translator/${id}/page-1.jpg`,
    sourceBlockCount: 1,
    translatedBlockCount: 1,
    machineAuditStatus: "passed",
    machineAuditFindings: [],
  });
  await db.insert(cworksTranslationPageReviews).values({
    jobId: id,
    revisionCount: 0,
    pageNumber: 1,
    checked: true,
    resolvedFindingIndexes: [],
    notes: "Initial valid review state.",
    reviewerSessionId: randomUUID(),
    checkedAt: new Date(),
  });

  let releaseLock!: () => void;
  const lockRelease = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let lockAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    lockAcquired = resolve;
  });
  const blocker = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    lockAcquired();
    await lockRelease;
  });
  await acquired;

  const pageChangePromise = request("PUT", `/jobs/${id}/pages/1/review`, {
    checked: false,
    resolvedFindingIndexes: [],
    notes: "Overlapping reviewer withdrew the page check.",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const approvalPromise = request("POST", `/jobs/${id}/feedback`, {
    decision: "approve",
    notes: "",
    reviewerName: "Concurrent Qualified Reviewer",
    reviewerQualification: "Chartered engineer and fluent source-language reviewer",
    declaration: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseLock();

  const [pageChange, approval] = await Promise.all([pageChangePromise, approvalPromise]);
  await blocker;
  assert.ok(
    (pageChange.status === 200 && approval.status === 409)
      || (pageChange.status === 409 && approval.status === 200),
    `expected one safe serialization order, got page ${pageChange.status} and approval ${approval.status}`,
  );

  const [job] = await db.select().from(cworksTranslationJobs)
    .where(eq(cworksTranslationJobs.id, id));
  const [persistedReview] = await db.select().from(cworksTranslationPageReviews)
    .where(and(
      eq(cworksTranslationPageReviews.jobId, id),
      eq(cworksTranslationPageReviews.revisionCount, 0),
      eq(cworksTranslationPageReviews.pageNumber, 1),
    ));
  const events = await db.select().from(cworksTranslationReviewEvents)
    .where(eq(cworksTranslationReviewEvents.jobId, id));

  if (approval.status === 200) {
    assert.equal(job.status, "done");
    assert.equal(pageChange.status, 409, "a page check cannot change after release");
    assert.equal(persistedReview.checked, true);
    assert.equal(persistedReview.notes, "Initial valid review state.");
    assert.equal(events.length, 1, "release must create exactly one immutable approval event");
    assert.deepEqual(events[0].pageReviewSnapshot, [{
      pageNumber: 1,
      checked: true,
      notes: "Initial valid review state.",
      machineAuditStatus: "passed",
      findingCount: 0,
      resolvedFindingIndexes: [],
      allFindingsResolved: true,
    }]);
  } else {
    assert.equal(approval.status, 409, "approval must reject the newly unchecked page");
    assert.equal(job.status, "awaiting_review");
    assert.equal(persistedReview.checked, false);
    assert.equal(persistedReview.notes, "Overlapping reviewer withdrew the page check.");
    assert.equal(events.length, 0, "a rejected stale approval must not create a release snapshot");
  }
});

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------

test("repeated wrong passwords on /auth/login get rate limited", async () => {
  let sawUnauthorized = false;
  let limitedAt: number | null = null;
  for (let attempt = 1; attempt <= 30; attempt++) {
    const res = await fetch(`${baseUrl}/api/cworks-translator/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: `wrong-${attempt}` }),
    });
    await res.arrayBuffer();
    if (res.status === 401) sawUnauthorized = true;
    if (res.status === 429) { limitedAt = attempt; break; }
    assert.ok([401, 429].includes(res.status), `unexpected status ${res.status} on attempt ${attempt}`);
  }
  assert.ok(sawUnauthorized, "wrong passwords must be rejected with 401 before the limit");
  assert.ok(limitedAt !== null, "repeated wrong passwords must eventually return 429");
});
