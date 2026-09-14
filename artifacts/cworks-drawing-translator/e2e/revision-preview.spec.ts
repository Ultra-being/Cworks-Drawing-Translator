import { expect, test } from "@playwright/test";

const jobId = "revision-preview-regression";

function job(revisionCount: number) {
  return {
    id: jobId,
    title: "Revision preview fixture",
    sourceLanguage: "ru",
    scope: "full",
    drawingDepth: "everything",
    status: "awaiting_review",
    progress: 100,
    progressNote: "Ready for review",
    pageCount: 1,
    pagesDone: 1,
    originalFilename: "fixture.pdf",
    sourceFormat: "pdf",
    feedbackNotes: null,
    errorMessage: null,
    tokenEstimate: 1,
    costEstimate: "0",
    revisionCount,
    createdAt: "2026-09-07T00:00:00.000Z",
  };
}

function detail(revisionCount: number) {
  return {
    job: job(revisionCount),
    coverage: {
      targetLineCount: 1,
      recoveredLineCount: 1,
      translatedLineCount: 1,
      placedLineCount: 1,
      unresolvedLineCount: 0,
      placementPercent: 100,
      severelyIncomplete: false,
      complete: true,
    },
    reviewHistory: [],
    pages: [{
      id: 1,
      pageNumber: 1,
      thumbnailUrl: `/api/cworks-translator/jobs/${jobId}/pages/1/thumbnail?revision=${revisionCount}`,
      sourceThumbnailUrl: `/api/cworks-translator/jobs/${jobId}/pages/1/source-thumbnail`,
      sourceBlockCount: 1,
      translatedBlockCount: 1,
      warnings: [],
      unresolvedLines: [],
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

test("replaces an open review preview when the next revision publishes", async ({ page }) => {
  let activeRevision = 1;
  const translatedPreviewRequests: string[] = [];

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
      return route.fulfill({ json: { jobs: [job(activeRevision)] } });
    }
    if (url.pathname.endsWith(`/jobs/${jobId}/restore-previous-revision`) && request.method() === "POST") {
      activeRevision = 2;
      return route.fulfill({ json: { job: job(activeRevision) } });
    }
    if (url.pathname.endsWith(`/jobs/${jobId}`) && request.method() === "GET") {
      return route.fulfill({ json: detail(activeRevision) });
    }
    if (url.pathname.endsWith(`/jobs/${jobId}/pages/1/source-thumbnail`)) {
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/></svg>',
      });
    }
    if (url.pathname.endsWith(`/jobs/${jobId}/pages/1/thumbnail`)) {
      translatedPreviewRequests.push(url.toString());
      const color = url.searchParams.get("revision") === "2" ? "#16803c" : "#b42318";
      return route.fulfill({
        contentType: "image/svg+xml",
        headers: { "Cache-Control": "no-store" },
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${color}"/></svg>`,
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });

  await page.goto("/");
  await page.getByTestId(`card-job-${jobId}`).click();

  const preview = page.getByRole("img", { name: "Translated" });
  await expect(preview).toHaveAttribute("src", new RegExp(`revision=1$`));
  await expect.poll(() => translatedPreviewRequests.some(url => url.endsWith("revision=1"))).toBe(true);
  const revisionOnePixels = await preview.screenshot();

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Restore previous revision" }).click();

  await expect(preview).toHaveAttribute("src", new RegExp(`revision=2$`));
  await expect.poll(() => translatedPreviewRequests.some(url => url.endsWith("revision=2"))).toBe(true);
  const revisionTwoPixels = await preview.screenshot();

  expect(revisionTwoPixels.equals(revisionOnePixels)).toBe(false);
  expect(translatedPreviewRequests.at(-1)).toMatch(/revision=2$/);
});