import { describe, it, expect } from "vitest";
import { projectGameSessionView } from "./gameSessionViewV2";
import { createInitialWorldState, appendNpc, appendLocation, type WorldState, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asFactId } from "@/game/domain/scenarioBlueprint";

describe("projectGameSessionView", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "一间客栈", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "一条街道", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  const ws = { ...appendNpc(appendLocation(createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  }), loc2), npc1), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });

  it("projects player and current location", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.player.name).toBe("侠客");
    expect(view.currentLocation.name).toBe("客栈");
  });

  it("projects available NPCs at current location", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.availableNpcs).toHaveLength(1);
    expect(view.availableNpcs[0]?.name).toBe("老板");
  });

  it("projects available moves to connected unlocked locations", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.availableMoves).toHaveLength(1);
    expect(view.availableMoves[0]?.name).toBe("街道");
  });

  it("projects story metrics", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.story.currentAct).toBe(1);
    expect(view.story.tension).toBe(30);
    expect(view.story.pacingNeed).toBe("reveal");
  });

  it("projects per-NPC dialogue pages for every present NPC", () => {
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsTwo = { ...ws, npcs: [...ws.npcs, secondNpc] };
    const view = projectGameSessionView(wsTwo, ss, 0);
    const dialogues = view.narrative.npcDialogues;
    expect(dialogues).toBeDefined();
    const ids = (dialogues ?? []).map((d) => String(d.npcId));
    expect(ids).toContain("npc_1");
    expect(ids).toContain("npc_2");
    for (const d of dialogues ?? []) {
      expect(d.speechPages.length).toBeGreaterThan(0);
    }
  });

  it("read model 零泄漏：序列化 view 不含 actionKey/choiceRegistry/PendingNarrativeJob/candidateEventPool/hidden facts", () => {
    const scene = {
      sceneId: "scene-1",
      turn: 0,
      narration: "你在客栈。",
      usedFactIds: [],
      npcLine: { npcId: asNpcId("npc_1"), text: "老板说道：\"需要什么吗？\"", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "t1", label: "请问一下目前状况是怎么样的？", choiceKind: "dialogue_response" as const, dialogueIntent: "intent_1", actionKey: "dialogue:t1" },
        { choiceToken: "t2", label: "是否可以告诉我事情的缘由？", choiceKind: "dialogue_response" as const, dialogueIntent: "intent_2", actionKey: "dialogue:t2" },
      ] as const,
      source: "generated" as const,
      event: { kind: "dialogue" as const, focusNpcId: asNpcId("npc_1") },
      npcDialogues: [
        { npcId: asNpcId("npc_1"), npcName: "老板", npcRole: "路人", speechPages: ["需要什么吗？"] },
      ],
    };
    const ssWithScene = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [{ choiceToken: "t1", sceneId: "scene-1", basedOnRevision: 0, label: "x", action: { type: "move" as const, locationId: asLocationId("loc_2") }, semanticSummary: "s" }],
        generation: { status: "pending" as const, job: { kind: "scene" as const, sceneId: "scene-1", seed: "s", inputDigest: "d", gameType: "wuxia" as const, intent: { kind: "initial" as const }, context: { triggerContext: { kind: "initial_opening" as const, npcId: asNpcId("npc_1") }, locationId: asLocationId("loc_1"), presentNpcIds: [] }, mode: "ai" as const, utterance: "你好" } } as unknown as import("@/game/domain/storyState").StoryState["narrative"]["generation"],
      },
    };
    const view = projectGameSessionView(ws, ssWithScene, 0);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("actionKey");
    expect(serialized).not.toContain("ApprovedAction");
    expect(serialized).not.toContain("choiceRegistry");
    expect(serialized).not.toContain("PendingNarrativeJob");
    expect(serialized).not.toContain("candidateEventPool");
    expect(serialized).not.toContain("utterance");
    // 选项只含白名单字段
    const choices = view.narrative.choices ?? [];
    for (const c of choices) {
      expect(Object.keys(c).sort()).toEqual(["choiceToken", "label"]);
    }
  });

  it("焦点 NPC 专属：只有 focusNpc 获得当前两个 dialogue choices，其他 NPC 只展示台词，freeInput 仅焦点开启", () => {
    const scene = {
      sceneId: "scene-d",
      turn: 0,
      narration: "你在客栈。",
      usedFactIds: [],
      npcLine: { npcId: asNpcId("npc_1"), text: "老板说道：\"需要什么吗？\"", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "t1", label: "请问一下目前状况是怎么样的？", choiceKind: "dialogue_response" as const, dialogueIntent: "intent_1", actionKey: "dialogue:t1" },
        { choiceToken: "t2", label: "是否可以告诉我事情的缘由？", choiceKind: "dialogue_response" as const, dialogueIntent: "intent_2", actionKey: "dialogue:t2" },
      ] as const,
      source: "generated" as const,
      event: { kind: "dialogue" as const, focusNpcId: asNpcId("npc_1") },
      npcDialogues: [
        { npcId: asNpcId("npc_1"), npcName: "老板", npcRole: "路人", speechPages: ["需要什么吗？"] },
      ],
    };
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsTwo = { ...ws, npcs: [...ws.npcs, secondNpc] };
    const ssScene = { ...ss, narrative: { ...ss.narrative, currentScene: scene } };
    const view = projectGameSessionView(wsTwo, ssScene, 0);
    const dialogues = view.narrative.npcDialogues ?? [];
    const lu = dialogues.find((d) => d.npcId === "npc_1");
    const guest = dialogues.find((d) => d.npcId === "npc_2");
    // 焦点 NPC 持有两个 dialogue choices 且 freeInput 开启
    expect(lu?.choices?.map((c) => c.choiceToken).sort()).toEqual(["t1", "t2"]);
    expect(lu?.freeInputEnabled).toBe(true);
    // 非焦点 NPC 只有台词，无 choices，freeInput 关闭
    expect(guest?.choices ?? []).toHaveLength(0);
    expect(guest?.freeInputEnabled).toBe(false);
    // 世界行动选择不投影为每 NPC 对话选择（dialogue 场景下 narrative.choices 应为空）
    expect(view.narrative.choices ?? []).toHaveLength(0);
  });

  it("世界行动场景：choices 进入 narrative.choices，不投影为任何 NPC 对话选择", () => {
    const scene = {
      sceneId: "scene-w",
      turn: 0,
      narration: "你在客栈大堂。",
      usedFactIds: [],
      npcLine: null,
      choices: [
        { choiceToken: "w1", label: "观察", choiceKind: "world_action" as const, actionKey: "explore" },
        { choiceToken: "w2", label: "离开", choiceKind: "world_action" as const, actionKey: "move:loc_2" },
      ] as const,
      source: "generated" as const,
      event: { kind: "observe" as const, locationId: asLocationId("loc_1") },
    };
    const ssScene = { ...ss, narrative: { ...ss.narrative, currentScene: scene } };
    const view = projectGameSessionView(ws, ssScene, 0);
    // 世界行动选项出现在 narrative.choices（白名单形状）
    expect(view.narrative.choices?.map((c) => c.choiceToken).sort()).toEqual(["w1", "w2"]);
    for (const c of view.narrative.choices ?? []) {
      expect(Object.keys(c).sort()).toEqual(["choiceToken", "label"]);
    }
    // 不进入任何 NPC 的对话选择
    for (const d of view.narrative.npcDialogues ?? []) {
      expect(d.choices ?? []).toHaveLength(0);
    }
  });

  it("npcDialogues prefer scene dialogue pages and fall back to deterministic line", () => {
    const sceneWithDialogue = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: {
          sceneId: "scene-1",
          turn: 0,
          narration: "你在客栈。",
          usedFactIds: [],
          npcLine: { npcId: asNpcId("npc_1"), text: "老板说道：\"需要什么吗？\"", emotion: "neutral" as const, usedFactIds: [] },
          choices: [] as never,
          source: "generated" as const,
          event: { kind: "dialogue" as const, focusNpcId: asNpcId("npc_1") },
          npcDialogues: [
            { npcId: asNpcId("npc_1"), npcName: "老板", npcRole: "路人", speechPages: ["需要什么吗？"] },
            { npcId: asNpcId("npc_2"), npcName: "客人", npcRole: "酒客", speechPages: [] },
          ],
        },
      },
    };
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsTwo = { ...ws, npcs: [...ws.npcs, secondNpc] };
    const view = projectGameSessionView(wsTwo, sceneWithDialogue, 0);
    const dialogues = view.narrative.npcDialogues ?? [];
    const lu = dialogues.find((d) => String(d.npcId) === "npc_1");
    const guest = dialogues.find((d) => String(d.npcId) === "npc_2");
    expect(lu!.speechPages.join("")).toBe("需要什么吗？");
    expect(guest!.speechPages.length).toBeGreaterThan(0);
  });

  it("任务目标引用未发现隐藏事实时，view 只显示中性目标，不泄漏 fact.text/FactId", () => {
    const SECRET_TEXT = "地窖里埋着先人的宝藏";
    const hiddenFact = { factId: asFactId("fact_secret"), text: SECRET_TEXT, source: "generated" as const, discovered: false };
    const wsWithSecret = {
      ...ws,
      worldFacts: [hiddenFact],
      quests: [{
        id: "q1", name: "寻宝", description: "t", kind: "main" as const, stage: 1, status: "active" as const,
        objectives: [{ kind: "discover_fact" as const, factId: asFactId("fact_secret") }],
        onSuccess: { kind: "reach_ending" as const, endingId: "ending_1" },
        onFailure: { kind: "closed" as const },
        tags: [],
      }      ] as unknown as WorldState["quests"],
    };
    const view = projectGameSessionView(wsWithSecret, ss, 0);
    const serialized = JSON.stringify(view);
    // 未发现：不出现事实正文，也不出现 FactId 字符串
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(serialized).not.toContain("fact_secret");
    const objective = view.quests[0]?.objectives[0];
    expect(objective?.label).toBe("发现秘密");
    expect(objective?.completed).toBe(false);
  });

  it("任务目标引用已发现事实时，view 显示该事实文本", () => {
    const SECRET_TEXT = "地窖里埋着先人的宝藏";
    const discoveredFact = { factId: asFactId("fact_secret"), text: SECRET_TEXT, source: "generated" as const, discovered: true };
    const wsWithSecret = {
      ...ws,
      worldFacts: [discoveredFact],
      quests: [{
        id: "q1", name: "寻宝", description: "t", kind: "main" as const, stage: 1, status: "active" as const,
        objectives: [{ kind: "discover_fact" as const, factId: asFactId("fact_secret") }],
        onSuccess: { kind: "reach_ending" as const, endingId: "ending_1" },
        onFailure: { kind: "closed" as const },
        tags: [],
      }      ] as unknown as WorldState["quests"],
    };
    const view = projectGameSessionView(wsWithSecret, ss, 0);
    const objective = view.quests[0]?.objectives[0];
    expect(objective?.label).toContain(SECRET_TEXT);
    expect(objective?.completed).toBe(true);
  });
});
