import { describe, expect, it } from "vitest";
import { asNarrativeJobId } from "@/game/domain/events";
import type { NarrativeBundleSourceContext } from "../../narrativeBundleSource";
import { buildOpeningNarrativePrompt } from "./openingNarrativePrompt";

function openingContext(): Extract<NarrativeBundleSourceContext, { kind: "opening" }> {
  return {
    kind: "opening",
    jobId: asNarrativeJobId("job-opening-prompt"),
    input: {
      gameType: "science_fiction",
      gameLength: "medium",
      seed: "prompt-seed",
      setup: {
        characterName: "林舟",
        characterIdentity: "失业的货运领航员",
        characterProfile: "曾在船厂修理引擎。",
        personalityTags: ["冷静", "多疑"],
        worldPremise: "潮汐锁定的殖民卫星依靠老旧轨道港维持补给。",
        storyOpening: "林舟来港口追查一份署有自己名字、却从未签过的维修记录。",
        narrativeStyle: "cinematic",
        contentIntensity: "dark",
      },
      novelty: {
        attempt: 2,
        recent: [
          { gameType: "science_fiction", fingerprint: "old", semanticFingerprint: "old", semanticText: "old", summary: "最早：废弃矿井", profile: { sceneFrame: "outskirts", npcArchetype: "guide", leadType: "trace", conflictMode: "pursuit" }, createdAt: "2026-09-01T00:00:00.000Z" },
          { gameType: "science_fiction", fingerprint: "new", semanticFingerprint: "new", semanticText: "new", summary: "最新：上次为码头商人交接清单", profile: { sceneFrame: "market", npcArchetype: "merchant", leadType: "document", conflictMode: "dispute" }, createdAt: "2026-09-05T00:00:00.000Z" },
          { gameType: "science_fiction", fingerprint: "fourth", semanticFingerprint: "fourth", semanticText: "fourth", summary: "第四新：船坞协商", profile: { sceneFrame: "workshop", npcArchetype: "craftsperson", leadType: "message", conflictMode: "other" }, createdAt: "2026-09-02T00:00:00.000Z" },
          { gameType: "science_fiction", fingerprint: "second", semanticFingerprint: "second", semanticText: "second", summary: "第二新：轨道站争执", profile: { sceneFrame: "station", npcArchetype: "official", leadType: "testimony", conflictMode: "misdirection" }, createdAt: "2026-09-04T00:00:00.000Z" },
          { gameType: "science_fiction", fingerprint: "third", semanticFingerprint: "third", semanticText: "third", summary: "第三新：神龛留言", profile: { sceneFrame: "shrine", npcArchetype: "keeper", leadType: "token", conflictMode: "concealment" }, createdAt: "2026-09-03T00:00:00.000Z" },
          { gameType: "science_fiction", fingerprint: "rejected", semanticFingerprint: "rejected", semanticText: "rejected", summary: "刚被拒绝：仍然沿用船厂前提", profile: { sceneFrame: "workshop", npcArchetype: "craftsperson", leadType: "document", conflictMode: "dispute" }, createdAt: "2026-09-05T00:00:00.000Z" },
        ],
      },
    },
  };
}

describe("buildOpeningNarrativePrompt", () => {
  it("preserves full player setup and uses only the latest three novelty summaries", () => {
    const prompt = buildOpeningNarrativePrompt(openingContext());

    for (const text of [
      "林舟", "失业的货运领航员", "曾在船厂修理引擎。", "冷静", "多疑",
      "潮汐锁定的殖民卫星", "林舟来港口追查", "cinematic", "dark",
      "最新：上次为码头商人交接清单", "第二新：轨道站争执", "attempt=2",
      "刚被拒绝：仍然沿用船厂前提",
    ]) expect(prompt).toContain(text);
    expect(prompt).not.toContain("第四新：船坞协商");
    expect(prompt).not.toContain("最早：废弃矿井");
    expect(prompt.indexOf("刚被拒绝：仍然沿用船厂前提"))
      .toBeLessThan(prompt.indexOf("最新：上次为码头商人交接清单"));
    expect(prompt).not.toContain("第三新：神龛留言");
    expect(prompt).toContain("玩家输入优先于新颖性要求");
  });

  it("fully declares the strict situation, creation, visibility, response, and scene contracts", () => {
    const prompt = buildOpeningNarrativePrompt(openingContext());

    expect(prompt).toContain("ask、support、challenge、threaten、deceive、offer、refuse、reassure");
    expect(prompt).toContain("short、long");
    expect(prompt).toContain("neutral、warm、guarded、afraid、angry、sad");
    expect(prompt).toContain("neutral、ally、protective_of、indebted_to、rival、wary");
    expect(prompt).toContain("history 0–4");
    expect(prompt).toContain("threads 1–3");
    expect(prompt).toContain("恰好 2");
    expect(prompt).toContain("[a-z][a-z0-9_]*");
    expect(prompt).toContain("knownFactKeys");
    expect(prompt).toContain("privateFactKeys");
    expect(prompt).toContain("privateFactKeys 可被 history.factKeys 引用并存入 ledger");
    expect(prompt).toContain("私密事实正文不得出现在 prologue、currentScene、choices、公开 history 渲染、thread question 或 response");
    expect(prompt).toContain("history.factKeys 不要求全部属于 knownFactKeys");
    expect(prompt).toContain("candidateId");
    expect(prompt).toContain("不得在序幕或 NPC 台词中宣称玩家已接受其中一项");
    expect(prompt).toContain("结局 theme 仅表达开放价值方向");
    expect(prompt).toContain("offer 不代表物品已经转移");
    expect(prompt).toContain("trust");
    expect(prompt).toContain("doubt");
  });

  it("builds legal instructions when setup and novelty are absent", () => {
    const context = openingContext();
    const prompt = buildOpeningNarrativePrompt({
      ...context,
      input: { gameType: "wuxia", gameLength: "short", seed: "no-setup" },
    });
    expect(prompt).toContain('"targetActs": 3');
    expect(prompt).toContain('"situation"');
    expect(prompt).toContain("由你生成");
    expect(prompt).not.toContain("undefined");
  });
});
