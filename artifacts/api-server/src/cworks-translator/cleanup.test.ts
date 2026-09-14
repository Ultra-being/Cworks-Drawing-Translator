import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { cworksTranslationCleanup } from "@workspace/db/schema";
import { runCworksCleanupBatch } from "./worker";

test("failed private-object deletion remains queued and is retried", async () => {
  const jobId = `cleanup-test-${randomUUID()}`;
  const storedName = `cworks-translator/cleanup-test/${randomUUID()}.pdf`;
  await db.insert(cworksTranslationCleanup).values({
    storedName,
    jobId,
    // Keep the live worker from claiming this test row.
    nextAttemptAt: new Date(Date.now() + 60 * 60_000),
  });

  try {
    await runCworksCleanupBatch({
      jobId,
      deleteObject: async () => {
        throw new Error("forced storage outage");
      },
    });
    const [retained] = await db.select().from(cworksTranslationCleanup)
      .where(eq(cworksTranslationCleanup.storedName, storedName));
    assert.equal(retained?.attempts, 1);
    assert.match(retained?.lastError || "", /forced storage outage/);

    await runCworksCleanupBatch({
      jobId,
      deleteObject: async () => {},
    });
    const rows = await db.select().from(cworksTranslationCleanup)
      .where(eq(cworksTranslationCleanup.storedName, storedName));
    assert.equal(rows.length, 0);
  } finally {
    await db.delete(cworksTranslationCleanup).where(eq(cworksTranslationCleanup.storedName, storedName));
  }
});