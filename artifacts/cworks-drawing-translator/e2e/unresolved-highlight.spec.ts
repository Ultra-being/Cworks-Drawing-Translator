import { expect, test, type Page } from "@playwright/test";

const jobId = "highlight-alignment-regression";
const bbox = [198, 153, 396, 306] as const;

async function openHighlightedRegion(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await page.route("**/api/cworks-translator/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/auth/status")) {
      return route.fulfill({ json: { authenticated: true } });
    }
    if (url.pathname.endsWith("/health")) {
      return route.fulfill({ json: { ok: true, translatorReady: true, translatorProvider: "gemini" } });
    }
    if (url.pathname.endsWith("/jobs")) {
      return route.fulfill({ json: { jobs: [{
        id: jobId,
        title: "Highlight alignment fixture",
        sourceLanguage: "ru",
        scope: "full",
        drawingDepth: "everything",
        status: "awaiting_review",
        progress: 100,
        progressNote: "Ready for review",
        pageCount: 1,
        pagesDone: 1,
        originalFilename: "fixture.pdf",
        feedbackNotes: null,
        errorMessage: null,
        tokenEstimate: 1,
        costEstimate: "0",
        revisionCount: 0,
        createdAt: "2026-08-26T00:00:00.000Z",
      }] } });
    }
    if (url.pathname.endsWith(`/jobs/${jobId}`)) {
      return route.fulfill({ json: {
        job: {
          id: jobId,
          title: "Highlight alignment fixture",
          sourceLanguage: "ru",
          scope: "full",
          drawingDepth: "everything",
          status: "awaiting_review",
          progress: 100,
          progressNote: "Ready for review",
          pageCount: 1,
          pagesDone: 1,
          originalFilename: "fixture.pdf",
          feedbackNotes: null,
          errorMessage: null,
          tokenEstimate: 1,
          costEstimate: "0",
          revisionCount: 0,
          createdAt: "2026-08-26T00:00:00.000Z",
        },
        coverage: {
          targetLineCount: 1,
          recoveredLineCount: 0,
          translatedLineCount: 0,
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
            pageNumber: 1,
            bbox,
            rejectionCategory: "overlap",
          }],
          previewMetadata: {
            pixelWidth: 1210,
            pixelHeight: 935,
            pageWidthPoints: 792,
            pageHeightPoints: 612,
          },
          machineAuditStatus: "passed",
          machineAuditFindings: [],
          review: null,
        }],
      } });
    }
    if (url.pathname.includes("/pages/1/")) {
      return route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="1210" height="935" viewBox="0 0 1210 935"><rect width="1210" height="935" fill="white"/><rect x="302.5" y="233.75" width="302.5" height="233.75" fill="#ddd"/></svg>`,
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });

  await page.goto("/");
  await page.getByTestId(`card-job-${jobId}`).click();
  await page.getByRole("button", { name: /Page 1/ }).click();
  await page.getByText("Overlap with nearby drawing content", { exact: true }).click();
  await expect(page.getByTestId("unresolved-region-highlight")).toBeVisible();
}

for (const viewport of [
  { name: "desktop", width: 1440 },
  { name: "narrow", width: 390 },
]) {
  test(`keeps the unresolved highlight aligned in the ${viewport.name} review layout`, async ({ page }) => {
    await openHighlightedRegion(page, viewport.width);
    const image = await page.getByTestId("source-preview-image").boundingBox();
    const highlight = await page.getByTestId("unresolved-region-highlight").boundingBox();
    expect(image).not.toBeNull();
    expect(highlight).not.toBeNull();

    const expected = {
      x: image!.x + image!.width * (bbox[0] / 792),
      y: image!.y + image!.height * (bbox[1] / 612),
      width: image!.width * ((bbox[2] - bbox[0]) / 792),
      height: image!.height * ((bbox[3] - bbox[1]) / 612),
    };
    expect(highlight!.x).toBeCloseTo(expected.x, 0);
    expect(highlight!.y).toBeCloseTo(expected.y, 0);
    expect(highlight!.width).toBeCloseTo(expected.width, 0);
    expect(highlight!.height).toBeCloseTo(expected.height, 0);
  });
}