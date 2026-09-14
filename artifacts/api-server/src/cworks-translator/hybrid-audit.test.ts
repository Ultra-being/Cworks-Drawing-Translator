import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeNativeDxfHybridAuditFindings,
  type CworksMachineAuditFinding,
} from "./worker";

const tableId = "ACAD_TABLE:AB:0:source-hash";
const tables = new Map([[tableId, { sourceText: "Помещение" }]]);
const translations = new Map([[tableId, "Room"]]);
const finding = (type: string, sourceBlockId: string | undefined = tableId) => ({
  type,
  message: `Independent audit: ${type}`,
  sourceBlockId,
} as CworksMachineAuditFinding);

test("hybrid audit defers only explicit source-residue and placement observations on translated table targets", () => {
  const deferred = [finding("source_residue"), finding("placement")];
  const blocking = [
    finding("semantic_mismatch"),
    finding("unreadable"),
    finding("missing_translation"),
    // Unexpected provider findings must fail closed, even if a future model
    // adds types that the application has not yet learned to classify.
    finding("structural"),
    finding("preservation"),
    finding("new_unknown_failure"),
    finding("placement", "MTEXT:1"),
    { ...finding("source_residue"), sourceBlockId: undefined },
  ];
  const result = normalizeNativeDxfHybridAuditFindings(
    [...deferred, ...blocking], tables, translations, "en",
  );
  assert.deepEqual(result.deferredFindings, deferred);
  assert.deepEqual(result.effectiveFindings, blocking);
});

test("deferred table observations cannot hide missing or wrong-language replacements", () => {
  const observations = [finding("source_residue"), finding("placement")];
  for (const replacement of [new Map<string, string>(), new Map([[tableId, "Помещение"]])]) {
    const result = normalizeNativeDxfHybridAuditFindings(
      observations, tables, replacement, "en",
    );
    assert.deepEqual(result.deferredFindings, []);
    assert.deepEqual(result.effectiveFindings, observations);
  }
  const wrongTarget = normalizeNativeDxfHybridAuditFindings(
    observations, tables, translations, "ja",
  );
  assert.deepEqual(wrongTarget.deferredFindings, []);
  assert.deepEqual(wrongTarget.effectiveFindings, observations);
});