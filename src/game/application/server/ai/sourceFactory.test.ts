import { describe, it, expect } from "vitest";
import { resolveLiveNpcLine, resolvePerformanceChoices } from "./liveScenePerformanceSource";
import { asLocationId } from "@/game/domain/worldEntity";
import { buildStylePolicy } from "../../stylePolicy";

const presentNpcs = [
  { id: "npc_1", name: "老板" },
  { id: "npc_2", name: "客人" },
] as readonly { readonly id: unknown; readonly name: string }[];

describe("resolveLiveNpcLine", () => {
  it("keeps a line whose npcId belongs to a present NPC", () => {
    const resolved = resolveLiveNpcLine({ npcId: "npc_2", text: "  有事吗？  ", emotion: "warm" }, presentNpcs);
    expect(resolved).not.toBeNull();
    expect(String(resolved!.npcId)).toBe("npc_2");
    expect(resolved!.text).toBe("有事吗？");
    expect(resolved!.emotion).toBe("warm");
  });

  it("rejects npcId not present in the location", () => {
    const resolved = resolveLiveNpcLine({ npcId: "npc_hallucinated", text: "你好。", emotion: "neutral" }, presentNpcs);
    expect(resolved).toBeNull();
  });

  it("rejects empty text and null candidate", () => {
    expect(resolveLiveNpcLine({ npcId: "npc_1", text: "   ", emotion: "neutral" }, presentNpcs)).toBeNull();
    expect(resolveLiveNpcLine(null, presentNpcs)).toBeNull();
  });

  it("normalizes invalid emotion to neutral", () => {
    const resolved = resolveLiveNpcLine({ npcId: "npc_1", text: "你好。", emotion: "furious" }, presentNpcs);
    expect(resolved?.emotion).toBe("neutral");
  });

  it("falls back to name matching when AI writes the NPC name instead of id", () => {
    const resolved = resolveLiveNpcLine({ npcId: "客人", text: "这壶酒我请。", emotion: "neutral" }, presentNpcs);
    expect(resolved).not.toBeNull();
    expect(String(resolved!.npcId)).toBe("npc_2");
    expect(resolved!.text).toBe("这壶酒我请。");
  });
});

describe("resolvePerformanceChoices", () => {
  const selectable = [
    { candidateId: "candidate_1", label: "探索", action: { type: "explore" as const } },
    { candidateId: "candidate_2", label: "前往街道", action: { type: "move" as const, locationId: asLocationId("loc_2") } },
  ];

  it("只把两个不同的服务端 candidateId 映射为选项", () => {
    const resolved = resolvePerformanceChoices(selectable, [
      { candidateId: "candidate_2", label: "前往街道" },
      { candidateId: "candidate_1", label: "查看四周" },
    ]);
    expect(resolved).toEqual([
      { candidateId: "candidate_2", label: "（前往街道）" },
      { candidateId: "candidate_1", label: "（查看四周）" },
    ]);
  });

  it("对话候选保留 AI 在剧情上下文中生成的直接对白，但动作仍绑定服务端 candidateId", () => {
    const dialogueSelectable = [
      { candidateId: "candidate_1", label: "请把刚才的线索说清楚。", action: { type: "talk" as const, npcId: "npc_1" as never, dialogueAct: "support" as const } },
      { candidateId: "candidate_2", label: "哪件证物能证明？", action: { type: "talk" as const, npcId: "npc_1" as never, dialogueAct: "challenge" as const } },
    ];
    expect(resolvePerformanceChoices(dialogueSelectable, [
      { candidateId: "candidate_1", label: "继续调查" },
      { candidateId: "candidate_2", label: "相信他" },
    ])).toEqual([
      { candidateId: "candidate_1", label: "继续调查" },
      { candidateId: "candidate_2", label: "相信他" },
    ]);
  });

  it("拒绝任意/重复 candidateId，不能用 actionKey 绕过候选", () => {
    expect(resolvePerformanceChoices(selectable, [
      { candidateId: "invented", label: "作弊" },
      { candidateId: "candidate_1", label: "探索" },
    ])).toBeNull();
    expect(resolvePerformanceChoices(selectable, [
      { candidateId: "candidate_1", label: "A" },
      { candidateId: "candidate_1", label: "B" },
    ])).toBeNull();
  });
});

describe("createLiveScenePerformanceSource 焦点 NPC", () => {
  it("talk 回合的对话场景必须指向玩家实际交谈的 NPC，而非第一个在场 NPC", async () => {
    const { createLiveScenePerformanceSource } = await import("./liveScenePerformanceSource");
    const { asNpcId, asLocationId } = await import("@/game/domain/worldEntity");
    const { asNarrativeJobId, asTurnId } = await import("@/game/domain/events");
    const { createPendingNarrativeJob } = await import("@/game/domain/pendingNarrativeJob");

    const npcA = { id: asNpcId("npc_a"), name: "格里姆", role: "工匠", publicProfile: "p", knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [] };
    const npcB = { id: asNpcId("npc_b"), name: "维珀", role: "情报贩子", publicProfile: "p", knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [] };

    const jobResult = createPendingNarrativeJob({
      jobId: asNarrativeJobId("job_1"),
      turnId: asTurnId("turn_1"),
      actionId: "act_talk",
      expectedRevision: 0,
      turnNumber: 1,
      actionSummary: { kind: "talk", npcId: npcB.id },
      focusNpcId: npcB.id,
      resolvedEvent: {
        actionId: "act_talk", status: "success", eventKind: "dialogue",
        facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
      },
      domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
      requestedAt: "2026-01-02",
      objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
      mandatoryBeats: [],
    });
    if (!jobResult.ok) throw new Error("job 构造失败");

    const context = {
      job: jobResult.job,
      player: { name: "p", identity: "i", knownFactCards: [] },
      currentLocation: { id: asLocationId("loc_1"), name: "小镇", description: "d", kind: "main" },
      publicWorldFacts: [],
      sceneVisibleFacts: [],
      presentNpcs: [npcA, npcB],
      story: {
        currentAct: 1, targetActs: 3, tension: 30, nextPacingNeed: "reveal",
        contract: {
          version: 1,
          targetActs: 3,
          centralConflict: "旧案背后的盟约正在瓦解",
          endingDirections: [
            { key: "trust", theme: "与盟友共同揭露真相" },
            { key: "doubt", theme: "独自追查真相" },
          ],
        },
        remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1, remainingSideQuests: 0 },
        unresolvedThreadSummaries: [],
        stylePolicy: buildStylePolicy(),
      },
      recentBeats: [],
      legalActionCandidates: [],
      legalEventTargets: { locationIds: [], factIds: [], itemIds: [], enemyIds: [] },
      worldConstraints: [],
      mandatoryBeats: [],
      beatSubjects: [],
      objectiveTarget: null,
      objectiveTransition: jobResult.job.objectiveTransition,
    };

    const transport = {
      complete: async () => ({
        ok: true,
        content: JSON.stringify({
          segments: [{ beatId: "atmosphere", text: "场景。" }],
          npcLine: { npcId: "npc_b", text: "维珀开口。", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
          objectiveLink: null,
          choices: [
            { label: "支持", candidateId: "candidate_1" },
            { label: "质疑", candidateId: "candidate_2" },
          ],
        }),
        latencyMs: 1,
      }),
    } as never;

    const source = createLiveScenePerformanceSource({
      transport,
      config: { baseUrl: "x", apiKey: "k", model: "m" },
    });
    const result = await source.generateScene(context as never);
    if (!result.ok) throw new Error("expected success");
    // 关键断言：焦点台词归属玩家实际交谈的 npc_b（维珀），不是第一个在场 NPC npc_a
    expect(result.proposal.npcLine?.npcId).toBe("npc_b");
  });
});
