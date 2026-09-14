import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildNativeDxfCheckpoint,
  isNativeDxfCheckpointResumeEligible,
  nativeDxfCheckpointResumeEligibility,
  nativeDxfMethodologyHash,
  type NativeDxfCheckpointBinding,
} from "./native-dxf-checkpoints";

const sourceSha256 = createHash("sha256").update("source.dxf").digest("hex");
const binding: NativeDxfCheckpointBinding = {
  sourceSha256,
  revisionCount: 3,
  targetLanguage: "en",
  methodologyHash: nativeDxfMethodologyHash({
    translationMethodologyVersion: 12,
    auditMethodologyVersion: 1,
    translationGlossary: "glossary-v1",
    auditPolicy: "audit-v1",
  }),
  placementManifestSha256: "placement-manifest",
};

function checkpoint() {
  return buildNativeDxfCheckpoint(binding, {
    stage: "pre_patch",
    completedBatchCount: 2,
    translations: { "MTEXT:A": "Roof plan" },
    audit: {
      pageNumber: 1,
      status: "passed",
      model: "stub-auditor",
      findings: [],
    },
    auditIndex: 0,
    correctionDiagnostics: [],
    ledger: {},
  });
}

test("native DXF checkpoint eligibility requires every evidence binding", () => {
  const saved = checkpoint();
  assert.equal(isNativeDxfCheckpointResumeEligible(saved, binding), true);
  assert.deepEqual(nativeDxfCheckpointResumeEligibility(saved, binding), {
    eligible: true,
    reason: "eligible",
    stage: "pre_patch",
  });

  for (const [field, value, reason] of [
    ["sourceSha256", createHash("sha256").update("other-source").digest("hex"), "source_mismatch"],
    ["revisionCount", 4, "revision_mismatch"],
    ["targetLanguage", "ja", "language_mismatch"],
    ["methodologyHash", "other-methodology", "methodology_mismatch"],
    ["placementManifestSha256", "other-manifest", "placement_manifest_mismatch"],
  ] as const) {
    const changed = { ...saved, [field]: value };
    assert.equal(
      nativeDxfCheckpointResumeEligibility(changed, binding).reason,
      reason,
      `changed ${field} must not resume`,
    );
    assert.equal(isNativeDxfCheckpointResumeEligible(changed, binding), false);
  }
});

test("native DXF checkpoint rejects malformed or legacy rows fail-closed", () => {
  assert.equal(
    nativeDxfCheckpointResumeEligibility(["not", "a", "native", "checkpoint"], binding).reason,
    "malformed",
  );
  assert.equal(
    nativeDxfCheckpointResumeEligibility({
      ...checkpoint(),
      format: "cworks-native-dxf-ledger-v1",
    }, binding).reason,
    "format_mismatch",
  );
  assert.equal(
    nativeDxfCheckpointResumeEligibility({
      ...checkpoint(),
      translations: { "MTEXT:A": "" },
    }, binding).reason,
    "malformed",
  );
});