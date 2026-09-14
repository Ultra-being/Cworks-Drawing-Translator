import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createSchema,
  validateNativeDxfApprovalEvidence,
  validateNativeDxfTableScriptLedger,
} from "../routes/cworksTranslation";
import {
  buildNativeDxfTableScript,
  cworksTargetLanguagePromptRequirement,
  isCworksTargetLanguageText,
  isNativeDxfTargetLanguageText,
} from "./worker";

test("job target language defaults to English and rejects unsupported values", () => {
  const base = {
    title: "Drawing",
    sourceLanguage: "ru",
    scope: "full",
    drawingDepth: "major-text",
  };
  assert.equal(createSchema.parse(base).targetLanguage, "en");
  assert.equal(createSchema.parse({ ...base, targetLanguage: "ja" }).targetLanguage, "ja");
  assert.throws(() => createSchema.parse({ ...base, targetLanguage: "fr" }));
});

test("target-language script gate rejects English-only Japanese output", () => {
  assert.equal(isCworksTargetLanguageText("機械室", "ja"), true);
  assert.equal(isCworksTargetLanguageText("Room", "ja"), false);
  assert.equal(isCworksTargetLanguageText("Room", "en"), true);
  assert.equal(isCworksTargetLanguageText("機械室", "en"), false);
  assert.equal(isNativeDxfTargetLanguageText("Помещение", "部屋", "en"), false);
  assert.equal(isNativeDxfTargetLanguageText("Помещение", "Room", "en"), true);
  assert.equal(
    isNativeDxfTargetLanguageText("не менее 3-Вр-1", "3-Вр-1以上", "ja"),
    true,
  );
});

test("translation prompt requirement explicitly binds the selected language", () => {
  assert.match(cworksTargetLanguagePromptRequirement("ja"), /Japanese script/);
  assert.match(cworksTargetLanguagePromptRequirement("ja"), /not an English-only/);
  assert.equal(
    cworksTargetLanguagePromptRequirement("en"),
    "Every human-language replacement must be written in English.",
  );
});

test("table-script validation mirrors source-occurrence manifest deduplication", () => {
  const source = "Экспликация";
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const targets = [{
    targetId: `ACAD_TABLE:A:${sourceSha256}`,
    tableHandle: "a",
    sourceOrdinal: 0,
    sourceOccurrenceCount: 2,
    source,
    translation: "Schedule",
  }, {
    targetId: `ACAD_TABLE:A:duplicate:${sourceSha256}`,
    tableHandle: "A",
    sourceOrdinal: 1,
    sourceOccurrenceCount: 1,
    source,
    translation: "Schedule",
  }];
  const tableScript = buildNativeDxfTableScript(targets);
  const ledgerTargets = targets.map((target) => ({
    ...target,
    sourceSha256,
    accounting: "translated_pending_table_script",
  }));
  const validated = validateNativeDxfTableScriptLedger({
    tableTargets: ledgerTargets,
    tableScript,
  }, "en");
  assert.equal(validated?.targetCount, 1);
  assert.equal(validated?.expectedAppliedCount, 3);
  assert.throws(
    () => validateNativeDxfTableScriptLedger({
      tableTargets: ledgerTargets.map((target, index) =>
        index ? { ...target, translation: "Conflicting" } : target),
      tableScript,
    }, "en"),
    /DXF_TABLE_SCRIPT_INVALID/,
  );
});

test("Japanese table-script manifest accepts Unicode replacements and rejects English-only evidence", () => {
  const source = "Таблица";
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const japaneseTarget = {
    targetId: `ACAD_TABLE:AB:0:${sourceSha256}`,
    tableHandle: "AB",
    sourceOrdinal: 0,
    sourceOccurrenceCount: 2,
    source,
    sourceSha256,
    translation: "表",
    replacement: "表",
    accounting: "translated_pending_table_script",
  };
  const tableScript = buildNativeDxfTableScript([japaneseTarget]);
  const validated = validateNativeDxfTableScriptLedger({
    targetLanguage: "ja",
    tableTargets: [japaneseTarget],
    tableScript,
  }, "ja");
  assert.equal(validated?.targetCount, 1);
  assert.equal(validated?.expectedAppliedCount, 2);

  const englishTarget = {
    ...japaneseTarget,
    translation: "Table",
    replacement: "Table",
  };
  assert.throws(
    () => validateNativeDxfTableScriptLedger({
      targetLanguage: "ja",
      tableTargets: [englishTarget],
      tableScript: buildNativeDxfTableScript([englishTarget]),
    }, "ja"),
    /DXF_TABLE_SCRIPT_INVALID/,
  );
});

test("native DXF approval evidence is bound to the selected target in both directions", () => {
  const source = Buffer.from("source");
  const output = Buffer.from("output");
  const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const placementManifestSha256 = sha256(Buffer.from("placement-manifest"));
  const tableScript = buildNativeDxfTableScript([]);
  const patch = {
    format: "dxf-surgical-patch-v1",
    targetLanguage: "ja",
    sourceSha256: sha256(source),
    outputSha256: sha256(output),
    approvedChanges: [{ handle: "T1" }],
    accountedMtextCount: 1,
    placementManifestSha256,
    placementCount: 1,
    unresolved: [],
    unchangedEntityPropertiesVerified: true,
    metadataIdentical: true,
    nonTextRecordsIdentical: true,
    reparsedCleanly: true,
    lineEndingPreserved: true,
    nonApprovedSegmentsIdentical: true,
  };
  const report = Buffer.from(JSON.stringify({
    format: "cworks-dxf-preservation-v1",
    targetLanguage: "ja",
    sourceSha256: sha256(source),
    placementManifestSha256,
    placementCount: 1,
    preserved: [],
    patch,
  }));
  const ledger = Buffer.from(JSON.stringify({
    format: "cworks-native-dxf-ledger-v1",
    targetLanguage: "ja",
    sourceSha256: sha256(source),
    placementManifestSha256,
    placementCount: 1,
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
    entries: [{
      handle: "T1",
      plain: "Помещение",
      isCyrillicTarget: true,
      replacement: "部屋",
      accounting: "translated_and_patched",
      preservationReason: null,
      placementCount: 1,
      placements: [{
        placementId: "T1:direct",
        x: 0,
        y: 0,
        insertPath: [],
      }],
    }],
    unresolved: [],
    blockingFindings: [],
    patch,
  }));
  assert.throws(
    () => validateNativeDxfApprovalEvidence(report, ledger, source, output, "en"),
    /DXF_APPROVAL_EVIDENCE_INVALID/,
  );
  const malformedReport = Buffer.from(JSON.stringify({
    ...JSON.parse(report.toString("utf8")),
    targetLanguage: "fr",
  }));
  assert.throws(
    () => validateNativeDxfApprovalEvidence(
      malformedReport,
      ledger,
      source,
      output,
      "en",
    ),
    /DXF_APPROVAL_EVIDENCE_INVALID/,
  );
  assert.doesNotThrow(
    () => validateNativeDxfApprovalEvidence(report, ledger, source, output, "ja"),
  );
  const legacyLedger = JSON.parse(ledger.toString("utf8"));
  delete legacyLedger.tableTargets;
  delete legacyLedger.tableScript;
  delete legacyLedger.scriptAccounting;
  assert.doesNotThrow(
    () => validateNativeDxfApprovalEvidence(
      report,
      Buffer.from(JSON.stringify(legacyLedger)),
      source,
      output,
      "ja",
    ),
  );
  const mismatchedPlacementLedger = Buffer.from(JSON.stringify({
    ...JSON.parse(ledger.toString("utf8")),
    placementCount: 2,
  }));
  assert.throws(
    () => validateNativeDxfApprovalEvidence(
      report,
      mismatchedPlacementLedger,
      source,
      output,
      "ja",
    ),
    /DXF_APPROVAL_EVIDENCE_INVALID/,
  );
  const validLedger = JSON.parse(ledger.toString("utf8"));
  for (const hybridCoverage of [
    { pendingTableTargetCount: 1, pendingTableCellCount: 2 },
    { unresolvedVisibleTextCount: 1 },
    { opaqueReviewRequired: true },
    { unplacedTargetCount: 1 },
  ]) {
    assert.throws(() => validateNativeDxfApprovalEvidence(
      report,
      Buffer.from(JSON.stringify({ ...validLedger, hybridCoverage })),
      source,
      output,
      "ja",
    ), /DXF_APPROVAL_EVIDENCE_INVALID/, "pending CAD work must not authorize the clean source");
  }
  const tamperedTableScript = Buffer.from(JSON.stringify({
    ...validLedger,
    tableScript: {
      ...validLedger.tableScript,
      script: `${validLedger.tableScript.script}\n(princ \"tampered\")`,
    },
  }));
  assert.throws(
    () => validateNativeDxfApprovalEvidence(
      report,
      tamperedTableScript,
      source,
      output,
      "ja",
    ),
    /DXF_APPROVAL_EVIDENCE_INVALID/,
  );
  const mismatchedTableCount = Buffer.from(JSON.stringify({
    ...validLedger,
    tableScript: { ...validLedger.tableScript, targetCount: 1 },
  }));
  assert.throws(
    () => validateNativeDxfApprovalEvidence(
      report,
      mismatchedTableCount,
      source,
      output,
      "ja",
    ),
    /DXF_APPROVAL_EVIDENCE_INVALID/,
  );
});