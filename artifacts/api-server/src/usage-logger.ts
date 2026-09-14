// Slim cost logger for the Drawing Translator. Writes to the shared
// `api_usage_logs` table so Navigator's Cost Dashboard still sees this spend.
import { db } from "../db";
import { apiUsageLogs } from "@workspace/db";

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250929": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  "claude-opus-4-5-20251101": { input: 5.0 / 1_000_000, output: 25.0 / 1_000_000 },
  "claude-haiku-4-5-20251001": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  "gemini-2.5-flash": { input: 0.3 / 1_000_000, output: 2.5 / 1_000_000 },
  "gemini-2.5-pro": { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 },
};

export function calculateCost(model: string | undefined, inputTokens: number, outputTokens: number): number {
  const p = model ? PRICING[model] : undefined;
  if (!p) return 0;
  return inputTokens * p.input + outputTokens * p.output;
}

export async function logApiUsage(opts: {
  service: string;
  model?: string;
  endpoint?: string;
  projectId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  prompt?: string | null;
  response?: string | null;
  metadata?: Record<string, any>;
}) {
  const inputTokens = opts.inputTokens ?? 0;
  const outputTokens = opts.outputTokens ?? 0;
  try {
    await db.insert(apiUsageLogs).values({
      service: opts.service,
      model: opts.model ?? null,
      endpoint: opts.endpoint ?? null,
      projectId: opts.projectId ?? null,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCost: calculateCost(opts.model, inputTokens, outputTokens).toFixed(6),
      prompt: opts.prompt ?? null,
      response: opts.response ?? null,
      metadata: JSON.stringify({ app: "cworks-drawing-translator", ...(opts.metadata ?? {}) }),
    });
  } catch (err) {
    console.error("[usage-logger] failed to record usage:", err);
  }
}
