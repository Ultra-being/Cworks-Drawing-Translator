import { expect, test, type Page, type Route } from "@playwright/test";

const jobId = "hybrid-derivative-regression";
const attestation = "I attest that I am the identified qualified CAD operator and that the recorded evidence is accurate.";
const hashes = {
  sourceSha256: "a".repeat(64),
  sourceOutputSha256: "b".repeat(64),
  preservationReportSha256: "c".repeat(64),
  ledgerSha256: "d".repeat(64),
  placementManifestSha256: "e".repeat(64),
  tableScriptSha256: "f".repeat(64),
  tableManifestSha256: "1".repeat(64),
};
const applicationOutput = `Command: CWORKS_APPLY_TABLE_TRANSLATIONS
CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=${hashes.tableManifestSha256}
Cworks table translations: matchedTargets=2 appliedCells=2 skippedTargets=0 countMismatch=0 unsafeCells=0 partialErrors=0 errors=0
CWORKS_APPLY_TABLE_TRANSLATIONS_END manifestSha256=${hashes.tableManifestSha256}
Command:`;

function job(status: "awaiting_review" | "done" = "awaiting_review") {
  return {
    id: jobId,
    title: "Hybrid derivative fixture",
    sourceLanguage: "ru",
    targetLanguage: "en",
    scope: "full",
    drawingDepth: "everything",
    status,
    progress: 100,
    progressNote: "Ready for CAD completion",
    pageCount: 1,
    pagesDone: 1,
    originalFilename: "fixture.dxf",
    sourceFormat: "dxf",
    feedbackNotes: null,
    errorMessage: null,
    tokenEstimate: 1,
    costEstimate: "0",
    revisionCount: 2,
    approvedRevision: null,
    approvedAt: null,
    machineAuditStatus: "passed",
    machineAuditModel: "independent-audit-model",
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

function requirements(overrides: Partial<typeof hashes> = {}) {
  return {
    format: "cworks-hybrid-derivative-requirements-v1",
    lineageKind: "hybrid_draft_completion",
    sourceRevision: 2,
    ...hashes,
    ...overrides,
    tableTargetCount: 2,
    expectedCounters: { expected: 2, applied: 2, missing: 0, ambiguous: 0, failed: 0, skipped: 0 },
    manualRequirementIds: ["opaque:layout-a"],
    machineDefectCount: 0,
    independentAuditModel: "independent-audit-model",
    submissionAllowed: true,
    requiredAttestation: attestation,
  };
}

function derivative(source = hashes, sourceRevision = 1) {
  return {
    id: "candidate-1",
    jobId,
    originalFilename: "completed.dwg",
    format: "dwg",
    operatorName: "Qualified Operator",
    operatorQualification: "Senior CAD Technician",
    operatorNotes: "Applied script and inspected all layouts.",
    operatorAttestation: attestation,
    sourceRevision,
    sha256: "2".repeat(64),
    source: {
      revision: sourceRevision,
      translatedOutputSha256: source.sourceOutputSha256,
      approvalEventId: null,
    },
    lineageKind: "hybrid_draft_completion",
    evidence: {
      format: "cworks-hybrid-derivative-evidence-v2",
      derivativeSha256: "2".repeat(64),
      sourceRevision,
      ...source,
      tableTargetCount: 2,
      expectedAppliedCount: 2,
      machineDefectCount: 0,
      independentAuditModel: "independent-audit-model",
      counters: { expected: 2, applied: 2, missing: 0, ambiguous: 0, failed: 0, skipped: 0 },
      applicationOutput: {
        text: applicationOutput,
        sha256: "3".repeat(64),
        parsedCounters: {
          matchedTargets: 2,
          appliedCells: 2,
          skippedTargets: 0,
          countMismatch: 0,
          unsafeCells: 0,
          partialErrors: 0,
          errors: 0,
        },
      },
      manualCoverageResolutions: [{ requirementId: "opaque:layout-a", resolution: "Inspected and resolved." }],
      operationalVerification: {
        platform: "windows_autocad",
        autoCadMajorVersion: 2024,
        lispSys: 1,
        sourceScriptManifestHashesVerified: true,
        partialApplicationEvidenceDisposition: "discarded",
        savedClosedReopened: true,
        reopenedInspectionNotes: "Inspected all layouts after reopening.",
      },
    },
    artifactClass: "human_edited_cad_derivative",
    preservationProof: false,
    bytePreservationClaim: false,
    downloadUrl: `/api/cworks-translator/jobs/${jobId}/cad-derivatives/candidate-1/download`,
    draftDownloadUrl: `/api/cworks-translator/jobs/${jobId}/cad-derivatives/candidate-1/draft-download`,
    lineageReportUrl: `/api/cworks-translator/jobs/${jobId}/cad-derivatives/candidate-1/lineage-report`,
    createdAt: "2026-09-10T01:00:00.000Z",
  };
}

function detail(derivatives: ReturnType<typeof derivative>[] = [], reviewHistory: unknown[] = []) {
  return {
    job: job(),
    coverage: {
      hybridPending: true,
      targetLineCount: 2,
      recoveredLineCount: 2,
      translatedLineCount: 2,
      placedLineCount: 0,
      unresolvedLineCount: 2,
      placementPercent: 0,
      severelyIncomplete: false,
      complete: false,
    },
    derivatives,
    reviewHistory,
    pages: [{
      id: 1,
      pageNumber: 1,
      thumbnailUrl: null,
      sourceThumbnailUrl: null,
      sourceBlockCount: 2,
      translatedBlockCount: 2,
      warnings: [],
      unresolvedLines: [],
      machineAuditStatus: "passed",
      machineAuditFindings: [],
      review: { checked: true, resolvedFindingIndexes: [], notes: null, checkedAt: "2026-09-10T00:30:00.000Z" },
    }],
  };
}

async function mockBase(page: Page, routeHandler: (route: Route) => Promise<void>) {
  await page.route("**/api/cworks-translator/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/auth/status")) return route.fulfill({ json: {
      authenticated: true,
      workspaceIdentity: { id: "reviewer-1", name: "Qualified Reviewer", role: "admin" },
      derivativeReviewAuthorized: true,
    } });
    if (pathname.endsWith("/health")) return route.fulfill({ json: { ok: true, translatorReady: true, translatorProvider: "gemini" } });
    if (pathname.endsWith("/jobs") && request.method() === "GET") return route.fulfill({ json: { jobs: [job()] } });
    return routeHandler(route);
  });
  await page.goto("/");
  await page.getByTestId(`card-job-${jobId}`).click();
}

async function completeHybridFormExceptOutput(page: Page) {
  await page.getByTestId("input-hybrid-derivative-file").setInputFiles({
    name: "completed.dwg",
    mimeType: "application/acad",
    buffer: Buffer.from("AC1032 regression fixture"),
  });
  await page.getByLabel("CAD operator legal name").fill("Qualified Operator");
  await page.getByLabel("CAD operator qualification").fill("Senior CAD Technician");
  await page.getByLabel("opaque:layout-a").fill("Inspected the opaque layout manually and verified the translated result.");
  await page.getByLabel("AutoCAD major version").fill("2024");
  await page.getByLabel("LISPSYS value").click();
  await page.getByRole("option", { name: /1 — Unicode/ }).click();
  await page.getByLabel(/verified the displayed source/).check();
  await page.getByLabel(/partial run was closed without saving/).check();
  await page.getByLabel(/saved the derivative DWG, closed it/).check();
  await page.getByLabel("Reopened derivative inspection").fill("Inspected all layouts after reopening.");
  await page.getByLabel("Operator notes").fill("Applied the bound script, ran AUDIT, and inspected every layout.");
  await page.getByLabel(attestation).check();
}

test("submits every revision-bound hybrid hash in the multipart payload", async ({ page }) => {
  let multipartBody = "";
  await mockBase(page, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivative-requirements`)) {
      return route.fulfill({ json: requirements() });
    }
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivatives`) && request.method() === "POST") {
      multipartBody = request.postDataBuffer()?.toString("utf8") || "";
      return route.fulfill({ status: 201, json: { derivative: derivative() } });
    }
    if (pathname.endsWith(`/jobs/${jobId}`)) return route.fulfill({ json: detail() });
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });

  await completeHybridFormExceptOutput(page);
  await page.getByTestId("textarea-application-output").fill(applicationOutput);
  await expect(page.getByTestId("status-application-output-validation")).toContainText("all seven counters are successful");
  await expect(page.getByTestId("button-submit-hybrid-derivative")).toBeEnabled();
  await page.getByTestId("button-submit-hybrid-derivative").click();

  await expect.poll(() => multipartBody.length).toBeGreaterThan(0);
  expect(multipartBody).toContain('name="sourceRevision"\r\n\r\n2');
  for (const [field, value] of Object.entries(hashes)) {
    expect(multipartBody).toContain(`name="${field}"\r\n\r\n${value}`);
  }
  expect(multipartBody).toContain('name="lineageKind"\r\n\r\nhybrid_draft_completion');
  expect(multipartBody).toContain('name="applicationOutput"');
  expect(multipartBody).toContain(`CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=${hashes.tableManifestSha256}`);
});

test("explains invalid pasted AutoCAD output and keeps submission disabled", async ({ page }) => {
  await mockBase(page, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivative-requirements`)) return route.fulfill({ json: requirements() });
    if (pathname.endsWith(`/jobs/${jobId}`)) return route.fulfill({ json: detail() });
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
  await completeHybridFormExceptOutput(page);

  await page.getByTestId("textarea-application-output").fill("Cworks table translations: matchedTargets=2 appliedCells=2 skippedTargets=0 countMismatch=0 unsafeCells=0 partialErrors=0 errors=0");
  await expect(page.getByTestId("status-application-output-validation")).toContainText("exactly one complete BEGIN marker");
  await expect(page.getByTestId("button-submit-hybrid-derivative")).toBeDisabled();

  await page.getByTestId("textarea-application-output").fill(applicationOutput.replaceAll(hashes.tableManifestSha256, "9".repeat(64)));
  await expect(page.getByTestId("status-application-output-validation")).toContainText("different table manifest");
  await expect(page.getByTestId("button-submit-hybrid-derivative")).toBeDisabled();

  await page.getByTestId("textarea-application-output").fill(applicationOutput.replace("errors=0", "errors=1"));
  await expect(page.getByTestId("status-application-output-validation")).toContainText("errors=1");
  await expect(page.getByTestId("button-submit-hybrid-derivative")).toBeDisabled();
});

test("accepts valid attached AutoCAD output", async ({ page }) => {
  await mockBase(page, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivative-requirements`)) return route.fulfill({ json: requirements() });
    if (pathname.endsWith(`/jobs/${jobId}`)) return route.fulfill({ json: detail() });
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
  await completeHybridFormExceptOutput(page);
  await page.getByTestId("input-application-output-file").setInputFiles({
    name: "command-output.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(applicationOutput),
  });
  await expect(page.getByTestId("status-application-output-validation")).toContainText("all seven counters are successful");
  await expect(page.getByTestId("button-submit-hybrid-derivative")).toBeEnabled();
});

test("rejects invalid attached AutoCAD output before upload", async ({ page }) => {
  await mockBase(page, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivative-requirements`)) return route.fulfill({ json: requirements() });
    if (pathname.endsWith(`/jobs/${jobId}`)) return route.fulfill({ json: detail() });
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
  await completeHybridFormExceptOutput(page);
  await page.getByTestId("input-application-output-file").setInputFiles({
    name: "command-output.log",
    mimeType: "text/plain",
    buffer: Buffer.from(applicationOutput.replace("partialErrors=0", "partialErrors=1")),
  });
  await expect(page.getByTestId("status-application-output-validation")).toContainText("partialErrors=1");
  await expect(page.getByTestId("button-submit-hybrid-derivative")).toBeDisabled();
});

test("does not expose an old approval after the parent source revision changes", async ({ page }) => {
  const oldHashes = Object.fromEntries(Object.keys(hashes).map((key, index) => [key, String((index + 2) % 10).repeat(64)])) as typeof hashes;
  const oldCandidate = derivative(oldHashes);
  const oldApproval = {
    id: 91,
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered Engineer",
    decision: "derivative_approve",
    declaration: "Signed",
    notes: "Approved prior revision.",
    revisionCount: 1,
    derivativeId: oldCandidate.id,
    createdAt: "2026-09-10T02:00:00.000Z",
  };
  await mockBase(page, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivative-requirements`)) return route.fulfill({ json: requirements() });
    if (pathname.endsWith(`/jobs/${jobId}`)) return route.fulfill({ json: detail([oldCandidate], [oldApproval]) });
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });

  await expect(page.getByTestId(`text-derivative-review-status-${oldCandidate.id}`)).toHaveText(/Stale source/);
  await expect(page.getByRole("button", { name: "Download released CAD" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Released evidence report" })).toHaveCount(0);
  await expect(page.getByTestId(`link-inspect-draft-derivative-${oldCandidate.id}`)).toHaveCount(0);
});

test("keeps revision history and reopens submission after a derivative revision request", async ({ page }) => {
  const currentCandidate = derivative(hashes, 2);
  let revisionRequested = false;
  const revisionEvent = {
    id: 92,
    reviewerName: "Qualified Reviewer",
    reviewerQualification: "Chartered Engineer",
    decision: "derivative_revise",
    declaration: "Returned without release",
    notes: "Correct the remaining title block cell.",
    revisionCount: 2,
    derivativeId: currentCandidate.id,
    createdAt: "2026-09-10T03:00:00.000Z",
  };
  await mockBase(page, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivative-requirements`)) return route.fulfill({ json: requirements() });
    if (pathname.endsWith(`/jobs/${jobId}/cad-derivatives/${currentCandidate.id}/review`) && request.method() === "POST") {
      revisionRequested = true;
      return route.fulfill({ json: { decision: "derivative_revise", derivative: currentCandidate, reviewEventId: revisionEvent.id } });
    }
    if (pathname.endsWith(`/jobs/${jobId}`)) {
      return route.fulfill({ json: detail([currentCandidate], revisionRequested ? [revisionEvent] : []) });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });

  await expect(page.getByText("Your signed-in workspace identity", { exact: false })).toBeVisible();
  await page.getByLabel("Review notes").fill(revisionEvent.notes);
  await page.getByRole("button", { name: "Request derivative revision" }).click();

  await expect(page.getByTestId(`text-derivative-review-status-${currentCandidate.id}`)).toHaveText(/Revision requested/);
  await expect(page.getByText(revisionEvent.notes, { exact: false })).toBeVisible();
  await expect(page.getByTestId(`card-hybrid-derivative-${currentCandidate.id}`)).toBeVisible();
  await expect(page.getByTestId("input-hybrid-derivative-file")).toBeEnabled();
});
