import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildNativeDxfTargetedCorrectionBrief,
  isNativeDxfTargetedCorrectionBrief,
  nativeDxfTargetedCorrectionTargetIds,
} from "./native-dxf-targeted-correction";

const checkpoint = {
  ledger: {
    entries: [{ targetId: "MTEXT:affected" }, { targetId: "MTEXT:unaffected" }],
    tableTargets: [{ targetId: "ACAD_TABLE:affected" }],
    unresolved: [{ targetId: "MTEXT:affected" }],
    blockingFindings: [
      { targetId: "MTEXT:affected" },
      { targetId: "UNRESOLVED_VISIBLE:cannot-patch" },
    ],
    independentAudit: {
      findings: [{ sourceBlockId: "ACAD_TABLE:affected" }],
      rawFindings: [{ sourceBlockId: "MTEXT:unaffected" }],
    },
  },
};

test("targeted DXF correction includes only evidence-affected immutable targets", () => {
  assert.deepEqual(
    nativeDxfTargetedCorrectionTargetIds(checkpoint, [[
      { sourceBlockId: "MTEXT:affected" },
      { sourceBlockId: "UNRESOLVED_VISIBLE:cannot-patch" },
    ]]),
    ["ACAD_TABLE:affected", "MTEXT:affected", "MTEXT:unaffected"],
  );
  const brief = buildNativeDxfTargetedCorrectionBrief({
    sourceRevision: 4,
    targetLanguage: "en",
    checkpoint,
  });
  assert.ok(brief);
  assert.equal(brief.consented, true);
  assert.equal(brief.correctionBudget, 1);
  assert.equal(isNativeDxfTargetedCorrectionBrief(brief), true);
  assert.equal(isNativeDxfTargetedCorrectionBrief({ ...brief, consented: false }), false);
  assert.equal(isNativeDxfTargetedCorrectionBrief({ ...brief, correctionBudget: 2 }), false);
});

test("targeted DXF correction refuses an empty or non-patchable evidence set", () => {
  assert.equal(buildNativeDxfTargetedCorrectionBrief({
    sourceRevision: 0,
    targetLanguage: "en",
    checkpoint: { ledger: { entries: [{ targetId: "MTEXT:A" }], unresolved: [] } },
  }), null);
  assert.equal(buildNativeDxfTargetedCorrectionBrief({
    sourceRevision: 0,
    targetLanguage: "fr",
    checkpoint,
  }), null);
});

test("targeted correction metadata is deterministic for append-only history", () => {
  const brief = buildNativeDxfTargetedCorrectionBrief({
    sourceRevision: 3,
    targetLanguage: "ja",
    checkpoint,
    requestedAt: "2026-01-02T03:04:05.000Z",
  });
  assert.ok(brief);
  assert.equal(
    createHash("sha256").update(JSON.stringify(brief)).digest("hex"),
    createHash("sha256").update(JSON.stringify({
      ...brief,
      targetIds: [...brief.targetIds].sort(),
    })).digest("hex"),
  );
});

test("targeted DXF correction requires valid request metadata", () => {
  const brief = buildNativeDxfTargetedCorrectionBrief({
    sourceRevision: 3,
    targetLanguage: "en",
    checkpoint,
    requestedAt: "2026-01-02T03:04:05.000Z",
  });
  assert.ok(brief);
  assert.equal(isNativeDxfTargetedCorrectionBrief({ ...brief, requestedAt: undefined }), false);
  assert.equal(isNativeDxfTargetedCorrectionBrief({ ...brief, requestedAt: "not-a-timestamp" }), false);
  assert.equal(
    isNativeDxfTargetedCorrectionBrief({ ...brief, requestedAt: "2026-01-02T03:04:05.000Z" }),
    true,
  );
  assert.equal(isNativeDxfTargetedCorrectionBrief({ ...brief, sourceRevision: -1 }), false);
});