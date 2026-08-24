import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { projectGameSessionView } from "./gameSessionView";
import { buildChoiceMap } from "./buildChoiceMap";
import { createInitialWorldState, appendNpc, appendLocation, type WorldState, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asFactId, asItemId, asEnemyId, asEndingId, asQuestId } from "@/game/domain/worldEntity";
import type { Action } from "@/game/domain/action";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";

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
  const ss = {
    ...createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } }),
    narrative: createFixtureNarrativeRuntimeState(),
  };

  function approved(
    choiceToken: string,
    sceneId: string,
    basedOnRevision: number,
    label: string,
    action: Action,
  ): ApprovedChoice {
    return { choiceToken, sceneId, basedOnRevision, label, action, semanticSummary: `approved:${choiceToken}` };
  }

  // ── Task 4 fixtures：已审批调查方式 / 无调查方式的事实 ─────────────────────
  const approachFact = {
    factId: asFactId("fact_approach"),
    text: "车辙尽头藏着半枚令牌",
    source: "generated" as const,
    discovered: false,
    locationId: asLocationId("loc_1"),
    investigationLabel: "泥地上的异常痕迹",
    investigationApproaches: [
      { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean" as const, tensionDelta: 4 },
      { approachId: "search", label: "翻查附近杂物", hint: "动静较大，可能惊动旁人", evidenceQuality: "noisy" as const, tensionDelta: 12 },
    ],
  };
  const approachlessFact = {
    factId: asFactId("fact_approachless"),
    text: "地窖里堆着旧账册",
    source: "generated" as const,
    discovered: false,
    locationId: asLocationId("loc_1"),
    investigationLabel: "客栈地窖",
  };

  function makeDiscoverQuest(fact: WorldState["worldFacts"][number]): WorldState["quests"][number] {
    return {
      id: asQuestId("quest_discover"),
      name: "查明真相",
      description: "查清车辙的来历",
      objectives: [{ kind: "discover_fact", factId: fact.factId }],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    };
  }

  function worldWithApproaches(): WorldState {
    return { ...ws, worldFacts: [approachFact], quests: [makeDiscoverQuest(approachFact)] };
  }

  function worldWithApproachlessFact(): WorldState {
    return { ...ws, worldFacts: [approachlessFact], quests: [makeDiscoverQuest(approachlessFact)] };
  }

  function storyWithDiscoverFact(): StoryState {
    return ss;
  }

  function viewWithInvestigationApproaches(): ReturnType<typeof projectGameSessionView> {
    return projectGameSessionView(worldWithApproaches(), storyWithDiscoverFact(), 0, "ending");
  }

  describe("Task 4：investigate approach 投影", () => {
    it("projects two approach choices and no generic investigate button", () => {
      const view = projectGameSessionView(worldWithApproaches(), storyWithDiscoverFact(), 0, "ending");
      expect(view.currentLocation.actions.filter((choice) => choice.presentation === "investigate").map((choice) => choice.label))
        .toEqual(["沿痕迹追查", "翻查附近杂物"]);
      expect(view.currentLocation.actions.some((choice) => choice.label === "调查现场线索")).toBe(false);
    });

    it("does not project any investigate action for an approach-less fact", () => {
      const view = projectGameSessionView(worldWithApproachlessFact(), storyWithDiscoverFact(), 0, "ending");
      expect(view.currentLocation.actions.filter((choice) => choice.presentation === "investigate")).toHaveLength(0);
    });

    it("每个 approach 各获一个 opaque token，且同 fact 不同 approach 的 token 互不相同", () => {
      const view = viewWithInvestigationApproaches();
      const investigate = view.currentLocation.actions.filter((choice) => choice.presentation === "investigate");
      expect(investigate).toHaveLength(2);
      expect(investigate[0]!.choiceToken).not.toBe(investigate[1]!.choiceToken);
      expect(investigate.every((choice) => /^c_[0-9a-f]{16}$/.test(choice.choiceToken))).toBe(true);
    });

    it("行动按钮只暴露 label/hint，不泄漏事实正文/approachId/evidenceQuality/tensionDelta", () => {
      const view = viewWithInvestigationApproaches();
      const serialized = JSON.stringify(view.currentLocation.actions);
      expect(serialized).not.toContain("车辙尽头藏着半枚令牌");
      expect(serialized).not.toContain("follow");
      expect(serialized).not.toContain("noisy");
      expect(serialized).not.toContain("tensionDelta");
      const search = view.currentLocation.actions.find((choice) => choice.label === "翻查附近杂物");
      expect(search?.hint).toBe("动静较大，可能惊动旁人");
    });

    it("discover_fact 多 approach 时 currentObjectiveChoiceTokens 返回全部 token，单一兼容 token 取第一个", () => {
      const view = viewWithInvestigationApproaches();
      const investigate = view.currentLocation.actions.filter((choice) => choice.presentation === "investigate");
      expect(view.story.currentObjectiveChoiceTokens).toEqual(investigate.map((choice) => choice.choiceToken));
      expect(view.story.currentObjectiveChoiceToken).toBe(investigate[0]?.choiceToken ?? null);
    });

    it("approach-less 事实：currentObjectiveChoiceTokens 为空，单一 token 为 null，行动栏无伪入口", () => {
      const view = projectGameSessionView(worldWithApproachlessFact(), storyWithDiscoverFact(), 0, "ending");
      expect(view.story.currentObjectiveChoiceTokens).toEqual([]);
      expect(view.story.currentObjectiveChoiceToken).toBeNull();
      expect(view.currentLocation.actions.some((choice) => choice.label === "调查客栈地窖")).toBe(false);
    });

    it("非 discover_fact 目标仍填充兼容的单一 token（currentObjectiveChoiceTokens 含该 token）", () => {
      const wsWithQuest: WorldState = {
        ...ws,
        quests: [{
          id: asQuestId("quest_talk"),
          name: "查明真相",
          description: "查清矿坑的真相",
          objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
          onSuccess: { kind: "advance_story" },
          onFailure: { kind: "closed" },
          tags: [],
          kind: "main",
          stage: 1,
          status: "active",
        }],
      };
      const view = projectGameSessionView(wsWithQuest, ss, 0, "test-ending-session");
      expect(view.story.currentObjectiveChoiceTokens).toEqual([view.story.currentObjectiveChoiceToken]);
      expect(view.story.currentObjectiveChoiceToken).toBe(view.currentLocation.npcs[0]?.talkChoice?.choiceToken ?? null);
    });
  });

  it("projects player and current location", () => {
    const view = projectGameSessionView(ws, ss, 0, "test-ending-session");
    expect(view.player.name).toBe("侠客");
    expect(view.currentLocation.name).toBe("客栈");
  });

  it("projects available NPCs at current location", () => {
    const view = projectGameSessionView(ws, ss, 0, "test-ending-session");
    // 无焦点场景时 NPC 经 currentLocation.npcs 暴露；读模型为所有在场 NPC 投影零回合闲聊
    expect(view.currentLocation.npcs).toHaveLength(1);
    expect(view.currentLocation.npcs[0]?.name).toBe("老板");
    expect(view.narrative.npcDialogues).toHaveLength(1);
    expect(view.narrative.npcDialogues[0]?.choices).toEqual([]);
    expect(view.narrative.npcDialogues[0]?.freeInputEnabled).toBe(false);
  });

  it("projects available moves to connected unlocked locations", () => {
    const view = projectGameSessionView(ws, ss, 0, "test-ending-session");
    const moves = view.worldMap.locations.filter((location) => location.travelChoice !== null);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.name).toBe("街道");
  });

  it("projects story metrics", () => {
    const view = projectGameSessionView(ws, ss, 0, "test-ending-session");
    expect(view.story.currentAct).toBe(1);
    expect(view.story.tension).toBe(30);
    expect(view.story.pacingNeed).toBe("reveal");
  });

  it("exposes the generated prologue text through the read model", () => {
    const ssWithPrologue = { ...ss, prologueText: "你在听雨客栈醒来，雨声压住了街道上的马蹄。" };
    const view = projectGameSessionView(ws, ssWithPrologue, 0, "test-ending-session");
    expect(view.prologueText).toBe("你在听雨客栈醒来，雨声压住了街道上的马蹄。");
  });

  it("empty prologue text stays empty (生成失败时由 UI 回退玩家 storyOpening)", () => {
    const view = projectGameSessionView(ws, ss, 0, "test-ending-session");
    expect(view.prologueText).toBe("");
  });

  it("projects the authoritative current objective label from persisted state", () => {
    const wsWithQuest: WorldState = {
      ...ws,
      quests: [{
        id: asQuestId("quest_0"),
        name: "查明真相",
        description: "查清矿坑的真相",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
    };
    const view = projectGameSessionView(wsWithQuest, ss, 0, "test-ending-session");
    expect(view.story.currentObjectiveLabel).toBe("与老板交谈");
    expect(view.story.currentObjectiveChoiceToken).toBe(view.currentLocation.npcs[0]?.talkChoice?.choiceToken ?? null);
  });

  it("prefers the approved scene move choice for a visit_location objective after dialogue handoff", () => {
    // 对话回合完成 talk 目标后的交接场景：eventKind=observe，AI 预生成
    // 指向下一地点的 move 选项（scene scope token）与 NPC 引导台词。
    const scene = {
      sceneId: "scene-handoff",
      turn: 2,
      narration: "老板压低声音：“那脚印往街道那边去了。”",
      usedFactIds: [],
      npcLine: { npcId: npc1.id, text: "那脚印往街道那边去了，你真想查就去瞧瞧。", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "move-handoff", label: "（动身前往街道）谢过老板，我这就去瞧瞧。" },
        { choiceToken: "talk-more", label: "老板，那脚印可有什么说法？" },
      ] as const,
      source: "fixture" as const,
      event: { kind: "observe" as const, locationId: asLocationId("loc_1") },
      npcDialogues: [{ npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["那脚印往街道那边去了。"] }],
    };
    const wsWithQuest: WorldState = {
      ...ws,
      quests: [{
        id: asQuestId("quest_1"),
        name: "追查脚印",
        description: "顺着脚印查下去",
        objectives: [{ kind: "visit_location", locationId: asLocationId("loc_2") }],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 2,
        status: "active",
      }],
    };
    const ssWithScene: StoryState = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("move-handoff", scene.sceneId, 0, "（动身前往街道）谢过老板，我这就去瞧瞧。", { type: "move", locationId: asLocationId("loc_2") }),
          approved("talk-more", scene.sceneId, 0, "老板，那脚印可有什么说法？", { type: "talk", npcId: npc1.id, dialogueAct: "ask" }),
        ],
      },
    };

    const view = projectGameSessionView(wsWithQuest, ssWithScene, 0, "test-ending-session");
    // 目标 token 命中场景已审批的 move 交接选项（scene scope，与 runtime
    // token 派生自不同 sceneId 永不相等），UI 行动栏由此给出角色化交接
    // 入口，handoff 判定不再把对话弹窗强制关闭。
    expect(view.story.currentObjectiveChoiceToken).toBe("move-handoff");
    expect(view.narrative.choices.map((entry) => entry.choiceToken)).toContain("move-handoff");

    // 无场景 move 选项时仍回退 runtime travelChoice token（地图层旅行入口）。
    const viewWithoutSceneChoice = projectGameSessionView(wsWithQuest, ss, 0, "test-ending-session");
    expect(viewWithoutSceneChoice.story.currentObjectiveChoiceToken).toBe(
      viewWithoutSceneChoice.worldMap.locations.find((location) => location.name === "街道")?.travelChoice?.choiceToken ?? null,
    );
  });

  it("does not mark a two-turn dialogue objective complete after only the first response", () => {
    const wsWithMetNpc: WorldState = {
      ...ws,
      npcs: ws.npcs.map((entry) => ({ ...entry, met: true })),
      quests: [{
        id: asQuestId("quest_0"),
        name: "查明真相",
        description: "查清矿坑的真相",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
    };
    const firstResponseStory: StoryState = {
      ...ss,
      narrative: {
        ...ss.narrative,
        dialogueSession: { npcId: asNpcId("npc_1"), turnCount: 1, requiredTurns: 2, completed: false },
      },
    };
    const firstView = projectGameSessionView(wsWithMetNpc, firstResponseStory, 0, "test-ending-session");
    expect(firstView.quests[0]?.objectives).toEqual([{ label: "与老板交谈", completed: false }]);

    const completedView = projectGameSessionView(wsWithMetNpc, {
      ...firstResponseStory,
      narrative: {
        ...firstResponseStory.narrative,
        dialogueSession: { npcId: asNpcId("npc_1"), turnCount: 2, requiredTurns: 2, completed: true },
      },
    }, 0, "test-ending-session");
    expect(completedView.quests[0]?.objectives).toEqual([{ label: "与老板交谈", completed: true }]);
  });

  it("exposes null current objective label when no active quest exists", () => {
    const view = projectGameSessionView(ws, ss, 0, "test-ending-session");
    expect(view.story.currentObjectiveLabel).toBeNull();
  });

  it("projects per-NPC dialogue pages for every present NPC", () => {
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsTwo = { ...ws, npcs: [...ws.npcs, secondNpc] };
    const view = projectGameSessionView(wsTwo, ss, 0, "test-ending-session");
    // 无焦点场景：所有在场 NPC 经 currentLocation.npcs 暴露，同时全部获得零回合闲聊投影
    const names = view.currentLocation.npcs.map((npc) => npc.name);
    expect(names).toContain("老板");
    expect(names).toContain("客人");
    expect(view.narrative.npcDialogues ?? []).toHaveLength(2);
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
        choiceRegistry: [approved("t1", "scene-1", 0, "x", { type: "move", locationId: asLocationId("loc_2") })],
      },
    };
    const view = projectGameSessionView(ws, ssWithScene, 0, "test-ending-session");
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
      expect(Object.keys(c).sort()).toEqual(["choiceToken", "label", "presentation"]);
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
    const ssScene = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("t1", "scene-d", 0, scene.choices[0].label, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }),
          approved("t2", "scene-d", 0, scene.choices[1].label, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" }),
        ],
      },
    };
    const view = projectGameSessionView(wsTwo, ssScene, 0, "test-ending-session");
    const dialogues = view.narrative.npcDialogues ?? [];
    const lu = dialogues.find((d) => d.npcId === "npc_1");
    const guest = dialogues.find((d) => d.npcId === "npc_2");
    // 焦点 NPC 持有两个 dialogue choices 且 freeInput 开启
    expect(lu?.choices?.map((c) => c.choiceToken).sort()).toEqual(["t1", "t2"]);
    expect(lu?.freeInputEnabled).toBe(true);
    // 非焦点 NPC 无场景供给台词时投影零回合闲聊（零选项、无自由输入；仍经 currentLocation.npcs 可见）
    expect(guest).toBeDefined();
    expect(guest?.choices).toEqual([]);
    expect(guest?.freeInputEnabled).toBe(false);
    expect(view.currentLocation.npcs.map((npc) => npc.name)).toContain("客人");
    // 世界行动选择不投影为每 NPC 对话选择（dialogue 场景下 narrative.choices 应为空）
    expect(view.narrative.choices ?? []).toHaveLength(0);
  });

  it("demotes a persisted stale focus when another present NPC is the current talk objective", () => {
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "传讯人", role: "信使", description: "带来下一幕消息",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsHandoff: WorldState = {
      ...ws,
      npcs: [...ws.npcs, secondNpc],
      quests: [{
        id: asQuestId("quest_1"),
        name: "循迹而行",
        description: "跟随信使的线索推进故事",
        objectives: [{ kind: "talk_to_npc", npcId: secondNpc.id }],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
    };
    const scene = {
      sceneId: "scene-stale-focus",
      turn: 2,
      narration: "主线已经交给传讯人。",
      usedFactIds: [],
      npcLine: { npcId: npc1.id, text: "去找传讯人吧。", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "t1", label: "表示愿意支持老板" },
        { choiceToken: "t2", label: "质疑老板的说法" },
      ] as const,
      source: "fixture" as const,
      event: { kind: "dialogue" as const, focusNpcId: npc1.id },
      npcDialogues: [
        { npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["去找传讯人吧。"] },
        { npcId: secondNpc.id, npcName: secondNpc.name, npcRole: secondNpc.role, speechPages: ["我有消息给你。"] },
      ],
    };
    const ssHandoff: StoryState = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("t1", scene.sceneId, 0, scene.choices[0].label, { type: "talk", npcId: npc1.id, dialogueAct: "support" }),
          approved("t2", scene.sceneId, 0, scene.choices[1].label, { type: "talk", npcId: npc1.id, dialogueAct: "challenge" }),
        ],
      },
    };

    const view = projectGameSessionView(wsHandoff, ssHandoff, 0, "test-ending-session");
    const oldNpc = view.narrative.npcDialogues.find((dialogue) => dialogue.npcId === "npc_1");
    const newNpc = view.narrative.npcDialogues.find((dialogue) => dialogue.npcId === "npc_2");
    expect(oldNpc?.freeInputEnabled).toBe(false);
    // 旧断言：expect(oldNpc?.choices.map((entry) => entry.label)).toEqual(["与老板交谈"]);
    expect(oldNpc?.choices).toEqual([]);
    expect(oldNpc?.speechPages.length).toBeGreaterThan(0);
    expect(newNpc?.freeInputEnabled).toBe(true);
    expect(newNpc?.choices).toHaveLength(2);
    expect(newNpc?.choices.map((entry) => entry.label)).toEqual([
      "我愿意先把手里的证据交给你核对，请你把知道的那一段说清楚。",
      "我会逐项核对线索；你凭什么确定它们指向同一个人？",
    ]);
    expect(view.narrative.choices).toHaveLength(0);
    expect(view.story.currentObjectiveLabel).toBe("与传讯人交谈");
  });

  it("旧对白 choice 过期且当前目标已非交谈时，不会吞掉地点战斗入口", () => {
    const enemy = {
      id: asEnemyId("enemy_1"), name: "夺旗客", tier: "normal" as const,
      stats: { hp: 20, attack: 5, defense: 1 }, locationId: asLocationId("loc_1"), tags: [],
    };
    const scene = {
      sceneId: "scene-expired-dialogue",
      turn: 7,
      narration: "苏绾已经说完了。",
      usedFactIds: [],
      npcLine: { npcId: npc1.id, text: "你去面对追兵吧。", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "expired-1", label: "旧选项一" },
        { choiceToken: "expired-2", label: "旧选项二" },
      ] as const,
      source: "generated" as const,
      event: { kind: "dialogue" as const, focusNpcId: npc1.id },
      npcDialogues: [{ npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["你去面对追兵吧。"] }],
    };
    const view = projectGameSessionView(
      { ...ws, enemies: [enemy] },
      { ...ss, narrative: { ...ss.narrative, currentScene: scene } },
      0,
      "test-ending-session",
    );
    expect(view.narrative.npcDialogues[0]?.freeInputEnabled).toBe(false);
    expect(view.currentLocation.actions.map((action) => action.label)).toContain("挑战夺旗客");
  });

  it("completed talk focus is demoted when the authoritative objective has moved to an item", () => {
    const itemId = asItemId("item_evidence");
    const scene = {
      sceneId: "scene-after-talk",
      turn: 4,
      narration: "顾砚已经把证物交到你面前。",
      usedFactIds: [],
      npcLine: { npcId: npc1.id, text: "这枚腰牌该交给你了。", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "support-after-talk", label: "支持老板" },
        { choiceToken: "challenge-after-talk", label: "质疑老板" },
      ] as const,
      source: "fixture" as const,
      event: { kind: "dialogue" as const, focusNpcId: npc1.id },
      npcDialogues: [{ npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["这枚腰牌该交给你了。"] }],
    };
    const wsAfterTalk: WorldState = {
      ...ws,
      npcs: [{ ...npc1, met: true }],
      visitedLocationIds: [loc1.id],
      worldFacts: [{ factId: asFactId("fact_opening"), text: "已经核实的线索", source: "generated", discovered: true, locationId: loc1.id }],
      items: [{ id: itemId, name: "染血腰牌", description: "一枚染血的腰牌", kind: "quest", tags: [] }],
      quests: [{
        id: asQuestId("quest_after_talk"),
        name: "追查旧案",
        description: "先与老板交谈，再取得证物",
        objectives: [
          { kind: "discover_fact", factId: asFactId("fact_opening") },
          { kind: "visit_location", locationId: loc1.id },
          { kind: "talk_to_npc", npcId: npc1.id },
          { kind: "obtain_item", itemId },
        ],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
    };
    const ssAfterTalk: StoryState = {
      ...ss,
      reveal: { questId: asQuestId("quest_after_talk"), visibleObjectiveIndex: 3 },
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("support-after-talk", scene.sceneId, 0, scene.choices[0].label, { type: "talk", npcId: npc1.id, dialogueAct: "support" }),
          approved("challenge-after-talk", scene.sceneId, 0, scene.choices[1].label, { type: "talk", npcId: npc1.id, dialogueAct: "challenge" }),
        ],
      },
    };

    const view = projectGameSessionView(wsAfterTalk, ssAfterTalk, 0, "test-ending-session");
    const dialogue = view.narrative.npcDialogues.find((entry) => entry.npcId === String(npc1.id));
    expect(view.story.currentObjectiveLabel).toBe("获取染血腰牌");
    expect(dialogue?.freeInputEnabled).toBe(false);
    // 旧断言：expect(dialogue?.choices).toHaveLength(1); expect(dialogue?.choices[0]?.label).toBe("与老板交谈");
    expect(dialogue?.choices).toEqual([]);
  });

  it("uses the newly generated objective NPC as focus even when the triggering event was travel", () => {
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "传讯人", role: "旧案传讯人", description: "带来下一幕消息",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const scene = {
      sceneId: "scene-target-ready",
      turn: 2,
      narration: "主线线索把你带到传讯人面前。",
      usedFactIds: [],
      npcLine: { npcId: secondNpc.id, text: "我手里有一条线索。", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "t1", label: "表示愿意支持传讯人" },
        { choiceToken: "t2", label: "质疑传讯人的说法" },
      ] as const,
      source: "fixture" as const,
      event: { kind: "travel" as const, locationId: asLocationId("loc_1") },
      npcDialogues: [
        { npcId: secondNpc.id, npcName: secondNpc.name, npcRole: secondNpc.role, speechPages: ["我手里有一条线索。"] },
      ],
    };
    const wsTarget = {
      ...ws,
      npcs: [...ws.npcs, secondNpc],
      quests: [{
        id: asQuestId("quest_target"), name: "循迹", description: "找到传讯人",
        objectives: [{ kind: "talk_to_npc" as const, npcId: secondNpc.id }],
        onSuccess: { kind: "advance_story" as const }, onFailure: { kind: "closed" as const },
        tags: [], kind: "main" as const, stage: 1, status: "active" as const,
      }],
    };
    const ssTarget = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("t1", scene.sceneId, 0, scene.choices[0].label, { type: "talk", npcId: secondNpc.id, dialogueAct: "support" }),
          approved("t2", scene.sceneId, 0, scene.choices[1].label, { type: "talk", npcId: secondNpc.id, dialogueAct: "challenge" }),
        ],
      },
    };
    const view = projectGameSessionView(wsTarget, ssTarget, 0, "test-ending-session");
    const focus = view.narrative.npcDialogues.find((dialogue) => dialogue.npcId === "npc_2");
    expect(focus?.choices).toHaveLength(2);
    expect(focus?.freeInputEnabled).toBe(true);
    // 旧 NPC 无焦点场景供给 → 投影零回合闲聊（零选项、无自由输入）
    const oldNpcDialogue = view.narrative.npcDialogues.find((dialogue) => dialogue.npcId === "npc_1");
    expect(oldNpcDialogue).toBeDefined();
    expect(oldNpcDialogue?.choices).toEqual([]);
    expect(oldNpcDialogue?.freeInputEnabled).toBe(false);
  });

  it("keeps a same-NPC ending response pair in that NPC dialogue after a non-dialogue event", () => {
    const scene = {
      sceneId: "scene-ending-pair-after-battle",
      turn: 9,
      narration: "迷雾散去，老板仍在等你的答复。",
      usedFactIds: [],
      npcLine: { npcId: npc1.id, text: "证据已经齐了，你准备怎样面对众人？", emotion: "guarded" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "end-support", label: "回应老板：我愿意把证据摊开。" },
        { choiceToken: "end-challenge", label: "质疑老板：我会先核对证据。" },
      ] as const,
      source: "fixture" as const,
      event: { kind: "battle" as const, enemyId: asEnemyId("enemy_1") },
      npcDialogues: [
        { npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["证据已经齐了，你准备怎样面对众人？"] },
      ],
    };
    const story: StoryState = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("end-support", scene.sceneId, 0, scene.choices[0].label, { type: "talk", npcId: npc1.id, dialogueAct: "support" }),
          approved("end-challenge", scene.sceneId, 0, scene.choices[1].label, { type: "talk", npcId: npc1.id, dialogueAct: "challenge" }),
        ],
      },
    };

    const view = projectGameSessionView(ws, story, 0, "test-ending-session");
    const dialogue = view.narrative.npcDialogues.find((entry) => entry.npcId === "npc_1");
    expect(dialogue?.choices.map((choice) => choice.choiceToken)).toEqual(["end-support", "end-challenge"]);
    expect(dialogue?.freeInputEnabled).toBe(true);
    expect(view.narrative.choices).toEqual([]);
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
    const ssScene = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("w1", "scene-w", 0, scene.choices[0].label, { type: "explore" }),
          approved("w2", "scene-w", 0, scene.choices[1].label, { type: "move", locationId: asLocationId("loc_2") }),
        ],
      },
    };
    // 本地点有未发现线索事实 → explore 场景选项具备可探索性，可以投影。
    const wsWithTrace = {
      ...ws,
      worldFacts: [
        { factId: asFactId("fact_trace"), text: "柜台下的旧账簿", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") },
      ],
    };
    const view = projectGameSessionView(wsWithTrace, ssScene, 0, "test-ending-session");
    // 世界行动选项出现在 narrative.choices（白名单形状）
    expect(view.narrative.choices?.map((c) => c.choiceToken).sort()).toEqual(["w1", "w2"]);
    for (const c of view.narrative.choices ?? []) {
      expect(Object.keys(c).sort()).toEqual(["choiceToken", "label", "presentation"]);
    }
    // 不进入任何 NPC 的对话选择
    for (const d of view.narrative.npcDialogues ?? []) {
      expect(d.choices ?? []).toHaveLength(0);
    }
  });

  it("无剧情钩子的地点：探索场景选项被过滤（方案 1）", () => {
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
    const ssScene = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("w1", "scene-w", 0, scene.choices[0].label, { type: "explore" }),
          approved("w2", "scene-w", 0, scene.choices[1].label, { type: "move", locationId: asLocationId("loc_2") }),
        ],
      },
    };
    // 干净地点：无事实、无物品、无任务、无候选事件 → explore 不投影，move 仍投影。
    const view = projectGameSessionView(ws, ssScene, 0, "test-ending-session");
    expect(view.narrative.choices?.map((c) => c.choiceToken).sort()).toEqual(["w2"]);
  });

  it("只投影当前场景、当前 revision 且仍可执行的 ApprovedChoice token", () => {
    const cases: readonly {
      readonly badToken: string;
      readonly badRegistry: readonly ApprovedChoice[];
    }[] = [
      { badToken: "missing-token", badRegistry: [] },
      { badToken: "stale-token", badRegistry: [approved("stale-token", "scene-current", 3, "旧选项", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" })] },
      { badToken: "wrong-scene-token", badRegistry: [approved("wrong-scene-token", "scene-other", 4, "别处选项", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" })] },
      { badToken: "tampered-token", badRegistry: [approved("server-token", "scene-current", 4, "服务器原始选项", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" })] },
      { badToken: "illegal-token", badRegistry: [approved("illegal-token", "scene-current", 4, "前往未连接地点", { type: "move", locationId: asLocationId("loc_locked") })] },
    ];

    for (const testCase of cases) {
      const scene = {
        sceneId: "scene-current",
        turn: 4,
        narration: "客栈里出现了新的动静。",
        usedFactIds: [],
        npcLine: null,
        choices: [
          { choiceToken: "valid-token", label: "场景中被篡改的标签" },
          { choiceToken: testCase.badToken, label: "无效选项" },
        ] as const,
        source: "generated" as const,
        event: { kind: "observe" as const, locationId: asLocationId("loc_1") },
      };
      const story: StoryState = {
        ...ss,
        narrative: {
          ...ss.narrative,
          currentScene: scene,
          choiceRegistry: [
            approved("valid-token", scene.sceneId, 4, "询问老板", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }),
            ...testCase.badRegistry,
          ],
        },
      };

      expect(projectGameSessionView(ws, story, 4, "test-ending-session").narrative.choices).toEqual([
        { choiceToken: "valid-token", label: "询问老板", presentation: "dialogue" },
      ]);
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
    const view = projectGameSessionView(wsTwo, sceneWithDialogue, 0, "test-ending-session");
    const dialogues = view.narrative.npcDialogues ?? [];
    const lu = dialogues.find((d) => String(d.npcId) === "npc_1");
    const guest = dialogues.find((d) => String(d.npcId) === "npc_2");
    expect(lu!.speechPages.join("")).toBe("需要什么吗？");
    expect(view.narrative.narration).toBe("你在客栈。");
    expect(view.narrative.npcLine?.text).toBe("需要什么吗？");
    expect(guest!.speechPages.length).toBeGreaterThan(0);
    expect(guest!.speechPages.join("")).toMatch(/^【fallback】/u);
  });

  it("对话终句把唯一 scene choice 投影为旧 NPC 的 handoff，而不是‘知道了’", () => {
    const scene = {
      sceneId: "scene-handoff",
      turn: 2,
      narration: "老板指向街道尽头。",
      usedFactIds: [],
      npcLine: { npcId: npc1.id, text: "线索已经指向街道。你现在过去，就能赶上留下的痕迹。", emotion: "neutral" as const, usedFactIds: [] },
      choices: [{ choiceToken: "handoff-token", label: "我这就去核对。" }],
      source: "generated" as const,
      event: { kind: "dialogue" as const, focusNpcId: npc1.id },
      npcDialogues: [{ npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["线索已经指向街道。你现在过去，就能赶上留下的痕迹。"] }],
    };
    const story: StoryState = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        dialogueSession: { npcId: npc1.id, turnCount: 2, requiredTurns: 2, completed: true },
        choiceRegistry: [approved("handoff-token", scene.sceneId, 0, "我这就去核对。", { type: "move", locationId: loc2.id })],
      },
    };
    const view = projectGameSessionView(ws, story, 0, "test-ending-session");
    const dialogue = view.narrative.npcDialogues.find((entry) => entry.npcId === String(npc1.id));
    expect(dialogue?.choices).toEqual([]);
    expect(dialogue?.handoffChoice?.label).toBe("（我这就去核对。）");
    expect(view.narrative.choices).toEqual([]);
    expect(dialogue?.handoffChoice?.label).not.toBe("知道了");
  });

  it("在 read model 统一标记 fallback 场景的旁白、NPC 台词和对白页", () => {
    const view = projectGameSessionView(ws, {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: {
          sceneId: "scene-fallback-marker",
          turn: 0,
          narration: "确定性旁白。",
          usedFactIds: [],
          npcLine: { npcId: npc1.id, text: "确定性回应。", emotion: "neutral" as const, usedFactIds: [] },
          choices: [] as never,
          source: "fixture" as const,
          event: { kind: "dialogue" as const, focusNpcId: npc1.id },
          npcDialogues: [{ npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["确定性回应。"] }],
        },
      },
    }, 0, "ending");

    expect(view.narrative.narration).toBe("【fallback】确定性旁白。");
    expect(view.narrative.npcLine?.text).toBe("【fallback】确定性回应。");
    expect(view.narrative.npcDialogues[0]?.speechPages).toEqual(["【fallback】确定性回应。"]);
  });

  it("旧存档中的 NPC 名称/动作前缀在 read model 投影时被清理", () => {
    const legacyStory = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: {
          sceneId: "scene-legacy-speech",
          turn: 0,
          narration: "你在客栈。",
          usedFactIds: [],
          npcLine: { npcId: asNpcId("npc_1"), text: "老板如实答道：\"我知道了。\"", emotion: "neutral" as const, usedFactIds: [] },
          choices: [] as never,
          source: "fixture" as const,
          event: { kind: "dialogue" as const, focusNpcId: asNpcId("npc_1") },
          npcDialogues: [
            { npcId: asNpcId("npc_1"), npcName: "老板", npcRole: "路人", speechPages: ["老板如实答道：\"我知道了。\""] },
          ],
        },
      },
    };
    const view = projectGameSessionView(ws, legacyStory, 0, "test-ending-session");
    const dialogue = view.narrative.npcDialogues.find((entry) => entry.npcId === "npc_1");
    expect(dialogue?.speechPages.join("")).toBe("【fallback】我知道了。");
    expect(dialogue?.speechPages.join("")).not.toMatch(/老板|如实答道/);
    expect(view.narrative.npcLine?.text).toBe("【fallback】我知道了。");
    expect(view.narrative.npcLine?.speaker).toBe("老板");
  });

  it("observe 场景的 NPC 旁白不会伪装成可自由输入的焦点对话", () => {
    const storyWithObservation = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: {
          sceneId: "scene-observe-with-npc-line",
          turn: 0,
          narration: "镇口一阵风吹过。",
          usedFactIds: [],
          npcLine: { npcId: asNpcId("npc_1"), text: "老板说道：\"我知道了。\"", emotion: "neutral" as const, usedFactIds: [] },
          choices: [] as never,
          source: "generated" as const,
          event: { kind: "observe" as const, locationId: asLocationId("loc_1") },
        },
      },
    };
    const view = projectGameSessionView(ws, storyWithObservation, 0, "test-ending-session");
    const dialogue = view.narrative.npcDialogues.find((entry) => entry.npcId === "npc_1");
    expect(dialogue?.freeInputEnabled).toBe(false);
    // observe 用例
    expect(dialogue?.choices).toEqual([]);
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
        onSuccess: { kind: "resolve_story" as const },
        onFailure: { kind: "closed" as const },
        tags: [],
      }      ] as unknown as WorldState["quests"],
    };
    const view = projectGameSessionView(wsWithSecret, ss, 0, "test-ending-session");
    const serialized = JSON.stringify(view);
    // 未发现：不出现事实正文，也不出现 FactId 字符串
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(serialized).not.toContain("fact_secret");
    const objective = view.quests[0]?.objectives[0];
    expect(objective?.label).toBe("调查现场线索");
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
        onSuccess: { kind: "resolve_story" as const },
        onFailure: { kind: "closed" as const },
        tags: [],
      }      ] as unknown as WorldState["quests"],
    };
    const view = projectGameSessionView(wsWithSecret, ss, 0, "test-ending-session");
    const objective = view.quests[0]?.objectives[0];
    expect(objective?.label).toContain(SECRET_TEXT);
    expect(objective?.completed).toBe(true);
  });

  it("projects complete map, location, item, and idle-battle choices as opaque presentation tokens", () => {
    const itemId = asItemId("item_key");
    const enemyId = asEnemyId("enemy_wolf");
    const completeWorld: WorldState = {
      ...ws,
      locations: ws.locations.map((location) => location.id === asLocationId("loc_1")
        ? { ...location, availableItemIds: [itemId] }
        : location),
      items: [{ id: itemId, name: "铜钥匙", description: "一把旧钥匙", kind: "key", tags: [] }],
      enemies: [{ id: enemyId, name: "灰狼", tier: "normal", stats: { hp: 20, attack: 5, defense: 2 }, locationId: asLocationId("loc_1"), tags: [] }],
      // 未发现的线索事实：探索与调查的剧情钩子。
      worldFacts: [{ factId: asFactId("fact_trace"), text: "柜底暗格", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") }],
    };

    const view = projectGameSessionView(completeWorld, ss, 7, "test-ending-session");
    const travel = view.worldMap.locations.find((location) => location.name === "街道")?.travelChoice;
    expect(travel).toMatchObject({ label: "前往街道", presentation: "travel" });
    expect(travel?.choiceToken).toMatch(/^c_[0-9a-f]{16}$/);
    expect(travel?.choiceToken).not.toContain("loc_2");

    // 未发现事实无已审批调查方式 → 不投影 investigate 按钮，只保留观察探索。
    expect(view.currentLocation.actions.map((choice) => choice.presentation)).toEqual([
      "explore", "battle",
    ]);
    expect(view.obtainableItems).toEqual([
      expect.objectContaining({ name: "铜钥匙", choice: expect.objectContaining({ presentation: "item" }) }),
    ]);
    expect(Object.keys(view.worldMap.locations[0]!).sort()).toEqual([
      "current", "name", "scale", "travelChoice", "visited",
    ]);
    expect(Object.keys(view.currentLocation).sort()).toEqual(["actions", "description", "name", "npcs", "scale", "town"]);
    expect(Object.keys(view.obtainableItems[0]!).sort()).toEqual(["choice", "description", "name"]);
    const inventoryView = projectGameSessionView({ ...completeWorld, inventory: [itemId] }, ss, 7, "test-ending-session");
    expect(inventoryView.inventory).toEqual([{
      name: "铜钥匙",
      description: "一把旧钥匙",
      category: "quest",
      rarity: "rare",
      level: null,
      statLines: [],
      icon: "key",
    }]);
    expect(JSON.stringify(view)).not.toMatch(/loc_1|loc_2|item_key|enemy_wolf/);
    for (const choice of [
      ...view.currentLocation.actions,
      ...view.obtainableItems.map((item) => item.choice),
    ]) {
      expect(choice.choiceToken).toMatch(/^c_[0-9a-f]{16}$/);
      expect(choice.choiceToken).not.toMatch(/move:|take_item:|attack:|explore/);
    }
    const executable = buildChoiceMap(completeWorld, ss, 7);
    for (const playerChoice of [
      travel!,
      ...view.currentLocation.actions,
      ...view.obtainableItems.map((item) => item.choice),
    ]) {
      expect(executable.has(playerChoice.choiceToken)).toBe(true);
    }
  });

  it("projects active battle controls as attack and guard tokens and no non-battle location actions", () => {
    const enemyId = asEnemyId("enemy_wolf");
    const battleWorld: WorldState = {
      ...ws,
      enemies: [{ id: enemyId, name: "灰狼", tier: "normal", stats: { hp: 20, attack: 5, defense: 2 }, locationId: asLocationId("loc_1"), tags: [] }],
      battle: { status: "active", enemyId, playerHp: 91, enemyHp: 13, round: 2 },
    };
    const view = projectGameSessionView(battleWorld, ss, 3, "test-ending-session");
    expect(view.currentLocation.actions).toEqual([]);
    expect(view.battle).toMatchObject({ enemyName: "灰狼", playerHp: 91, enemyHp: 13, round: 2 });
    expect(view.battle?.controls.map((choice) => choice.label)).toEqual(["攻击", "防御"]);
    expect(view.battle?.controls.every((choice) => choice.presentation === "battle")).toBe(true);
    expect(view.battle?.controls.every((choice) => /^c_[0-9a-f]{16}$/.test(choice.choiceToken))).toBe(true);
    const executable = buildChoiceMap(battleWorld, ss, 3);
    expect(view.battle?.controls.every((choice) => executable.has(choice.choiceToken))).toBe(true);
  });

  it("无已审批调查方式的事实不投影 investigate 入口，也不生成编号的伪按钮", () => {
    const facts = [
      { factId: asFactId("fact_a"), text: "暗号一", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") },
      { factId: asFactId("fact_b"), text: "暗号二", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") },
    ];
    const view = projectGameSessionView({ ...ws, worldFacts: facts }, ss, 7, "test-ending-session");
    expect(view.currentLocation.actions.filter((choice) => choice.presentation === "investigate")).toHaveLength(0);
    expect(view.currentLocation.actions.some((choice) => choice.label === "调查现场线索 1")).toBe(false);
    expect(view.currentLocation.actions.some((choice) => choice.label === "调查现场线索 2")).toBe(false);
  });

  it("projects focused NPC as exactly two dialogue choices plus custom input", () => {
    const scene = {
      sceneId: "scene-dialogue",
      turn: 2,
      narration: "老板压低声音。",
      usedFactIds: [],
      npcLine: { npcId: asNpcId("npc_1"), text: "此事不可声张。", emotion: "guarded" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "c_aabbccddeeff0011", label: "追问线索" },
        { choiceToken: "c_1122334455667788", label: "表示理解" },
      ] as const,
      source: "generated" as const,
      event: { kind: "dialogue" as const, focusNpcId: asNpcId("npc_1") },
    };
    const story = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved(scene.choices[0].choiceToken, scene.sceneId, 2, scene.choices[0].label, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }),
          approved(scene.choices[1].choiceToken, scene.sceneId, 2, scene.choices[1].label, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" }),
        ],
      },
    };
    const view = projectGameSessionView(ws, story, 2, "test-ending-session");
    const dialogue = view.narrative.npcDialogues[0];
    expect(dialogue).toMatchObject({ npcId: "npc_1", name: "老板", role: "路人", freeInputEnabled: true });
    expect(dialogue?.choices).toHaveLength(2);
    expect(dialogue?.choices.map((choice) => choice.presentation)).toEqual(["dialogue", "dialogue"]);
  });

  it("旧移动抵达场景含有 move 时，读模型修复为两个 talk 选项", () => {
    const scene = {
      sceneId: "scene-arrival-dialogue",
      turn: 3,
      narration: "你抵达客栈，老板迎了上来。",
      usedFactIds: [],
      npcLine: { npcId: asNpcId("npc_1"), text: "老板把旧案的关键线索说给你听。", emotion: "neutral" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "arrival-1", label: "请把下一步说清楚。" },
        { choiceToken: "arrival-2", label: "不再追问，离开这里" },
      ] as const,
      source: "generated" as const,
      event: { kind: "travel" as const, locationId: asLocationId("loc_1") },
    };
    const story = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("arrival-1", scene.sceneId, 3, scene.choices[0].label, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" }),
          approved("arrival-2", scene.sceneId, 3, scene.choices[1].label, { type: "move", locationId: asLocationId("loc_2") }),
        ],
      },
    };
    const world = {
      ...ws,
      quests: [{
        id: asQuestId("quest_arrival"),
        name: "追查旧案",
        description: "查明旧案真相",
        objectives: [{ kind: "talk_to_npc" as const, npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "advance_story" as const },
        onFailure: { kind: "closed" as const },
        tags: [],
        kind: "main" as const,
        stage: 1,
        status: "active" as const,
      }],
    };

    const view = projectGameSessionView(world, story, 3, "test-ending-session");
    const dialogue = view.narrative.npcDialogues.find((entry) => entry.npcId === "npc_1");
    expect(dialogue?.choices).toHaveLength(2);
    expect(dialogue?.choices.every((choice) => choice.presentation === "dialogue")).toBe(true);
    const executable = buildChoiceMap(world, story, 3);
    expect(dialogue?.choices.every((choice) => executable.has(choice.choiceToken))).toBe(true);
    expect(view.narrative.choices).toEqual([]);
  });

  it("projects quest objectives, pending/reload data, and ending without leaking server state", () => {
    const endingId = asEndingId("ending_home");
    const secretText = "皇城密道位于古井之下";
    const fullWorld: WorldState = {
      ...ws,
      worldFacts: [{ factId: asFactId("fact_hidden"), text: secretText, source: "generated", discovered: false }],
      quests: [{
        id: "quest_main" as WorldState["quests"][number]["id"],
        name: "查明真相", description: "追寻线索", kind: "main", stage: 1, status: "active",
        objectives: [{ kind: "discover_fact", factId: asFactId("fact_hidden") }],
        onSuccess: { kind: "resolve_story" }, onFailure: { kind: "closed" }, tags: [],
      }],
      ending: { endingId, outcome: "success" },
    };
    const pendingStory = {
      ...ss,
      candidateEventPool: [{ secretEffect: "must-never-leak" }] as unknown as StoryState["candidateEventPool"],
      narrative: {
        status: "provider_pending" as const,
        mode: "ai" as const,
        job: { utterance: "private player text", jobId: "job-pending" } as never,
        lastPresentedScene: ss.narrative.currentScene,
      },
    };
    const view = projectGameSessionView(fullWorld, pendingStory, 12, "opaque-ended-session");
    expect(view.revision).toBe(12);
    expect(view.narrativeGeneration).toEqual({ status: "pending" });
    expect(view.quests[0]?.objectives).toEqual([{ label: "调查现场线索", completed: false }]);
    expect(view.ending).toMatchObject({ name: "故事结局", outcome: "success", restartIdentity: "opaque-ended-session" });

    const reloaded = JSON.parse(JSON.stringify(view));
    expect(reloaded).toEqual(view);
    const serialized = JSON.stringify(view);
    for (const forbidden of [
      "actionKey", "choiceRegistry", "candidateEventPool", "secretEffect", "secretRegistry",
      "private player text", secretText, "worldState", "storyState", "eventLedger",
      "quest_main", "ending_home", "loc_1", "loc_2",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(view.quests[0]!).sort()).toEqual([
      "description", "kind", "name", "objectives", "status",
    ]);
    expect(Object.keys(view.ending!).sort()).toEqual(["description", "name", "outcome", "restartIdentity"]);
  });

  it("does not project non-focus smallTalk as a zero-write action", () => {
    const scene = {
      sceneId: "scene-small-talk",
      turn: 2,
      narration: "你与周伯交谈时，韩征在一旁巡视。",
      usedFactIds: [],
      npcLine: { npcId: asNpcId("npc_1"), text: "周伯低声说道：那天晚上我确实看到了可疑的人影。", emotion: "guarded" as const, usedFactIds: [] },
      choices: [
        { choiceToken: "c_choice1", label: "追问详情" },
        { choiceToken: "c_choice2", label: "表示支持" },
      ] as const,
      source: "generated" as const,
      event: { kind: "dialogue" as const, focusNpcId: asNpcId("npc_1") },
      npcDialogues: [
        {
          npcId: asNpcId("npc_1"),
          npcName: "周伯",
          npcRole: "客栈掌柜",
          speechPages: ["那天晚上我确实看到了可疑的人影。"],
        },
        {
          npcId: asNpcId("npc_2"),
          npcName: "韩征",
          npcRole: "捕头",
          speechPages: ["韩征看了你一眼，继续巡视。"],
          speechSource: "generated" as const,
          smallTalk: {
            prompt: "向韩征打个招呼",
            response: "韩征点了点头：「有什么事直接找我，别耽误正事。」",
          },
        },
      ],
    };
    const secondNpc: NpcEntry = {
      id: asNpcId("npc_2"), name: "韩征", role: "捕头", description: "镇上的捕头",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsTwo = { ...ws, npcs: [...ws.npcs, secondNpc] };
    const story = {
      ...ss,
      narrative: {
        ...ss.narrative,
        currentScene: scene,
        choiceRegistry: [
          approved("c_choice1", scene.sceneId, 2, "追问详情", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }),
          approved("c_choice2", scene.sceneId, 2, "表示支持", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" }),
        ],
      },
    };

    const view = projectGameSessionView(wsTwo, story, 2, "test-ending-session");
    const dialogues = view.narrative.npcDialogues ?? [];

    // 焦点 NPC (周伯) 有两个正式选项
    const focusNpc = dialogues.find((d) => d.npcId === "npc_1");
    expect(focusNpc).toBeDefined();
    expect(focusNpc?.choices).toHaveLength(2);
    expect(focusNpc?.freeInputEnabled).toBe(true);

    // 非焦点 NPC (韩征)：无 ask 选项；动作旁白被清洗后回落闲聊台词
    const nonFocusNpc = dialogues.find((d) => d.npcId === "npc_2");
    expect(nonFocusNpc).toBeDefined();
    expect(nonFocusNpc?.choices).toEqual([]);
    expect(nonFocusNpc?.freeInputEnabled).toBe(false);
    expect(nonFocusNpc).not.toHaveProperty("smallTalk");
    expect(nonFocusNpc?.speechPages.join("")).not.toContain("继续巡视");
    expect(nonFocusNpc?.speechPages.length).toBeGreaterThan(0);
    expect(nonFocusNpc?.speechPages.join("")).not.toContain("【fallback】");
  });

  it("交接后的非焦点 NPC 只提供零回合闲聊，不再投影可提交的 ask 选项", () => {
    const factTracks = {
      factId: asFactId("fact_tracks"),
      text: "车轮印",
      source: "generated" as const,
      discovered: false,
      locationId: loc1.id,
    };
    const wsHandoffIdle: WorldState = {
      ...ws,
      npcs: [{ ...npc1, met: true }],
      worldFacts: [factTracks],
      quests: [{
        id: asQuestId("quest_tracks"),
        name: "追查车轮印",
        description: "查明车轮印",
        objectives: [
          { kind: "talk_to_npc", npcId: npc1.id },
          { kind: "discover_fact", factId: factTracks.factId },
        ],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
    };
    const ssHandoffIdle: StoryState = {
      ...ss,
      reveal: { questId: asQuestId("quest_tracks"), visibleObjectiveIndex: 1 },
      narrative: {
        ...ss.narrative,
        dialogueSession: { npcId: npc1.id, turnCount: 2, requiredTurns: 2, completed: true },
        currentScene: {
          sceneId: "scene-handoff-idle",
          turn: 5,
          narration: "老板说完了。",
          usedFactIds: [],
          npcLine: { npcId: npc1.id, text: "接下来去查明车轮印。", emotion: "neutral" as const, usedFactIds: [] },
          choices: [] as never,
          source: "fixture" as const,
          event: { kind: "observe" as const, locationId: loc1.id },
        },
      },
    };

    const view = projectGameSessionView(wsHandoffIdle, ssHandoffIdle, 0, "test-ending-session");
    const idle = view.narrative.npcDialogues.find((dialogue) => dialogue.npcId === String(npc1.id));
    expect(idle).toBeDefined();
    expect(idle?.choices).toEqual([]);
    expect(idle?.freeInputEnabled).toBe(false);
    expect(idle?.speechPages.length).toBeGreaterThan(0);
    // 断言来自场景 npcLine 焦点台词（本用例保留交接场景的焦点台词），
    // 并非 composeIdleNpcLine 的提醒变体；提醒路径由下方独立用例覆盖。
    //（discover_fact 的 label 规则：已发现 → 查明：fact 文本；未发现 → 调查investigationLabel，
    //  不会把未发现的事实正文泄露进 label，故此处断言的是场景台词中的事实文本）
    expect(idle?.speechPages.join("")).toContain("车轮印");
    // 行动栏与 talkChoice 不再为非目标 NPC 提供交谈入口
    expect(view.currentLocation.actions.some((action) => action.presentation === "dialogue")).toBe(false);
    expect(view.currentLocation.npcs[0]?.talkChoice).toBeNull();
  });

  it("非焦点 NPC 无场景台词时，按权威目标 label 投影 composeIdleNpcLine 提醒变体", () => {
    const factTracks = {
      factId: asFactId("fact_tracks"),
      text: "车轮印",
      source: "generated" as const,
      discovered: false,
      locationId: loc1.id,
      // 未发现事实的 label 使用 investigationLabel（知识边界：不泄露事实正文）
      investigationLabel: "车轮印",
    };
    const wsReminder: WorldState = {
      ...ws,
      npcs: [{
        ...npc1,
        met: true,
        memory: {
          ...npc1.memory,
          interactionHistory: [{
            turnNumber: 2,
            actionId: "act_setup",
            locationId: loc1.id,
            dialogueAct: "ask" as const,
            topicSummary: "询问线索",
            outcome: "positive" as const,
            relationshipDelta: 2,
            learnedFactIds: [],
            summary: "询问车轮印线索",
          }],
        },
      }],
      worldFacts: [factTracks],
      quests: [{
        id: asQuestId("quest_tracks"),
        name: "追查车轮印",
        description: "查明车轮印",
        objectives: [
          { kind: "talk_to_npc", npcId: npc1.id },
          { kind: "discover_fact", factId: factTracks.factId },
        ],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
    };
    const ssReminder: StoryState = {
      ...ss,
      reveal: { questId: asQuestId("quest_tracks"), visibleObjectiveIndex: 1 },
      narrative: {
        ...ss.narrative,
        dialogueSession: { npcId: npc1.id, turnCount: 2, requiredTurns: 2, completed: true },
        // 该 NPC 既无场景台词，也无焦点台词 → 非焦点 NPC 走 idleLine
        currentScene: {
          sceneId: "scene-reminder-idle",
          turn: 5,
          narration: "老板没有接话。",
          usedFactIds: [],
          npcLine: null,
          choices: [] as never,
          source: "fixture" as const,
          event: { kind: "observe" as const, locationId: loc1.id },
        },
      },
    };

    const view = projectGameSessionView(wsReminder, ssReminder, 0, "test-ending-session");
    const idle = view.narrative.npcDialogues.find((dialogue) => dialogue.npcId === String(npc1.id));
    expect(idle).toBeDefined();
    expect(idle?.choices).toEqual([]);
    expect(idle?.freeInputEnabled).toBe(false);
    // 有结构化交互历史 + 权威目标 label → 提醒台词承接权威目标（未发现事实 → 调查investigationLabel）
    expect(idle?.speechPages.join("")).toContain("调查车轮印");
    // 行动栏与 talkChoice 不再为非目标 NPC 提供交谈入口
    expect(view.currentLocation.actions.some((action) => action.presentation === "dialogue")).toBe(false);
    expect(view.currentLocation.npcs[0]?.talkChoice).toBeNull();
  });

  it("projects only the stable AI failure kind for a failed generation", () => {
    const failedStory: StoryState = {
      ...ss,
      narrative: {
          status: "provider_failed",
          mode: "ai",
          job: {
            jobId: "job-failed-1" as never,
            turnId: "turn-1" as never,
            actionId: "action-1",
            basedOnRevision: 2,
            turnNumber: 3,
            actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
            utterance: "private player text",
            resolvedEvent: { actionId: "action-1", status: "success", eventKind: "observe", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] },
            domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
            focusNpcId: asNpcId("npc_1"),
            requestedAt: "2026-08-21T00:00:00.000Z",
            objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
            mandatoryBeats: [],
            generationKind: "npc_fixed_choice",
            sceneRequestKind: "npc_response",
          } as never,
          lastPresentedScene: ss.narrative.currentScene,
          failure: {
            kind: "AI_RESPONSE_INVALID",
            phase: "scene",
            failedAt: "2026-08-21T00:00:00.000Z",
          },
      },
    };
    const view = projectGameSessionView(ws, failedStory, 3, "ending-id");

    expect(view.narrativeGeneration).toEqual({
      status: "failed",
      failureKind: "AI_RESPONSE_INVALID",
    });
  });

  it("failed projection does not leak job, utterance or provider details", () => {
    const failedStory: StoryState = {
      ...ss,
      narrative: {
          status: "provider_failed",
          mode: "ai",
          job: {
            jobId: "job-failed-1" as never,
            turnId: "turn-1" as never,
            actionId: "action-1",
            basedOnRevision: 2,
            turnNumber: 3,
            actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
            utterance: "private player text",
            resolvedEvent: { actionId: "action-1", status: "success", eventKind: "observe", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] },
            domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
            focusNpcId: asNpcId("npc_1"),
            requestedAt: "2026-08-21T00:00:00.000Z",
            objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
            mandatoryBeats: [],
            generationKind: "npc_fixed_choice",
            sceneRequestKind: "npc_response",
          } as never,
          lastPresentedScene: ss.narrative.currentScene,
          failure: {
            kind: "AI_CALL_FAILED",
            phase: "scene",
            failedAt: "2026-08-21T00:00:00.000Z",
          },
      },
    };
    const view = projectGameSessionView(ws, failedStory, 3, "ending-id");
    const serialized = JSON.stringify(view.narrativeGeneration);

    expect(serialized).not.toContain("private player text");
    expect(serialized).not.toContain("job-failed-1");
    expect(serialized).not.toContain("action-1");
    expect(serialized).not.toContain("failedAt");
  });
});

describe("projectGameSessionView town read model", () => {
  const townLoc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "街道", description: "一条街道", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
  };
  const townNpc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  function makeTownWorld(): WorldState {
    const town = bindNpcToTownSlot(
      createTownRuntime({ locationId: asLocationId("loc_1"), seed: "view-town-test" }),
      asNpcId("npc_1"),
    ).town;
    const base = createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: townLoc1,
      startingItemIds: [],
    });
    return {
      ...base,
      locations: base.locations.map((loc) => (loc.id === asLocationId("loc_1") ? { ...loc, scale: "town" as const, town } : loc)),
      npcs: [townNpc1],
    };
  }

  it("currentLocation.town 暴露快照 + 已绑定交互建筑条目", () => {
    const townWs = makeTownWorld();
    const townSs = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
    const view = projectGameSessionView(townWs, townSs, 0, "test-ending-session");
    const town = view.currentLocation.town;
    expect(town).not.toBeNull();
    expect(town!.townName).toBe("街道");
    expect(town!.snapshot.grid.width).toBe(32);
    const interactive = town!.interactiveBuildings;
    expect(interactive.length).toBeGreaterThan(0);
    expect(interactive[0]?.npcId).toBe("npc_1");
    expect(interactive[0]?.npcName).toBe("老板");
  });

  it("town 地点的同一物品只投影到一个可进入建筑，不会在每个建筑场景重复出现", () => {
    const secondNpcId = asNpcId("npc_2");
    const secondNpc: NpcEntry = {
      ...townNpc1,
      id: secondNpcId,
      name: "铁匠",
      role: "铁匠",
      locationId: asLocationId("loc_1"),
      memory: { ...townNpc1.memory, npcId: secondNpcId },
    };
    const base = makeTownWorld();
    const location = base.locations[0]!;
    const town = bindNpcToTownSlot(location.town!, secondNpcId).town;
    const itemId = asItemId("item_town_relic");
    const townWs: WorldState = {
      ...base,
      locations: [{ ...location, npcIds: [townNpc1.id, secondNpcId], availableItemIds: [itemId], town }],
      npcs: [townNpc1, secondNpc],
      items: [{ id: itemId, name: "染血腰牌", description: "一块旧腰牌。", kind: "relic", tags: [] }],
    };
    const view = projectGameSessionView(
      townWs,
      createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 2, quests: 0, events: 0 } }),
      0,
      "test-ending-session",
    );
    const interactive = view.currentLocation.town?.interactiveBuildings ?? [];
    expect(interactive.length).toBeGreaterThanOrEqual(2);
    expect(view.obtainableItems).toHaveLength(1);
    expect(view.obtainableItems[0]?.buildingId).toBe(interactive[0]?.buildingId);
    expect(view.obtainableItems[0]?.buildingId).not.toBe(interactive[1]?.buildingId);
  });

  it("town 读模型不泄漏 seed/空闲 slot/生成器内部", () => {
    const townWs = makeTownWorld();
    const townSs = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
    const view = projectGameSessionView(townWs, townSs, 0, "test-ending-session");
    const serialized = JSON.stringify(view.currentLocation.town);
    expect(serialized).not.toMatch(/"seed"/);
    expect(serialized).not.toMatch(/"generatorVersion"/);
    expect(serialized).not.toMatch(/"boundNpcId"/);
    expect(serialized).not.toMatch(/"slotId"/);
  });

  it("scene 地点 currentLocation.town 为 null", () => {
    const base = createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: townLoc1,
      startingItemIds: [],
    });
    const view = projectGameSessionView(base, createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } }), 0, "test-ending-session");
    expect(view.currentLocation.town).toBeNull();
  });

  it("projects only the stable AI failure kind", () => {
    const baseStory = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
    const failedStory: StoryState = {
      ...baseStory,
      narrative: {
        status: "provider_failed",
        mode: "ai",
        job: { jobId: "job_1", actionId: "a_1", generationKind: "npc_fixed_choice", sceneRequestKind: "npc_response" } as never,
        lastPresentedScene: null,
          failure: { kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: "2026-08-21T00:00:00.000Z" },
      },
    };
    const view = projectGameSessionView(makeTownWorld(), failedStory, 3, "ending-id");
    expect(view.narrativeGeneration).toEqual({
      status: "failed",
      failureKind: "AI_RESPONSE_INVALID",
    });
  });

  it("projects failed with AI_CALL_FAILED kind", () => {
    const baseStory = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
    const failedStory: StoryState = {
      ...baseStory,
      narrative: {
        status: "provider_failed",
        mode: "ai",
        job: { jobId: "job_2", actionId: "a_2", generationKind: "npc_fixed_choice", sceneRequestKind: "npc_response" } as never,
        lastPresentedScene: null,
          failure: { kind: "AI_CALL_FAILED", phase: "scene", failedAt: "2026-08-21T00:00:00.000Z" },
      },
    };
    const view = projectGameSessionView(makeTownWorld(), failedStory, 5, "ending-id");
    expect(view.narrativeGeneration).toEqual({
      status: "failed",
      failureKind: "AI_CALL_FAILED",
    });
  });
});
