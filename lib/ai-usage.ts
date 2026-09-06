import { AsyncLocalStorage } from "node:async_hooks";
import type Anthropic from "@anthropic-ai/sdk";
export interface AiUsage {
  stage: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
  ok: boolean;
  estimatedUsd?: number;
}
const scope = new AsyncLocalStorage<AiUsage[]>();
export async function collectUsage<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; usage: AiUsage[] }> {
  const usage: AiUsage[] = [];
  return scope.run(usage, async () => ({ result: await fn(), usage }));
}
export function currentUsage(): AiUsage[] {
  return scope.getStore() ?? [];
}
export async function measuredMessage(
  stage: string,
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: Parameters<Anthropic["messages"]["create"]>[1],
): Promise<Anthropic.Message> {
  const start = Date.now();
  let row: AiUsage = {
    stage,
    model: params.model,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ms: 0,
    ok: false,
  };
  try {
    const r = await client.messages.create(params, options);
    const u = r.usage ?? { input_tokens: 0, output_tokens: 0 };
    row = {
      ...row,
      model: r.model || params.model,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      ok: true,
    };
    // Estimates use standard global list rates; raw counts are authoritative.
    const rates: Record<string, [number, number]> = {
      "claude-sonnet-4-6": [3, 15],
      "claude-opus-4-8": [5, 25],
      "claude-opus-4-7": [5, 25],
      "claude-opus-4-6": [5, 25],
      "claude-haiku-4-5": [1, 5],
    };
    const rate = rates[params.model];
    if (rate)
      row.estimatedUsd =
        (row.input * rate[0] +
          row.output * rate[1] +
          row.cacheRead * rate[0] * 0.1 +
          row.cacheWrite * rate[0] * 1.25) /
        1e6;
    if (r.stop_reason === "max_tokens")
      throw new Error(
        "AI output was truncated. Retry with fewer requested fields.",
      );
    return r;
  } finally {
    row.ms = Date.now() - start;
    scope.getStore()?.push(row);
    console.info(JSON.stringify({ event: "ai_usage", ...row }));
  }
}
