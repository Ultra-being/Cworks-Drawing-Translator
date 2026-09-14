import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  cworksTranslationCleanup,
  cworksTranslationJobs,
  cworksTranslationRenderCheckpoints,
} from "@workspace/db/schema";
import {
  type CworksJob,
  type CworksPage,
  type CworksRenderPageMeta,
  type CworksTranslation,
  claimNextJob,
  renderCworksPages,
  runCworksCleanupBatch,
} from "./worker";

// Focused coverage for the durable, restart-safe renderCworksPages flow. No
// external Object Storage is required: readObject/writeObject/renderPage are
// injected and backed by an in-memory store plus a real temp directory.
test("renderCworksPages resumes checkpointed pages and re-renders only missing ones", async () => {
  const id = `render-test-${randomUUID()}`;
  const firstToken = randomUUID();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cad-render-test-${randomUUID()}-`));

  const pages: CworksPage[] = [1, 2, 3].map((pageNumber) => ({
    pageNumber,
    width: 200,
    height: 300,
    blocks: [{
      id: `p${pageNumber}-l0`,
      text: `SOURCE ${pageNumber}`,
      bbox: [1, 1, 50, 12],
      fontSize: 8,
      direction: [1, 0],
      color: 0,
    }],
  }));
  const translations: CworksTranslation[] = pages.map((page) => ({
    id: `${page.pageNumber === 1 ? "p1" : page.pageNumber === 2 ? "p2" : "p3"}-l0`,
    pageNumber: page.pageNumber,
    bbox: [1, 1, 50, 12],
    fontSize: 8,
    direction: [1, 0],
    color: 0,
    source: `SOURCE ${page.pageNumber}`,
    translation: `English ${page.pageNumber}`,
    uncertain: false,
  }));

  // In-memory private object store standing in for Object Storage.
  const store = new Map<string, Buffer>();
  const writeObject = async (storedName: string, content: Buffer | string) => {
    store.set(storedName, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
  };
  const readObject = async (storedName: string): Promise<Buffer | null> => {
    const value = store.get(storedName);
    return value ? Buffer.from(value) : null;
  };

  // Deterministic renderer: writes fragment/thumbnail bytes to disk (as the
  // real processor would) and records which pages it was asked to render.
  const renderedPages: number[] = [];
  const makeRenderPage = () =>
    (async (opts: {
      page: CworksPage;
      inputPath: string;
      translationsPath: string;
      fragmentPath: string;
      thumbnailPath: string;
      metadataPath: string;
    }): Promise<CworksRenderPageMeta> => {
      renderedPages.push(opts.page.pageNumber);
      await fs.writeFile(opts.fragmentPath, Buffer.from(`FRAGMENT ${opts.page.pageNumber} rev`));
      await fs.writeFile(opts.thumbnailPath, Buffer.from(`THUMB ${opts.page.pageNumber} rev`));
      const meta: CworksRenderPageMeta = {
        pageNumber: opts.page.pageNumber,
        sourceBlockCount: 1,
        translatedBlockCount: 1,
        preview: {
          pixelWidth: 200,
          pixelHeight: 300,
          pageWidthPoints: 200,
          pageHeightPoints: 300,
        },
        warnings: [],
      };
      await fs.writeFile(opts.metadataPath, JSON.stringify(meta));
      return meta;
    });

  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Render recovery test",
    status: "running",
    originalFilename: "render-test.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: firstToken,
    pageCount: pages.length,
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });

  const inputPath = path.join(dir, "input.pdf");
  const translationsPath = path.join(dir, "translations.json");
  await fs.writeFile(inputPath, Buffer.from("PDF"));
  await fs.writeFile(translationsPath, JSON.stringify({ translations, obstacles: [] }));

  try {
    const [firstJob] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));

    // First run: durably checkpoint pages 1 and 2, then simulate a process
    // interruption right after page 2's checkpoint is saved.
    const renderPage = makeRenderPage();
    await assert.rejects(
      renderCworksPages(firstJob, pages, translations, inputPath, translationsPath, dir, {
        renderPage,
        readObject,
        writeObject,
        onCheckpointSaved: async (pageNumber) => {
          if (pageNumber === 2) throw new Error("simulated instance shutdown");
        },
      }),
      /simulated instance shutdown/,
    );
    assert.deepEqual(renderedPages, [1, 2], "only pages 1 and 2 rendered before interruption");

    const afterInterrupt = await db.select().from(cworksTranslationRenderCheckpoints).where(and(
      eq(cworksTranslationRenderCheckpoints.jobId, id),
      eq(cworksTranslationRenderCheckpoints.revisionCount, 0),
    )).orderBy(cworksTranslationRenderCheckpoints.pageNumber);
    const readyPages = afterInterrupt.filter((r) => r.status === "ready").map((r) => r.pageNumber);
    assert.deepEqual(readyPages, [1, 2], "pages 1 and 2 durably checkpointed as ready");
    for (const row of afterInterrupt.filter((r) => r.status === "ready")) {
      assert.ok(row.fragmentStoredName && store.has(row.fragmentStoredName));
      assert.ok(row.thumbnailStoredName && store.has(row.thumbnailStoredName));
      assert.ok(row.fragmentSha256 && row.thumbnailSha256, "hashes recorded for validation");
    }

    // Expire the lease and claim with a replacement worker (new run token).
    await db.update(cworksTranslationJobs).set({
      leaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(cworksTranslationJobs.id, id));
    const replacementJob = await claimNextJob({ jobId: id });
    assert.ok(replacementJob);
    assert.notEqual(replacementJob.runToken, firstToken, "replacement worker holds a new token");

    // A stale old-token worker must not be able to continue rendering.
    const staleRendered: number[] = [];
    await assert.rejects(
      renderCworksPages(firstJob, pages, translations, inputPath, translationsPath, dir, {
        renderPage: (async (opts) => {
          staleRendered.push(opts.page.pageNumber);
          await fs.writeFile(opts.fragmentPath, Buffer.from("STALE"));
          await fs.writeFile(opts.thumbnailPath, Buffer.from("STALE"));
          return {
            pageNumber: opts.page.pageNumber,
            sourceBlockCount: 1,
            translatedBlockCount: 1,
            preview: {
              pixelWidth: 200,
              pixelHeight: 300,
              pageWidthPoints: 200,
              pageHeightPoints: 300,
            },
            warnings: [],
          };
        }),
        readObject,
        writeObject,
      }),
      /lease was superseded/,
      "stale old-token worker cannot continue",
    );
    // The stale worker may restore pages 1/2 from storage (no renderPage), but
    // it must fail before rendering/saving page 3.
    assert.ok(!staleRendered.includes(3), "stale worker never renders page 3");
    const stalePage3 = await db.select().from(cworksTranslationRenderCheckpoints).where(and(
      eq(cworksTranslationRenderCheckpoints.jobId, id),
      eq(cworksTranslationRenderCheckpoints.revisionCount, 0),
      eq(cworksTranslationRenderCheckpoints.pageNumber, 3),
      eq(cworksTranslationRenderCheckpoints.status, "ready"),
    ));
    assert.equal(stalePage3.length, 0, "stale worker did not mark page 3 ready");

    // Replacement worker resumes: pages 1 and 2 are hash-validated and restored
    // from storage without renderPage; only page 3 is rendered.
    renderedPages.length = 0;
    const resumeRenderPage = makeRenderPage();
    const resumed = await renderCworksPages(
      replacementJob,
      pages,
      translations,
      inputPath,
      translationsPath,
      dir,
      { renderPage: resumeRenderPage, readObject, writeObject },
    );
    assert.deepEqual(renderedPages, [3], "only page 3 rendered on resume");
    assert.equal(resumed.checkpoints.length, 3);
    assert.deepEqual(
      resumed.checkpoints.map((c) => c.pageNumber),
      [1, 2, 3],
      "ready checkpoints returned in page order",
    );
    assert.equal(resumed.fragmentPaths.length, 3);

    // Restored fragments were written back to the temp dir from storage.
    for (const fragmentPath of resumed.fragmentPaths) {
      const stat = await fs.stat(fragmentPath);
      assert.ok(stat.isFile());
    }

    // Progress note advanced during resume/restore.
    const [afterResume] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    assert.match(afterResume.progressNote || "", /page 3 of 3 saved|Resuming final placement/);

    // A new revision reuses byte-identical page renders. This is what lets a
    // one-page manual touch-up rerender only its affected page.
    const priorFragmentNames = afterInterrupt
      .flatMap((r) => [r.fragmentStoredName, r.thumbnailStoredName])
      .filter((n): n is string => Boolean(n));
    const resumedRevisionNames = resumed.checkpoints
      .flatMap((c) => [c.fragmentStoredName, c.thumbnailStoredName])
      .filter((n): n is string => Boolean(n));

    const [revisionJob] = await db.update(cworksTranslationJobs).set({
      revisionCount: 1,
      runToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).where(eq(cworksTranslationJobs.id, id)).returning();

    renderedPages.length = 0;
    const revisionRenderPage = makeRenderPage();
    const revised = await renderCworksPages(
      revisionJob,
      pages,
      translations,
      inputPath,
      translationsPath,
      dir,
      { renderPage: revisionRenderPage, readObject, writeObject },
    );
    assert.deepEqual(renderedPages, [], "byte-identical pages are restored across revisions");
    assert.deepEqual(revised.checkpoints.map((c) => c.pageNumber), [1, 2, 3]);

    // Prior-revision checkpoints are gone.
    const remainingRev0 = await db.select().from(cworksTranslationRenderCheckpoints).where(and(
      eq(cworksTranslationRenderCheckpoints.jobId, id),
      eq(cworksTranslationRenderCheckpoints.revisionCount, 0),
    ));
    assert.equal(remainingRev0.length, 0, "prior revision checkpoints invalidated");

    // Reused private objects remain referenced and must not be queued for cleanup.
    const cleanupRows = await db.select().from(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    const cleanupNames = new Set(cleanupRows.map((r) => r.storedName));
    const queuedPriorObjects = [...new Set([...priorFragmentNames, ...resumedRevisionNames])]
      .filter((name) => cleanupNames.has(name));
    assert.equal(queuedPriorObjects.length, 0, "reused private objects remain live");

    const changedTranslations = translations.map((item) =>
      item.pageNumber === 2 ? { ...item, translation: "Manually shortened" } : item);
    const [secondRevisionJob] = await db.update(cworksTranslationJobs).set({
      revisionCount: 2,
      runToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).where(eq(cworksTranslationJobs.id, id)).returning();
    renderedPages.length = 0;
    await renderCworksPages(
      secondRevisionJob,
      pages,
      changedTranslations,
      inputPath,
      translationsPath,
      dir,
      { renderPage: makeRenderPage(), readObject, writeObject },
    );
    assert.deepEqual(renderedPages, [2], "only the page with changed translated text is rerendered");
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await fs.rm(dir, { recursive: true, force: true });
  }

  const remainingCheckpoints = await db.select().from(cworksTranslationRenderCheckpoints)
    .where(eq(cworksTranslationRenderCheckpoints.jobId, id));
  assert.equal(remainingCheckpoints.length, 0, "checkpoints cascade-deleted with the job");
});

test("renderCworksPages cleanup outbox survives a lease handoff during upload", async () => {
  const id = `render-race-test-${randomUUID()}`;
  const firstToken = randomUUID();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cad-render-race-${randomUUID()}-`));
  const page: CworksPage = {
    pageNumber: 1,
    width: 200,
    height: 300,
    blocks: [{
      id: "p1-l0",
      text: "SOURCE",
      bbox: [1, 1, 50, 12],
      fontSize: 8,
      direction: [1, 0],
      color: 0,
    }],
  };
  const translation: CworksTranslation = {
    id: "p1-l0",
    pageNumber: 1,
    bbox: [1, 1, 50, 12],
    fontSize: 8,
    direction: [1, 0],
    color: 0,
    source: "SOURCE",
    translation: "English",
    uncertain: false,
  };
  const store = new Map<string, Buffer>();
  let replacementJob: CworksJob | null = null;
  let uploadCount = 0;

  await db.insert(cworksTranslationJobs).values({
    id,
    title: "Render upload race test",
    status: "running",
    originalFilename: "render-race-test.pdf",
    sourceStoredName: `cworks-translator/${id}/source.pdf`,
    runToken: firstToken,
    pageCount: 1,
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const inputPath = path.join(dir, "input.pdf");
  const translationsPath = path.join(dir, "translations.json");
  await fs.writeFile(inputPath, Buffer.from("PDF"));
  await fs.writeFile(translationsPath, JSON.stringify({
    translations: [translation],
    obstacles: [],
  }));

  try {
    const [firstJob] = await db.select().from(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await assert.rejects(
      renderCworksPages(
        firstJob,
        [page],
        [translation],
        inputPath,
        translationsPath,
        dir,
        {
          renderPage: async (options) => {
            await fs.writeFile(options.fragmentPath, Buffer.from("FRAGMENT"));
            await fs.writeFile(options.thumbnailPath, Buffer.from("THUMB"));
            return {
              pageNumber: 1,
              sourceBlockCount: 1,
              translatedBlockCount: 1,
              preview: {
                pixelWidth: 200,
                pixelHeight: 300,
                pageWidthPoints: 200,
                pageHeightPoints: 300,
              },
              warnings: [],
            };
          },
          readObject: async (storedName) => store.get(storedName) || null,
          writeObject: async (storedName, content) => {
            uploadCount++;
            store.set(storedName, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
            if (uploadCount === 1) {
              await db.update(cworksTranslationJobs).set({
                leaseExpiresAt: new Date(Date.now() - 60_000),
              }).where(eq(cworksTranslationJobs.id, id));
              replacementJob = await claimNextJob({ jobId: id });
            }
          },
        },
      ),
      /lease was superseded/,
    );
    assert.ok(replacementJob, "a replacement worker claimed the expired lease");
    assert.equal(uploadCount, 1, "stale worker was fenced before its second upload");
    assert.equal(store.size, 1, "the first immutable object can still finish uploading");

    const checkpointRows = await db.select().from(cworksTranslationRenderCheckpoints).where(and(
      eq(cworksTranslationRenderCheckpoints.jobId, id),
      eq(cworksTranslationRenderCheckpoints.revisionCount, 0),
    ));
    assert.equal(checkpointRows.length, 1);
    assert.equal(checkpointRows[0].status, "processing");
    assert.equal(checkpointRows[0].runToken, firstToken);

    const cleanupRows = await db.select().from(cworksTranslationCleanup)
      .where(eq(cworksTranslationCleanup.jobId, id));
    const cleanupNames = new Set(cleanupRows.map((row) => row.storedName));
    assert.equal(cleanupRows.length, 2, "both planned object names were registered before upload");
    assert.ok(
      checkpointRows[0].fragmentStoredName
      && cleanupNames.has(checkpointRows[0].fragmentStoredName),
      "uploaded fragment remains discoverable in the cleanup outbox",
    );
    assert.ok(
      checkpointRows[0].thumbnailStoredName
      && cleanupNames.has(checkpointRows[0].thumbnailStoredName),
      "not-yet-uploaded thumbnail name is also safe to clean idempotently",
    );

    await runCworksCleanupBatch({
      jobId: id,
      deleteObject: async (storedName) => {
        store.delete(storedName);
      },
    });
    assert.equal(store.size, 0, "abandoned uploaded fragment was deleted");
    const remainingCleanup = await db.select().from(cworksTranslationCleanup)
      .where(eq(cworksTranslationCleanup.jobId, id));
    assert.equal(remainingCleanup.length, 0, "cleanup outbox drained after deletion");
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.jobId, id));
    await db.delete(cworksTranslationJobs).where(eq(cworksTranslationJobs.id, id));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
