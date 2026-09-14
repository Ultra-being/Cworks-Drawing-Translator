import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  encodeNativeDxfInspectionCache,
  MAX_NATIVE_DXF_INSPECTION_CACHE_EXPANDED_BYTES,
  nativeDxfInspectionCacheKey,
  nativeDxfPlacementManifestSha256,
  nativeDxfProcessorFingerprint,
  readNativeDxfInspectionCache,
} from "./native-dxf-inspection-cache";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function inventoryFor(sourceSha256: string) {
  const placementManifest = [{
    definitionBlock: null,
    handle: "A",
    insertPath: [],
    placementId: "A:direct",
    x: 1,
    y: 2,
  }];
  return {
    sha256: sourceSha256,
    placementManifestSha256: nativeDxfPlacementManifestSha256(placementManifest)!,
    placementCount: 1,
    placementManifest,
    textEntries: [{
      handle: "A",
      definitionBlock: null,
      placements: [{
        placementId: "A:direct",
        x: 1,
        y: 2,
        insertPath: [],
      }],
    }],
    tableTargets: [],
    splitFragmentGroups: [],
    dimensionCacheBindings: [],
    unresolvedVisibleText: [],
  };
}

test("native DXF inspection cache accepts only an intact source and processor binding", () => {
  const sourceSha256 = sha256("source");
  const processorSha256 = sha256("processor");
  const inventory = inventoryFor(sourceSha256);
  const encoded = encodeNativeDxfInspectionCache(
    inventory,
    Buffer.from(JSON.stringify(inventory)),
    sourceSha256,
    processorSha256,
  );
  assert.ok(encoded);
  assert.match(
    nativeDxfInspectionCacheKey("job/id", sourceSha256, processorSha256),
    /job%2Fid\/inspection-cache/,
  );
  assert.equal(
    readNativeDxfInspectionCache(encoded, sourceSha256, processorSha256).reason,
    "hit",
  );
  assert.equal(
    readNativeDxfInspectionCache(encoded, sha256("changed source"), processorSha256).inventory,
    null,
    "a changed source never accepts an old inspector result",
  );
  assert.equal(
    readNativeDxfInspectionCache(encoded, sourceSha256, sha256("changed parser")).inventory,
    null,
    "a changed processor never accepts an old inspector result",
  );

  const corrupt = Buffer.from(encoded);
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.equal(
    readNativeDxfInspectionCache(corrupt, sourceSha256, processorSha256).inventory,
    null,
    "corrupt compressed cache data falls back to inspection",
  );
});

test("native DXF inspection cache rejects a placement manifest altered after inspection", () => {
  const sourceSha256 = sha256("source");
  const processorSha256 = sha256("processor");
  const inventory = inventoryFor(sourceSha256);
  inventory.placementManifest[0].x = 9;
  // This mimics a stale or manually altered payload that did not come from the
  // parser's canonical placement-manifest calculation.
  const encoded = encodeNativeDxfInspectionCache(
    inventory,
    Buffer.from(JSON.stringify(inventory)),
    sourceSha256,
    processorSha256,
  );
  assert.equal(encoded, null);
});

test("native DXF inspection cache bounds decompression and fingerprints parser dependencies", () => {
  const sourceSha256 = sha256("source");
  const processorSha256 = sha256("processor");
  const header = Buffer.from(`${JSON.stringify({
    format: "cworks-native-dxf-inspection-cache-v1",
    sourceSha256,
    processorSha256,
    payloadSha256: sha256("x"),
    payloadBytes: MAX_NATIVE_DXF_INSPECTION_CACHE_EXPANDED_BYTES + 1,
    contentEncoding: "gzip",
  })}\n`);
  const zipBomb = Buffer.concat([header, gzipSync(Buffer.alloc(1, 0))]);
  assert.equal(
    readNativeDxfInspectionCache(zipBomb, sourceSha256, processorSha256).inventory,
    null,
    "declared oversized expanded data is rejected before decompression",
  );
  const processor = Buffer.from("processor");
  const first = nativeDxfProcessorFingerprint([
    { name: "dxf_processor.py", content: processor },
    { name: "dxf_table_cells.py", content: Buffer.from("cells-v1") },
  ]);
  const second = nativeDxfProcessorFingerprint([
    { name: "dxf_processor.py", content: processor },
    { name: "dxf_table_cells.py", content: Buffer.from("cells-v2") },
  ]);
  assert.notEqual(first, second, "an imported processor dependency invalidates old cache output");
});

test("native DXF inspection cache accepts the captured Python inventory codec", async (t) => {
  let inventoryJson: Buffer;
  try {
    inventoryJson = await fs.readFile("/tmp/dxf-inventory.json");
  } catch {
    t.skip("captured DXF inventory fixture is available only in the inspection environment");
    return;
  }
  const inventory = JSON.parse(inventoryJson.toString("utf8"));
  const sourceSha256 = inventory.sha256;
  assert.match(sourceSha256, /^[a-f0-9]{64}$/u);
  const processorSha256 = sha256("captured-processor");
  const encoded = encodeNativeDxfInspectionCache(
    inventory,
    inventoryJson,
    sourceSha256,
    processorSha256,
  );
  assert.ok(encoded, "Python float formatting must not make a valid inventory uncacheable");
  assert.equal(
    readNativeDxfInspectionCache(encoded, sourceSha256, processorSha256).reason,
    "hit",
  );
});