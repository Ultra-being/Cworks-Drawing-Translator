// Minimal AI service layer for the Drawing Translator: just `askClaude`.
// Same signature as Navigator's so `cworks-translator/*` is unchanged.
import { logApiUsage } from "./usage-logger";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

const CLAUDE_MODEL = process.env.TRANSLATOR_CLAUDE_MODEL || "claude-sonnet-4-5-20250929";

export async function askClaude(
  prompt: string,
  context?: string,
  conversationHistory?: ClaudeMessage[],
  projectId?: string | null,
  options?: {
    logUsage?: boolean;
    maxTokens?: number;
    requireComplete?: boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const messages: ClaudeMessage[] = conversationHistory || [];
  let userMessage = prompt;
  if (context) {
    userMessage = `Context:\n${context}\n\n---\n\nRequest:\n${prompt}`;
  }
  messages.push({ role: "user", content: userMessage });

  const model = CLAUDE_MODEL;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      messages,
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw Object.assign(
      new Error(`Claude API error: ${response.status} - ${errorText}`),
      { status: response.status },
    );
  }

  const data: any = await response.json();
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const textContent = data.content?.find((block: any) => block.type === "text");
  const responseText = textContent?.text || "No response generated";
  if (options?.requireComplete && data.stop_reason === "max_tokens") {
    throw new Error("Claude response truncated at the output limit");
  }

  if (options?.logUsage !== false) {
    logApiUsage({
      service: "claude",
      model,
      endpoint: "/api/cworks-translator",
      projectId: projectId || undefined,
      inputTokens,
      outputTokens,
      prompt: userMessage.slice(0, 4000),
      response: responseText.slice(0, 4000),
    });
  }

  return responseText;
}
