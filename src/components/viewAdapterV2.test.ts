import { describe, it, expect } from "vitest";
import type { GameSessionViewV2 } from "@/game/application/gameSessionViewV2";
import { projectGameSessionView } from "@/game/application/gameSessionViewV2";
import { createDeterministicSceneSource } from "@/game/application/deterministicSceneSource";
import { approveScenePackage } from "@/game/application/approveAndWriteScene";
import type { SceneGenerationContext } from "@/game/application/sceneGenerationContext";
import { createInitialWorldState, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { adaptV2ToV1View } from "./viewAdapterV2";

function makeV2View(overrides: {
  readonly npcLines?: readonly {
    readonly npcId: string;
    readonly npcName: string;
    readonly npcRole: string;
    readonly speechPages: readonly string[];
    readonly choices?: readonly { readonly choiceToken: string; readonly label: string; readonly hint?: string }[];
    readonly freeInputEnabled?: boolean;
  }[];
  readonly npcLine?: { readonly npcId: string; readonly text: string; readonly emotion: string } | null;
}): GameSessionViewV2 {
  return {
    revision: 0,
    gameType: "wuxia",
    player: { name: "侠客", identity: "剑客", hp: 100, attack: 10, defense: 5 },
    currentLocation: { id: "loc_1" as never, name: "客栈", description: "一间客栈" },
    availableNpcs: [
      { id: "npc_1" as never, name: "老板", role: "路人", met: false },
      { id: "npc_2" as never, name: "客人", role: "酒客", met: false },
    ],
    availableMoves: [],
    inventory: [],
    story: { currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 0 },
    narrative: {
      mode: "offline",
      hasScene: true,
      eventKind: "dialogue",
      narration: "你在客栈。",
      choices: [],
      npcLine: overrides.npcLine ?? null,
      ...(overrides.npcLines !== undefined ? { npcDialogues: overrides.npcLines } : {}),
    },
    battle: null,
    quests: [],
    prologueShown: true,
    ending: null,
  } as unknown as GameSessionViewV2;
}

describe("adaptV2ToV1View dialogues", () => {
  it("uses narrative.npcDialogues speech pages per NPC", () => {
    const v = makeV2View({
      npcLines: [
        { npcId: "npc_1", npcName: "老板", npcRole: "路人", speechPages: ["老板说道：\"欢迎。\""] },
        { npcId: "npc_2", npcName: "客人", npcRole: "酒客", speechPages: ["客人点了点头。"] },
      ],
    });
    const adapted = adaptV2ToV1View(v) as unknown as {
      readonly dialogues: readonly { readonly npcId: string; readonly speechPages: readonly string[] }[];
    };
    const lu = adapted.dialogues.find((d) => d.npcId === "npc_1");
    const guest = adapted.dialogues.find((d) => d.npcId === "npc_2");
    expect(lu!.speechPages).toEqual(["老板说道：\"欢迎。\""]);
    expect(guest!.speechPages).toEqual(["客人点了点头。"]);
  });

  it("falls back to narrative.npcLine when npcDialogues is absent", () => {
    const v = makeV2View({ npcLine: { npcId: "npc_1", text: "直接台词。", emotion: "neutral" } });
    const adapted = adaptV2ToV1View(v) as unknown as {
      dialogues: readonly { npcId: string; speechPages: readonly string[] }[];
    };
    expect(adapted.dialogues.find((d) => d.npcId === "npc_1")!.speechPages.join("")).toBe("直接台词。");
  });

  it("falls back to npcLine when npcDialogues entry has empty pages", () => {
    const v = makeV2View({
      npcLines: [
        { npcId: "npc_1", npcName: "老板", npcRole: "路人", speechPages: [] },
      ],
      npcLine: { npcId: "npc_1", text: "焦点台词。", emotion: "neutral" },
    });
    const adapted = adaptV2ToV1View(v) as unknown as {
      dialogues: readonly { npcId: string; speechPages: readonly string[] }[];
    };
    expect(adapted.dialogues.find((d) => d.npcId === "npc_1")!.speechPages.join("")).toBe("焦点台词。");
  });

  it("focus-NPC only: dialogue choices & freeInput 只对焦点 NPC 生效，非焦点 NPC 无选项", () => {
    const v = makeV2View({
      npcLines: [
        { npcId: "npc_1", npcName: "老板", npcRole: "路人", speechPages: ["需要什么吗？"], choices: [{ choiceToken: "t1", label: "询问" }, { choiceToken: "t2", label: "告辞" }], freeInputEnabled: true },
        { npcId: "npc_2", npcName: "客人", npcRole: "酒客", speechPages: ["客人点头。"], freeInputEnabled: false },
      ],
    });
    const adapted = adaptV2ToV1View(v) as unknown as {
      dialogues: readonly {
        npcId: string;
        choices: readonly { choiceToken: string; label: string }[];
        freeInputEnabled: boolean;
      }[];
    };
    const lu = adapted.dialogues.find((d) => d.npcId === "npc_1")!;
    const guest = adapted.dialogues.find((d) => d.npcId === "npc_2")!;
    expect(lu.choices.map((c) => c.choiceToken).sort()).toEqual(["t1", "t2"]);
    expect(lu.freeInputEnabled).toBe(true);
    expect(guest.choices).toHaveLength(0);
    expect(guest.freeInputEnabled).toBe(false);
  });

  it("chain: deterministic scene -> projection -> adapter keeps every present NPC voiced", async () => {
    const loc: LocationEntry = {
      id: asLocationId("loc_1"), name: "客栈", description: "一间客栈", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    let ws = createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: loc,
      startingItemIds: [],
    });
    const npcs: readonly NpcEntry[] = [
      { id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t", locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false, memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } },
      { id: asNpcId("npc_2"), name: "客人", role: "酒客", description: "t", locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false, memory: { npcId: asNpcId("npc_2"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } },
    ];
    for (const npc of npcs) ws = appendNpc(ws, npc);
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 2, quests: 0, events: 0 } });
    const jobResult = createPendingNarrativeJob({
      jobId: asNarrativeJobId("job_s1"),
      turnId: asTurnId("turn_s1"),
      actionId: "act_s1",
      expectedRevision: 0,
      turnNumber: 1,
      actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
      resolvedEvent: {
        actionId: "act_s1", status: "success", eventKind: "dialogue",
        facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
      },
      domainEventRange: { fromLedgerIndex: 1, toLedgerIndexExclusive: 2 },
      focusNpcId: asNpcId("npc_1"),
      requestedAt: "2026-01-01",
    });
    if (!jobResult.ok) throw new Error("fixture job 构造失败");
    const context: SceneGenerationContext = {
      job: jobResult.job,
      player: { name: "侠客", identity: "剑客", knownFactCards: [] },
      currentLocation: { id: loc.id, name: loc.name, description: loc.description, kind: "main" },
      publicWorldFacts: [],
      sceneVisibleFacts: [],
      presentNpcs: npcs.map((n) => ({
        id: n.id, name: n.name, role: n.role, publicProfile: n.description,
        knownFactCards: [], hiddenFactCards: [], sceneVisibleFactIds: [],
        recentInteractionSummaries: [], relationship: { affinity: 0 }, emotion: "neutral",
        goals: [], forbiddenKnowledgeIds: [],
      })),
      story: {
        currentAct: ss.currentAct, targetActs: ss.targetActs, tension: ss.tension,
        nextPacingNeed: ss.nextPacingNeed,
        remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1 },
        unresolvedThreadSummaries: [],
      },
      recentBeats: [],
      legalActionCandidates: [{ kind: "talk", label: "与老板交谈", targetId: "npc_1" }],
      legalEventTargets: { locationIds: [loc.id], factIds: [], itemIds: [], enemyIds: [] },
      worldConstraints: [],
    };
    const sceneResult = await createDeterministicSceneSource().generateScene(context);
    const approved = approveScenePackage({
      context,
      proposal: sceneResult,
      basedOnRevision: 1,
      existingCandidateEventPool: [],
    });
    if (!approved.ok) throw new Error(`fixture approval failed: ${approved.code}`);
    const ssWithScene = { ...ss, narrative: { ...ss.narrative, currentScene: approved.scene } };
    const view = projectGameSessionView({ ...ws, npcs }, ssWithScene, 1);
    expect(view.narrative.npcDialogues).toHaveLength(2);
    const adapted = adaptV2ToV1View(view) as unknown as {
      dialogues: readonly { npcId: string; speechPages: readonly string[] }[];
    };
    expect(adapted.dialogues).toHaveLength(2);
    for (const d of adapted.dialogues) {
      expect(d.speechPages.length).toBeGreaterThan(0);
    }
  });
});
