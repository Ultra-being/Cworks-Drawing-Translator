import assert from "node:assert/strict";
import test from "node:test";
import { askClaude } from "../ai-services";
import {
  CworksProviderError,
  hasUnsettledCworksProviderRequest,
  requestCworksProviderWithRetry,
} from "./worker";

test("provider timeout aborts the first request before retrying", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let firstSignal: AbortSignal | undefined;
  const retries: number[] = [];

  const result = await requestCworksProviderWithRetry(
    async (signal) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (calls === 2) {
        active--;
        return "translated";
      }
      firstSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          active--;
          reject(signal.reason);
        }, { once: true });
      });
    },
    {
      timeoutMs: 10,
      maxAttempts: 2,
      retryDelayMs: 0,
      abortGraceMs: 50,
      onRetry: ({ nextAttempt }) => retries.push(nextAttempt),
    },
  );

  assert.equal(result, "translated");
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.equal(firstSignal?.aborted, true);
  assert.deepEqual(retries, [2]);
});

test("provider timeout does not retry when cancellation does not settle", async () => {
  let calls = 0;
  let settleRequest: (() => void) | undefined;
  await assert.rejects(
    requestCworksProviderWithRetry(
      async () => {
        calls++;
        return new Promise<string>((resolve) => {
          settleRequest = () => resolve("late response");
        });
      },
      {
        timeoutMs: 5,
        maxAttempts: 2,
        retryDelayMs: 0,
        abortGraceMs: 5,
        quarantineKey: "unsettled-test-job",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CworksProviderError);
      assert.equal(error.attempts, 1);
      assert.equal(error.timedOut, true);
      assert.equal(error.cancellationConfirmed, false);
      assert.match(error.message, /no overlapping retry/i);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(hasUnsettledCworksProviderRequest("unsettled-test-job"), true);
  settleRequest?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hasUnsettledCworksProviderRequest("unsettled-test-job"), false);
});

test("non-transient provider rejection is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    requestCworksProviderWithRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
      {
        timeoutMs: 50,
        maxAttempts: 2,
        retryDelayMs: 0,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CworksProviderError);
      assert.equal(error.attempts, 1);
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("unknown provider failures are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    requestCworksProviderWithRetry(
      async () => {
        calls++;
        throw new Error("Gemini translator returned an empty response");
      },
      {
        timeoutMs: 50,
        maxAttempts: 2,
        retryDelayMs: 0,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CworksProviderError);
      assert.equal(error.attempts, 1);
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("recognized network failures retry once", async () => {
  let calls = 0;
  const result = await requestCworksProviderWithRetry(
    async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return "translated";
    },
    {
      timeoutMs: 50,
      maxAttempts: 2,
      retryDelayMs: 0,
    },
  );
  assert.equal(result, "translated");
  assert.equal(calls, 2);
});

test("Claude requests receive the optional abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async (_input, init) => {
    observedSignal = init?.signal;
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "translated" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await askClaude("translate", undefined, undefined, "project", {
      logUsage: false,
      signal: controller.signal,
    });
    assert.equal(result, "translated");
    assert.equal(observedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});