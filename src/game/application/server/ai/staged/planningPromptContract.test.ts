import { expect, it } from "vitest";
import { buildPlanningPrompt, PLANNING_CONTENT_RULES } from "./planningPrompt";
import { asGenerationId } from "@/game/domain/worldEntity";
it("one complete draft schema removes duplicate tasks and keeps independent authority", () => {
  const prompt = buildPlanningPrompt({ kind: "opening", input: { gameType: "wuxia", gameLength: "short", seed: "roles" },
    generation: { generationId: asGenerationId("gen_roles"), seed: "roles", templateVersion: "v2", inputDigest: "", gameType: "wuxia" } });
  for (const key of ['"draft"', '"parts"', '"labels"', 'knownFactKeys', 'requiredObservationKeys', 'requiredBeats']) expect(prompt).toContain(key);
  for (const obsolete of ['"brief"', '"task"', 'inquiries', 'answers', '20–60']) expect(prompt + PLANNING_CONTENT_RULES).not.toContain(obsolete);
  expect(prompt).toContain('publicIntent 恰有 3 键'); expect(prompt).toContain('trust/doubt');
});
