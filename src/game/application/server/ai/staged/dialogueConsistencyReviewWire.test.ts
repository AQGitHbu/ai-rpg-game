import { expect, it, vi } from "vitest";
import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";
import { createRpgAiClient } from "@/game/application/server/ai/rpgAiClient";
import { createLiveStageSource } from "@/game/application/server/ai/staged/liveStageSource";

it.each([false, true])("actual reviewer HTTP body explicitly requests JSON, including protocol repair=%s", async repair => {
  const bodies: { response_format?: { type: string }; messages: { role: string; content: string }[] }[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"pass","failedIds":[]}' }, finish_reason: "stop" }] }), { status: 200 });
  });
  const client = createRpgAiClient({ config: { baseUrl: "https://provider.test/v1", apiKey: "offline-test", model: "model" },
    transport: createOpenAiCompatibleTransport({ fetchImpl }) });
  const source = createLiveStageSource({ client });
  const result = await source.reviewDialogueConsistency!({ items: [{ id: "polish_0", stage: "character", draft: "我不知道。", text: "我不知道。", facts: [] }] },
    { signal: new AbortController().signal, timeoutMs: 1000, audit: { purpose: "game_api", trigger: "dialogue_consistency_review" },
      ...(repair ? { repair: { attempt: 1, reason: "invalid_schema" as const, rejectionCode: "dialogue_consistency_review_invalid" } } : {}) });
  expect(result).toEqual({ ok: true, verdict: "pass", failedIds: [] });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
  // Check the actual assembled message content, not JSON serialization of the outer body.
  expect(bodies[0]?.messages.some(message => /\bJSON\b/i.test(message.content))).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
