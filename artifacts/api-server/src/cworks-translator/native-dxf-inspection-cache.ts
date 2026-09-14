import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const NATIVE_DXF_INSPECTION_CACHE_FORMAT = "cworks-native-dxf-inspection-cache-v1";
export const MAX_NATIVE_DXF_INSPECTION_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_NATIVE_DXF_INSPECTION_CACHE_EXPANDED_BYTES = 64 * 1024 * 1024;

type NativeDxfInspectionCacheEnvelope = {
  format: typeof NATIVE_DXF_INSPECTION_CACHE_FORMAT;
  sourceSha256: string;
  processorSha256: string;
  payloadSha256: string;
  payloadBytes: number;
  contentEncoding: "gzip";
};

export type NativeDxfInspectionCacheReadResult =
  | { inventory: Record<string, unknown>; reason: "hit" }
  | { inventory: null; reason: string };

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function nativeDxfProcessorFingerprint(
  files: ReadonlyArray<{ name: string; content: Buffer }>,
): string {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    digest.update(file.name, "utf8");
    digest.update("\0", "utf8");
    digest.update(sha256(file.content), "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * This has the same key ordering and compact separators as Python's
 * json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":")).
 * DXF inventory coordinates are parser values, so ordinary JSON primitives are
 * sufficient here. It is deliberately not used for arbitrary application data.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("invalid JSON value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function pythonFloatJson(value: number): string {
  if (!Number.isFinite(value)) throw new Error("non-finite placement coordinate");
  if (Object.is(value, -0)) return "-0.0";
  const absolute = Math.abs(value);
  let rendered = absolute !== 0 && (absolute >= 1e16 || absolute < 1e-4)
    ? value.toExponential()
    : value.toString();
  const exponent = rendered.match(/^(.*e[+-])(\d+)$/u);
  if (exponent) rendered = `${exponent[1]}${exponent[2].padStart(2, "0")}`;
  return /[.e]/u.test(rendered) ? rendered : `${rendered}.0`;
}

function inventoryPlacementManifestSha256(
  inventory: Record<string, unknown>,
): { count: number; sha256: string } | null {
  const entries = inventory.textEntries;
  if (!Array.isArray(entries)) return null;
  try {
    const digest = createHash("sha256");
    let count = 0;
    digest.update("[", "utf8");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const textEntry = entry as Record<string, unknown>;
      if (
        typeof textEntry.handle !== "string"
        || !hasOwn(textEntry, "definitionBlock")
        || !Array.isArray(textEntry.placements)
      ) return null;
      for (const placement of textEntry.placements) {
        if (!placement || typeof placement !== "object" || Array.isArray(placement)) return null;
        const value = placement as Record<string, unknown>;
        if (
          typeof value.placementId !== "string"
          || typeof value.x !== "number"
          || typeof value.y !== "number"
          || !Number.isFinite(value.x)
          || !Number.isFinite(value.y)
          || !Array.isArray(value.insertPath)
        ) return null;
        if (count++) digest.update(",", "utf8");
        digest.update(`{"definitionBlock":${canonicalJson(textEntry.definitionBlock)},"handle":${canonicalJson(textEntry.handle)},"insertPath":${canonicalJson(value.insertPath)},"placementId":${canonicalJson(value.placementId)},"x":${pythonFloatJson(value.x)},"y":${pythonFloatJson(value.y)}}`, "utf8");
      }
    }
    digest.update("]", "utf8");
    return { count, sha256: digest.digest("hex") };
  } catch {
    return null;
  }
}

/**
 * The native processor builds this exact list using Python floats. JSON.parse
 * loses a trailing ".0", so normal JSON.stringify is not equivalent for DXF
 * coordinates; recreate Python's compact float spelling for its two numeric
 * fields before checking the processor's placement evidence.
 */
export function nativeDxfPlacementManifestSha256(manifest: unknown): string | null {
  if (!Array.isArray(manifest)) return null;
  try {
    const digest = createHash("sha256");
    digest.update("[", "utf8");
    for (let index = 0; index < manifest.length; index++) {
      const item = manifest[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid placement");
      const value = item as Record<string, unknown>;
      if (
        typeof value.placementId !== "string"
        || typeof value.handle !== "string"
        || !hasOwn(value, "definitionBlock")
        || typeof value.x !== "number"
        || typeof value.y !== "number"
        || !Array.isArray(value.insertPath)
      ) throw new Error("invalid placement");
      if (index) digest.update(",", "utf8");
      digest.update(`{"definitionBlock":${canonicalJson(value.definitionBlock)},"handle":${canonicalJson(value.handle)},"insertPath":${canonicalJson(value.insertPath)},"placementId":${canonicalJson(value.placementId)},"x":${pythonFloatJson(value.x)},"y":${pythonFloatJson(value.y)}}`, "utf8");
    }
    digest.update("]", "utf8");
    return digest.digest("hex");
  } catch {
    return null;
  }
}

/**
 * Cache eligibility is intentionally stricter than ordinary inspection
 * consumption. A cache is optional, so a missing newer parser field simply
 * triggers a fresh inspection instead of making a job unrecoverable.
 */
export function validateNativeDxfInspectionInventory(
  inventory: unknown,
  sourceSha256: string,
): inventory is Record<string, unknown> {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return false;
  const value = inventory as Record<string, unknown>;
  if (
    value.sha256 !== sourceSha256
    || !isSha256(value.placementManifestSha256)
    || !Number.isInteger(value.placementCount)
    || (value.placementCount as number) < 0
    || !Array.isArray(value.placementManifest)
    || !Array.isArray(value.textEntries)
    || !Array.isArray(value.tableTargets)
    || !Array.isArray(value.splitFragmentGroups)
    || !Array.isArray(value.dimensionCacheBindings)
    || !Array.isArray(value.unresolvedVisibleText)
  ) return false;
  const derivedManifest = inventoryPlacementManifestSha256(value);
  if (!derivedManifest || derivedManifest.count !== value.placementCount) return false;
  try {
    const suppliedManifest = value.placementManifest;
    const computedPlacementSha256 = nativeDxfPlacementManifestSha256(suppliedManifest);
    return suppliedManifest.length === value.placementCount
      && computedPlacementSha256 === value.placementManifestSha256
      && derivedManifest.sha256 === value.placementManifestSha256;
  } catch {
    return false;
  }
}

export function nativeDxfInspectionCacheKey(
  jobId: string,
  sourceSha256: string,
  processorSha256: string,
): string {
  if (!isSha256(sourceSha256) || !isSha256(processorSha256)) {
    throw new Error("Native DXF inspection cache key requires SHA-256 digests");
  }
  // job IDs are generated by the application, but encoding also makes this
  // safe if an imported legacy ID contains a storage path delimiter.
  return `cworks-translator/${encodeURIComponent(jobId)}/inspection-cache/${sourceSha256}/${processorSha256}.json.gz`;
}

export function encodeNativeDxfInspectionCache(
  inventory: unknown,
  inventoryJson: Buffer,
  sourceSha256: string,
  processorSha256: string,
  maxBytes = MAX_NATIVE_DXF_INSPECTION_CACHE_BYTES,
): Buffer | null {
  if (
    inventoryJson.length > MAX_NATIVE_DXF_INSPECTION_CACHE_EXPANDED_BYTES
    || !isSha256(processorSha256)
    || !validateNativeDxfInspectionInventory(inventory, sourceSha256)
  ) {
    return null;
  }
  try {
    const envelope: NativeDxfInspectionCacheEnvelope = {
      format: NATIVE_DXF_INSPECTION_CACHE_FORMAT,
      sourceSha256,
      processorSha256,
      payloadSha256: sha256(inventoryJson),
      payloadBytes: inventoryJson.length,
      contentEncoding: "gzip",
    };
    const header = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    const compressed = gzipSync(inventoryJson);
    const content = Buffer.concat([header, compressed], header.length + compressed.length);
    return content.length <= maxBytes ? content : null;
  } catch {
    return null;
  }
}

export function readNativeDxfInspectionCache(
  content: Buffer,
  sourceSha256: string,
  processorSha256: string,
): NativeDxfInspectionCacheReadResult {
  if (content.length > MAX_NATIVE_DXF_INSPECTION_CACHE_BYTES) {
    return { inventory: null, reason: "compressed_size" };
  }
  try {
    const headerEnd = content.indexOf(0x0a);
    if (headerEnd < 1 || headerEnd > 2_048) return { inventory: null, reason: "header" };
    const envelope = JSON.parse(
      content.subarray(0, headerEnd).toString("utf8"),
    ) as Partial<NativeDxfInspectionCacheEnvelope>;
    if (
      envelope.format !== NATIVE_DXF_INSPECTION_CACHE_FORMAT
      || envelope.sourceSha256 !== sourceSha256
      || envelope.processorSha256 !== processorSha256
      || !isSha256(envelope.payloadSha256)
      || !Number.isInteger(envelope.payloadBytes)
      || envelope.payloadBytes! < 0
      || envelope.payloadBytes! > MAX_NATIVE_DXF_INSPECTION_CACHE_EXPANDED_BYTES
      || envelope.contentEncoding !== "gzip"
    ) return { inventory: null, reason: "binding_or_shape" };
    const payload = gunzipSync(content.subarray(headerEnd + 1), {
      maxOutputLength: MAX_NATIVE_DXF_INSPECTION_CACHE_EXPANDED_BYTES,
    });
    if (payload.length !== envelope.payloadBytes || sha256(payload) !== envelope.payloadSha256) {
      return { inventory: null, reason: "payload_checksum" };
    }
    const inventory = JSON.parse(payload.toString("utf8"));
    if (!validateNativeDxfInspectionInventory(inventory, sourceSha256)) {
      return { inventory: null, reason: "binding_or_shape" };
    }
    return { inventory, reason: "hit" };
  } catch {
    return { inventory: null, reason: "corrupt" };
  }
}