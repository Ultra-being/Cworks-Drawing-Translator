import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { cworksTranslationCheckpoints, cworksTranslationJobs } from "@workspace/db/schema";
import {
  applyNativeDxfContextPairGlossary,
  applyNativeDxfExactGlossary,
  applyNativeDxfSplitGlossary,
  assertCworksManualTouchupRenderBinding,
  buildCworksAuditLedger,
  buildCworksManualTouchupRenderFingerprint,
  buildNativeDxfAuditPayload,
  buildNativeDxfAuditPayloadChunks,
  buildNativeDxfTableScript,
  CworksProviderError,
  dedupeNativeDxfTableTargets,
  describeNativeDxfProcessorFailure,
  claimNextJob,
  fitAwareDrawingTranslation,
  getCworksTranslationReadiness,
  hasUnsettledCworksProviderRequest,
  isCworksCoverageSeverelyIncomplete,
  nativeDxfEmbeddedTechnicalIdentifierReason,
  nativeDxfCheckpointMethodologyHash,
  nativeDxfReplacementPreservesPlaceholder,
  NATIVE_DXF_AUDIT_POLICY,
  NATIVE_DXF_TRANSLATION_GLOSSARY,
  parseCworksMachineAudit,
  parseNativeDxfTranslationRowsWithRepair,
  requestNativeDxfTranslationRowsWithBoundedSubdivision,
  recoverSuspiciousBlocks,
  readOptionalNativeDxfPriorLedger,
  removeNativeDxfPreservedTranslations,
  requireRecoverableCworksText,
  requestCworksProviderWithRetry,
  reusableNativeDxfTranslations,
  shouldTranslate,
  summarizeCworksCoverage,
  synchronizeNativeDxfLedgerEntries,
  synchronizeNativeDxfDimensionCacheTranslations,
  type CworksPage,
  translateBlocks,
} from "./worker";

test("native DXF subprocess diagnostics distinguish timeout and redacted invariant rejection", () => {
  const timeout = describeNativeDxfProcessorFailure(
    Object.assign(new Error("private source path"), {
      code: "ETIMEDOUT",
      killed: true,
      signal: "SIGTERM",
      stderr: "/private/customer/source.dxf",
    }),
    "job-1",
    "patch",
  );
  assert.equal(timeout.reason, "timeout");
  assert.equal(timeout.timedOut, true);
  assert.equal(JSON.stringify(timeout).includes("private/customer"), false);

  const invariant = describeNativeDxfProcessorFailure(
    Object.assign(new Error("rejected"), {
      code: 2,
      stderr: JSON.stringify({
        kind: "native_dxf_rejected",
        reason: "post_patch_preservation_invariant",
        privateText: "must never be logged",
      }),
    }),
    "job-2",
    "patch",
  );
  assert.equal(invariant.reason, "post_patch_preservation_invariant");
  assert.equal(invariant.deterministic, true);
  assert.equal(JSON.stringify(invariant).includes("must never be logged"), false);
});

test("native DXF table script is deterministic, source-verified, and memory-only", () => {
  const targets = [{
    targetId: "ACAD_TABLE:AB:1:0",
    tableHandle: "ab",
    sourceOrdinal: 0,
    source: "Примечание",
    translation: "Note",
  }, {
    targetId: "ACAD_TABLE:CD:1:1",
    tableHandle: "CD",
    sourceOrdinal: 1,
    source: "Этаж",
    translation: "Floor",
  }];
  const first = buildNativeDxfTableScript(targets);
  const second = buildNativeDxfTableScript([...targets].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.targetCount, 2);
  assert.equal(first.expectedAppliedCount, 2);
  assert.match(first.script, /handent/);
  assert.match(first.script, /vlax-ename->vla-object/);
  assert.match(first.script, /vla-get-ObjectName/);
  assert.match(first.script, /AcDbTable/);
  assert.match(first.script, /vla-GetText/);
  assert.match(first.script, /vla-SetText/);
  assert.match(first.script, /\(vla-GetHasFormula table rowIndex columnIndex 0\)/);
  assert.match(first.script, /\(vla-GetContentType table rowIndex columnIndex\)/);
  assert.match(first.script, /\(vla-IsContentEditable table rowIndex columnIndex\)/);
  assert.match(first.script, /matchedTargets=.*appliedCells=.*skippedTargets=.*errors=/);
  assert.match(first.script, new RegExp(`CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=${first.manifestSha256}`));
  assert.match(first.script, new RegExp(`CWORKS_APPLY_TABLE_TRANSLATIONS_END manifestSha256=${first.manifestSha256}`));
  assert.doesNotMatch(first.script, /entmod|qsave|saveas|save/iu);
  assert.doesNotMatch(first.script, /\(\s*command\b/iu);
  assert.equal(
    createHash("sha256").update(first.script).digest("hex"),
    first.sha256,
  );
});

test("native DXF malformed translation JSON gets one bounded, target-bound repair", async () => {
  const allowed = new Set(["MTEXT:A", "ACAD_TABLE:B"]);
  let repairCalls = 0;
  const rows = await parseNativeDxfTranslationRowsWithRepair(
    "not valid json",
    allowed,
    async (malformedResponse) => {
      repairCalls++;
      assert.equal(malformedResponse, "not valid json");
      return "```json\n" + JSON.stringify({
        translations: [{
          targetId: "MTEXT:A",
          translation: "  Roof plan  ",
        }, {
          targetId: "ACAD_TABLE:B",
          translation: "   ",
        }, {
          targetId: "MTEXT:UNKNOWN",
          translation: "Invented",
        }],
      }) + "\n```";
    },
  );
  assert.equal(repairCalls, 1);
  assert.deepEqual(rows, [{
    targetId: "MTEXT:A",
    translation: "Roof plan",
  }]);

  let secondRepairCalls = 0;
  await assert.rejects(() => parseNativeDxfTranslationRowsWithRepair(
    "{",
    allowed,
    async () => {
      secondRepairCalls++;
      return "still not valid json";
    },
  ));
  assert.equal(secondRepairCalls, 1);
});

test("native DXF malformed translation batch subdivides original targets once and saves each sibling", async () => {
  const batch = ["A", "B", "C", "D"].map((targetId) => ({
    targetId,
    plainText: `Источник ${targetId}`,
  }));
  const requestIds: string[][] = [];
  const repairInputs: Array<{ ids: string[]; source: string[]; malformed: string }> = [];
  const persisted: Array<{ ids: string[]; complete: boolean }> = [];
  const rows = await requestNativeDxfTranslationRowsWithBoundedSubdivision(
    batch,
    async (candidate) => {
      requestIds.push(candidate.map((item) => item.targetId));
      if (candidate.length === 4) return "not valid json";
      return JSON.stringify({
        translations: candidate.map((item) => ({
          targetId: item.targetId,
          translation: `Translation ${item.targetId}`,
        })),
      });
    },
    async (candidate, allowedTargetIds, malformedResponse) => {
      repairInputs.push({
        ids: [...allowedTargetIds],
        source: candidate.map((item) => item.plainText),
        malformed: malformedResponse,
      });
      return "still not valid json";
    },
    (candidate) => [candidate.slice(0, 2), candidate.slice(2)],
    async (subRows, complete) => {
      persisted.push({
        ids: subRows.map((row) => row.targetId),
        complete,
      });
    },
  );
  assert.deepEqual(requestIds, [["A", "B", "C", "D"], ["A", "B"], ["C", "D"]]);
  assert.deepEqual(repairInputs, [{
    ids: ["A", "B", "C", "D"],
    source: ["Источник A", "Источник B", "Источник C", "Источник D"],
    malformed: "not valid json",
  }]);
  assert.deepEqual(persisted, [
    { ids: ["A", "B"], complete: false },
    { ids: ["C", "D"], complete: true },
  ]);
  assert.deepEqual(rows.map((row) => row.targetId), ["A", "B", "C", "D"]);
});

test("native DXF table transport uses short wire keys and maps exact rows back to immutable IDs", async () => {
  const immutableIds = [
    "ACAD_TABLE:82AD36:1:0e512f4e0908f461be33ad3de362a738e9cb152d694c163136b6eaf324e49657",
    "ACAD_TABLE:82AD36:1:cc38fb24c20d181c77a0ed6f7c603ba3310ffe4e5eaa08b85ea3897c97aef1c6",
  ];
  const batch = immutableIds.map((targetId, index) => ({
    targetId,
    plainText: index ? "Экспликация помещений" : "Ведомость перемычек",
  }));
  let suppliedWireIds: string[] = [];
  const rows = await requestNativeDxfTranslationRowsWithBoundedSubdivision(
    batch,
    async (_candidate, allowedWireIds) => {
      suppliedWireIds = [...allowedWireIds];
      assert.deepEqual(suppliedWireIds, ["t1", "t2"]);
      assert.ok(suppliedWireIds.every((id) => id.length < immutableIds[0].length));
      return JSON.stringify({
        translations: [
          { targetId: "t1", translation: "Lintel Sched." },
          { targetId: "t2", translation: "Room Sched." },
        ],
      });
    },
    async () => {
      throw new Error("a complete exact wire response must not be repaired");
    },
    (candidate) => [candidate.slice(0, 1), candidate.slice(1)],
    undefined,
    (candidate) => new Map(candidate.map((item, index) => [item.targetId, `t${index + 1}`])),
  );
  assert.deepEqual(rows, [
    { targetId: immutableIds[0], translation: "Lintel Sched." },
    { targetId: immutableIds[1], translation: "Room Sched." },
  ]);
});

test("native DXF correction transport rejects bad, duplicate, and missing short wire rows", async () => {
  const allowed = new Set(["t1", "t2"]);
  const invalidResponses = [
    JSON.stringify({
      translations: [
        { targetId: "t1", translation: "First" },
        { targetId: "MTEXT:IMMUTABLE", translation: "Second" },
      ],
    }),
    JSON.stringify({
      translations: [
        { targetId: "t1", translation: "First" },
        { targetId: "t1", translation: "Second" },
      ],
    }),
    JSON.stringify({
      translations: [{ targetId: "t1", translation: "First" }],
    }),
  ];
  for (const response of invalidResponses) {
    let repairCalls = 0;
    await assert.rejects(() => parseNativeDxfTranslationRowsWithRepair(
      response,
      allowed,
      async () => {
        repairCalls++;
        return response;
      },
      true,
    ));
    assert.equal(repairCalls, 1);
  }
});

test("native DXF table script counts every exact source occurrence", () => {
  const script = buildNativeDxfTableScript([{
    targetId: "ACAD_TABLE:AB:1:0",
    tableHandle: "AB",
    sourceOrdinal: 0,
    sourceOccurrenceCount: 2,
    source: "Этаж",
    translation: "Floor",
  }, {
    targetId: "ACAD_TABLE:AB:1:2",
    tableHandle: "ab",
    sourceOrdinal: 2,
    source: "Этаж",
    translation: "Floor",
  }]);
  assert.equal(script.targetCount, 1);
  assert.equal(script.expectedAppliedCount, 3);
  assert.match(script.script, /\(= cellText source\)/);
});

test("native DXF table inventory dedupe sums processor occurrence counts", () => {
  const targets = dedupeNativeDxfTableTargets([{
    targetId: "ACAD_TABLE:AB:1:0",
    tableHandle: "ab",
    sourceText: "Этаж",
    sourceOccurrenceCount: 3,
  }, {
    targetId: "ACAD_TABLE:AB:1:4",
    tableHandle: "AB",
    sourceText: "Этаж",
    sourceOccurrenceCount: 2,
  }]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sourceOccurrenceCount, 5);
  const script = buildNativeDxfTableScript(targets.map((target) => ({
    ...target,
    sourceOrdinal: 0,
    source: target.sourceText,
    translation: "Floor",
  })));
  assert.equal(script.expectedAppliedCount, 5);
});

test("native DXF table script preflights safety and has balanced syntax", () => {
  const script = buildNativeDxfTableScript([{
    targetId: "ACAD_TABLE:AB:1:0",
    tableHandle: "AB",
    sourceOrdinal: 0,
    sourceOccurrenceCount: 2,
    source: "Этаж",
    translation: "Floor",
  }]).script;
  for (const token of [
    "vla-GetCellType", "vla-GetFieldId", "vla-GetHasFormula",
    "vla-IsMergedCell", "%<", "countMismatch", "unsafeCells",
    "partialErrors", "LISPSYS", "vlax-get-acad-object", ".DWG",
  ]) assert.ok(script.includes(token), `missing ${token}`);
  assert.ok(script.indexOf("vla-GetCellType") < script.indexOf("'vla-SetText"));
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of script) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = quoted;
    } else if (character === "\"") {
      quoted = !quoted;
    } else if (!quoted && character === "(") {
      depth++;
    } else if (!quoted && character === ")") {
      depth--;
      assert.ok(depth >= 0, "closing parenthesis precedes its opening parenthesis");
    }
  }
  assert.equal(quoted, false);
  assert.equal(depth, 0);
  assert.doesNotMatch(script, /entmod|qsave|saveas|save/iu);
});

test("dimension override translations are authoritative for bound caches", () => {
  const translations = new Map([
    ["DIMENSION:A", "<> mm"],
    ["MTEXT:CACHE", "divergent"],
  ]);
  synchronizeNativeDxfDimensionCacheTranslations([{
    dimensionTargetId: "DIMENSION:A",
    cacheTargetId: "MTEXT:CACHE",
  }], translations);
  assert.equal(translations.get("MTEXT:CACHE"), "<> mm");
  translations.delete("DIMENSION:A");
  synchronizeNativeDxfDimensionCacheTranslations([{
    dimensionTargetId: "DIMENSION:A",
    cacheTargetId: "MTEXT:CACHE",
  }], translations);
  assert.equal(translations.has("MTEXT:CACHE"), false);
});

test("native DXF dimension placeholders cannot silently disappear", () => {
  assert.equal(nativeDxfReplacementPreservesPlaceholder("<> мм", "<> mm"), true);
  assert.equal(nativeDxfReplacementPreservesPlaceholder("<> мм", "10 mm"), false);
  assert.equal(nativeDxfReplacementPreservesPlaceholder("Высота", "Height"), true);
});

test("native DXF targetId keys keep same-handle entity targets distinct", () => {
  const translations = new Map<string, string>();
  applyNativeDxfExactGlossary([{
    targetId: "TEXT:A",
    handle: "A",
    plain: "Номер",
  }, {
    targetId: "MTEXT:A",
    handle: "A",
    plain: "Кат.",
  }], translations);
  assert.deepEqual([...translations], [
    ["TEXT:A", "No."],
    ["MTEXT:A", "Cat."],
  ]);
});

test("native DXF exact glossary applies only to the exact source entry", () => {
  const translations = new Map([
    ["TITLE", "Arch. Solutions"],
    ["NUMBER", "Number"],
    ["CATEGORY", "Category"],
    ["COMPANY", "Joint-stock company"],
    ["RECONSTRUCTION", "Existing reconstruction"],
    ["ADDRESS", "Existing address"],
    ["MASONRY", "Existing masonry"],
    ["LINTELS", "Existing lintels"],
    ["SECTION", "Existing section"],
    ["ROOMS", "Existing rooms"],
    ["LINTELS_NEAR", "Existing near lintels"],
    ["OTHER", "Existing translation"],
    ["NO_HANDLE", "Untouched"],
  ]);
  applyNativeDxfExactGlossary([
    { handle: "TITLE", plain: "Архитектурные решения" },
    { handle: "NUMBER", plain: "Номер" },
    { handle: "CATEGORY", plain: "Кат." },
    { handle: "COMPANY", plain: "АО", maxCharacters: 2 },
    { handle: "RECONSTRUCTION", plain: "Реконструкция дома расположенного в Японии" },
    { handle: "ADDRESS", plain: "по адресу: Шинагава-ку, Хигаси Готанда 3-9-13" },
    { handle: "MASONRY", plain: "Кладочный план 3-го" },
    { handle: "LINTELS", plain: "Ведомость перемычек" },
    { handle: "SECTION", plain: "Схема сечения" },
    { handle: "ROOMS", plain: "Экспликация помещений" },
    { handle: "LINTELS_NEAR", plain: "Ведомость перемычек и деталей" },
    { handle: "OTHER", plain: "Архитектурные решения проекта" },
    { plain: "Архитектурные решения" },
  ], translations);
  assert.equal(translations.get("TITLE"), "Arch. Design");
  assert.equal(translations.get("NUMBER"), "No.");
  assert.equal(translations.get("CATEGORY"), "Cat.");
  assert.equal(translations.get("COMPANY"), "JSC");
  assert.equal(translations.get("RECONSTRUCTION"), "House Reconst., Japan");
  assert.equal(translations.get("ADDRESS"), "Addr.: Shinagawa-ku, H. Gotanda 3-9-13");
  assert.equal(translations.get("MASONRY"), "3F Masonry Plan");
  assert.equal(translations.get("LINTELS"), "Lintel Sched.");
  assert.equal(translations.get("SECTION"), "Section");
  assert.equal(translations.get("ROOMS"), "Room Sched.");
  assert.equal(translations.get("LINTELS_NEAR"), "Existing near lintels");
  assert.equal(translations.get("OTHER"), "Existing translation");
  assert.equal(translations.get("NO_HANDLE"), "Untouched");
  assert.equal(translations.size, 13, "an exact phrase without a handle must not create a translation");
});

test("native DXF exact mixed phrase preserves its technical designation", () => {
  const translations = new Map<string, string>();
  applyNativeDxfExactGlossary([
    { handle: "MIXED", plain: "не менее 3-Вр-1" },
    { handle: "NEAR_MATCH", plain: "не более 3-Вр-1" },
  ], translations);
  assert.equal(translations.get("MIXED"), "min 3-Вр-1");
  assert.equal(translations.has("NEAR_MATCH"), false);
});

test("native DXF ledger names an exact embedded technical identifier", () => {
  const entries = [{
    handle: "MIXED",
    plain: "не менее 3-Вр-1",
    isCyrillicTarget: true,
    preservationReason: null,
  }];
  synchronizeNativeDxfLedgerEntries(
    entries,
    new Map([["MIXED", "min 3-Вр-1"]]),
    new Set(),
  );
  assert.equal(entries[0].accounting, "translated_pending_patch");
  assert.match(entries[0].preservationReason || "", /3-Вр-1/);
  entries[0].accounting = "translated_and_patched";
  assert.equal(entries[0].accounting, "translated_and_patched");
  assert.match(entries[0].preservationReason || "", /surrounding prose is translated/);
});

test("embedded technical identifier reason requires translated surrounding prose", () => {
  assert.equal(
    nativeDxfEmbeddedTechnicalIdentifierReason(
      "не менее 3-Вр-1",
      "не менее 3-Вр-1",
    ),
    null,
  );
  assert.equal(
    nativeDxfEmbeddedTechnicalIdentifierReason(
      "не менее 3-Вр-1",
      "min 3-Vr-1",
    ),
    null,
  );
});

test("embedded technical identifier reason accepts Japanese prose around an exact drawing code", () => {
  const reason = nativeDxfEmbeddedTechnicalIdentifierReason(
    "не менее 3-Вр-1",
    "3-Вр-1以上",
    "ja",
  );
  assert.match(reason || "", /3-Вр-1/);
  assert.equal(
    nativeDxfEmbeddedTechnicalIdentifierReason(
      "не менее 3-Вр-1",
      "minimum 3-Вр-1",
      "ja",
    ),
    null,
  );
});

test("embedded technical identifier reason supports exact digit-letter codes", () => {
  const reason = nativeDxfEmbeddedTechnicalIdentifierReason(
    "Поз. 10-А",
    "Pos. 10-А",
  );
  assert.match(reason || "", /10-А/);
  assert.equal(
    nativeDxfEmbeddedTechnicalIdentifierReason("Поз. 10-А", "Поз. 10-А"),
    null,
  );
  assert.equal(
    nativeDxfEmbeddedTechnicalIdentifierReason("Поз. 10-А", "Pos. 10-A"),
    null,
  );
});

test("embedded technical identifier detection leaves nonmatching strings unaffected", () => {
  assert.equal(
    nativeDxfEmbeddedTechnicalIdentifierReason("не менее Вр-1", "min Вр-1"),
    null,
  );
  assert.equal(
    nativeDxfEmbeddedTechnicalIdentifierReason("не менее 3-Вр", "min 3-Вр"),
    null,
  );
});

test("native DXF split glossary applies only to the exact declared two-handle phrase", () => {
  const entries = [
    { handle: "A", plain: "Отм. низа", maxCharacters: 9 },
    { handle: "B", plain: "перекрытия", maxCharacters: 10 },
    { handle: "C", plain: "Отм. верха", maxCharacters: 10 },
    { handle: "D", plain: "перекрытия", maxCharacters: 10 },
  ];
  const translations = new Map([["C", "Existing"], ["D", "Slab"]]);
  applyNativeDxfSplitGlossary(entries, [
    { handles: ["A", "B"] },
    { handles: ["C", "D"] },
    { handles: ["A"] },
  ], translations);
  assert.equal(translations.get("A"), "Slab U/S");
  assert.equal(translations.get("B"), "Elevation");
  assert.equal(translations.get("C"), "Existing");
  assert.equal(translations.get("D"), "Slab");

  const noDeclaredGroup = new Map<string, string>();
  applyNativeDxfSplitGlossary(entries, [], noDeclaredGroup);
  assert.equal(noDeclaredGroup.size, 0);
});

test("native DXF context pair glossary requires exact adjacency and context", () => {
  const entries = [
    { handle: "A", plain: "Отм. низа", maxCharacters: 9 },
    { handle: "B", plain: "перекрытия", maxCharacters: 10 },
    { handle: "C", plain: "перекрытия", maxCharacters: 10 },
    { handle: "D", plain: "Отм. низа", maxCharacters: 9 },
    { handle: "GAP", plain: "другое", maxCharacters: 6 },
    { handle: "E", plain: "перекрытия", maxCharacters: 10 },
  ];
  const translations = new Map([
    ["C", "Existing slab"],
    ["D", "Existing elevation"],
    ["E", "Existing isolated slab"],
  ]);
  applyNativeDxfContextPairGlossary(entries, translations);
  assert.equal(translations.get("A"), "Soffit EL");
  assert.equal(translations.get("B"), "of slab");
  assert.equal(translations.get("C"), "Existing slab");
  assert.equal(translations.get("D"), "Existing elevation");
  assert.equal(translations.get("E"), "Existing isolated slab");
});

test("compact native DXF audit payload includes every target once without truncation", () => {
  const targetEntries = Array.from({ length: 116 }, (_, index) => ({
    handle: `T${index}`,
    plain: `Цель ${index}`,
    maxCharacters: 20,
    replacement: `Target ${index}`,
    accounting: "translated_pending_patch",
    preservationReason: null,
    isCyrillicTarget: true,
    source: `raw private source ${index}`,
    ignoredField: "not audited",
  }));
  const serialized = buildNativeDxfAuditPayload({
    format: "cworks-native-dxf-ledger-v1",
    sourceSha256: "source-sha",
    splitFragmentGroups: [],
    unresolved: [],
    correctionDiagnostics: [],
    entries: [
      ...targetEntries,
      {
        handle: "NON_TARGET",
        plain: "English",
        isCyrillicTarget: false,
        replacement: null,
      },
    ],
  });
  const payload = JSON.parse(serialized);
  assert.equal(payload.entries.length, 116);
  assert.equal(new Set(payload.entries.map((entry: any) => entry.handle)).size, 116);
  assert.equal(payload.entries.some((entry: any) => entry.handle === "NON_TARGET"), false);
  assert.equal(serialized.includes("raw private source"), false);
  assert.deepEqual(Object.keys(payload.entries[0]), [
    "handle",
    "plain",
    "maxCharacters",
    "definitionBlock",
    "placementCount",
    "replacement",
    "accounting",
    "preservationReason",
  ]);
  assert.equal(payload.entries[0].definitionBlock, null);
  assert.equal(payload.entries[0].placementCount, 1);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 100_000);
  assert.throws(() => buildNativeDxfAuditPayload({
    entries: targetEntries,
  }, 100), /exceeds 100 byte safety limit/);
});

test("large native DXF audit ledgers are independently bounded without dropping targets", () => {
  const entries = Array.from({ length: 4_000 }, (_, index) => ({
    targetId: `TEXT:${index}`,
    entityType: "TEXT",
    handle: `${index}`,
    plain: `Цель ${index}`,
    maxCharacters: 20,
    replacement: `Target ${index}`,
    accounting: "translated_pending_patch",
    preservationReason: null,
    isCyrillicTarget: true,
  }));
  const payloads = buildNativeDxfAuditPayloadChunks({
    format: "cworks-native-dxf-ledger-v1",
    entries,
    tableTargets: [],
    splitFragmentGroups: [],
    unresolved: [],
  });
  assert.ok(payloads.length > 1);
  assert.ok(payloads.every((payload) => Buffer.byteLength(payload, "utf8") <= 90_000));
  const auditedIds = payloads.flatMap((payload) =>
    JSON.parse(payload).entries.map((entry: any) => entry.targetId));
  assert.equal(auditedIds.length, entries.length);
  assert.equal(new Set(auditedIds).size, entries.length);
});

test("bounded native DXF audit partitions label global table-script counts as complete-ledger evidence", () => {
  const entries = Array.from({ length: 76 }, (_, index) => ({
    targetId: `TEXT:${index}`,
    entityType: "TEXT",
    handle: `${index}`,
    plain: `Цель ${index}`,
    maxCharacters: 20,
    replacement: `Target ${index}`,
    accounting: "translated_pending_patch",
    preservationReason: null,
    isCyrillicTarget: true,
  }));
  const tableTargets = Array.from({ length: 76 }, (_, index) => ({
    targetId: `ACAD_TABLE:${index}`,
    tableHandle: `${index.toString(16)}`,
    sourceOrdinal: 0,
    sourceOccurrenceCount: index % 2 + 1,
    source: `Таблица ${index}`,
    translation: `Table ${index}`,
    accounting: "translated_pending_table_script",
  }));
  const payloads = buildNativeDxfAuditPayloadChunks({
    format: "cworks-native-dxf-ledger-v1",
    placementCount: 999,
    entries,
    tableTargets,
    tableScript: {
      sha256: "global-script",
      manifestSha256: "global-manifest",
      targetCount: tableTargets.length,
      expectedAppliedCount: tableTargets.reduce(
        (sum, target) => sum + target.sourceOccurrenceCount, 0),
    },
    splitFragmentGroups: [],
    unresolved: [],
  }).map((payload) => JSON.parse(payload));

  assert.ok(payloads.length > 1);
  for (const payload of payloads) {
    assert.deepEqual(payload.auditScope, {
      kind: "bounded_partition",
      completeLedger: false,
      partitionTargetCount: payload.entries.length + payload.tableTargets.length,
      partitionEntryCount: payload.entries.length,
      partitionTableTargetCount: payload.tableTargets.length,
      partitionTableOccurrenceCount: payload.tableTargets.reduce(
        (sum: number, target: any) => sum + target.sourceOccurrenceCount, 0),
      fullLedgerTargetCount: entries.length + tableTargets.length,
      fullLedgerEntryCount: entries.length,
      fullLedgerTableTargetCount: tableTargets.length,
      fullLedgerTableOccurrenceCount: tableTargets.reduce(
        (sum, target) => sum + target.sourceOccurrenceCount, 0),
    });
    assert.equal(payload.tableScript.targetCount, tableTargets.length);
    assert.equal(
      payload.tableScript.expectedAppliedCount,
      tableTargets.reduce((sum, target) => sum + target.sourceOccurrenceCount, 0),
    );
  }
});

test("bounded audit scope guidance preserves the current native DXF resume methodology", () => {
  // This is the methodology fingerprint carried by the active Architecture
  // correction checkpoint. Scope guidance changes the interpretation of a
  // bounded request, not the saved translation/audit methodology; changing
  // it here would reject a pending mandatory re-audit before it can resume.
  assert.equal(
    nativeDxfCheckpointMethodologyHash("en"),
    "325ede3ff3453df3bddd29dee518414f141b58516c0b1e445c300bc9d76374de",
  );
});

test("native DXF audit policy permits exact reasoned identifiers but rejects units and prose", () => {
  assert.match(NATIVE_DXF_AUDIT_POLICY, /ГОСТ5264-80-Н1/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /Пр-1/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /explicit preservation reason/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /surrounding prose is translated/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /Reject a transliterated, partially copied, or otherwise altered code/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /Reject preserved prose, headings, labels, and units such as м2/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /exact isolated uppercase Cyrillic letter used as a grid or stage identifier/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /only when its ledger entry has an explicit preservation reason/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /bounded_partition/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /complete-ledger tableScript/);
});

test("native DXF translation prompts do not request grid identifier transliteration", () => {
  assert.doesNotMatch(NATIVE_DXF_TRANSLATION_GLOSSARY, /В\s+(?:as an )?axis\s*(?:is|=)\s*V/i);
  assert.doesNotMatch(NATIVE_DXF_TRANSLATION_GLOSSARY, /Б\s+(?:as an )?axis\s*(?:is|=)\s*B/i);
  assert.match(NATIVE_DXF_TRANSLATION_GLOSSARY, /м2 means m²/);
  assert.match(NATIVE_DXF_TRANSLATION_GLOSSARY, /AutoCAD fit-evidenced readable construction abbreviations/);
  assert.match(NATIVE_DXF_AUDIT_POLICY, /not semantic omissions/);
});

test("bounded provider seam quarantines a never-settling native audit invocation", async () => {
  const quarantineKey = `native-audit-timeout-${randomUUID()}`;
  await assert.rejects(
    requestCworksProviderWithRetry(
      async () => new Promise<string>(() => {}),
      {
        timeoutMs: 5,
        abortGraceMs: 1,
        maxAttempts: 2,
        retryDelayMs: 0,
        quarantineKey,
        includeProviderMessageInLogs: false,
      },
    ),
    (error: unknown) =>
      error instanceof CworksProviderError
      && error.timedOut
      && error.cancellationConfirmed === false,
  );
  assert.equal(hasUnsettledCworksProviderRequest(quarantineKey), true);
});

test("native DXF ledger synchronization reflects correction-added unit translations", () => {
  const entries = [{
    handle: "10BF2",
    plain: "м2",
    isCyrillicTarget: true,
    replacement: null,
    accounting: "unresolved",
    preservationReason: null,
  }, {
    handle: "CODE1",
    plain: "АР-101",
    isCyrillicTarget: true,
    replacement: null,
    accounting: "preserved",
    preservationReason: "explicit drawing identifier",
  }];
  const translations = new Map<string, string>();
  synchronizeNativeDxfLedgerEntries(entries, translations, new Set(["CODE1"]));
  assert.equal(entries[0].accounting, "unresolved");
  assert.equal(entries[1].accounting, "preserved");

  translations.set("10BF2", "m²");
  synchronizeNativeDxfLedgerEntries(entries, translations, new Set(["CODE1"]));
  assert.equal(entries[0].replacement, "m²");
  assert.equal(entries[0].accounting, "translated_pending_patch");
  assert.equal(entries[1].accounting, "preserved");
});

test("native DXF prior replacement reuse requires exact SHA, handle, and source identity", () => {
  const inventory = {
    sha256: "same-source-sha",
    mtext: [{ handle: "10BF2", plainText: "м2", rawText: "м2" }],
  };
  const prior = {
    sourceSha256: "same-source-sha",
    entries: [{
      handle: "10BF2",
      plain: "м2",
      source: "м2",
      replacement: "m²",
      accounting: "translated_and_patched",
    }],
  };
  assert.deepEqual([...reusableNativeDxfTranslations(prior, inventory)], [["10BF2", "m²"]]);
  assert.equal(reusableNativeDxfTranslations({
    ...prior,
    targetLanguage: "ja",
    entries: [{ ...prior.entries[0], replacement: "平方メートル" }],
  }, inventory, "en").size, 0);
  assert.equal(reusableNativeDxfTranslations({
    ...prior,
    targetLanguage: "en",
  }, inventory, "ja").size, 0);
  assert.equal(reusableNativeDxfTranslations({
    ...prior,
    targetLanguage: "fr",
  }, inventory, "en").size, 0);
  assert.equal(reusableNativeDxfTranslations({ ...prior, sourceSha256: "other" }, inventory).size, 0);
  assert.equal(reusableNativeDxfTranslations({
    ...prior,
    entries: [{ ...prior.entries[0], handle: "UNKNOWN" }],
  }, inventory).size, 0);
  assert.equal(reusableNativeDxfTranslations({
    ...prior,
    entries: [{ ...prior.entries[0], plain: "changed" }],
  }, inventory).size, 0);
  assert.equal(reusableNativeDxfTranslations({
    ...prior,
    entries: [{ ...prior.entries[0], accounting: "preserved" }],
  }, inventory).size, 0);
  assert.equal(reusableNativeDxfTranslations({
    ...prior,
    entries: [{ ...prior.entries[0], replacement: null }],
  }, inventory).size, 0);
});

test("optional native DXF prior-ledger read returns a fast valid ledger", async () => {
  const ledger = {
    format: "cworks-native-dxf-ledger-v1",
    sourceSha256: "source-sha",
    entries: [{ handle: "A" }],
  };
  const result = await readOptionalNativeDxfPriorLedger(
    async () => Buffer.from(JSON.stringify(ledger)),
    50,
  );
  assert.deepEqual(result, ledger);
});

test("optional native DXF prior-ledger read bounds a stall and ignores late settlement", async () => {
  let settle!: (value: Buffer) => void;
  const stalledRead = new Promise<Buffer>((resolve) => {
    settle = resolve;
  });
  const translations = new Map<string, string>();
  const result = await readOptionalNativeDxfPriorLedger(() => stalledRead, 5);
  if (result?.entries?.[0]?.replacement) {
    translations.set(result.entries[0].handle, result.entries[0].replacement);
  }
  assert.equal(result, null);
  assert.equal(translations.size, 0);

  settle(Buffer.from(JSON.stringify({
    entries: [{ handle: "LATE", replacement: "must be ignored" }],
  })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(translations.size, 0);
});

test("native DXF prior reuse rejects entries newly classified for whole preservation", () => {
  const inventory = {
    sha256: "same-source-sha",
    mtext: [{
      handle: "CODE",
      plainText: "198/ДУ-2021. АР",
      rawText: "198/ДУ-2021. АР",
      preservedDrawingCodeCandidate: true,
    }],
  };
  const prior = {
    sourceSha256: "same-source-sha",
    entries: [{
      handle: "CODE",
      plain: "198/ДУ-2021. АР",
      source: "198/ДУ-2021. АР",
      replacement: "198/DU-2021. AR",
      accounting: "translated_and_patched",
    }],
  };
  assert.equal(reusableNativeDxfTranslations(prior, inventory).size, 0);
});

test("whole-preservation cleanup removes stale replacements and restores preserved ledger state", () => {
  const translations = new Map([
    ["CODE_A", "198/DU-2021. AR"],
    ["CODE_B", "P.v.-3/-4"],
    ["UNIT", "m²"],
  ]);
  const preservedHandles = new Set(["CODE_A", "CODE_B"]);
  removeNativeDxfPreservedTranslations(translations, preservedHandles);
  assert.deepEqual([...translations], [["UNIT", "m²"]]);

  const entries = [{
    handle: "CODE_A",
    plain: "198/ДУ-2021. АР",
    isCyrillicTarget: true,
    replacement: "198/DU-2021. AR",
    accounting: "translated_and_patched",
    preservationReason: "drawing_code_candidate: explicit non-language drawing identifier preservation",
  }, {
    handle: "UNIT",
    plain: "м2",
    isCyrillicTarget: true,
    replacement: null,
    accounting: "unresolved",
    preservationReason: null,
  }];
  synchronizeNativeDxfLedgerEntries(entries, translations, preservedHandles);
  assert.equal(entries[0].replacement, null);
  assert.equal(entries[0].accounting, "preserved");
  assert.match(entries[0].preservationReason || "", /drawing_code_candidate/);
  assert.equal(entries[1].replacement, "m²");
  assert.equal(entries[1].accounting, "translated_pending_patch");
});

test("manual preview binding blocks any changed final render payload", () => {
  const source = Buffer.from("private drawing bytes");
  const translations = [{
    id: "p1-l0",
    source: "Помещение",
    translation: "Room",
    pageNumber: 1,
    bbox: [10, 10, 40, 20] as [number, number, number, number],
    fontSize: 8,
    direction: [1, 0] as [number, number],
    color: 0,
  }];
  const obstacles = [{
    id: "p1-l0",
    pageNumber: 1,
    bbox: [10, 10, 40, 20] as [number, number, number, number],
  }];
  const fingerprint = buildCworksManualTouchupRenderFingerprint(
    source,
    1,
    translations,
    obstacles,
  );
  const job = {
    repairBrief: {
      kind: "cworks-manual-touchup",
      previewRenderFingerprint: fingerprint,
      previewRenderLayoutVersion: 12,
      pages: [{ pageNumber: 1 }],
    },
  } as any;
  assert.doesNotThrow(() =>
    assertCworksManualTouchupRenderBinding(job, source, translations, obstacles));
  assert.throws(() =>
    assertCworksManualTouchupRenderBinding(
      job,
      source,
      [{ ...translations[0], translation: "Room designation" }],
      obstacles,
    ), /MANUAL_PREVIEW_MISMATCH/);
  assert.throws(() =>
    assertCworksManualTouchupRenderBinding(
      job,
      source,
      translations,
      [{ ...obstacles[0], bbox: [10, 10, 41, 20] }],
    ), /MANUAL_PREVIEW_MISMATCH/);
});

test("language-aware targeting excludes existing English labels and drawing identifiers", () => {
  const block = (text: string, suspicious = false) => ({
    id: "p1-l0",
    text,
    bbox: [1, 1, 40, 10] as [number, number, number, number],
    fontSize: 8,
    direction: [1, 0],
    color: 0,
    suspicious,
  });
  assert.equal(shouldTranslate(block("План кровли"), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("Roof Plan"), "everything", "ru"), false);
  assert.equal(shouldTranslate(block("ГОСТ 21.101-2020"), "everything", "ru"), false);
  assert.equal(shouldTranslate(block("П-10"), "everything", "ru"), false);
  assert.equal(shouldTranslate(block("198/ДУ-2021.АР", true), "everything", "ru"), false);
  assert.equal(shouldTranslate(block("198/ ДУ -2021. АР", true), "everything", "ru"), false);
  assert.equal(shouldTranslate(block("Ф1.2"), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("План-1", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("Вид-1", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("Узел-1", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("Лист-1", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("План-1-А", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("Узел-1-А", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("Разрез-1", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("Фасад-2", true), "everything", "ru"), true);
  assert.equal(shouldTranslate(block("????", true), "everything", "ru"), true);
});

test("fit-aware title-block translations use readable engineering abbreviations", () => {
  const block = (text: string) => ({
    id: "p1-l0",
    text,
    bbox: [1, 1, 30, 10] as [number, number, number, number],
    fontSize: 8,
    direction: [0, -1] as [number, number],
    color: 0,
  });
  assert.equal(fitAwareDrawingTranslation(block("Инв. N подл."), "Inventory number of original"), "Orig. inv. No.");
  assert.equal(fitAwareDrawingTranslation(block("Подп. и дата"), "Signature and date"), "Sign. & date");
  assert.equal(fitAwareDrawingTranslation(block("Взам. инв. N"), "Replacement inventory number"), "Repl. Inv.");
  assert.equal(fitAwareDrawingTranslation(block("инв"), "inventory"), "inv.");
  assert.equal(fitAwareDrawingTranslation(block("Взам"), "Instead"), "Repl.");
  assert.equal(fitAwareDrawingTranslation(block("Подп"), "Signature"), "Sign.");
});

test("targeting accepts CJK, RTL, Latin, and mixed-script human language", () => {
  const block = (text: string) => ({
    id: "p1-l0",
    text,
    bbox: [1, 1, 80, 12] as [number, number, number, number],
    fontSize: 8,
    direction: [1, 0] as [number, number],
    color: 0,
  });
  assert.equal(shouldTranslate(block("屋根伏図"), "everything", "ja"), true);
  assert.equal(shouldTranslate(block("结构说明"), "everything", "zh"), true);
  assert.equal(shouldTranslate(block("ملاحظات التركيب"), "everything", "ar"), true);
  assert.equal(shouldTranslate(block("הערות התקנה"), "everything", "he"), true);
  assert.equal(shouldTranslate(block("Nivel técnico"), "everything", "es"), true);
  assert.equal(shouldTranslate(block("Монтаж / INSTALLATION"), "everything", "auto"), true);
  assert.equal(shouldTranslate(block("JIS B 7516"), "everything", "ja"), false);
});

test("independent auditor readiness is mandatory", () => {
  const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const savedBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  try {
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const readiness = getCworksTranslationReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.independentAuditorReady, false);
  } finally {
    if (savedKey === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = savedKey;
    if (savedBaseUrl === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = savedBaseUrl;
  }
});

test("non-compact paragraph groups discard stray model group translations", async () => {
  const id = `non-compact-group-test-${randomUUID()}`;
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Non-compact group test",
    status: "running",
    sourceLanguage: "ru",
    originalFilename: "non-compact.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    const page: CworksPage = {
      pageNumber: 1,
      width: 200,
      height: 100,
      blocks: ["Первая строка", "Вторая строка"].map((text, index) => ({
        id: `p1-l${index}`,
        paragraphId: "p1-b0",
        layoutGroupId: "p1-g0",
        layoutGroupCompact: false,
        text,
        bbox: [10, 10 + index * 15, 90, 22 + index * 15],
        fontSize: 9,
        direction: [1, 0],
        color: 0,
      })),
    };
    const translated = await translateBlocks(job, [page], "Translate drawing text.", {
      askTranslator: async () => JSON.stringify([
        {
          id: "p1-l0",
          translation: "First line",
          layoutGroupTranslation: "THIS MUST NOT COLLAPSE THE PARAGRAPH",
          uncertain: false,
        },
        {
          id: "p1-l1",
          translation: "Second line",
          layoutGroupTranslation: "THIS MUST NOT COLLAPSE THE PARAGRAPH",
          uncertain: false,
        },
      ]),
    });
    assert.deepEqual(
      translated.translations.map((item) => item.translation),
      ["First line", "Second line"],
    );
    assert.equal(
      translated.translations.some((item) => item.layoutGroupTranslation),
      false,
    );
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("replacement worker resumes after the last checkpointed page", async () => {
  const id = `checkpoint-test-${randomUUID()}`;
  const firstToken = randomUUID();
  const pages: CworksPage[] = [1, 2, 3].map((pageNumber) => ({
    pageNumber,
    width: 100,
    height: 100,
    blocks: [{
      id: `p${pageNumber}-l0`,
      text: `SOURCE ${pageNumber}`,
      bbox: [1, 1, 40, 10],
      fontSize: 8,
      direction: [1, 0],
      color: 0,
    }],
  }));
  const calls: string[] = [];
  const askTranslator = async (prompt: string) => {
    const matches = Array.from(prompt.matchAll(/"id":"([^"]+)"/g));
    const id = matches.at(-1)?.[1];
    assert.ok(id);
    calls.push(id);
    return JSON.stringify([{ id, translation: `English ${id}`, uncertain: false }]);
  };

  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Checkpoint recovery test",
    status: "running",
    originalFilename: "checkpoint-test.pdf",
    sourceStoredName: `cworks-translator/checkpoint-test/${id}/source.pdf`,
    runToken: firstToken,
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });

  try {
    const [firstJob] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await assert.rejects(
      translateBlocks(firstJob, pages, "Translate accurately.", {
        askTranslator,
        onCheckpointSaved: async (pageNumber) => {
          if (pageNumber === 2) throw new Error("simulated instance shutdown");
        },
      }),
      /simulated instance shutdown/,
    );
    assert.deepEqual(calls, ["p1-l0", "p2-l0"]);

    const firstCheckpoints = await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, id),
      eq(cworksTranslationCheckpoints.revisionCount, 0),
    ));
    assert.deepEqual(firstCheckpoints.map((row) => row.pageNumber).sort(), [1, 2]);

    await db.update(cworksTranslationJobs).set({
      leaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(cworksTranslationJobs.id, id));
    const replacementJob = await claimNextJob({ jobId: id });
    assert.ok(replacementJob);
    assert.notEqual(replacementJob.runToken, firstToken);
    assert.match(replacementJob.progressNote || "", /Resuming/);

    const staleCalls: string[] = [];
    await assert.rejects(
      translateBlocks(firstJob, [pages[2]], "Translate accurately.", {
        askTranslator: async () => {
          staleCalls.push("p3-l0");
          return JSON.stringify([{ id: "p3-l0", translation: "Late stale result", uncertain: false }]);
        },
      }),
      /lease was superseded/,
    );
    assert.deepEqual(staleCalls, []);
    const stalePageCheckpoint = await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, id),
      eq(cworksTranslationCheckpoints.revisionCount, 0),
      eq(cworksTranslationCheckpoints.pageNumber, 3),
    ));
    assert.equal(stalePageCheckpoint.length, 0);

    const resumed = await translateBlocks(replacementJob, pages, "Translate accurately.", { askTranslator });
    assert.deepEqual(calls, ["p1-l0", "p2-l0", "p3-l0"]);
    assert.deepEqual(resumed.translations.map((item) => item.id), ["p1-l0", "p2-l0", "p3-l0"]);

    const [updated] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(updated.pagesDone, 3);
    assert.match(updated.progressNote || "", /Resuming translation/);

    const callsBeforeRevision = calls.length;
    const [revisionJob] = await db.update(cworksTranslationJobs).set({
      revisionCount: 1,
      pagesDone: 0,
      runToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).where(eq(cworksTranslationJobs.id, id)).returning();
    await translateBlocks(revisionJob, pages, "Translate accurately.", { askTranslator });
    assert.deepEqual(calls.slice(callsBeforeRevision), ["p1-l0", "p2-l0", "p3-l0"]);
    const revisionCheckpoints = await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, id),
      eq(cworksTranslationCheckpoints.revisionCount, 1),
    ));
    assert.equal(revisionCheckpoints.length, 3);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }

  const remaining = await db.select().from(cworksTranslationCheckpoints)
    .where(eq(cworksTranslationCheckpoints.jobId, id));
  assert.equal(remaining.length, 0);
});

test("automatic repair reuses correct prior translations and sends only targeted blocks", async () => {
  const id = `targeted-repair-test-${randomUUID()}`;
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 100,
    blocks: [{
      id: "p1-l0",
      layoutGroupId: "p1-g0",
      layoutGroupCompact: true,
      text: "План кровли",
      bbox: [10, 10, 100, 24],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }, {
      id: "p1-l1",
      layoutGroupId: "p1-g0",
      layoutGroupCompact: true,
      text: "Общие указания",
      bbox: [10, 30, 120, 44],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
  };
  const unaffectedPage: CworksPage = {
    pageNumber: 2,
    width: 200,
    height: 100,
    blocks: [{
      id: "p2-l0",
      text: "Схема монтажа",
      bbox: [10, 10, 110, 24],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Targeted automatic repair test",
    status: "running",
    sourceLanguage: "ru",
    originalFilename: "targeted-repair.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [initialJob] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    await translateBlocks(initialJob, [page, unaffectedPage], "Translate drawing text.", {
      askTranslator: async (prompt) => prompt.includes('"id":"p2-l0"')
        ? JSON.stringify([{ id: "p2-l0", translation: "Installation Diagram", uncertain: false }])
        : JSON.stringify([
          {
            id: "p1-l0",
            translation: "Roof Plan",
            layoutGroupTranslation: "Roof Plan General Notes",
            uncertain: false,
          },
          {
            id: "p1-l1",
            translation: "General Notes",
            layoutGroupTranslation: "Roof Plan General Notes",
            uncertain: false,
          },
        ]),
    });
    const [repairJob] = await db.update(cworksTranslationJobs).set({
      revisionCount: 1,
      runToken: randomUUID(),
      repairBrief: {
        kind: "cworks-unresolved-repair",
        sourceRevision: 0,
        pages: [{
          pageNumber: 1,
          unsafePlacementBlockIds: [],
          placementFailures: [{
            blockId: "p1-l1",
            rejectionCategory: "text_too_long",
            bbox: [10, 30, 120, 44],
          }],
          retryWholePage: false,
          findings: [{
            type: "translation",
            message: "Use the project-standard wording.",
            sourceBlockId: "p1-g0",
          }],
          reviewerNotes: "Correct only the unresolved general-notes heading.",
        }],
      },
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).where(eq(cworksTranslationJobs.id, id)).returning();
    const prompts: string[] = [];
    const repaired = await translateBlocks(repairJob, [page, unaffectedPage], "Translate drawing text.", {
      askTranslator: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify([
          {
            id: "p1-l0",
            translation: "Roof Plan",
            layoutGroupTranslation: "Roof Plan General Instructions",
            uncertain: false,
          },
          {
            id: "p1-l1",
            translation: "General Instructions",
            layoutGroupTranslation: "Roof Plan General Instructions",
            uncertain: false,
          },
        ]);
      },
    });
    assert.equal(prompts.length, 1);
    const suppliedLines = prompts[0].split("\nLines:\n").at(-1) || "";
    assert.match(suppliedLines, /"id":"p1-l0","text"/);
    assert.match(suppliedLines, /"id":"p1-l1"/);
    assert.match(suppliedLines, /"layoutGroupMemberIds":\["p1-l0","p1-l1"\]/);
    assert.match(suppliedLines, /"layoutGroupSource":"План кровли Общие указания"/);
    assert.match(prompts[0], /project-standard wording/);
    assert.match(prompts[0], /"rejectionCategory":"text_too_long"/);
    assert.match(prompts[0], /"bbox":\[10,30,120,44\]/);
    assert.match(prompts[0], /"expandedLayoutGroupBlockIds":\["p1-l0","p1-l1"\]/);
    assert.equal(
      repaired.translations.find((item) => item.id === "p1-l1")?.layoutGroupTranslation,
      "Roof Plan General Instructions",
    );
    assert.equal(
      repaired.translations.find((item) => item.id === "p1-l0")?.layoutGroupTranslation,
      "Roof Plan General Instructions",
      "a repaired group phrase must replace stale retained group metadata",
    );
    assert.deepEqual(
      repaired.translations.map((item) => [item.id, item.translation]),
      [
        ["p1-l0", "Roof Plan"],
        ["p1-l1", "General Instructions"],
        ["p2-l0", "Installation Diagram"],
      ],
    );

    const [geometryRepairJob] = await db.update(cworksTranslationJobs).set({
      revisionCount: 2,
      runToken: randomUUID(),
      repairBrief: {
        kind: "cworks-unresolved-repair",
        sourceRevision: 1,
        pages: [{
          pageNumber: 1,
          unsafePlacementBlockIds: [],
          retryWholePage: false,
          findings: [{ type: "translation", message: "Retry notes.", sourceBlockId: "p1-l1" }],
        }],
      },
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).where(eq(cworksTranslationJobs.id, id)).returning();
    const changedGeometryPage: CworksPage = {
      ...page,
      blocks: page.blocks.map((block) => block.id === "p1-l0"
        ? { ...block, bbox: [20, 10, 110, 24] }
        : block),
    };
    const geometryPrompts: string[] = [];
    await translateBlocks(geometryRepairJob, [changedGeometryPage, unaffectedPage], "Translate drawing text.", {
      askTranslator: async (prompt) => {
        geometryPrompts.push(prompt);
        return JSON.stringify([
          { id: "p1-l0", translation: "Roof Plan", uncertain: false },
          { id: "p1-l1", translation: "General Instructions", uncertain: false },
        ]);
      },
    });
    const geometryLines = geometryPrompts[0].split("\nLines:\n").at(-1) || "";
    assert.match(geometryLines, /"id":"p1-l0"/, "changed placement geometry must be retranslated");
    assert.match(geometryLines, /"id":"p1-l1"/);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("uncertain Russian text gets a focused lower-cost resolution pass", async () => {
  const id = `uncertain-retry-test-${randomUUID()}`;
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 100,
    blocks: [{
      id: "p1-l0",
      text: "План первого этажа",
      bbox: [10, 10, 120, 24],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Uncertain retry test",
    status: "running",
    sourceLanguage: "auto",
    originalFilename: "uncertain-retry.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    let calls = 0;
    const translated = await translateBlocks(job, [page], "Translate drawing text.", {
      askTranslator: async () => {
        calls++;
        return calls === 1
          ? JSON.stringify([{
              id: "p1-l0",
              translation: "План первого этажа",
              uncertain: true,
            }])
          : JSON.stringify([{
              id: "p1-l0",
              translation: "First Floor Plan",
              uncertain: false,
            }]);
      },
    });
    assert.equal(calls, 2);
    assert.equal(translated.translations[0].translation, "First Floor Plan");
    assert.equal(translated.translations[0].uncertain, false);
    assert.equal(translated.warningCount, 0);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("remaining clean Russian text gets a final best-effort lower-cost pass", async () => {
  const id = `final-pass-test-${randomUUID()}`;
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 100,
    blocks: [{
      id: "p1-l0",
      text: "План кровли",
      bbox: [10, 10, 100, 24],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Final pass test",
    status: "running",
    sourceLanguage: "ru",
    originalFilename: "final-pass.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    let calls = 0;
    const translated = await translateBlocks(job, [page], "Translate drawing text.", {
      askTranslator: async () => {
        calls++;
        return calls < 3
          ? JSON.stringify([{
              id: "p1-l0",
              translation: "План кровли",
              uncertain: true,
            }])
          : JSON.stringify([{
              id: "p1-l0",
              translation: "Roof Plan",
              uncertain: false,
            }]);
      },
    });
    assert.equal(calls, 3);
    assert.equal(translated.translations[0].translation, "Roof Plan");
    assert.equal(translated.translations[0].uncertain, false);
    assert.equal(translated.warningCount, 0);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("malformed optional-pass output stays unresolved without failing the page", async () => {
  const id = `optional-pass-json-test-${randomUUID()}`;
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 100,
    blocks: [{
      id: "p1-l0",
      text: "План кровли",
      bbox: [10, 10, 100, 24],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Optional JSON test",
    status: "running",
    sourceLanguage: "ru",
    originalFilename: "optional-json.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    let calls = 0;
    const translated = await translateBlocks(job, [page], "Translate drawing text.", {
      askTranslator: async () => {
        calls++;
        return calls <= 2
          ? JSON.stringify([{
              id: "p1-l0",
              translation: "План кровли",
              uncertain: true,
            }])
          : "not valid json";
      },
    });
    assert.equal(calls, 4);
    assert.equal(translated.translations[0].translation, "План кровли");
    assert.equal(translated.translations[0].uncertain, true);
    assert.equal(translated.warningCount, 1);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("malformed primary JSON can recover through the focused pass", async () => {
  const id = `primary-json-test-${randomUUID()}`;
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 100,
    blocks: [{
      id: "p1-l0",
      text: "План кровли",
      bbox: [10, 10, 100, 24],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Primary JSON recovery test",
    status: "running",
    sourceLanguage: "ru",
    originalFilename: "primary-json.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    let calls = 0;
    const translated = await translateBlocks(job, [page], "Translate drawing text.", {
      askTranslator: async () => {
        calls++;
        return calls <= 2
          ? "not valid json"
          : JSON.stringify([{
              id: "p1-l0",
              translation: "Roof Plan",
              uncertain: false,
            }]);
      },
    });
    assert.equal(calls, 3);
    assert.equal(translated.translations[0].translation, "Roof Plan");
    assert.equal(translated.translations[0].uncertain, false);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("empty provider responses retry within the bounded policy", async () => {
  let attempts = 0;
  const result = await requestCworksProviderWithRetry(async () => {
    attempts++;
    if (attempts === 1) {
      throw Object.assign(new Error("empty response"), { code: "EMPTY_RESPONSE" });
    }
    return "ok";
  }, {
    maxAttempts: 2,
    retryDelayMs: 0,
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("bounded raster-title recovery maps normalized boxes and stays raster-backed", async () => {
  const id = `raster-title-recovery-test-${randomUUID()}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cworks-raster-title-"));
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 100,
    blocks: [{
      id: "p1-l0",
      text: "Existing selectable label",
      bbox: [60, 5, 140, 15],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
    visualRecoveryRegions: [{
      id: "p1-raster-title",
      bbox: [20, 0, 180, 20],
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Raster title recovery test",
    status: "running",
    sourceLanguage: "ru",
    originalFilename: "raster-title.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    const recovered = await recoverSuspiciousBlocks(
      job,
      [page],
      path.join(dir, "unused.pdf"),
      dir,
      {
        recoverRegion: async () => JSON.stringify({
          lines: [{
            sourceText: "План кровли",
            bbox: [250, 250, 750, 750],
          }, {
            sourceText: "Примечания по монтажу кровли",
            bbox: [0, 500, 200, 1000],
          }],
        }),
      },
    );
    assert.equal(recovered.attemptedCount, 1);
    assert.equal(recovered.recoveredCount, 1);
    assert.equal(recovered.unresolvedCount, 0);
    assert.equal(recovered.pages[0].blocks.length, 2);
    const block = recovered.pages[0].blocks[1];
    assert.deepEqual(block.bbox, [20, 10, 52, 20]);
    assert.equal(block.text, "Примечания по монтажу кровли");
    assert.equal(block.rasterBacked, true);
    assert.equal(block.recoveredFromVisual, true);
    const translated = await translateBlocks(
      job,
      recovered.pages,
      "Translate drawing text.",
      {
        askTranslator: async () => JSON.stringify([{
          id: block.id,
          translation: "Roof Plan",
          uncertain: false,
        }]),
      },
    );
    assert.equal(translated.translations[0].translation, "Roof Plan");
    assert.equal(translated.translations[0].rasterBacked, true);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("raster-only drawing with no recoverable language is blocked before review or final output", async () => {
  const id = `raster-only-empty-recovery-test-${randomUUID()}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cworks-raster-only-empty-"));
  const page: CworksPage = {
    pageNumber: 1,
    width: 400,
    height: 300,
    blocks: [],
    visualRecoveryRegions: [{
      id: "p1-raster-title",
      kind: "raster-title",
      bbox: [60, 0, 340, 60],
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Raster-only empty recovery test",
    status: "running",
    sourceLanguage: "auto",
    originalFilename: "raster-only-symbols.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    let recoveryCalls = 0;
    const recovered = await recoverSuspiciousBlocks(
      job,
      [page],
      path.join(dir, "unused.pdf"),
      dir,
      {
        recoverRegion: async ({ region }) => {
          recoveryCalls++;
          assert.deepEqual(region.bbox, [60, 0, 340, 60]);
          return JSON.stringify({ lines: [] });
        },
      },
    );

    assert.equal(recoveryCalls, 1);
    assert.equal(recovered.attemptedCount, 1);
    assert.equal(recovered.recoveredCount, 0);
    assert.equal(recovered.pages[0].blocks.length, 0);
    assert.throws(
      () => requireRecoverableCworksText(job, recovered.pages),
      /No translatable human-language text/,
    );

    const [unchanged] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(unchanged.status, "running");
    assert.equal(unchanged.outputStoredName, null);
    assert.equal(unchanged.approvedAt, null);
    assert.equal(unchanged.approvedRevision, null);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("audited raster side strips recover only flagged human-language prose", async () => {
  const id = `raster-strip-recovery-test-${randomUUID()}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cworks-raster-strip-"));
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 200,
    blocks: [{
      id: "p1-l0",
      text: "Выборочная надпись",
      bbox: [0, 82, 80, 92],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
    }],
    visualRecoveryRegions: [{
      id: "p1-raster-region-0",
      kind: "raster-region",
      bbox: [0, 80, 200, 120],
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Raster strip recovery test",
    status: "running",
    sourceLanguage: "auto",
    originalFilename: "raster-strip.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    const recovered = await recoverSuspiciousBlocks(
      job,
      [page],
      path.join(dir, "unused.pdf"),
      dir,
      {
        recoverRegion: async () => JSON.stringify({
          lines: [{
            sourceText: "Примечания по монтажу кровли",
            bbox: [500, 500, 900, 900],
            likelySourceLanguage: true,
          }, {
            sourceText: "Не подтвержденная строка",
            bbox: [500, 100, 900, 300],
          }, {
            sourceText: "ГОСТ 21.101-2020",
            bbox: [500, 300, 900, 450],
            likelySourceLanguage: true,
          }, {
            sourceText: "Выборочная надпись",
            bbox: [0, 0, 1000, 1000],
            likelySourceLanguage: true,
          }, {
            sourceText: "П-10",
            bbox: [500, 450, 900, 550],
            likelySourceLanguage: true,
          }, {
            sourceText: "25 мм",
            bbox: [500, 550, 900, 650],
            likelySourceLanguage: true,
          }],
        }),
      },
    );
    assert.equal(recovered.attemptedCount, 1);
    assert.equal(recovered.recoveredCount, 1);
    assert.equal(recovered.unresolvedCount, 0);
    const rasterBlocks = recovered.pages[0].blocks.filter((block) => block.rasterBacked);
    assert.equal(rasterBlocks.length, 1);
    assert.equal(rasterBlocks[0].text, "Примечания по монтажу кровли");
    assert.equal(rasterBlocks[0].recoveredFromVisual, true);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("raster side-strip recovery supports an explicit non-Russian source", async () => {
  const id = `raster-strip-language-test-${randomUUID()}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cworks-raster-strip-language-"));
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 200,
    blocks: [{
      id: "p1-l0",
      text: "Texto seleccionable",
      bbox: [0, 10, 80, 20],
      fontSize: 9,
    }],
    visualRecoveryRegions: [{
      id: "p1-raster-strip-0",
      kind: "raster-strip",
      bbox: [0, 80, 200, 120],
    }],
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Raster strip language gate test",
    status: "running",
    sourceLanguage: "es",
    originalFilename: "raster-strip-language.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    let calls = 0;
    const recovered = await recoverSuspiciousBlocks(
      job,
      [page],
      path.join(dir, "unused.pdf"),
      dir,
      {
        recoverRegion: async () => {
          calls++;
          return JSON.stringify({
            lines: [{
              sourceText: "Notas de montaje",
              bbox: [100, 100, 700, 500],
              likelySourceLanguage: true,
            }],
          });
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(recovered.attemptedCount, 1);
    assert.equal(recovered.recoveredCount, 1);
    assert.equal(
      recovered.pages[0].blocks.find((block) => block.rasterBacked)?.text,
      "Notas de montaje",
    );
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("broken font text is visually recovered before translation and unresolved lines stay visible", async () => {
  const id = `visual-recovery-test-${randomUUID()}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cworks-visual-recovery-"));
  const pages: CworksPage[] = [1, 2].map((pageNumber) => ({
    pageNumber,
    width: 200,
    height: 100,
    blocks: [{
      id: `p${pageNumber}-l0`,
      text: "????",
      bbox: [10, 10, 70, 24],
      fontSize: 9,
      direction: [1, 0],
      color: 0,
      suspicious: true,
    }],
  }));
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Visual recovery test",
    status: "running",
    sourceLanguage: "ru",
    originalFilename: "visual-recovery.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    const recovered = await recoverSuspiciousBlocks(
      job,
      pages,
      path.join(dir, "unused.pdf"),
      dir,
      {
        recoverBlock: async ({ page }) =>
          page.pageNumber === 1 ? "Дверь" : null,
      },
    );
    assert.equal(recovered.attemptedCount, 2);
    assert.equal(recovered.recoveredCount, 1);
    assert.equal(recovered.unresolvedCount, 1);
    assert.equal(recovered.pages[0].blocks[0].text, "Дверь");
    assert.equal(recovered.pages[0].blocks[0].recoveredFromVisual, true);
    assert.equal(recovered.pages[1].blocks[0].visualRecoveryFailed, true);

    const providerIds: string[] = [];
    const translated = await translateBlocks(job, recovered.pages, "Translate drawing text.", {
      askTranslator: async (prompt) => {
        const idMatch = prompt.match(/"id":"([^"]+)"/);
        assert.ok(idMatch);
        providerIds.push(idMatch[1]);
        return JSON.stringify([{
          id: idMatch[1],
          translation: "Door",
          uncertain: false,
        }]);
      },
    });
    assert.deepEqual(providerIds, ["p1-l0"], "unreadable glyph runs are not sent as text");
    assert.equal(translated.translations[0].source, "Дверь");
    assert.equal(translated.translations[0].recoveredFromVisual, true);
    assert.equal(translated.translations[0].translation, "Door");
    assert.equal(translated.translations[1].uncertain, true);
    assert.equal(translated.warningCount, 1);

    const reuseCalls: number[] = [];
    await recoverSuspiciousBlocks(job, pages, path.join(dir, "unused.pdf"), dir, {
      recoverBlock: async ({ page }) => {
        reuseCalls.push(page.pageNumber);
        return null;
      },
    });
    assert.deepEqual(reuseCalls, [2], "matching visual recovery checkpoint is reused");

    const changedPages: CworksPage[] = pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => ({
        ...block,
        bbox: page.pageNumber === 1 ? [11, 10, 70, 24] : block.bbox,
      })),
    }));
    const invalidatedCalls: number[] = [];
    await recoverSuspiciousBlocks(job, changedPages, path.join(dir, "unused.pdf"), dir, {
      recoverBlock: async ({ page }) => {
        invalidatedCalls.push(page.pageNumber);
        return null;
      },
    });
    assert.deepEqual(invalidatedCalls, [1, 2], "changed source geometry invalidates visual recovery");

    const coverage = summarizeCworksCoverage(translated.translations, [
      { translatedBlockCount: 1 },
      { translatedBlockCount: 0 },
    ]);
    assert.deepEqual(coverage, {
      targetLineCount: 2,
      recoveredLineCount: 1,
      translatedLineCount: 1,
      placedLineCount: 1,
      unresolvedLineCount: 1,
      placementPercent: 50,
      complete: false,
    });
    assert.equal(isCworksCoverageSeverelyIncomplete(2, 1), true);
    assert.equal(isCworksCoverageSeverelyIncomplete(10, 9), true);
    assert.equal(isCworksCoverageSeverelyIncomplete(10, 10), false);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("coverage denominator cannot omit an untranslated target line", () => {
  const coverage = summarizeCworksCoverage([{
    id: "p1-l0",
    source: "Стена",
    translation: "Wall",
    uncertain: false,
    bbox: [0, 0, 20, 10],
    fontSize: 8,
    pageNumber: 1,
  }], [{ translatedBlockCount: 1 }], 2);
  assert.equal(coverage.targetLineCount, 2);
  assert.equal(coverage.translatedLineCount, 1);
  assert.equal(coverage.placedLineCount, 1);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.unresolvedLineCount, 1);
});

test("independent audit ledger uses one canonical record for a rendered layout group", () => {
  const translations = ["Номер", "поме-", "щения"].map((source, index) => ({
    id: `p1-l${index}`,
    layoutGroupId: "p1-g0",
    layoutGroupCompact: true,
    layoutGroupTranslation: "Room No.",
    source,
    translation: ["Room", "Num-", "ber"][index],
    uncertain: false,
    bbox: [10, 10 + index * 10, 40, 20 + index * 10] as [number, number, number, number],
    fontSize: 8,
    direction: [1, 0] as [number, number],
    color: 0,
    pageNumber: 1,
  }));
  const ledger = buildCworksAuditLedger(translations);
  assert.deepEqual(ledger, [{
    id: "p1-g0",
    memberIds: ["p1-l0", "p1-l1", "p1-l2"],
    source: "Номер помещения",
    translation: "Room No.",
    uncertain: false,
    bboxes: translations.map((item) => item.bbox),
  }]);
});

test("independent audit disagreement becomes a blocking page finding", () => {
  const audit = parseCworksMachineAudit(JSON.stringify({
    passed: false,
    findings: [{
      type: "source_residue",
      message: "Russian schedule heading remains visible.",
      sourceBlockId: "p1-l4",
    }],
  }), 1);
  assert.equal(audit.status, "findings");
  assert.equal(audit.model, "gpt-5.6-sol");
  assert.deepEqual(audit.findings, [{
    type: "source_residue",
    message: "Russian schedule heading remains visible.",
    sourceBlockId: "p1-l4",
  }]);
});

test("CAD provider logs omit private drawing source echoed in an error", async () => {
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await assert.rejects(
      requestCworksProviderWithRetry(
        async () => {
          throw Object.assign(new Error("PRIVATE_DRAWING_SOURCE_LINE"), { status: 400 });
        },
        {
          maxAttempts: 1,
          includeProviderMessageInLogs: false,
        },
      ),
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /PRIVATE_DRAWING_SOURCE_LINE/);
  assert.match(logs[0], /status=400/);
});