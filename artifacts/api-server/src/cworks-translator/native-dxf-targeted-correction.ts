/**
 * A correction is deliberately distinct from a failed-job resume.  It carries
 * the exact predecessor revision and only immutable target IDs that were
 * unresolved or named by the independent audit.  The worker still rebinds
 * this intent to the source, language, policy, and placement manifest before
 * it may send anything to a provider.
 */
export const NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND =
  "cworks-native-dxf-targeted-correction-v1";

export type NativeDxfTargetedCorrectionBrief = {
  kind: typeof NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND;
  sourceRevision: number;
  targetLanguage: "en" | "ja";
  consented: true;
  /** This revision gets exactly this one explicit translation correction pass. */
  correctionBudget: 1;
  targetIds: string[];
  requestedAt: string;
};

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item && typeof item === "object" && typeof (item as any).targetId === "string"
      ? [(item as any).targetId]
      : []);
}

function findingIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item && typeof item === "object" && typeof (item as any).sourceBlockId === "string"
      ? [(item as any).sourceBlockId]
      : []);
}

function isValidRequestedAt(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

/**
 * Do not trust page findings alone: unresolved visible/raster findings are not
 * patchable DXF text.  The predecessor ledger is the immutable allow-list.
 */
export function nativeDxfTargetedCorrectionTargetIds(
  checkpoint: unknown,
  pageFindings: unknown[] = [],
): string[] {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return [];
  const ledger = (checkpoint as any).ledger;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return [];
  const allowed = new Set([
    ...stringIds((ledger as any).entries),
    ...stringIds((ledger as any).tableTargets),
  ]);
  if (!allowed.size) return [];
  const requested = new Set([
    ...stringIds((ledger as any).unresolved),
    ...stringIds((ledger as any).blockingFindings),
    ...findingIds((ledger as any).blockingFindings),
    ...findingIds((ledger as any).independentAudit?.findings),
    ...findingIds((ledger as any).independentAudit?.rawFindings),
    ...pageFindings.flatMap(findingIds),
  ]);
  return [...requested].filter((id) => allowed.has(id)).sort();
}

export function buildNativeDxfTargetedCorrectionBrief(input: {
  sourceRevision: number;
  targetLanguage: unknown;
  checkpoint: unknown;
  pageFindings?: unknown[];
  requestedAt?: string;
}): NativeDxfTargetedCorrectionBrief | null {
  if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 0) return null;
  const targetLanguage = input.targetLanguage === "ja" ? "ja"
    : input.targetLanguage === "en" ? "en" : null;
  const targetIds = nativeDxfTargetedCorrectionTargetIds(
    input.checkpoint,
    input.pageFindings,
  );
  if (!targetLanguage || !targetIds.length || targetIds.length > 10_000) return null;
  return {
    kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND,
    sourceRevision: input.sourceRevision,
    targetLanguage,
    consented: true,
    correctionBudget: 1,
    targetIds,
    requestedAt: input.requestedAt || new Date().toISOString(),
  };
}

export function isNativeDxfTargetedCorrectionBrief(
  value: unknown,
): value is NativeDxfTargetedCorrectionBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const brief = value as Partial<NativeDxfTargetedCorrectionBrief> | null;
  return Boolean(
    brief.kind === NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND
    && Number.isInteger(brief.sourceRevision)
    && brief.sourceRevision >= 0
    && (brief.targetLanguage === "en" || brief.targetLanguage === "ja")
    && brief.consented === true
    && brief.correctionBudget === 1
    && isValidRequestedAt(brief.requestedAt)
    && Array.isArray(brief.targetIds)
    && brief.targetIds.length > 0
    && brief.targetIds.length <= 10_000
    && brief.targetIds.every((id) => typeof id === "string" && Boolean(id.trim()))
    && new Set(brief.targetIds).size === brief.targetIds.length,
  );
}

/** Detect the reserved kind separately from validation so malformed consent can fail closed. */
export function hasNativeDxfTargetedCorrectionKind(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as any).kind === NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND,
  );
}