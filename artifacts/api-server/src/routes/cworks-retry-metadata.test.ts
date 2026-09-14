import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  downloadAvailabilityForJob,
  downloadAvailabilityFromMetadata,
  retryRepairBriefForRequest,
  retryMetadataFromEvidence,
} from "./cworksTranslation";
import {
  NATIVE_DXF_RETRY_BRIEF_KIND,
  nativeDxfCheckpointMethodologyHash,
} from "../cworks-translator/worker";
import { NATIVE_DXF_CHECKPOINT_FORMAT } from "../cworks-translator/native-dxf-checkpoints";
import { NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND } from "../cworks-translator/native-dxf-targeted-correction";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "retry-metadata-test",
    status: "failed",
    sourceFormat: "dxf",
    sourceStoredName: "source.dxf",
    revisionCount: 2,
    targetLanguage: "en",
    approvedRevision: null,
    approvedAt: null,
    ...overrides,
  } as any;
}

function nativeCheckpoint(overrides: Record<string, unknown> = {}) {
  const sourceSha256 = sha256("source");
  return {
    format: NATIVE_DXF_CHECKPOINT_FORMAT,
    sourceSha256,
    sourceRevision: 2,
    revisionCount: 2,
    targetLanguage: "en",
    methodologyHash: nativeDxfCheckpointMethodologyHash("en"),
    placementManifestSha256: sha256("placement"),
    stage: "pre_patch",
    completedBatchCount: 1,
    translations: { "MTEXT:A": "Note" },
    ...overrides,
  };
}

test("retry metadata compares native DXF checkpoints to the current policy", () => {
  const current = retryMetadataFromEvidence(
    job(),
    [{ translations: nativeCheckpoint(), updatedAt: new Date() }],
    sha256("source"),
  );
  assert.equal(current.resumeAvailable, true);
  assert.equal(current.resumeEligibility, "provisional");
  assert.match(current.resumeReason, /Provisional/i);
  assert.match(current.resumeValidationNote, /placement manifest/i);

  // The route has no current inspected manifest. A different durable
  // checkpoint binding remains provisional rather than being compared to
  // itself and mislabeled as exact eligibility.
  const differentSavedManifest = retryMetadataFromEvidence(
    job(),
    [{
      translations: nativeCheckpoint({ placementManifestSha256: sha256("different-placement") }),
      updatedAt: new Date(),
    }],
    sha256("source"),
  );
  assert.equal(differentSavedManifest.resumeAvailable, true);
  assert.equal(differentSavedManifest.resumeEligibility, "provisional");

  const staleMethodology = retryMetadataFromEvidence(
    job(),
    [{ translations: nativeCheckpoint({ methodologyHash: sha256("old-policy") }), updatedAt: new Date() }],
    sha256("source"),
  );
  assert.equal(staleMethodology.resumeAvailable, false);
  assert.match(staleMethodology.resumeReason, /methodology/i);
});

test("retry metadata is fail-closed when the DXF source binding is unavailable", () => {
  const result = retryMetadataFromEvidence(
    job(),
    [{ translations: nativeCheckpoint(), updatedAt: new Date() }],
  );
  assert.equal(result.resumeAvailable, false);
  assert.match(result.resumeReason, /source DXF is unavailable/i);
});

test("download availability uses object presence and release status without reading bodies", () => {
  const awaiting = downloadAvailabilityFromMetadata(job({ status: "awaiting_review" }), {
    original: true,
    output: true,
    summary: true,
    ledger: true,
    preservationReport: true,
  });
  assert.deepEqual(awaiting, {
    original: true,
    output: true,
    summary: true,
    ledger: true,
    preservationReport: true,
    tableScript: true,
    draftDxf: true,
  });

  const unreleased = downloadAvailabilityFromMetadata(job({ status: "done" }), {
    original: true,
    output: true,
    summary: true,
    ledger: true,
    preservationReport: true,
  });
  assert.equal(unreleased.output, false);
  assert.equal(unreleased.ledger, false);

  const released = downloadAvailabilityFromMetadata(job({
    status: "done",
    approvedRevision: 2,
    approvedAt: new Date(),
  }), {
    original: true,
    output: true,
    summary: true,
    ledger: true,
    preservationReport: true,
  });
  assert.equal(released.output, true);
  assert.equal(released.tableScript, true);
});

test("PDF availability does not expose DXF evidence buttons", () => {
  const result = downloadAvailabilityFromMetadata(job({
    sourceFormat: "pdf",
    status: "awaiting_review",
  }), {
    original: true,
    output: true,
    summary: true,
    ledger: true,
    preservationReport: true,
  });
  assert.equal(result.original, true);
  assert.equal(result.summary, true);
  assert.equal(result.ledger, false);
  assert.equal(result.tableScript, false);
  assert.equal(result.draftDxf, false);
});

test("download availability accepts a metadata/HEAD stub and never asks for object bytes", async () => {
  const requested: Array<string | null> = [];
  const result = await downloadAvailabilityForJob(job({
    status: "awaiting_review",
    outputStoredName: "output.dxf",
    summaryStoredName: "summary.md",
    ledgerStoredName: "ledger.json",
    preservationStoredName: "preservation.json",
  }), async (storedName) => {
    requested.push(storedName);
    return storedName ? { size: 47_000_000 } : null;
  });
  assert.deepEqual(new Set(requested), new Set([
    "source.dxf",
    "output.dxf",
    "summary.md",
    "ledger.json",
    "preservation.json",
  ]));
  assert.equal(result.draftDxf, true);
});

test("queued native DXF resume persists an explicit revision-bound intent", () => {
  const brief = retryRepairBriefForRequest(job({ revisionCount: 7 }), "resume") as any;
  assert.deepEqual(brief, {
    kind: NATIVE_DXF_RETRY_BRIEF_KIND,
    mode: "resume",
    sourceRevision: 7,
    targetLanguage: "en",
    provisionalPlacementValidation: true,
  });
  const cleared = retryRepairBriefForRequest(job({
    revisionCount: 7,
    repairBrief: brief,
  }), "full_restart");
  assert.equal(cleared, null);
});

test("a failed targeted DXF successor preserves its immutable correction brief on resume", () => {
  const targetedBrief = {
    kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND,
    sourceRevision: 4,
    targetLanguage: "en",
    consented: true,
    correctionBudget: 1,
    targetIds: ["MTEXT:7"],
    requestedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(
    retryRepairBriefForRequest(job({ revisionCount: 5, repairBrief: targetedBrief }), "resume"),
    targetedBrief,
  );
  assert.equal(
    retryRepairBriefForRequest(job({ revisionCount: 5, repairBrief: targetedBrief }), "full_restart"),
    null,
  );
});