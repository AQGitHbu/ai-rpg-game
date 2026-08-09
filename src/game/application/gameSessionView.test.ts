import { describe, it, expect } from "vitest";
import { projectGameSessionView } from "./gameSessionView";
import { buildChoiceMap } from "./buildChoiceMap";
import { createInitialWorldState, appendNpc, appendLocation, type WorldState, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asFactId, asItemId, asEnemyId, asEndingId } from "@/game/domain/scenarioBlueprint";
import type { Action } from "@/game/domain/action";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";

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

  function approved(
    choiceToken: string,
    sceneId: string,
    basedOnRevision: number,
    label: string,
    action: Action,
  ): ApprovedChoice {
    return { choiceToken, sceneId, basedOnRevision, label, action, semanticSummary: `approved:${choiceToken}` };
  }

  it("projects player and current location", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.player.name).toBe("侠客");
    expect(view.currentLocation.name).toBe("客栈");
  });

  it("projects available NPCs at current location", () => {
    const view = projectGameSessionView(ws, ss, 0);
    expect(view.narrative.npcDialogues).toHaveLength(1);
    expect(view.narrative.npcDialogues[0]?.name).toBe("老板");
  });

  it("projects available moves to connected unlocked locations", () => {
    const view = projectGameSessionView(ws, ss, 0);
    const moves = view.worldMap.locations.filter((location) => location.travelChoice !== null);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.name).toBe("街道");
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
        choiceRegistry: [approved("t1", "scene-1", 0, "x", { type: "move", locationId: asLocationId("loc_2") })],
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
    const view = projectGameSessionView(ws, ssScene, 0);
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

  it("只投影当前场景、当前 revision 且仍可执行的 ApprovedChoice token", () => {
    const cases: readonly {
      readonly badToken: string;
      readonly badRegistry: readonly ApprovedChoice[];
    }[] = [
      { badToken: "missing-token", badRegistry: [] },
      { badToken: "stale-token", badRegistry: [approved("stale-token", "scene-current", 3, "旧选项", { type: "rest" })] },
      { badToken: "wrong-scene-token", badRegistry: [approved("wrong-scene-token", "scene-other", 4, "别处选项", { type: "rest" })] },
      { badToken: "tampered-token", badRegistry: [approved("server-token", "scene-current", 4, "服务器原始选项", { type: "rest" })] },
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
            approved("valid-token", scene.sceneId, 4, "继续观察", { type: "explore" }),
            ...testCase.badRegistry,
          ],
        },
      };

      expect(projectGameSessionView(ws, story, 4).narrative.choices).toEqual([
        { choiceToken: "valid-token", label: "继续观察", presentation: "explore" },
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
    };

    const view = projectGameSessionView(completeWorld, ss, 7);
    const travel = view.worldMap.locations.find((location) => location.name === "街道")?.travelChoice;
    expect(travel).toMatchObject({ label: "前往街道", presentation: "travel" });
    expect(travel?.choiceToken).toMatch(/^c_[0-9a-f]{16}$/);
    expect(travel?.choiceToken).not.toContain("loc_2");

    expect(view.currentLocation.actions.map((choice) => choice.presentation)).toEqual([
      "explore", "dialogue", "battle", "rest",
    ]);
    expect(view.obtainableItems).toEqual([
      expect.objectContaining({ name: "铜钥匙", choice: expect.objectContaining({ presentation: "item" }) }),
    ]);
    expect(Object.keys(view.worldMap.locations[0]!).sort()).toEqual([
      "current", "name", "travelChoice", "visited",
    ]);
    expect(Object.keys(view.currentLocation).sort()).toEqual(["actions", "description", "name"]);
    expect(Object.keys(view.obtainableItems[0]!).sort()).toEqual(["choice", "description", "name"]);
    const inventoryView = projectGameSessionView({ ...completeWorld, inventory: [itemId] }, ss, 7);
    expect(inventoryView.inventory).toEqual([{ name: "铜钥匙", description: "一把旧钥匙" }]);
    expect(JSON.stringify(view)).not.toMatch(/loc_1|loc_2|item_key|enemy_wolf/);
    for (const choice of [
      ...view.currentLocation.actions,
      ...view.obtainableItems.map((item) => item.choice),
    ]) {
      expect(choice.choiceToken).toMatch(/^c_[0-9a-f]{16}$/);
      expect(choice.choiceToken).not.toMatch(/move:|take_item:|attack:|explore|rest/);
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

  it("projects active battle controls as three opaque tokens and no non-battle location actions", () => {
    const enemyId = asEnemyId("enemy_wolf");
    const battleWorld: WorldState = {
      ...ws,
      enemies: [{ id: enemyId, name: "灰狼", tier: "normal", stats: { hp: 20, attack: 5, defense: 2 }, locationId: asLocationId("loc_1"), tags: [] }],
      battle: { status: "active", enemyId, playerHp: 91, enemyHp: 13, round: 2 },
    };
    const view = projectGameSessionView(battleWorld, ss, 3);
    expect(view.currentLocation.actions).toEqual([]);
    expect(view.battle).toMatchObject({ enemyName: "灰狼", playerHp: 91, enemyHp: 13, round: 2 });
    expect(view.battle?.controls.map((choice) => choice.label)).toEqual(["攻击", "防御", "撤退"]);
    expect(view.battle?.controls.every((choice) => choice.presentation === "battle")).toBe(true);
    expect(view.battle?.controls.every((choice) => /^c_[0-9a-f]{16}$/.test(choice.choiceToken))).toBe(true);
    const executable = buildChoiceMap(battleWorld, ss, 3);
    expect(view.battle?.controls.every((choice) => executable.has(choice.choiceToken))).toBe(true);
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
    const view = projectGameSessionView(ws, story, 2);
    const dialogue = view.narrative.npcDialogues[0];
    expect(dialogue).toMatchObject({ npcId: "npc_1", name: "老板", role: "路人", freeInputEnabled: true });
    expect(dialogue?.choices).toHaveLength(2);
    expect(dialogue?.choices.map((choice) => choice.presentation)).toEqual(["dialogue", "dialogue"]);
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
        onSuccess: { kind: "reach_ending", endingId }, onFailure: { kind: "closed" }, tags: [],
      }],
      ending: { endingId, outcome: "success" },
    };
    const pendingStory = {
      ...ss,
      candidateEventPool: [{ secretEffect: "must-never-leak" }] as unknown as StoryState["candidateEventPool"],
      narrative: {
        ...ss.narrative,
        choiceRegistry: [{ secretRegistry: true }] as unknown as NonNullable<StoryState["narrative"]["choiceRegistry"]>,
        generation: { status: "pending", job: { utterance: "private player text" } } as unknown as StoryState["narrative"]["generation"],
      },
    };
    const view = projectGameSessionView(fullWorld, pendingStory, 12);
    expect(view.revision).toBe(12);
    expect(view.narrativeGeneration).toEqual({ status: "pending" });
    expect(view.quests[0]?.objectives).toEqual([{ label: "发现秘密", completed: false }]);
    expect(view.ending).toMatchObject({ name: "故事结局", outcome: "success" });

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
    expect(Object.keys(view.ending!).sort()).toEqual(["description", "name", "outcome"]);
  });
});
