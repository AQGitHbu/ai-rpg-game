import { expect, it } from "vitest";
import { buildPlanningPrompt, PLANNING_CONTENT_RULES } from "./planningPrompt";
import { asGenerationId } from "@/game/domain/worldEntity";
import { parseOpeningVariationProfile } from "@/game/domain/openingNovelty";
it("one complete draft schema removes duplicate tasks and keeps independent authority", () => {
  const prompt = buildPlanningPrompt({ kind: "opening", input: { gameType: "wuxia", gameLength: "short", seed: "roles" },
    generation: { generationId: asGenerationId("gen_roles"), seed: "roles", templateVersion: "v2", inputDigest: "", gameType: "wuxia" } });
  for (const key of ['"draft"', '"parts"', '"labels"', 'knownFactKeys', 'requiredObservationKeys', 'requiredBeats']) expect(prompt).toContain(key);
  for (const obsolete of ['"brief"', '"task"', 'inquiries', 'answers', '20–60']) expect(prompt + PLANNING_CONTENT_RULES).not.toContain(obsolete);
  expect(prompt).toContain('publicIntent 恰有 3 键'); expect(prompt).toContain('trust/doubt');
  expect(prompt).toContain('requiredBeats：数组，每项恰有 4 键');
  expect(prompt).not.toContain('requiredBeats.instruction');
  expect(prompt).not.toContain('"instruction": 非空中文字符串');
});

it("opening distinguishes required keys from optional metadata and supplies a parseable profile", () => {
  const prompt = buildPlanningPrompt({ kind: "opening", input: { gameType: "wuxia", gameLength: "short", seed: "contract" },
    generation: { generationId: asGenerationId("gen_contract"), seed: "contract", templateVersion: "v2", inputDigest: "", gameType: "wuxia" } });
  expect(prompt).not.toContain("opening 恰有 6 键");
  expect(prompt).toContain("省略时共 4 键，提供时共 5 键");
  expect(prompt).toContain("本次不生成 firstScene");
  expect(prompt).toContain("不是字符串或 null");
  const example = prompt.match(/variationProfile 示例：(\{[^\n]+\})/)?.[1];
  expect(example).toBeDefined();
  const profile: unknown = JSON.parse(example!);
  expect(parseOpeningVariationProfile(profile)).toEqual(profile);
});
