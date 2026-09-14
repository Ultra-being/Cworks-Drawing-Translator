import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  cworksTranslationCheckpoints,
  cworksTranslationCleanup,
  cworksTranslationJobs,
} from "@workspace/db/schema";
import {
  claimNextJob,
  nativeDxfCheckpointMethodologyHash,
  runNativeDxfJobAttempt,
  type CworksJob,
  type NativeDxfJobAttemptOptions,
} from "./worker";
import { buildNativeDxfCheckpoint } from "./native-dxf-checkpoints";
import { NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND } from "./native-dxf-targeted-correction";

function responseFor(prompt: string, translation: string): string {
  const targets = JSON.parse(prompt.slice(prompt.lastIndexOf("\ntargets: ") + 10));
  return JSON.stringify({
    translations: targets.map((target: any) => ({
      targetId: target.targetId,
      translation,
    })),
  });
}

test("consented DXF correction reuses predecessor translations, re-audits, syncs cache, and resumes", async () => {
  const id = `native-dxf-targeted-correction-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifestSha256 = createHash("sha256").update("placements").digest("hex");
  const stored = new Map<string, Buffer>([[`cworks-translator/${id}/source.dxf`, source]]);
  let translationCalls = 0;
  let auditCalls = 0;
  let patchCalls = 0;
  const options: NativeDxfJobAttemptOptions = {
    readObject: async (name) => stored.get(name) || null,
    writeObject: async (name, body) => {
      stored.set(name, Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
    deleteObject: async (name) => { stored.delete(name); },
    runProcess: async (_processor, stage, args) => {
      if (stage === "inspect") {
        await fs.writeFile(args[1], JSON.stringify({
          sha256: sourceSha256,
          placementManifestSha256,
          placementCount: 3,
          textEntries: [
            ["DIMENSION:1", "DIM", "Размер"], ["CACHE:1", "CACHE", "Размер"],
            ["MTEXT:UNCHANGED", "OTHER", "Прочее"],
          ].map(([targetId, handle, plainText]) => ({
            targetId, entityType: "MTEXT", handle, plainText, rawText: plainText,
            isCyrillicTarget: true, patchableInDxf: true,
            preservedDrawingCodeCandidate: false, placementCount: 1,
          })),
          tableTargets: [],
          splitFragmentGroups: [],
          dimensionCacheBindings: [{ dimensionTargetId: "DIMENSION:1", cacheTargetId: "CACHE:1" }],
          unresolvedVisibleText: [],
        }));
        return;
      }
      if (stage === "patch") {
        patchCalls++;
        await fs.copyFile(args[0], args[2]);
        await fs.writeFile(args[3], JSON.stringify({
          approvedChanges: [{ targetId: "DIMENSION:1" }, { targetId: "CACHE:1" }, { targetId: "MTEXT:UNCHANGED" }],
          unresolved: [],
        }));
        return;
      }
      await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    },
    askTranslator: async (prompt) => {
      translationCalls++;
      assert.match(prompt, /DIMENSION:1|handle":"DIM/);
      assert.doesNotMatch(prompt, /MTEXT:UNCHANGED|Прочее/);
      return responseFor(prompt, "Corrected dimension");
    },
    askAuditor: async () => {
      auditCalls++;
      if (auditCalls === 1) throw new Error("simulated interruption after saved targeted correction");
      return JSON.stringify({ passed: true, findings: [] });
    },
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Targeted correction resume",
    status: "running",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    sourceFormat: "dxf",
    originalFilename: "targeted.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`,
    revisionCount: 1,
    repairBrief: {
      kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND,
      sourceRevision: 0,
      targetLanguage: "en",
      consented: true,
      correctionBudget: 1,
      targetIds: ["DIMENSION:1"],
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const predecessor = buildNativeDxfCheckpoint({
    sourceSha256,
    revisionCount: 0,
    targetLanguage: "en",
    methodologyHash: nativeDxfCheckpointMethodologyHash("en"),
    placementManifestSha256,
  }, {
    stage: "pre_patch",
    completedBatchCount: 1,
    translations: {
      "DIMENSION:1": "Old dimension",
      "CACHE:1": "Old dimension",
      "MTEXT:UNCHANGED": "Unchanged",
    },
    audit: {
      pageNumber: 1,
      status: "findings",
      model: "independent",
      findings: [{ type: "semantic_mismatch", message: "Correct dimension", sourceBlockId: "DIMENSION:1" }],
    },
    auditIndex: 2,
    correctionDiagnostics: [],
    ledger: {
      entries: [
        { targetId: "DIMENSION:1" }, { targetId: "CACHE:1" }, { targetId: "MTEXT:UNCHANGED" },
      ],
      tableTargets: [],
      unresolved: [{ targetId: "DIMENSION:1" }],
      blockingFindings: [{ targetId: "DIMENSION:1" }],
      independentAudit: { findings: [{ sourceBlockId: "DIMENSION:1" }] },
    },
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id, revisionCount: 0, pageNumber: 1, sourceHash: sourceSha256, translations: predecessor,
  });
  try {
    const [first] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(first, options);
    const [interrupted] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(interrupted.status, "queued");
    assert.equal(translationCalls, 1);
    assert.equal(patchCalls, 0);
    const [savedCorrection] = await db.select().from(cworksTranslationCheckpoints).where(
      and(
        eq(cworksTranslationCheckpoints.jobId, id),
        eq(cworksTranslationCheckpoints.revisionCount, 1),
      ),
    );
    assert.equal((savedCorrection.translations as any).stage, "correction");
    assert.equal((savedCorrection.translations as any).targetedCorrectionPendingReaudit, true);

    const replacement = await claimNextJob({ jobId: id });
    assert.ok(replacement);
    await runNativeDxfJobAttempt(replacement as CworksJob, options);
    const [finished] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(finished.status, "awaiting_review", finished.errorMessage);
    assert.equal(translationCalls, 1, "interruption resumes saved correction without a new targeted call");
    assert.equal(auditCalls, 2, "complete independent audit is retried after the saved correction");
    assert.equal(patchCalls, 1);
    const [successor] = await db.select().from(cworksTranslationCheckpoints).where(
      and(
        eq(cworksTranslationCheckpoints.jobId, id),
        eq(cworksTranslationCheckpoints.revisionCount, 1),
      ),
    );
    assert.deepEqual((successor.translations as any).translations, {
      "CACHE:1": "Corrected dimension",
      "DIMENSION:1": "Corrected dimension",
      "MTEXT:UNCHANGED": "Unchanged",
    });
    const predecessors = await db.select().from(cworksTranslationCheckpoints).where(
      and(
        eq(cworksTranslationCheckpoints.jobId, id),
        eq(cworksTranslationCheckpoints.revisionCount, 0),
      ),
    );
    assert.equal(predecessors.length, 1, "predecessor checkpoint remains immutable history");
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("57-target correction checkpoints a successful bounded subdivision before its sibling fails", async () => {
  const id = `native-dxf-targeted-subdivision-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifestSha256 = createHash("sha256").update("subdivision-placements").digest("hex");
  const targetIds = Array.from({ length: 57 }, (_, index) => `MTEXT:SUBDIVIDE-${index + 1}`);
  const textEntries = targetIds.map((targetId, index) => ({
    targetId, entityType: "MTEXT", handle: `SUBDIVIDE-${index + 1}`,
    plainText: `Текст ${index + 1}`, rawText: `Текст ${index + 1}`,
    isCyrillicTarget: true, patchableInDxf: true,
    preservedDrawingCodeCandidate: false, placementCount: 1,
  }));
  let normalRequests = 0;
  let repairRequests = 0;
  let firstSiblingTargetCount = 0;
  let secondSiblingTargetCount = 0;
  let retryTargetCount = 0;
  let auditCalls = 0;
  let patchCalls = 0;
  await db.insert(cworksTranslationJobs).values({
    id, title: "Targeted correction bounded subdivision", status: "running",
    sourceLanguage: "ru", targetLanguage: "en", scope: "full", drawingDepth: "everything",
    sourceFormat: "dxf", originalFilename: "subdivision.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`, revisionCount: 1,
    repairBrief: {
      kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND, sourceRevision: 0,
      targetLanguage: "en", consented: true, correctionBudget: 1, targetIds,
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
    retryCount: 0, runToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const predecessor = buildNativeDxfCheckpoint({
    sourceSha256, revisionCount: 0, targetLanguage: "en",
    methodologyHash: nativeDxfCheckpointMethodologyHash("en"), placementManifestSha256,
  }, {
    stage: "pre_patch", completedBatchCount: 1,
    translations: Object.fromEntries(targetIds.map((targetId) => [targetId, "Old correction"])),
    audit: { pageNumber: 1, status: "findings", model: "independent", findings: [] },
    auditIndex: 2, correctionDiagnostics: [],
    ledger: {
      entries: targetIds.map((targetId) => ({ targetId })), tableTargets: [],
      unresolved: targetIds.map((targetId) => ({ targetId })),
      blockingFindings: targetIds.map((targetId) => ({ targetId })),
    },
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id, revisionCount: 0, pageNumber: 1, sourceHash: sourceSha256, translations: predecessor,
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(job, {
      readObject: async () => source,
      writeObject: async () => {},
      deleteObject: async () => {},
      runProcess: async (_processor, stage, args) => {
        if (stage === "inspect") {
          await fs.writeFile(args[1], JSON.stringify({
            sha256: sourceSha256, placementManifestSha256, placementCount: targetIds.length,
            textEntries, tableTargets: [], splitFragmentGroups: [], dimensionCacheBindings: [],
            unresolvedVisibleText: [],
          }));
          return;
        }
        if (stage === "patch") {
          patchCalls++;
          await fs.copyFile(args[0], args[2]);
          await fs.writeFile(args[3], JSON.stringify({
            approvedChanges: targetIds.map((targetId) => ({ targetId })),
            unresolved: [],
          }));
          return;
        }
        await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
      },
      askTranslator: async (prompt) => {
        if (prompt.startsWith("Repair this malformed")) {
          repairRequests++;
          return JSON.stringify({ translations: [] });
        }
        const targets = JSON.parse(prompt.slice(prompt.lastIndexOf("\ntargets: ") + "\ntargets: ".length));
        normalRequests++;
        if (normalRequests === 1 || normalRequests === 3) return "{\"translations\":[";
        firstSiblingTargetCount = targets.length;
        if (normalRequests > 3) retryTargetCount = targets.length;
        return JSON.stringify({
          translations: targets.map((target: any) => ({
            targetId: target.targetId,
            translation: "Corrected",
          })),
        });
      },
      askAuditor: async () => {
        auditCalls++;
        return JSON.stringify({ passed: true, findings: [] });
      },
    });
    const [retrying] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(retrying.status, "queued");
    assert.match(
      retrying.errorMessage || "",
      /\[translate:provider_protocol_invalid\].*28 target\(s\).*one bounded subdivision/i,
    );
    const [saved] = await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, id),
      eq(cworksTranslationCheckpoints.revisionCount, 1),
    ));
    const envelope = saved.translations as any;
    secondSiblingTargetCount = targetIds.length - firstSiblingTargetCount;
    assert.equal(normalRequests, 3, "outer malformed response plus two finite sibling requests");
    assert.equal(repairRequests, 2, "only the outer and failed sibling get JSON repair");
    assert.equal(firstSiblingTargetCount, 29);
    assert.equal(secondSiblingTargetCount, 28);
    assert.equal(auditCalls, 0, "a failed correction sibling cannot enter mandatory re-audit");
    assert.equal(envelope.stage, "correction");
    assert.equal(envelope.targetedCorrectionCompletedTargetIds.length, 29);
    assert.equal(Object.keys(envelope.targetedCorrectionCompletionReasons).length, 29);
    assert.equal(
      targetIds.filter((targetId) => envelope.translations[targetId] === "Corrected").length,
      29,
    );
    assert.equal(
      targetIds.filter((targetId) => envelope.translations[targetId] === "Old correction").length,
      28,
      "the retry input is exactly the unsaved sibling; saved corrections are not repeated",
    );
    const replacement = await claimNextJob({ jobId: id });
    assert.ok(replacement);
    await runNativeDxfJobAttempt(replacement as CworksJob, {
      readObject: async () => source,
      writeObject: async () => {},
      deleteObject: async () => {},
      runProcess: async (_processor, stage, args) => {
        if (stage === "inspect") {
          await fs.writeFile(args[1], JSON.stringify({
            sha256: sourceSha256, placementManifestSha256, placementCount: targetIds.length,
            textEntries, tableTargets: [], splitFragmentGroups: [], dimensionCacheBindings: [],
            unresolvedVisibleText: [],
          }));
          return;
        }
        if (stage === "patch") {
          patchCalls++;
          await fs.copyFile(args[0], args[2]);
          await fs.writeFile(args[3], JSON.stringify({
            approvedChanges: targetIds.map((targetId) => ({ targetId })),
            unresolved: [],
          }));
          return;
        }
        await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
      },
      askTranslator: async (prompt) => {
        if (prompt.startsWith("Repair this malformed")) {
          repairRequests++;
          return JSON.stringify({ translations: [] });
        }
        const targets = JSON.parse(prompt.slice(prompt.lastIndexOf("\ntargets: ") + "\ntargets: ".length));
        normalRequests++;
        retryTargetCount = targets.length;
        return JSON.stringify({
          translations: targets.map((target: any) => ({
            targetId: target.targetId,
            translation: "Corrected",
          })),
        });
      },
      askAuditor: async () => {
        auditCalls++;
        return JSON.stringify({ passed: true, findings: [] });
      },
    });
    const [finished] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(normalRequests, 4);
    assert.equal(retryTargetCount, 28, "only the failed sibling is resubmitted");
    assert.ok(auditCalls > 0);
    assert.equal(patchCalls, 1);
    assert.equal(finished.status, "awaiting_review", finished.errorMessage);
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("targeted DXF correction rejects stale predecessor evidence before any provider call", async () => {
  const id = `native-dxf-targeted-stale-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifestSha256 = createHash("sha256").update("stale-placements").digest("hex");
  let translatorCalls = 0;
  let auditorCalls = 0;
  await db.insert(cworksTranslationJobs).values({
    id, title: "Stale targeted correction", status: "running", sourceLanguage: "ru",
    targetLanguage: "en", sourceFormat: "dxf", originalFilename: "stale.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`, revisionCount: 1,
    repairBrief: {
      kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND, sourceRevision: 0,
      targetLanguage: "en", consented: true, correctionBudget: 1,
      targetIds: ["MTEXT:A"], requestedAt: "2026-01-01T00:00:00.000Z",
    },
    runToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const stale = buildNativeDxfCheckpoint({
    sourceSha256, revisionCount: 0, targetLanguage: "en",
    methodologyHash: createHash("sha256").update("obsolete policy").digest("hex"),
    placementManifestSha256,
  }, {
    stage: "pre_patch", completedBatchCount: 1, translations: { "MTEXT:A": "Old" },
    audit: { pageNumber: 1, status: "findings", model: "independent", findings: [] },
    auditIndex: 0, correctionDiagnostics: [],
    ledger: {
      entries: [{ targetId: "MTEXT:A" }], tableTargets: [],
      unresolved: [{ targetId: "MTEXT:A" }], blockingFindings: [{ targetId: "MTEXT:A" }],
    },
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id, revisionCount: 0, pageNumber: 1, sourceHash: sourceSha256, translations: stale,
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(job, {
      readObject: async () => source,
      writeObject: async () => {},
      deleteObject: async () => {},
      runProcess: async (_processor, stage, args) => {
        assert.equal(stage, "inspect");
        await fs.writeFile(args[1], JSON.stringify({
          sha256: sourceSha256, placementManifestSha256, placementCount: 1,
          textEntries: [{
            targetId: "MTEXT:A", entityType: "MTEXT", handle: "A", plainText: "Примечание",
            rawText: "Примечание", isCyrillicTarget: true, patchableInDxf: true,
            preservedDrawingCodeCandidate: false, placementCount: 1,
          }],
          tableTargets: [], splitFragmentGroups: [], dimensionCacheBindings: [], unresolvedVisibleText: [],
        }));
      },
      askTranslator: async () => { translatorCalls++; return "{}"; },
      askAuditor: async () => { auditorCalls++; return "{}"; },
    });
    const [failed] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(failed.status, "failed");
    assert.match(failed.errorMessage || "", /resume rejected.*methodology/i);
    assert.equal(translatorCalls, 0);
    assert.equal(auditorCalls, 0);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("malformed reserved targeted-correction intent fails closed before either AI provider", async () => {
  const id = `native-dxf-targeted-malformed-${randomUUID()}`;
  let translatorCalls = 0;
  let auditorCalls = 0;
  await db.insert(cworksTranslationJobs).values({
    id, title: "Malformed targeted correction", status: "running", sourceLanguage: "ru",
    targetLanguage: "en", sourceFormat: "dxf", originalFilename: "bad.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`, revisionCount: 1,
    repairBrief: {
      kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND,
      sourceRevision: 0,
      // Consent and finite budget are intentionally missing.
      targetLanguage: "en",
      targetIds: ["MTEXT:A"],
    },
    runToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(job, {
      readObject: async () => { throw new Error("malformed intent must stop before source processing"); },
      askTranslator: async () => { translatorCalls++; return "{}"; },
      askAuditor: async () => { auditorCalls++; return "{}"; },
    });
    const [failed] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(failed.status, "failed");
    assert.match(failed.errorMessage || "", /targeted_correction_intent_incomplete/);
    assert.equal(translatorCalls, 0);
    assert.equal(auditorCalls, 0);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("multi-batch correction retains durable intent through audit and pre-patch interruption", async () => {
  const id = `native-dxf-targeted-multibatch-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifestSha256 = createHash("sha256").update("many-placements").digest("hex");
  const targetIds = Array.from({ length: 91 }, (_, index) => `MTEXT:${index + 1}`);
  const textEntries = targetIds.map((targetId, index) => ({
    targetId, entityType: "MTEXT", handle: `H${index + 1}`, plainText: `Текст ${index + 1}`,
    rawText: `Текст ${index + 1}`, isCyrillicTarget: true, patchableInDxf: true,
    preservedDrawingCodeCandidate: false, placementCount: 1,
  }));
  let translationCalls = 0;
  let auditCalls = 0;
  let patchCalls = 0;
  const auditPayloads: string[] = [];
  await db.insert(cworksTranslationJobs).values({
    id, title: "Multi batch correction", status: "running", sourceLanguage: "ru",
    targetLanguage: "en", sourceFormat: "dxf", originalFilename: "many.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`, revisionCount: 1,
    repairBrief: {
      kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND, sourceRevision: 0,
      targetLanguage: "en", consented: true, correctionBudget: 1, targetIds,
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
    runToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const predecessor = buildNativeDxfCheckpoint({
    sourceSha256, revisionCount: 0, targetLanguage: "en",
    methodologyHash: nativeDxfCheckpointMethodologyHash("en"), placementManifestSha256,
  }, {
    stage: "pre_patch", completedBatchCount: 1,
    translations: Object.fromEntries(targetIds.map((targetId) => [targetId, "Old"])),
    audit: { pageNumber: 1, status: "findings", model: "independent", findings: [] },
    auditIndex: 2, correctionDiagnostics: [],
    ledger: {
      entries: targetIds.map((targetId) => ({ targetId })), tableTargets: [],
      unresolved: targetIds.map((targetId) => ({ targetId })),
      blockingFindings: targetIds.map((targetId) => ({ targetId })),
    },
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id, revisionCount: 0, pageNumber: 1, sourceHash: sourceSha256, translations: predecessor,
  });
  const options: NativeDxfJobAttemptOptions = {
    readObject: async () => source,
    writeObject: async () => {},
    deleteObject: async () => {},
    runProcess: async (_processor, stage, args) => {
      if (stage === "inspect") {
        await fs.writeFile(args[1], JSON.stringify({
          sha256: sourceSha256, placementManifestSha256, placementCount: textEntries.length,
          textEntries, tableTargets: [], splitFragmentGroups: [], dimensionCacheBindings: [],
          unresolvedVisibleText: [],
        }));
        return;
      }
      if (stage === "patch") {
        patchCalls++;
        if (patchCalls === 1) throw new Error("interrupt after saved audit and pre-patch checkpoint");
        await fs.copyFile(args[0], args[2]);
        await fs.writeFile(args[3], JSON.stringify({ approvedChanges: targetIds.map((targetId) => ({
          targetId,
        })), unresolved: [] }));
        return;
      }
      await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    },
    askTranslator: async (prompt) => {
      translationCalls++;
      return responseFor(prompt, "Corrected");
    },
    askAuditor: async (payload) => {
      auditCalls++;
      auditPayloads.push(payload);
      return JSON.stringify({ passed: true, findings: [] });
    },
  };
  try {
    const [first] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(first, options);
    assert.equal(translationCalls, 2, "91 targeted IDs must be checkpointed across bounded batches");
    assert.ok(auditCalls > 0, "targeted successor must perform its full independent re-audit");
    assert.match(auditPayloads.join("\n"), /MTEXT:1/);
    assert.match(auditPayloads.join("\n"), /MTEXT:91/);
    const [prePatch] = await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, id),
      eq(cworksTranslationCheckpoints.revisionCount, 1),
    ));
    const envelope = prePatch.translations as any;
    assert.equal(envelope.stage, "pre_patch");
    assert.equal(envelope.targetedCorrectionPendingReaudit, false);
    assert.deepEqual(envelope.targetedCorrectionIntent.targetIds, targetIds);
    assert.equal(envelope.targetedCorrectionCompletedTargetIds.length, targetIds.length);
    assert.equal(Object.keys(envelope.targetedCorrectionCompletionReasons).length, targetIds.length);

    const auditCallsAfterSavedPrePatch = auditCalls;
    // Simulate generic retry metadata replacing the job brief. The successor
    // checkpoint must remain the correction source of truth.
    await db.update(cworksTranslationJobs).set({
      repairBrief: {
        kind: "cworks-native-dxf-retry",
        mode: "resume",
        sourceRevision: 1,
        targetLanguage: "en",
        provisionalPlacementValidation: true,
      },
    }).where(eq(cworksTranslationJobs.id, id));
    const replacement = await claimNextJob({ jobId: id });
    assert.ok(replacement);
    await runNativeDxfJobAttempt(replacement as CworksJob, options);
    assert.equal(translationCalls, 2, "pre-patch resume cannot repeat consented correction work");
    assert.equal(auditCalls, auditCallsAfterSavedPrePatch,
      "pre-patch resume reuses the already completed mandatory independent audit");
    assert.equal(patchCalls, 2);
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("mixed consented correction preserves drawing codes while resuming table, cache, and split targets", async () => {
  const id = `native-dxf-targeted-mixed-preservation-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifestSha256 = createHash("sha256").update("mixed-placements").digest("hex");
  const tableId = `ACAD_TABLE:2F113B:1:${"a".repeat(64)}`;
  const targetIds = [
    "DIMENSION:1", "MTEXT:CACHE", "MTEXT:PRIMARY", "MTEXT:SPLIT",
    "MULTILEADER:1", "TEXT:CODE", tableId,
  ];
  const textEntries = [
    ["DIMENSION:1", "DIMENSION", "DIM", "Размер"],
    ["MTEXT:CACHE", "MTEXT", "CACHE", "Кэш размера"],
    ["MTEXT:PRIMARY", "MTEXT", "PRIMARY", "Основная часть"],
    ["MTEXT:SPLIT", "MTEXT", "SPLIT", "продолжение"],
    ["MULTILEADER:1", "MULTILEADER", "LEADER", "Выноска"],
  ].map(([targetId, entityType, handle, plainText]) => ({
    targetId, entityType, handle, plainText, rawText: plainText,
    isCyrillicTarget: true, patchableInDxf: true,
    preservedDrawingCodeCandidate: false, placementCount: 1,
  }));
  textEntries.push({
    targetId: "TEXT:CODE", entityType: "TEXT", handle: "CODE",
    plainText: "КОД-100х7", rawText: "КОД-100х7",
    isCyrillicTarget: true, patchableInDxf: true,
    preservedDrawingCodeCandidate: true, placementCount: 1,
  });
  let translationCalls = 0;
  let auditCalls = 0;
  let patchCalls = 0;
  const auditPayloads: string[] = [];
  await db.insert(cworksTranslationJobs).values({
    id, title: "Mixed preserved correction", status: "running", sourceLanguage: "ru",
    targetLanguage: "en", sourceFormat: "dxf", originalFilename: "mixed.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`, revisionCount: 1,
    repairBrief: {
      kind: NATIVE_DXF_TARGETED_CORRECTION_BRIEF_KIND, sourceRevision: 0,
      targetLanguage: "en", consented: true, correctionBudget: 1, targetIds,
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
    runToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const predecessor = buildNativeDxfCheckpoint({
    sourceSha256, revisionCount: 0, targetLanguage: "en",
    methodologyHash: nativeDxfCheckpointMethodologyHash("en"), placementManifestSha256,
  }, {
    stage: "pre_patch", completedBatchCount: 1,
    translations: Object.fromEntries(targetIds.map((targetId) => [targetId, "Old replacement"])),
    audit: { pageNumber: 1, status: "findings", model: "independent", findings: [] },
    auditIndex: 2, correctionDiagnostics: [],
    ledger: {
      entries: textEntries.map(({ targetId }) => ({ targetId })),
      tableTargets: [{ targetId: tableId }],
      unresolved: targetIds.map((targetId) => ({ targetId })),
      blockingFindings: targetIds.map((targetId) => ({ targetId })),
      independentAudit: { findings: targetIds.map((sourceBlockId) => ({ sourceBlockId })) },
    },
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id, revisionCount: 0, pageNumber: 1, sourceHash: sourceSha256, translations: predecessor,
  });
  const options: NativeDxfJobAttemptOptions = {
    readObject: async (name) => name.endsWith("/source.dxf") ? source : null,
    writeObject: async () => {},
    deleteObject: async () => {},
    runProcess: async (_processor, stage, args) => {
      if (stage === "inspect") {
        await fs.writeFile(args[1], JSON.stringify({
          sha256: sourceSha256, placementManifestSha256, placementCount: textEntries.length,
          textEntries,
          tableTargets: [{
            targetId: tableId, tableHandle: "2F113B", sourceOrdinal: 1,
            sourceOccurrenceCount: 1, sourceText: "Табличная строка",
          }],
          splitFragmentGroups: [{ handles: ["PRIMARY", "SPLIT"] }],
          dimensionCacheBindings: [{ dimensionTargetId: "DIMENSION:1", cacheTargetId: "MTEXT:CACHE" }],
          unresolvedVisibleText: [],
        }));
        return;
      }
      if (stage === "patch") {
        patchCalls++;
        await fs.copyFile(args[0], args[2]);
        await fs.writeFile(args[3], JSON.stringify({
          approvedChanges: targetIds.filter((targetId) => targetId !== "TEXT:CODE")
            .map((targetId) => ({ targetId })),
          unresolved: [],
        }));
        return;
      }
      await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    },
    askTranslator: async (prompt) => {
      translationCalls++;
      assert.doesNotMatch(prompt, /КОД-100х7/, "protected drawing code must never reach provider");
      return responseFor(prompt, "Corrected");
    },
    askAuditor: async (payload) => {
      auditCalls++;
      auditPayloads.push(payload);
      if (auditCalls === 1) throw new Error("interrupt after saved mixed correction");
      return JSON.stringify({ passed: true, findings: [] });
    },
  };
  try {
    const [first] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(first, options);
    const [interrupted] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(interrupted.status, "queued");
    assert.equal(translationCalls, 1);
    const [saved] = await db.select().from(cworksTranslationCheckpoints).where(and(
      eq(cworksTranslationCheckpoints.jobId, id),
      eq(cworksTranslationCheckpoints.revisionCount, 1),
    ));
    const envelope = saved.translations as any;
    assert.deepEqual(envelope.targetedCorrectionCompletedTargetIds, [...targetIds].sort());
    assert.equal(
      envelope.targetedCorrectionCompletionReasons["TEXT:CODE"],
      "explicitly_preserved_drawing_code_not_sent_to_provider",
    );
    assert.equal(envelope.translations["TEXT:CODE"], undefined,
      "a predecessor-era replacement cannot overwrite a preserved drawing code");
    assert.equal(envelope.translations["MTEXT:CACHE"], "Corrected",
      "dimension cache is updated from its authoritative dimension correction");
    assert.match(auditPayloads.join("\n"), /КОД-100х7/,
      "explicitly preserved consented codes remain in the mandatory full audit");

    // A generic retry must recover the same failed successor, not require a
    // fresh correction revision or make another targeted provider request.
    await db.update(cworksTranslationJobs).set({
      repairBrief: {
        kind: "cworks-native-dxf-retry", mode: "resume", sourceRevision: 1,
        targetLanguage: "en", provisionalPlacementValidation: true,
      },
    }).where(eq(cworksTranslationJobs.id, id));
    const replacement = await claimNextJob({ jobId: id });
    assert.ok(replacement);
    await runNativeDxfJobAttempt(replacement as CworksJob, options);
    const [finished] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.equal(finished.status, "awaiting_review");
    assert.equal(translationCalls, 1, "saved successor must not repeat its correction provider call");
    assert.equal(patchCalls, 1);
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

const architectureBriefPath = "/tmp/architecture-current-brief.csv";
const architectureInventoryPath = "/tmp/architecture-current-inventory.json";

test("actual Architecture 453-target consent replays as source-patchable with explicit protected codes", {
  skip: !existsSync(architectureBriefPath) || !existsSync(architectureInventoryPath),
}, async () => {
  const csv = await fs.readFile(architectureBriefPath, "utf8");
  const serializedBrief = csv.slice(csv.indexOf("\n") + 1).trim();
  const brief = JSON.parse(serializedBrief.slice(1, -1).replace(/""/g, "\"")) as {
    targetIds: string[];
  };
  const inventory = JSON.parse(await fs.readFile(architectureInventoryPath, "utf8")) as {
    textEntries: Array<Record<string, unknown>>;
    tableTargets: Array<Record<string, unknown>>;
  };
  const sourcePatchableIds = new Set([
    ...inventory.textEntries.filter((item) =>
      item.isCyrillicTarget === true && item.patchableInDxf === true
      && typeof item.targetId === "string").map((item) => item.targetId as string),
    ...inventory.tableTargets.filter((item) =>
      typeof item.targetId === "string" && typeof item.tableHandle === "string"
      && typeof item.sourceText === "string" && Number.isInteger(item.sourceOrdinal))
      .map((item) => item.targetId as string),
  ]);
  const protectedTargets = inventory.textEntries.filter((item) =>
    brief.targetIds.includes(item.targetId as string)
    && item.isCyrillicTarget === true
    && item.patchableInDxf === true
    && item.preservedDrawingCodeCandidate === true,
  );
  assert.equal(brief.targetIds.length, 453);
  assert.deepEqual(brief.targetIds.filter((targetId) => !sourcePatchableIds.has(targetId)), []);
  assert.deepEqual(
    protectedTargets.map((item) => item.targetId).sort(),
    [
      "MTEXT:30F3D1", "MTEXT:30F3D3", "MTEXT:31223B", "MTEXT:31223E",
      "MTEXT:3272DC", "MTEXT:3272DE", "MTEXT:3273A1", "MTEXT:3273A4",
      "MTEXT:335BD0", "MTEXT:3C6D52", "MTEXT:3C6D54", "MTEXT:3C6E17",
      "MTEXT:3C6E1A", "TEXT:73D520", "TEXT:73D52F", "TEXT:73D57E",
      "TEXT:73D7A4", "TEXT:73D7AB", "TEXT:73D7B5", "TEXT:73D994",
    ],
  );
  assert.deepEqual(
    protectedTargets.filter((item) => String(item.targetId).startsWith("TEXT:"))
      .map((item) => item.plainText).sort(),
    ["-5х50", "-5х50", "100х7", "100х7", "100х7", "100х7", "100х7"],
  );
});