import assert from "node:assert/strict";
import test from "node:test";
import { NativeDxfProcessError } from "./native-dxf-process";
import {
  describeNativeDxfError,
  NATIVE_DXF_DIAGNOSTIC_CODES,
  NATIVE_DXF_DIAGNOSTIC_LOCATIONS,
  NATIVE_DXF_DIAGNOSTIC_STAGES,
} from "./native-dxf-diagnostics";

test("generic native DXF errors become safe, actionable allowlisted diagnostics", () => {
  const diagnostic = describeNativeDxfError(
    Object.assign(new Error(
      "provider secret Bearer abc123 while reading /private/customer/source.dxf",
    ), {
      code: "EACCES",
      stderr: "drawing source text and https://provider.invalid/v1",
      path: "/private/customer/source.dxf",
    }),
    { stage: "patch", location: "patch_process" },
  );

  assert.deepEqual(diagnostic, {
    stage: "patch",
    location: "patch_process",
    code: "storage_permission",
    action: "inspect_storage",
  });
  assert.ok(NATIVE_DXF_DIAGNOSTIC_STAGES.includes(diagnostic.stage));
  assert.ok(NATIVE_DXF_DIAGNOSTIC_LOCATIONS.includes(diagnostic.location));
  assert.ok(NATIVE_DXF_DIAGNOSTIC_CODES.includes(diagnostic.code));
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|Bearer|abc123|private|customer|source\.dxf|provider\.invalid|drawing source/i);
});

test("processor failures preserve their safe stage and use an allowlisted code", () => {
  const diagnostic = describeNativeDxfError(
    new NativeDxfProcessError("preview", "timeout"),
    { stage: "publish", location: "publication_transaction" },
  );

  assert.deepEqual(diagnostic, {
    stage: "preview",
    location: "publication_transaction",
    code: "native_process_timeout",
    action: "retry",
  });
});

test("CPU supervision failures keep their specific diagnostic cause", () => {
  const cases = [
    {
      kind: "cpu_budget_exhausted" as const,
      expected: { code: "native_process_cpu_budget_exhausted", action: "check_runtime" },
    },
    {
      kind: "no_cpu_progress" as const,
      expected: { code: "native_process_no_cpu_progress", action: "retry" },
    },
    {
      kind: "metrics_unavailable" as const,
      expected: { code: "native_process_metrics_unavailable", action: "check_runtime" },
    },
  ];

  for (const item of cases) {
    const diagnostic = describeNativeDxfError(
      new NativeDxfProcessError("patch", item.kind),
      { stage: "publish", location: "publication_transaction" },
    );
    assert.equal(diagnostic.stage, "patch");
    assert.equal(diagnostic.code, item.expected.code);
    assert.equal(diagnostic.action, item.expected.action);
    assert.notEqual(diagnostic.code, "native_process_timeout");
  }
});

test("known runtime and protocol errors are classified without exposing messages", () => {
  const cases = [
    {
      error: Object.assign(new Error("unexpected output /tmp/secret/output"), { code: "INVALID_OUTPUT" }),
      expected: { code: "processor_invalid_output", action: "check_runtime" },
    },
    {
      error: Object.assign(new Error("malformed response with drawing text"), { name: "SyntaxError" }),
      expected: { code: "invalid_json", action: "inspect_translation_response" },
    },
    {
      error: Object.assign(new Error("network response contains a token"), { name: "CworksProviderError" }),
      expected: { code: "provider_failure", action: "retry" },
    },
  ] as const;

  for (const item of cases) {
    const diagnostic = describeNativeDxfError(item.error, {
      stage: "translate",
      location: "translation_provider",
    });
    assert.equal(diagnostic.code, item.expected.code);
    assert.equal(diagnostic.action, item.expected.action);
    assert.doesNotMatch(JSON.stringify(diagnostic), /unexpected|secret|drawing|token|network/i);
  }
});

test("unknown or untrusted fields fall back to safe constants", () => {
  const diagnostic = describeNativeDxfError({
    name: "Error",
    code: "/private/provider/path",
    kind: "not-an-allowlisted-kind",
    stage: "/private/source.dxf",
  }, {
    stage: "not-a-stage" as never,
    location: "/private/source.dxf" as never,
  });

  assert.deepEqual(diagnostic, {
    stage: "unknown",
    location: "unknown",
    code: "unknown_error",
    action: "contact_support",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|provider|source\.dxf/i);
});