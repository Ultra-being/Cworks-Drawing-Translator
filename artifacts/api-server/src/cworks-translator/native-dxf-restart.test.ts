import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  cworksTranslationCheckpoints,
  cworksTranslationCleanup,
  cworksTranslationJobs,
} from "@workspace/db/schema";
import { NativeDxfProcessError } from "./native-dxf-process";
import { nativeDxfPlacementManifestSha256 } from "./native-dxf-inspection-cache";
import {
  claimNextJob,
  runNativeDxfJobAttempt,
  type CworksJob,
  type NativeDxfJobAttemptOptions,
} from "./worker";
import {
  buildNativeDxfCheckpoint,
} from "./native-dxf-checkpoints";
import { nativeDxfCheckpointMethodologyHash } from "./worker";

function nativeDxfWireTranslationResponse(prompt: string, translation: string): string {
  const marker = "\ntargets: ";
  const offset = prompt.lastIndexOf(marker);
  assert.notEqual(offset, -1, "native DXF translator must receive an explicit target list");
  const targets = JSON.parse(prompt.slice(offset + marker.length));
  assert.ok(Array.isArray(targets) && targets.length > 0);
  assert.ok(targets.every((target: any) => /^t\d+$/.test(target.targetId)));
  return JSON.stringify({
    translations: targets.map((target: any) => ({
      targetId: target.targetId,
      translation,
    })),
  });
}

test("native DXF patch failure restarts from durable batches and audit without AI repeats", async () => {
  const id = `native-dxf-restart-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifest = [{
    definitionBlock: null,
    handle: "A",
    insertPath: [],
    placementId: "A:direct",
    x: 1,
    y: 2,
  }];
  const placementManifestSha256 = nativeDxfPlacementManifestSha256(placementManifest)!;
  const stored = new Map<string, Buffer>();
  stored.set(`cworks-translator/${id}/source.dxf`, source);
  let patchAttempts = 0;
  let inspectionCalls = 0;
  let translationCalls = 0;
  let auditCalls = 0;
  const nativeProcessOptions: Array<{
    stage: "inspect" | "patch" | "preview";
    timeoutMs: number;
    cpuAware?: {
      cpuBudgetMs: number;
      noCpuProgressTimeoutMs: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
    };
  }> = [];

  const runProcess: NonNullable<NativeDxfJobAttemptOptions["runProcess"]> = async (
    _processor,
    stage,
    args,
    processOptions,
  ) => {
    nativeProcessOptions.push({
      stage,
      timeoutMs: processOptions.timeoutMs,
      cpuAware: processOptions.cpuAware,
    });
    if (stage === "inspect") {
      inspectionCalls++;
      await fs.writeFile(args[1], JSON.stringify({
        sha256: sourceSha256,
        placementManifestSha256,
        placementCount: 1,
        textEntries: [{
          targetId: "MTEXT:A",
          entityType: "MTEXT",
          handle: "A",
          plainText: "Примечание",
          rawText: "Примечание",
          definitionBlock: null,
          placements: [{
            placementId: "A:direct",
            x: 1,
            y: 2,
            insertPath: [],
          }],
          isCyrillicTarget: true,
          patchableInDxf: true,
          preservedDrawingCodeCandidate: false,
          placementCount: 1,
        }],
        tableTargets: [],
        splitFragmentGroups: [],
        dimensionCacheBindings: [],
        unresolvedVisibleText: [],
        placementManifest,
      }));
      return;
    }
    if (stage === "patch") {
      patchAttempts++;
      if (patchAttempts === 1) {
        throw new NativeDxfProcessError("patch", "process_error");
      }
      await fs.copyFile(args[0], args[2]);
      await fs.writeFile(args[3], JSON.stringify({
        approvedChanges: [{ targetId: "MTEXT:A" }],
        unresolved: [],
      }));
      return;
    }
    await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  };
  const options: NativeDxfJobAttemptOptions = {
    runProcess,
    readObject: async (storedName) => stored.get(storedName) || null,
    writeObject: async (storedName, content) => {
      stored.set(storedName, Buffer.isBuffer(content) ? content : Buffer.from(content));
    },
    deleteObject: async (storedName) => {
      stored.delete(storedName);
    },
    askTranslator: async (prompt) => {
      translationCalls++;
      return nativeDxfWireTranslationResponse(prompt, "Note");
    },
    askAuditor: async () => {
      auditCalls++;
      return auditCalls === 1
        ? JSON.stringify({
            passed: false,
            findings: [{
              type: "semantic_mismatch",
              message: "Use the approved concise drawing term.",
              sourceBlockId: "MTEXT:A",
            }],
          })
        : JSON.stringify({ passed: true, findings: [] });
    },
  };

  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Native DXF deterministic restart",
    status: "running",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    sourceFormat: "dxf",
    originalFilename: "restart.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });

  try {
    const [firstJob] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(firstJob, options);

    const [failed] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(failed.status, "queued");
    assert.equal(failed.retryCount, 1);
    const [checkpoint] = await db.select().from(cworksTranslationCheckpoints)
      .where(eq(cworksTranslationCheckpoints.jobId, id));
    assert.equal((checkpoint.translations as any).stage, "pre_patch");
    assert.equal((checkpoint.translations as any).sourceSha256, sourceSha256);
    assert.equal((checkpoint.translations as any).targetLanguage, "en");
    assert.equal(typeof (checkpoint.translations as any).methodologyHash, "string");
    assert.deepEqual((checkpoint.translations as any).translations, { "MTEXT:A": "Note" });
    assert.equal(translationCalls, 2);
    assert.equal(auditCalls, 2);

    const replacement = await claimNextJob({ jobId: id });
    assert.ok(replacement);
    await runNativeDxfJobAttempt(replacement as CworksJob, options);

    const [published] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(published.status, "awaiting_review");
    assert.equal(published.approvedRevision, null);
    assert.equal(published.ledgerStoredName !== null, true);
    assert.equal(published.outputStoredName !== null, true);
    assert.equal(translationCalls, 2, "saved translation and correction batches are reused");
    assert.equal(auditCalls, 2, "saved audit and correction are reused");
    assert.equal(inspectionCalls, 1,
      "the second worker process reuses its source- and parser-bound inspection cache");
    assert.equal(patchAttempts, 2);
    assert.deepEqual(nativeProcessOptions.map((call) => call.stage),
      ["inspect", "patch", "patch", "preview", "preview"]);
    assert.deepEqual(nativeProcessOptions.map((call) => call.timeoutMs),
      [20 * 60_000, 12 * 60_000, 12 * 60_000, 12 * 60_000, 12 * 60_000]);
    for (const call of nativeProcessOptions) {
      assert.deepEqual({
        cpuBudgetMs: call.cpuAware?.cpuBudgetMs,
        noCpuProgressTimeoutMs: call.cpuAware?.noCpuProgressTimeoutMs,
        pollIntervalMs: call.cpuAware?.pollIntervalMs,
      }, {
        cpuBudgetMs: 30 * 60_000,
        noCpuProgressTimeoutMs: 10 * 60_000,
        pollIntervalMs: 5_000,
      });
      assert.ok(call.cpuAware?.signal instanceof AbortSignal);
      assert.equal(call.cpuAware?.signal?.aborted, true,
        "attempt cleanup aborts every native subprocess signal");
    }
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("native DXF pre-patch retry keeps intentionally unresolved evidence after preview timeout", async () => {
  const id = `native-dxf-pre-patch-preview-retry-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifest = [{
    definitionBlock: null,
    handle: "A",
    insertPath: [],
    placementId: "A:direct",
    x: 1,
    y: 2,
  }, {
    definitionBlock: null,
    handle: "B",
    insertPath: [],
    placementId: "B:direct",
    x: 3,
    y: 4,
  }];
  const placementManifestSha256 = nativeDxfPlacementManifestSha256(placementManifest)!;
  const stored = new Map<string, Buffer>([
    [`cworks-translator/${id}/source.dxf`, source],
  ]);
  let previewCalls = 0;
  let inspectionCalls = 0;
  let translationCalls = 0;
  let auditCalls = 0;
  const savedAudit = {
    pageNumber: 1,
    status: "passed" as const,
    model: "saved-auditor",
    findings: [],
  };
  const runProcess: NonNullable<NativeDxfJobAttemptOptions["runProcess"]> = async (
    _processor,
    stage,
    args,
  ) => {
    if (stage === "inspect") {
      inspectionCalls++;
      await fs.writeFile(args[1], JSON.stringify({
        sha256: sourceSha256,
        placementManifestSha256,
        placementCount: 2,
        textEntries: [{
          targetId: "MTEXT:A",
          entityType: "MTEXT",
          handle: "A",
          plainText: "Архитектурные решения",
          rawText: "Архитектурные решения",
          definitionBlock: null,
          placements: [{
            placementId: "A:direct",
            x: 1,
            y: 2,
            insertPath: [],
          }],
          isCyrillicTarget: true,
          patchableInDxf: true,
          preservedDrawingCodeCandidate: false,
          placementCount: 1,
        }, {
          targetId: "MTEXT:B",
          entityType: "MTEXT",
          handle: "B",
          plainText: "Этаж",
          rawText: "Этаж",
          definitionBlock: null,
          placements: [{
            placementId: "B:direct",
            x: 3,
            y: 4,
            insertPath: [],
          }],
          isCyrillicTarget: true,
          patchableInDxf: true,
          preservedDrawingCodeCandidate: false,
          placementCount: 1,
        }],
        tableTargets: [],
        splitFragmentGroups: [{ handles: ["A", "B"] }],
        dimensionCacheBindings: [],
        unresolvedVisibleText: [],
        placementManifest,
      }));
      return;
    }
    if (stage === "patch") {
      await fs.copyFile(args[0], args[2]);
      await fs.writeFile(args[3], JSON.stringify({
        approvedChanges: [{ targetId: "MTEXT:A" }],
        unresolved: [{
          targetId: "MTEXT:B",
          handle: "B",
          reason: "missing_translation",
        }],
      }));
      return;
    }
    previewCalls++;
    if (previewCalls === 1) throw new NativeDxfProcessError("preview", "timeout");
    await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  };
  const options: NativeDxfJobAttemptOptions = {
    runProcess,
    readObject: async (storedName) => stored.get(storedName) || null,
    writeObject: async (storedName, content) => {
      stored.set(storedName, Buffer.isBuffer(content) ? content : Buffer.from(content));
    },
    deleteObject: async (storedName) => {
      stored.delete(storedName);
    },
    askTranslator: async () => {
      translationCalls++;
      return JSON.stringify({ translations: [] });
    },
    askAuditor: async () => {
      auditCalls++;
      return JSON.stringify({ passed: true, findings: [] });
    },
  };

  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Native DXF pre-patch preview retry",
    status: "running",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    sourceFormat: "dxf",
    originalFilename: "pre-patch-preview-retry.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`,
    repairBrief: {
      kind: "cworks-native-dxf-retry",
      mode: "resume",
      sourceRevision: 0,
      targetLanguage: "en",
      provisionalPlacementValidation: true,
    },
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });

  const checkpoint = buildNativeDxfCheckpoint({
    sourceSha256,
    revisionCount: 0,
    targetLanguage: "en",
    methodologyHash: nativeDxfCheckpointMethodologyHash("en"),
    placementManifestSha256,
  }, {
    stage: "pre_patch",
    completedBatchCount: 1,
    translations: { "MTEXT:A": "Saved Title" },
    audit: savedAudit,
    auditIndex: 2,
    correctionDiagnostics: [],
    ledger: { evidence: "saved-pre-patch-audit" },
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id,
    revisionCount: 0,
    pageNumber: 1,
    sourceHash: sourceSha256,
    translations: checkpoint,
  });

  try {
    const [firstJob] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(firstJob, options);

    const [failed] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(failed.status, "queued");
    assert.equal(translationCalls, 0);
    assert.equal(auditCalls, 0);
    assert.equal(inspectionCalls, 1,
      "terminal audit restart needs neither providers nor another inspection");
    const [afterTimeout] = await db.select().from(cworksTranslationCheckpoints)
      .where(eq(cworksTranslationCheckpoints.jobId, id));
    const timedOutCheckpoint = afterTimeout.translations as any;
    assert.equal(timedOutCheckpoint.stage, "pre_patch");
    assert.equal(timedOutCheckpoint.completedBatchCount, 1);
    assert.deepEqual(timedOutCheckpoint.translations, { "MTEXT:A": "Saved Title" });
    assert.deepEqual(timedOutCheckpoint.audit, savedAudit);

    const replacement = await claimNextJob({ jobId: id });
    assert.ok(replacement);
    await runNativeDxfJobAttempt(replacement as CworksJob, options);

    const [published] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(published.status, "awaiting_review");
    assert.equal(translationCalls, 0);
    assert.equal(auditCalls, 0);
    const [afterRetry] = await db.select().from(cworksTranslationCheckpoints)
      .where(eq(cworksTranslationCheckpoints.jobId, id));
    const saved = afterRetry.translations as any;
    assert.equal(saved.stage, "pre_patch");
    assert.equal(saved.completedBatchCount, 1);
    assert.deepEqual(saved.translations, { "MTEXT:A": "Saved Title" });
    assert.deepEqual(saved.audit, savedAudit);
    assert.equal(saved.ledger.evidence, "saved-pre-patch-audit");
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("native DXF resumed correction synchronizes dimension cache before interruption and retry", async () => {
  const id = `native-dxf-dimension-cache-correction-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifestSha256 = createHash("sha256")
    .update("dimension-cache-correction-placement").digest("hex");
  const stored = new Map<string, Buffer>([
    [`cworks-translator/${id}/source.dxf`, source],
  ]);
  let translationCalls = 0;
  let auditCalls = 0;
  let patchCalls = 0;
  let interruptAudit = true;
  const runProcess: NonNullable<NativeDxfJobAttemptOptions["runProcess"]> = async (
    _processor,
    stage,
    args,
  ) => {
    if (stage === "inspect") {
      await fs.writeFile(args[1], JSON.stringify({
        sha256: sourceSha256,
        placementManifestSha256,
        placementCount: 2,
        textEntries: [{
          targetId: "DIMENSION:1",
          entityType: "MTEXT",
          handle: "DIMENSION-HANDLE",
          plainText: "Размер",
          rawText: "Размер",
          isCyrillicTarget: true,
          patchableInDxf: true,
          preservedDrawingCodeCandidate: false,
          placementCount: 1,
        }, {
          targetId: "CACHE:1",
          entityType: "MTEXT",
          handle: "CACHE-HANDLE",
          plainText: "Размер",
          rawText: "Размер",
          isCyrillicTarget: true,
          patchableInDxf: true,
          preservedDrawingCodeCandidate: false,
          placementCount: 1,
        }],
        tableTargets: [],
        splitFragmentGroups: [],
        dimensionCacheBindings: [{
          dimensionTargetId: "DIMENSION:1",
          cacheTargetId: "CACHE:1",
        }],
        unresolvedVisibleText: [],
      }));
      return;
    }
    if (stage === "patch") {
      patchCalls++;
      await fs.copyFile(args[0], args[2]);
      await fs.writeFile(args[3], JSON.stringify({
        approvedChanges: [
          { targetId: "DIMENSION:1" },
          { targetId: "CACHE:1" },
        ],
        unresolved: [],
      }));
      return;
    }
    await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  };
  const options: NativeDxfJobAttemptOptions = {
    runProcess,
    readObject: async (storedName) => stored.get(storedName) || null,
    writeObject: async (storedName, content) => {
      stored.set(storedName, Buffer.isBuffer(content) ? content : Buffer.from(content));
    },
    deleteObject: async (storedName) => {
      stored.delete(storedName);
    },
    askTranslator: async (prompt) => {
      translationCalls++;
      return nativeDxfWireTranslationResponse(prompt, "Corrected dimension");
    },
    askAuditor: async () => {
      auditCalls++;
      if (interruptAudit) {
        interruptAudit = false;
        throw new Error("interrupt after correction checkpoint");
      }
      return JSON.stringify({ passed: true, findings: [] });
    },
  };

  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Native DXF dimension cache correction",
    status: "running",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    sourceFormat: "dxf",
    originalFilename: "dimension-cache-correction.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`,
    repairBrief: {
      kind: "cworks-native-dxf-retry",
      mode: "resume",
      sourceRevision: 0,
      targetLanguage: "en",
      provisionalPlacementValidation: true,
    },
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });

  const savedAudit = {
    pageNumber: 1,
    status: "findings" as const,
    model: "saved-auditor",
    findings: [{
      type: "semantic_mismatch" as const,
      message: "Use the corrected dimension term.",
      sourceBlockId: "DIMENSION:1",
    }],
  };
  const checkpoint = buildNativeDxfCheckpoint({
    sourceSha256,
    revisionCount: 0,
    targetLanguage: "en",
    methodologyHash: nativeDxfCheckpointMethodologyHash("en"),
    placementManifestSha256,
  }, {
    stage: "audit",
    completedBatchCount: 1,
    translations: {
      "DIMENSION:1": "Old dimension",
      "CACHE:1": "Old cache",
    },
    audit: savedAudit,
    auditIndex: 0,
    correctionDiagnostics: [],
  });
  await db.insert(cworksTranslationCheckpoints).values({
    jobId: id,
    revisionCount: 0,
    pageNumber: 1,
    sourceHash: sourceSha256,
    translations: checkpoint,
  });

  try {
    const [firstJob] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(firstJob, options);

    const [interrupted] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(interrupted.status, "queued");
    assert.equal(translationCalls, 1);
    assert.equal(auditCalls, 1);
    assert.equal(patchCalls, 0);
    const [correctionCheckpoint] = await db.select().from(cworksTranslationCheckpoints)
      .where(eq(cworksTranslationCheckpoints.jobId, id));
    const correction = correctionCheckpoint.translations as any;
    assert.equal(correction.stage, "correction");
    assert.deepEqual(correction.translations, {
      "CACHE:1": "Corrected dimension",
      "DIMENSION:1": "Corrected dimension",
    });

    const replacement = await claimNextJob({ jobId: id });
    assert.ok(replacement);
    await runNativeDxfJobAttempt(replacement as CworksJob, options);

    const [published] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(published.status, "awaiting_review");
    assert.equal(translationCalls, 1, "the saved correction is reused after retry");
    assert.equal(auditCalls, 2);
    assert.equal(patchCalls, 1);
    const [finalCheckpoint] = await db.select().from(cworksTranslationCheckpoints)
      .where(eq(cworksTranslationCheckpoints.jobId, id));
    const final = finalCheckpoint.translations as any;
    assert.equal(final.stage, "pre_patch");
    assert.deepEqual(final.translations, {
      "CACHE:1": "Corrected dimension",
      "DIMENSION:1": "Corrected dimension",
    });
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("native DXF does not write a checkpoint after lease supersession", async () => {
  const id = `native-dxf-stale-lease-${randomUUID()}`;
  const staleToken = randomUUID();
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const placementManifestSha256 = createHash("sha256").update("stale-placement").digest("hex");
  const stored = new Map<string, Buffer>([
    [`cworks-translator/${id}/source.dxf`, source],
  ]);
  let patchCalled = false;
  const runProcess: NonNullable<NativeDxfJobAttemptOptions["runProcess"]> = async (
    _processor,
    stage,
    args,
  ) => {
    if (stage === "inspect") {
      // This models another worker reclaiming the row between the worker's
      // ordinary progress update and its first checkpoint transaction.
      await db.update(cworksTranslationJobs).set({
        runToken: staleToken,
        leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
      }).where(eq(cworksTranslationJobs.id, id));
      await fs.writeFile(args[1], JSON.stringify({
        sha256: sourceSha256,
        placementManifestSha256,
        placementCount: 1,
        textEntries: [{
          targetId: "MTEXT:A",
          entityType: "MTEXT",
          handle: "A",
          plainText: "Примечание",
          rawText: "Примечание",
          isCyrillicTarget: true,
          patchableInDxf: true,
          preservedDrawingCodeCandidate: false,
          placementCount: 1,
        }],
        tableTargets: [],
        splitFragmentGroups: [],
        dimensionCacheBindings: [],
        unresolvedVisibleText: [],
      }));
      return;
    }
    if (stage === "patch") patchCalled = true;
  };
  const options: NativeDxfJobAttemptOptions = {
    runProcess,
    readObject: async (storedName) => stored.get(storedName) || null,
    writeObject: async () => {},
    deleteObject: async () => {},
    askTranslator: async (prompt) => nativeDxfWireTranslationResponse(prompt, "Note"),
    askAuditor: async () => JSON.stringify({ passed: true, findings: [] }),
  };

  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Native DXF stale lease",
    status: "running",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    sourceFormat: "dxf",
    originalFilename: "stale.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });

  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(job, options);

    const [after] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    const checkpoints = await db.select().from(cworksTranslationCheckpoints)
      .where(eq(cworksTranslationCheckpoints.jobId, id));
    assert.equal(after.status, "running");
    assert.equal(after.runToken, staleToken);
    assert.equal(checkpoints.length, 0);
    assert.equal(patchCalled, false);
  } finally {
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("native DXF removes a cache written after deletion consumed its cleanup row", async () => {
  const id = `native-dxf-cache-delete-race-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const stored = new Map<string, Buffer>([
    [`cworks-translator/${id}/source.dxf`, source],
  ]);
  const options: NativeDxfJobAttemptOptions = {
    readObject: async (storedName) => stored.get(storedName) || null,
    writeObject: async (storedName, content) => {
      stored.set(storedName, Buffer.isBuffer(content) ? content : Buffer.from(content));
      if (storedName.includes("/inspection-cache/")) {
        // Model the narrow interval where job deletion has consumed the
        // outbox row after the worker queued it but before this upload ended.
        await db.delete(cworksTranslationCleanup)
          .where(eq(cworksTranslationCleanup.storedName, storedName));
        await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
      }
    },
    deleteObject: async (storedName) => {
      stored.delete(storedName);
    },
    runProcess: async (_processor, stage, args) => {
      if (stage !== "inspect") throw new Error("worker continued after deletion race");
      await fs.writeFile(args[1], JSON.stringify({
        sha256: sourceSha256,
        placementManifestSha256: createHash("sha256").update("[]").digest("hex"),
        placementCount: 0,
        placementManifest: [],
        textEntries: [],
        tableTargets: [],
        splitFragmentGroups: [],
        dimensionCacheBindings: [],
        unresolvedVisibleText: [],
      }));
    },
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Native DXF cache deletion race",
    status: "running",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    sourceFormat: "dxf",
    originalFilename: "cache-race.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(job, options);
    assert.equal(
      [...stored.keys()].some((key) => key.includes("/inspection-cache/")),
      false,
      "a post-deletion cache upload is removed instead of becoming orphaned",
    );
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

test("native DXF cache read and write failures fall back without blocking safe processing", async () => {
  const id = `native-dxf-cache-storage-failure-${randomUUID()}`;
  const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const stored = new Map<string, Buffer>([
    [`cworks-translator/${id}/source.dxf`, source],
  ]);
  let inspections = 0;
  let cacheReadAttempts = 0;
  let cacheWriteAttempts = 0;
  const options: NativeDxfJobAttemptOptions = {
    readObject: async (storedName) => {
      if (storedName.includes("/inspection-cache/")) {
        cacheReadAttempts++;
        throw new Error("temporary cache read failure");
      }
      return stored.get(storedName) || null;
    },
    writeObject: async (storedName, content) => {
      if (storedName.includes("/inspection-cache/")) {
        cacheWriteAttempts++;
        throw new Error("temporary cache write failure");
      }
      stored.set(storedName, Buffer.isBuffer(content) ? content : Buffer.from(content));
    },
    deleteObject: async (storedName) => {
      stored.delete(storedName);
    },
    askAuditor: async () => JSON.stringify({ passed: true, findings: [] }),
    runProcess: async (_processor, stage, args) => {
      if (stage === "inspect") {
        inspections++;
        await fs.writeFile(args[1], JSON.stringify({
          sha256: sourceSha256,
          placementManifestSha256: createHash("sha256").update("[]").digest("hex"),
          placementCount: 0,
          placementManifest: [],
          textEntries: [],
          tableTargets: [],
          splitFragmentGroups: [],
          dimensionCacheBindings: [],
          unresolvedVisibleText: [],
        }));
      } else if (stage === "patch") {
        await fs.copyFile(args[0], args[2]);
        await fs.writeFile(args[3], JSON.stringify({ approvedChanges: [], unresolved: [] }));
      } else {
        await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
      }
    },
  };
  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Native DXF cache storage failure",
    status: "running",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    sourceFormat: "dxf",
    originalFilename: "cache-storage-failure.dxf",
    sourceStoredName: `cworks-translator/${id}/source.dxf`,
    runToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  try {
    const [job] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    await runNativeDxfJobAttempt(job, options);
    const [finished] = await db.select().from(cworksTranslationJobs)
      .where(eq(cworksTranslationJobs.id, id));
    assert.equal(finished.status, "awaiting_review");
    assert.equal(inspections, 1);
    assert.equal(cacheReadAttempts, 1);
    assert.equal(cacheWriteAttempts, 1);
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
  }
});

for (const [auditIndex, expectedTranslationCalls, expectedAuditCalls] of [
  [1, 1, 1],
  [2, 0, 0],
] as const) {
  test(`native DXF resumes saved audit findings at terminal index ${auditIndex}`, async () => {
    const id = `native-dxf-audit-resume-${auditIndex}-${randomUUID()}`;
    const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const placementManifestSha256 = createHash("sha256")
      .update(`audit-placement-${auditIndex}`).digest("hex");
    const stored = new Map<string, Buffer>([
      [`cworks-translator/${id}/source.dxf`, source],
    ]);
    let translationCalls = 0;
    let auditCalls = 0;
    let patchCalls = 0;
    const runProcess: NonNullable<NativeDxfJobAttemptOptions["runProcess"]> = async (
      _processor,
      stage,
      args,
    ) => {
      if (stage === "inspect") {
        await fs.writeFile(args[1], JSON.stringify({
          sha256: sourceSha256,
          placementManifestSha256,
          placementCount: 1,
          textEntries: [{
            targetId: "MTEXT:A",
            entityType: "MTEXT",
            handle: "A",
            plainText: "Примечание",
            rawText: "Примечание",
            isCyrillicTarget: true,
            patchableInDxf: true,
            preservedDrawingCodeCandidate: false,
            placementCount: 1,
          }],
          tableTargets: [],
          splitFragmentGroups: [],
          dimensionCacheBindings: [],
          unresolvedVisibleText: [],
        }));
        return;
      }
      if (stage === "patch") {
        patchCalls++;
        await fs.copyFile(args[0], args[2]);
        await fs.writeFile(args[3], JSON.stringify({
          approvedChanges: [{ targetId: "MTEXT:A" }],
          unresolved: [],
        }));
        return;
      }
      await fs.writeFile(args[1], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    };
    const options: NativeDxfJobAttemptOptions = {
      runProcess,
      readObject: async (storedName) => stored.get(storedName) || null,
      writeObject: async () => {},
      deleteObject: async () => {},
      askTranslator: async (prompt) => {
        translationCalls++;
        return nativeDxfWireTranslationResponse(prompt, "Note");
      },
      askAuditor: async () => {
        auditCalls++;
        return JSON.stringify({ passed: true, findings: [] });
      },
    };
    await db.insert(cworksTranslationJobs).values({
      id,
      title: `Native DXF audit resume ${auditIndex}`,
      status: "running",
      sourceLanguage: "ru",
      targetLanguage: "en",
      scope: "full",
      drawingDepth: "everything",
      sourceFormat: "dxf",
      originalFilename: "audit-resume.dxf",
      sourceStoredName: `cworks-translator/${id}/source.dxf`,
      repairBrief: {
        kind: "cworks-native-dxf-retry",
        mode: "resume",
        sourceRevision: 0,
        targetLanguage: "en",
        provisionalPlacementValidation: true,
      },
      runToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const checkpoint = buildNativeDxfCheckpoint({
      sourceSha256,
      revisionCount: 0,
      targetLanguage: "en",
      methodologyHash: nativeDxfCheckpointMethodologyHash("en"),
      placementManifestSha256,
    }, {
      stage: "audit",
      completedBatchCount: 1,
      translations: { "MTEXT:A": "Note" },
      audit: {
        pageNumber: 1,
        status: "findings",
        model: "stub-auditor",
        findings: [{
          type: "semantic_mismatch",
          message: "Use the approved concise drawing term.",
          sourceBlockId: "MTEXT:A",
        }],
      },
      auditIndex,
      correctionDiagnostics: [],
    });
    await db.insert(cworksTranslationCheckpoints).values({
      jobId: id,
      revisionCount: 0,
      pageNumber: 1,
      sourceHash: sourceSha256,
      translations: checkpoint,
    });
    try {
      const [job] = await db.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, id));
      await runNativeDxfJobAttempt(job, options);
      const [finished] = await db.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, id));
      assert.equal(finished.status, "awaiting_review");
      assert.equal(translationCalls, expectedTranslationCalls);
      assert.equal(auditCalls, expectedAuditCalls);
      assert.equal(patchCalls, 1);
    } finally {
      await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    }
  });
}

for (const mismatch of [
  "source",
  "revision",
  "language",
  "methodology",
  "placement",
  "malformed",
  "missing",
] as const) {
  test(`explicit native DXF resume rejects ${mismatch} checkpoint evidence before AI`, async () => {
    const id = `native-dxf-resume-reject-${mismatch}-${randomUUID()}`;
    const source = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "utf8");
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const placementManifestSha256 = createHash("sha256")
      .update(`reject-placement-${mismatch}`).digest("hex");
    const stored = new Map<string, Buffer>([
      [`cworks-translator/${id}/source.dxf`, source],
    ]);
    let translationCalls = 0;
    let auditCalls = 0;
    let patchCalled = false;
    const runProcess: NonNullable<NativeDxfJobAttemptOptions["runProcess"]> = async (
      _processor,
      stage,
      args,
    ) => {
      if (stage === "inspect") {
        await fs.writeFile(args[1], JSON.stringify({
          sha256: sourceSha256,
          placementManifestSha256,
          placementCount: 0,
          textEntries: [],
          tableTargets: [],
          splitFragmentGroups: [],
          dimensionCacheBindings: [],
          unresolvedVisibleText: [],
        }));
        return;
      }
      if (stage === "patch") patchCalled = true;
    };
    const options: NativeDxfJobAttemptOptions = {
      runProcess,
      readObject: async (storedName) => stored.get(storedName) || null,
      writeObject: async () => {},
      deleteObject: async () => {},
      askTranslator: async () => {
        translationCalls++;
        return JSON.stringify({ translations: [] });
      },
      askAuditor: async () => {
        auditCalls++;
        return JSON.stringify({ passed: true, findings: [] });
      },
    };
    await db.insert(cworksTranslationJobs).values({
      id,
      title: `Native DXF resume reject ${mismatch}`,
      status: "running",
      sourceLanguage: "ru",
      targetLanguage: "en",
      scope: "full",
      drawingDepth: "everything",
      sourceFormat: "dxf",
      originalFilename: "resume-reject.dxf",
      sourceStoredName: `cworks-translator/${id}/source.dxf`,
      repairBrief: {
        kind: "cworks-native-dxf-retry",
        mode: "resume",
        sourceRevision: 0,
        targetLanguage: "en",
        provisionalPlacementValidation: true,
      },
      runToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const valid = buildNativeDxfCheckpoint({
      sourceSha256,
      revisionCount: 0,
      targetLanguage: "en",
      methodologyHash: nativeDxfCheckpointMethodologyHash("en"),
      placementManifestSha256,
    }, {
      stage: "pre_patch",
      completedBatchCount: 1,
      translations: {},
      audit: {
        pageNumber: 1,
        status: "passed",
        model: "stub-auditor",
        findings: [],
      },
      auditIndex: 2,
      correctionDiagnostics: [],
      ledger: {},
    });
    const invalid: any = {
      ...valid,
      ...(mismatch === "source"
        ? { sourceSha256: createHash("sha256").update("other-source").digest("hex") }
        : mismatch === "revision"
          ? { sourceRevision: 9, revisionCount: 9 }
          : mismatch === "language"
            ? { targetLanguage: "ja" }
            : mismatch === "methodology"
              ? { methodologyHash: createHash("sha256").update("old-policy").digest("hex") }
              : mismatch === "placement"
                ? { placementManifestSha256: createHash("sha256").update("old-placement").digest("hex") }
                : mismatch === "malformed"
                  ? { translations: [] }
                  : {}),
    };
    if (mismatch !== "missing") {
      await db.insert(cworksTranslationCheckpoints).values({
        jobId: id,
        revisionCount: 0,
        pageNumber: 1,
        sourceHash: sourceSha256,
        translations: invalid,
      });
    }
    try {
      const [job] = await db.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, id));
      await runNativeDxfJobAttempt(job, options);
      const [rejected] = await db.select().from(cworksTranslationJobs)
        .where(eq(cworksTranslationJobs.id, id));
      assert.equal(rejected.status, "failed");
      assert.match(rejected.errorMessage || "", /resume rejected/i);
      assert.equal(translationCalls, 0);
      assert.equal(auditCalls, 0);
      assert.equal(patchCalled, false);
    } finally {
      await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    }
  });
}