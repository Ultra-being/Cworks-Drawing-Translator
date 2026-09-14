import { expect, test } from "@playwright/test";

const jobId = "native-dxf-targeted-repair";

function job(status: "awaiting_review" | "revising") {
  return {
    id: jobId,
    title: "Native DXF targeted repair fixture",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    sourceFormat: "dxf",
    drawingDepth: "everything",
    status,
    progress: status === "revising" ? 8 : 100,
    progressNote: status === "revising" ? "Targeted DXF correction queued" : "Ready for review",
    pageCount: 1,
    pagesDone: status === "revising" ? 0 : 1,
    originalFilename: "fixture.dxf",
    feedbackNotes: null,
    errorMessage: null,
    tokenEstimate: 1,
    costEstimate: "0",
    revisionCount: 2,
    createdAt: "2026-09-13T00:00:00.000Z",
  };
}

function detail(status: "awaiting_review" | "revising") {
  return {
    job: job(status),
    coverage: {
      targetLineCount: 1,
      recoveredLineCount: 1,
      translatedLineCount: 1,
      placedLineCount: 0,
      unresolvedLineCount: 1,
      placementPercent: 0,
      severelyIncomplete: false,
      complete: false,
    },
    reviewHistory: [],
    pages: [{
      id: 1,
      pageNumber: 1,
      thumbnailUrl: `/api/cworks-translator/jobs/${jobId}/pages/1/thumbnail`,
      sourceThumbnailUrl: `/api/cworks-translator/jobs/${jobId}/pages/1/source-thumbnail`,
      sourceBlockCount: 1,
      translatedBlockCount: 0,
      warnings: [],
      unresolvedLines: [{
        blockId: "p1-l0",
        sourceText: "КЛАПАН",
        currentTranslation: "VALVE",
        pageNumber: 1,
        bbox: [10, 10, 100, 30],
        rejectionCategory: "overlap",
      }],
      previewMetadata: {
        pixelWidth: 400,
        pixelHeight: 300,
        pageWidthPoints: 400,
        pageHeightPoints: 300,
      },
      machineAuditStatus: "passed",
      machineAuditFindings: [],
      review: null,
    }],
  };
}

test("confirms and starts a targeted native DXF correction without duplicate submits", async ({ page }) => {
  let activeStatus: "awaiting_review" | "revising" = "awaiting_review";
  let repairRequests = 0;
  let confirmation = "";

  await page.route("**/api/cworks-translator/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith("/auth/status")) {
      return route.fulfill({ json: { authenticated: true } });
    }
    if (url.pathname.endsWith("/health")) {
      return route.fulfill({ json: { ok: true, translatorReady: true, translatorProvider: "gemini" } });
    }
    if (url.pathname.endsWith("/jobs") && request.method() === "GET") {
      return route.fulfill({ json: { jobs: [job(activeStatus)] } });
    }
    if (url.pathname.endsWith(`/jobs/${jobId}/correct-unresolved`) && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({
        consentToTargetedDxfCorrection: true,
        expectedSourceRevision: 2,
      });
      repairRequests += 1;
      activeStatus = "revising";
      return route.fulfill({ json: { job: job(activeStatus) } });
    }
    if (url.pathname.endsWith(`/jobs/${jobId}`) && request.method() === "GET") {
      return route.fulfill({ json: detail(activeStatus) });
    }
    if (url.pathname.includes("/pages/1/")) {
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/></svg>',
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });

  await page.goto("/");
  await page.getByTestId(`card-job-${jobId}`).click();

  const fix = page.getByTestId("button-fix-unresolved-coverage");
  await expect(fix).toHaveText("Fix unresolved DXF text");

  page.once("dialog", dialog => {
    confirmation = dialog.message();
    void dialog.accept();
  });
  await fix.click();
  await expect.poll(() => repairRequests).toBe(1);
  await expect.poll(() => confirmation).toContain("saved translations and review evidence");
  await expect.poll(() => confirmation).toContain("does not alter geometry");
  await expect.poll(() => confirmation).toContain("not a full translation restart");
  await expect.poll(() => confirmation).toContain("Text fit is not guaranteed");
  await expect(page.getByText("Revision in progress")).toBeVisible();
  await expect(page.getByText(/Saved translations and evidence are retained/)).toBeVisible();
});