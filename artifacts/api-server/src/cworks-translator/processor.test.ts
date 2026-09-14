import assert from "node:assert/strict";
import test from "node:test";
import {
  CworksProcessorError,
  type ProcessorFailureDiagnostic,
  runProcessor,
  sanitizeProcessorUserMessage,
} from "./worker";

function failedProcess(options: {
  message?: string;
  code?: string | number;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stderr?: string;
}) {
  return Object.assign(new Error(options.message || "processor failed"), {
    code: options.code ?? 1,
    signal: options.signal ?? null,
    killed: options.killed ?? false,
    stderr: options.stderr || "",
  });
}

test("transient extraction failure retries once in process", async () => {
  let calls = 0;
  const diagnostics: ProcessorFailureDiagnostic[] = [];
  const result = await runProcessor(
    ["extract", "/tmp/private-job/input.pdf", "/tmp/private-job/blocks.json"],
    {
      stage: "extraction",
      timeoutMs: 1_000,
      maxAttempts: 2,
      retryDelayMs: 0,
      logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      executor: async () => {
        calls++;
        if (calls === 1) {
          throw failedProcess({
            message: "Command failed: python3 /workspace/server/cworks-translator/processor.py",
            code: 1,
            stderr: "Traceback: temporary PyMuPDF runtime failure at /tmp/private-job/input.pdf",
          });
        }
        return { stdout: '{"pageCount":42,"blockCount":100}\n', stderr: "" };
      },
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.pageCount, 42);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].deterministic, false);
  assert.equal(diagnostics[0].exitCode, 1);
});

test("deterministic PDF rejection does not retry", async () => {
  let calls = 0;
  await assert.rejects(
    runProcessor(
      ["extract", "/tmp/private-job/input.pdf", "/tmp/private-job/blocks.json"],
      {
        stage: "extraction",
        timeoutMs: 1_000,
        maxAttempts: 2,
        retryDelayMs: 0,
        logDiagnostic: () => {},
        executor: async () => {
          calls++;
          throw failedProcess({
            code: 2,
            stderr: JSON.stringify({
              kind: "document_rejected",
              code: "password_protected",
              message: "Password-protected PDFs are not supported",
            }),
          });
        },
      },
    ),
    (err: unknown) => {
      assert.ok(err instanceof CworksProcessorError);
      assert.equal(err.deterministic, true);
      assert.equal(err.attempts, 1);
      assert.equal(err.message, "Password-protected PDFs are not supported");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("processor errors shown to users do not expose commands or private paths", async () => {
  const sanitized = sanitizeProcessorUserMessage(
    "Cannot open /tmp/cad-secret/input.pdf with python3 /workspace/server/cworks-translator/processor.py",
    "The PDF could not be processed.",
  );
  assert.doesNotMatch(sanitized, /\/tmp|\/workspace|processor\.py|python3/i);

  await assert.rejects(
    runProcessor(
      ["extract", "/tmp/cad-secret/input.pdf", "/tmp/cad-secret/blocks.json"],
      {
        stage: "extraction",
        timeoutMs: 1_000,
        maxAttempts: 1,
        retryDelayMs: 0,
        logDiagnostic: () => {},
        executor: async () => {
          throw failedProcess({
            message: "Command failed: python3 /workspace/server/cworks-translator/processor.py /tmp/cad-secret/input.pdf",
            code: "ETIMEDOUT",
            signal: "SIGTERM",
            killed: true,
            stderr: "private traceback at /tmp/cad-secret/input.pdf",
          });
        },
      },
    ),
    (err: unknown) => {
      assert.ok(err instanceof CworksProcessorError);
      assert.equal(err.deterministic, false);
      assert.doesNotMatch(err.message, /\/tmp|\/workspace|processor\.py|python3/i);
      return true;
    },
  );
});