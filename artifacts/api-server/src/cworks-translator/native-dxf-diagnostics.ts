/**
 * The native DXF attempt boundary must be useful to operators without turning
 * an exception into a log sink for drawing text, provider responses, or local
 * paths.  This module intentionally accepts only values from small
 * allowlists.  It never reads an error message, stderr, stdout, cause, or
 * stack.
 */

export const NATIVE_DXF_DIAGNOSTIC_STAGES = [
  "setup",
  "inspect",
  "translate",
  "audit",
  "checkpoint",
  "patch",
  "preview",
  "publish",
  "cleanup",
  "unknown",
] as const;

export type NativeDxfDiagnosticStage = typeof NATIVE_DXF_DIAGNOSTIC_STAGES[number];

export const NATIVE_DXF_DIAGNOSTIC_LOCATIONS = [
  "attempt_boundary",
  "source_read",
  "inspection_process",
  "inspection_cache",
  "translation_provider",
  "audit_provider",
  "checkpoint_read",
  "checkpoint_write",
  "patch_process",
  "patch_report",
  "preview_process",
  "artifact_write",
  "publication_transaction",
  "cleanup",
  "unknown",
] as const;

export type NativeDxfDiagnosticLocation = typeof NATIVE_DXF_DIAGNOSTIC_LOCATIONS[number];

export const NATIVE_DXF_DIAGNOSTIC_CODES = [
  "native_process_timeout",
  "native_process_memory",
  "native_process_terminated",
  "native_process_rejected",
  "native_process_output_limit",
  "native_process_unavailable",
  "native_process_failed",
  "native_process_cpu_budget_exhausted",
  "native_process_no_cpu_progress",
  "native_process_metrics_unavailable",
  "storage_missing",
  "storage_permission",
  "storage_capacity",
  "storage_io",
  "storage_shape_invalid",
  "runtime_resource_exhausted",
  "dependency_timeout",
  "dependency_unavailable",
  "processor_invalid_output",
  "invalid_json",
  "invalid_internal_input",
  "internal_invariant",
  "provider_failure",
  "provider_protocol_invalid",
  "resume_rejected",
  "cancelled",
  "unknown_error",
] as const;

export type NativeDxfDiagnosticCode = typeof NATIVE_DXF_DIAGNOSTIC_CODES[number];

export const NATIVE_DXF_DIAGNOSTIC_ACTIONS = [
  "retry",
  "inspect_storage",
  "check_runtime",
  "inspect_translation_response",
  "restart_full_run",
  "no_action",
  "contact_support",
] as const;

export type NativeDxfDiagnosticAction = typeof NATIVE_DXF_DIAGNOSTIC_ACTIONS[number];

export type NativeDxfDiagnosticContext = {
  stage: NativeDxfDiagnosticStage;
  location: NativeDxfDiagnosticLocation;
};

export type NativeDxfDiagnostic = NativeDxfDiagnosticContext & {
  code: NativeDxfDiagnosticCode;
  action: NativeDxfDiagnosticAction;
};

const STAGES = new Set<string>(NATIVE_DXF_DIAGNOSTIC_STAGES);
const LOCATIONS = new Set<string>(NATIVE_DXF_DIAGNOSTIC_LOCATIONS);

const PROCESS_KIND_CODES: Readonly<Record<string, NativeDxfDiagnosticCode>> = {
  timeout: "native_process_timeout",
  memory: "native_process_memory",
  terminated: "native_process_terminated",
  rejected: "native_process_rejected",
  output_limit: "native_process_output_limit",
  unavailable: "native_process_unavailable",
  process_error: "native_process_failed",
  cpu_budget_exhausted: "native_process_cpu_budget_exhausted",
  no_cpu_progress: "native_process_no_cpu_progress",
  metrics_unavailable: "native_process_metrics_unavailable",
  aborted: "cancelled",
};

const ERROR_CODES: Readonly<Record<string, NativeDxfDiagnosticCode>> = {
  ENOENT: "storage_missing",
  EACCES: "storage_permission",
  EPERM: "storage_permission",
  ENOSPC: "storage_capacity",
  EIO: "storage_io",
  ENOTDIR: "storage_shape_invalid",
  EISDIR: "storage_shape_invalid",
  EMFILE: "runtime_resource_exhausted",
  ENFILE: "runtime_resource_exhausted",
  ETIMEDOUT: "dependency_timeout",
  ECONNRESET: "dependency_unavailable",
  ECONNREFUSED: "dependency_unavailable",
  EAI_AGAIN: "dependency_unavailable",
  ENETDOWN: "dependency_unavailable",
  ENETUNREACH: "dependency_unavailable",
  EHOSTUNREACH: "dependency_unavailable",
  EMPTY_RESPONSE: "dependency_unavailable",
  UND_ERR_CONNECT_TIMEOUT: "dependency_timeout",
  UND_ERR_HEADERS_TIMEOUT: "dependency_timeout",
  UND_ERR_SOCKET: "dependency_unavailable",
  ERR_CHILD_PROCESS_STDIO_MAXBUFFER: "native_process_output_limit",
  INVALID_OUTPUT: "processor_invalid_output",
  ERR_INVALID_ARG_TYPE: "invalid_internal_input",
  ERR_INVALID_ARG_VALUE: "invalid_internal_input",
  ERR_ASSERTION: "internal_invariant",
};

const ACTIONS: Readonly<Record<NativeDxfDiagnosticCode, NativeDxfDiagnosticAction>> = {
  native_process_timeout: "retry",
  native_process_memory: "check_runtime",
  native_process_terminated: "retry",
  native_process_rejected: "inspect_storage",
  native_process_output_limit: "check_runtime",
  native_process_unavailable: "check_runtime",
  native_process_failed: "check_runtime",
  native_process_cpu_budget_exhausted: "check_runtime",
  native_process_no_cpu_progress: "retry",
  native_process_metrics_unavailable: "check_runtime",
  storage_missing: "inspect_storage",
  storage_permission: "inspect_storage",
  storage_capacity: "inspect_storage",
  storage_io: "retry",
  storage_shape_invalid: "inspect_storage",
  runtime_resource_exhausted: "check_runtime",
  dependency_timeout: "retry",
  dependency_unavailable: "retry",
  processor_invalid_output: "check_runtime",
  invalid_json: "inspect_translation_response",
  invalid_internal_input: "contact_support",
  internal_invariant: "contact_support",
  provider_failure: "retry",
  provider_protocol_invalid: "inspect_translation_response",
  resume_rejected: "restart_full_run",
  cancelled: "no_action",
  unknown_error: "contact_support",
};

function safeProperty(value: unknown, property: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function safeStringProperty(value: unknown, property: string): string | null {
  const propertyValue = safeProperty(value, property);
  return typeof propertyValue === "string" ? propertyValue : null;
}

function allowlistedStage(value: unknown): NativeDxfDiagnosticStage | null {
  return typeof value === "string" && STAGES.has(value)
    ? value as NativeDxfDiagnosticStage
    : null;
}

function allowlistedLocation(value: unknown): NativeDxfDiagnosticLocation | null {
  return typeof value === "string" && LOCATIONS.has(value)
    ? value as NativeDxfDiagnosticLocation
    : null;
}

function errorCode(error: unknown): NativeDxfDiagnosticCode {
  const kind = safeStringProperty(error, "kind");
  if (kind && PROCESS_KIND_CODES[kind]) return PROCESS_KIND_CODES[kind];

  const name = safeStringProperty(error, "name");
  if (name === "SyntaxError") return "invalid_json";
  if (name === "CworksProviderError") return "provider_failure";
  if (name === "NativeDxfMalformedTranslationResponse") return "provider_protocol_invalid";
  if (name === "NativeDxfResumeRejectedError") return "resume_rejected";
  if (name === "AbortError") return "cancelled";

  const code = safeStringProperty(error, "code");
  if (code) {
    const normalizedCode = code.toUpperCase();
    return ERROR_CODES[normalizedCode] || "unknown_error";
  }
  return "unknown_error";
}

function errorStage(error: unknown): NativeDxfDiagnosticStage | null {
  return allowlistedStage(safeProperty(error, "stage"));
}

/**
 * Produce a bounded, safe diagnostic for the native DXF job boundary.
 *
 * `context` should be the last known worker location.  A native processor
 * error carries its own allowlisted stage, which is preferred over the
 * surrounding context because it is more precise.  All other output values
 * come from the constants above; arbitrary error properties are not returned.
 */
export function describeNativeDxfError(
  error: unknown,
  context: NativeDxfDiagnosticContext,
): NativeDxfDiagnostic {
  const code = errorCode(error);
  return {
    stage: errorStage(error) || allowlistedStage(context?.stage) || "unknown",
    location: allowlistedLocation(context?.location) || "unknown",
    code,
    action: ACTIONS[code],
  };
}