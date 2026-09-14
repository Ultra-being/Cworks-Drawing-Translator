import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeDxfProcess } from "../../src/cworks-translator/native-dxf-process";

type InventoryEntry = {
  targetId: string;
  entityType: string;
  handle: string;
  plainText: string;
  isCyrillicTarget: boolean;
  preservedDrawingCodeCandidate: boolean;
  patchableInDxf: boolean;
  deferredTableCache: boolean;
};

type Inventory = {
  sha256: string;
  lineEnding: string;
  visibleTextCount: number;
  cyrillicTargetCount: number;
  tableTargetCount: number;
  placementCount: number;
  placementManifestSha256: string;
  textEntries: InventoryEntry[];
  dimensionCacheBindings: Array<{
    dimensionTargetId: string;
    cacheTargetId: string;
  }>;
};

type PatchReport = {
  sourceSha256: string;
  outputSha256: string;
  targetLanguage: "en" | "ja";
  approvedChanges: Array<{
    targetId: string;
    sourceRanges: Array<[number, number]>;
    outputRanges: Array<[number, number]>;
  }>;
  unresolved: unknown[];
  lineEndingPreserved: boolean;
  reparsedCleanly: boolean;
  nonApprovedSegmentsIdentical: boolean;
  placementCount: number;
  placementManifestSha256: string;
};

const EXPECTED_SOURCE_SHA256 =
  "73a1711a5e35750cfc30e78bfc31c767da26edc6663a1bfea23e38f095a299ac";
const EXPECTED_SOURCE_BYTES = 47_341_153;
const PROCESS_JOB_LABEL = "opt-in-native-dxf-smoke-not-a-job";
const STAGE_TIMEOUT_MS = 90_000;
const PREVIEW_TIMEOUT_MS = 60_000;
const WHOLE_HARNESS_TIMEOUT_MS = 300_000;
const CYRILLIC = /[\u0400-\u04ff]/u;
const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/u;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function rssMiB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function stage(
  timings: Record<string, number>,
  name: string,
  processor: string,
  command: "inspect" | "patch" | "preview",
  args: string[],
  timeoutMs: number,
): Promise<void> {
  const started = performance.now();
  await runNativeDxfProcess(processor, command, args, {
    jobId: PROCESS_JOB_LABEL,
    timeoutMs,
  });
  const elapsed = Math.round(performance.now() - started);
  timings[name] = elapsed;
  assert.ok(elapsed <= timeoutMs + 2_000, `${name} exceeded its bounded stage allowance`);
}

function placeholderSuffix(source: string): string {
  // The native processor itself retains MTEXT controls. These are the visible
  // CAD substitution tokens for which changing the token would change meaning.
  const tokens = source.match(/<>|%<.*?>%/gu) ?? [];
  return [...new Set(tokens)].join(" ");
}

function replacementFor(entry: InventoryEntry, language: "en" | "ja"): string {
  const suffix = placeholderSuffix(entry.plainText);
  const word = language === "ja" ? "日" : "A";
  return suffix ? `${word} ${suffix}` : word;
}

function expectedChangedTargets(
  selected: InventoryEntry[],
  inventory: Inventory,
): Set<string> {
  const expected = new Set(selected.map((entry) => entry.targetId));
  for (const binding of inventory.dimensionCacheBindings) {
    if (expected.has(binding.dimensionTargetId) || expected.has(binding.cacheTargetId)) {
      expected.add(binding.dimensionTargetId);
      expected.add(binding.cacheTargetId);
    }
  }
  return expected;
}

function assertNonApprovedBytes(
  source: Buffer,
  output: Buffer,
  report: PatchReport,
): void {
  const ranges = report.approvedChanges
    .flatMap((change) => change.sourceRanges.map((sourceRange, index) => ({
      sourceRange,
      outputRange: change.outputRanges[index],
    })))
    .sort((a, b) => a.sourceRange[0] - b.sourceRange[0]);
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const { sourceRange, outputRange } of ranges) {
    assert.deepEqual(
      output.subarray(outputCursor, outputRange[0]),
      source.subarray(sourceCursor, sourceRange[0]),
      `non-approved bytes before source offset ${sourceRange[0]} changed`,
    );
    sourceCursor = sourceRange[1];
    outputCursor = outputRange[1];
  }
  assert.deepEqual(
    output.subarray(outputCursor),
    source.subarray(sourceCursor),
    "non-approved trailing bytes changed",
  );
}

async function runLanguage(
  language: "en" | "ja",
  processor: string,
  sourcePath: string,
  source: Buffer,
  workspace: string,
  timings: Record<string, number>,
): Promise<Record<string, unknown>> {
  const prefix = path.join(workspace, language);
  const inventoryPath = `${prefix}-source-inventory.json`;
  const replacementsPath = `${prefix}-replacements.json`;
  const outputPath = `${prefix}-output.dxf`;
  const reportPath = `${prefix}-patch-report.json`;
  const sourcePreviewPath = `${prefix}-source.svg`;
  const outputPreviewPath = `${prefix}-output.svg`;
  const outputInventoryPath = `${prefix}-output-inventory.json`;

  await stage(timings, `${language}.inspect-source`, processor, "inspect",
    [sourcePath, inventoryPath], STAGE_TIMEOUT_MS);
  const inventory = await readJson<Inventory>(inventoryPath);
  assert.equal(inventory.sha256, EXPECTED_SOURCE_SHA256);
  assert.equal(inventory.sha256, sha256(source));
  assert.equal(inventory.lineEnding, "CRLF");

  const selected = inventory.textEntries.filter((entry) =>
    entry.isCyrillicTarget
    && entry.patchableInDxf
    && !entry.preservedDrawingCodeCandidate
    && !entry.deferredTableCache);
  assert.ok(selected.length > 0, "fixture has no safe Cyrillic targets");
  assert.ok(selected.some((entry) => entry.entityType === "MTEXT"),
    "fixture safe target set does not exercise MTEXT");
  assert.ok(selected.every((entry) => CYRILLIC.test(entry.plainText)));
  assert.ok(selected.every((entry) => !entry.deferredTableCache),
    "a generated table cache entered the replacement set");

  const translations = selected.map((entry) => ({
    targetId: entry.targetId,
    translation: replacementFor(entry, language),
  }));
  assert.ok(translations.every(({ translation }) =>
    language === "ja" ? JAPANESE.test(translation) : !JAPANESE.test(translation)));
  await writeFile(replacementsPath, JSON.stringify({
    targetLanguage: language,
    translations,
  }));

  await stage(timings, `${language}.patch`, processor, "patch",
    [sourcePath, replacementsPath, outputPath, reportPath], STAGE_TIMEOUT_MS);
  const [output, report] = await Promise.all([
    readFile(outputPath),
    readJson<PatchReport>(reportPath),
  ]);
  assert.equal(report.sourceSha256, EXPECTED_SOURCE_SHA256);
  assert.equal(report.outputSha256, sha256(output));
  assert.equal(report.targetLanguage, language);
  assert.equal(report.unresolved.length, 0, "safe replacements must all be approved");
  assert.equal(report.reparsedCleanly, true);
  assert.equal(report.lineEndingPreserved, true);
  assert.equal(report.nonApprovedSegmentsIdentical, true);
  assert.equal(report.placementCount, inventory.placementCount);
  assert.equal(report.placementManifestSha256, inventory.placementManifestSha256);
  assert.deepEqual(
    new Set(report.approvedChanges.map((change) => change.targetId)),
    expectedChangedTargets(selected, inventory),
    "approved target set differs from safe requested targets plus dimension caches",
  );
  assertNonApprovedBytes(source, output, report);
  assert.ok(!/(^|[^\r])\n/.test(output.toString("utf8")),
    "output introduced a non-CRLF record ending");

  await stage(timings, `${language}.inspect-output`, processor, "inspect",
    [outputPath, outputInventoryPath], STAGE_TIMEOUT_MS);
  const outputInventory = await readJson<Inventory>(outputInventoryPath);
  assert.equal(outputInventory.sha256, report.outputSha256);
  assert.equal(outputInventory.lineEnding, "CRLF");
  assert.equal(outputInventory.placementCount, inventory.placementCount);
  assert.equal(outputInventory.placementManifestSha256, inventory.placementManifestSha256);
  const outputByTarget = new Map(
    outputInventory.textEntries.map((entry) => [entry.targetId, entry]),
  );
  const sourceByTarget = new Map(
    inventory.textEntries.map((entry) => [entry.targetId, entry]),
  );
  for (const change of report.approvedChanges) {
    const changed = outputByTarget.get(change.targetId);
    assert.ok(changed, `independent output reparse lost ${change.targetId}`);
    assert.ok(
      language === "ja"
        ? JAPANESE.test(changed.plainText)
        : !CYRILLIC.test(changed.plainText.replace(/%<.*?>%/gu, "")),
      `${change.targetId} does not contain actual ${language === "ja" ? "Japanese" : "English"} output`,
    );
    assert.equal(
      placeholderSuffix(changed.plainText),
      placeholderSuffix(sourceByTarget.get(change.targetId)?.plainText ?? ""),
      `${change.targetId} did not preserve its visible CAD substitution tokens`,
    );
  }
  for (const binding of inventory.dimensionCacheBindings) {
    if (!expectedChangedTargets(selected, inventory).has(binding.dimensionTargetId)) continue;
    assert.equal(
      outputByTarget.get(binding.dimensionTargetId)?.plainText,
      outputByTarget.get(binding.cacheTargetId)?.plainText,
      `dimension/cache text diverged for ${binding.dimensionTargetId}`,
    );
  }

  // Preview failures intentionally propagate: a broken real-fixture preview is
  // a smoke-test finding, not an optional assertion to suppress.
  await stage(timings, `${language}.preview-source`, processor, "preview",
    [sourcePath, sourcePreviewPath], PREVIEW_TIMEOUT_MS);
  await stage(timings, `${language}.preview-output`, processor, "preview",
    [outputPath, outputPreviewPath], PREVIEW_TIMEOUT_MS);
  const [sourcePreview, outputPreview] = await Promise.all([
    readFile(sourcePreviewPath, "utf8"),
    readFile(outputPreviewPath, "utf8"),
  ]);
  assert.ok(sourcePreview.length > 100 && sourcePreview.includes("<svg"));
  assert.ok(outputPreview.length > 100 && outputPreview.includes("<svg"));
  if (language === "ja") assert.ok(JAPANESE.test(outputPreview), "Japanese preview is empty");

  return {
    requestedSafeTargets: selected.length,
    approvedTargets: report.approvedChanges.length,
    approvedMtextTargets: report.approvedChanges.filter((change) =>
      outputByTarget.get(change.targetId)?.entityType === "MTEXT").length,
    tableTargetsExcluded: inventory.tableTargetCount,
    placementCount: inventory.placementCount,
    outputSha256: report.outputSha256,
    sourcePreviewBytes: Buffer.byteLength(sourcePreview),
    outputPreviewBytes: Buffer.byteLength(outputPreview),
  };
}

async function main(): Promise<void> {
  // Keep the normal verification path side-effect free. This command is
  // deliberately a no-op unless a developer explicitly opts in; in
  // particular, do not even read the large fixture on the default path.
  if (process.env.RUN_NATIVE_DXF_REAL_SMOKE !== "1") {
    console.log(JSON.stringify({
      status: "skipped",
      reason: "set RUN_NATIVE_DXF_REAL_SMOKE=1 to run the bounded fixture smoke",
      networkRequests: 0,
      aiRequests: 0,
      productionJobs: 0,
    }, null, 2));
    return;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../../../..");
  const sourcePath = path.join(root, "attached_assets/0_Architecture_1788835080215.dxf");
  const processor = path.resolve(here, "../../src/cworks-translator/dxf_processor.py");
  const source = await readFile(sourcePath);
  assert.equal(source.length, EXPECTED_SOURCE_BYTES);
  assert.equal(sha256(source), EXPECTED_SOURCE_SHA256);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "native-dxf-real-smoke-"));
  const timings: Record<string, number> = {};
  const started = performance.now();
  const initialRssMiB = rssMiB();
  try {
    const english = await runLanguage(
      "en", processor, sourcePath, source, workspace, timings,
    );
    const japanese = await runLanguage(
      "ja", processor, sourcePath, source, workspace, timings,
    );
    const elapsedMs = Math.round(performance.now() - started);
    assert.ok(elapsedMs <= WHOLE_HARNESS_TIMEOUT_MS, "whole harness exceeded five minutes");
    console.log(JSON.stringify({
      status: "passed",
      fixture: path.basename(sourcePath),
      sourceBytes: source.length,
      sourceSha256: EXPECTED_SOURCE_SHA256,
      languagesRunSequentially: ["en", "ja"],
      english,
      japanese,
      timingsMs: timings,
      elapsedMs,
      memory: {
        scope: "Node harness RSS only; child peak RSS unavailable through wrapper",
        initialRssMiB,
        finalRssMiB: rssMiB(),
      },
      coverage: [
        "real AC1032 fixture through runNativeDxfProcess inspect/patch/preview",
        "all patchable non-code Cyrillic visible-text targets, including MTEXT",
        "dimension override/cache mirroring and table-cache exclusion",
        "independent output reparse, hashes, CRLF, placement manifest",
        "independent byte comparison of every non-approved segment",
        "nonempty source/output SVG and actual Japanese output",
      ],
      limitations: [
        "deterministic smoke replacements are not semantic translations",
        "ACAD_TABLE text and generated table caches are intentionally excluded",
        "strict native structural validation is not AutoCAD rendering validation",
        "SVG preview is processor diagnostic output, not AutoCAD",
      ],
      autoCadValidated: false,
    }, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();