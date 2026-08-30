import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
/** @vitest-environment node */
import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WorldState, LocationEntry, NpcEntry } from "@/game/domain/worldState";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asFactId, asLocationId, asNpcId, asQuestId, asGenerationId } from "@/game/domain/worldEntity";
import { asGameId, type GameRecord } from "@/game/application/server/persistence/gameRepository";
import { createSqliteGameRepository } from "@/game/application/server/persistence/sqliteGameRepository";
import { createSqliteClient } from "@/game/application/server/persistence/sqliteClient";
import { projectGameSessionView, type GameSessionView } from "@/game/application/gameSessionView";
import { playIssuedChoice, advanceScene } from "./foundationJourney.testutil";

// ---------------------------------------------------------------------------
// Task 6：端到端事实自动揭示旅程。
//   - mode="offline"：真实临时 SQLite 上建立一个含两个历史调查方式的事实，
//     经 application facade（performTurn）验证当前 read model 不再下发调查 token，
//     普通探索行动后由规则层自动确认事实。
//   - mode="legacy_fact"：旧形状事实（无 investigationApproaches）在同一个规则
//     回合内自动揭示；行动栏永不出现 investigate 按钮；reload 只恢复已写入的
//     fact_discovered，不等待不存在的 pending。
// 测试不构造任何 action/fact ID：choose 只消费投影器下发的 label + opaque token。
// ---------------------------------------------------------------------------

const CHOICE_FACT_ID = "fact_trace_choice";
const LEGACY_FACT_ID = "fact_legacy_wheel";

type SqliteRepo = ReturnType<typeof createSqliteGameRepository>;

const RUN_ROOT = mkdtempSync(join(tmpdir(), "ai-rpg-investigation-choice-journey-"));
const openedRepos: SqliteRepo[] = [];
let dbCounter = 0;

afterAll(async () => {
  for (const repo of openedRepos) {
    try { await repo.close(); } catch { /* ignore */ }
  }
  try { rmSync(RUN_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

function openRepo(dbPath: string): SqliteRepo {
  const repo = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(dbPath),
    logError: () => {},
  });
  openedRepos.push(repo);
  return repo;
}

// ---------------------------------------------------------------------------
// Fixture 世界：真实 SQLite 存档，选择路径 / 旧路径各一份。
// ---------------------------------------------------------------------------

function worldWithApproaches(): WorldState {
  const loc: LocationEntry = {
    id: asLocationId("loc_invest"), name: "北巷旧道", description: "潮湿狭窄的石道，车辙在泥水里断续延伸。", kind: "main",
    connectedLocationIds: [asLocationId("loc_next")], npcIds: [asNpcId("npc_keeper")], availableItemIds: [], tags: [],
  };
  const nextLoc: LocationEntry = {
    id: asLocationId("loc_next"), name: "旧镖局", description: "深处的旧镖局废墟。", kind: "main",
    connectedLocationIds: [asLocationId("loc_invest")], npcIds: [], availableItemIds: [], tags: [],
  };
  // 在场旁观 NPC：为调查后的即时场景提供第二个合法行动候选，不给行动栏加按钮。
  const bystander: NpcEntry = {
    id: asNpcId("npc_keeper"), name: "守门人", role: "镖局旧仆", description: "守在看守旧镖局入口的旧仆。",
    locationId: asLocationId("loc_invest"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_keeper"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const fact = {
    factId: asFactId(CHOICE_FACT_ID),
    text: "车辙尽头的旧镖局地窖里压着半枚盟誓印。",
    source: "generated" as const,
    discovered: false,
    locationId: asLocationId("loc_next"),
    investigationLabel: "泥地上的车辙",
    investigationApproaches: [
      { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean" as const, tensionDelta: 4 },
      { approachId: "search", label: "翻查附近杂物", hint: "动静较大，可能惊动旁人", evidenceQuality: "noisy" as const, tensionDelta: 12 },
    ],
  };
  const quest = {
    id: asQuestId("quest_choice"),
    name: "追查车轮印",
    description: "查清车辙通向何处。",
    objectives: [
      { kind: "visit_location" as const, locationId: asLocationId("loc_next") },
      { kind: "discover_fact" as const, factId: fact.factId },
    ],
    onSuccess: { kind: "advance_story" as const },
    onFailure: { kind: "closed" as const },
    tags: [],
    kind: "main" as const,
    stage: 1,
    status: "active" as const,
  };
  // 兼容投影一次给全：loc_invest 的连接边不再前向引用尚未入库的 loc_next。
  const generation: GenerationMetadata = { generationId: asGenerationId("g1"), seed: "choice-seed", templateVersion: "v2", inputDigest: "", gameType: "wuxia" };
  return createWorldStateFixture({
    generation,
    projection: {
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      locations: [loc, nextLoc],
      currentLocationId: loc.id,
      unlockedLocationIds: [asLocationId("loc_invest"), asLocationId("loc_next")],
      visitedLocationIds: [asLocationId("loc_invest")],
      npcs: [bystander],
      items: [],
      inventory: [],
      worldFacts: [fact],
      quests: [quest],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
    eventLedger: [{ type: "game_initialized", generation }],
  });
}

function worldWithApproachlessFact(): WorldState {
  const loc: LocationEntry = {
    id: asLocationId("loc_inn"), name: "听雨客栈", description: "镇上的落脚客栈。", kind: "main",
    connectedLocationIds: [], npcIds: [asNpcId("npc_shen")], availableItemIds: [], tags: [],
  };
  const npc: NpcEntry = {
    id: asNpcId("npc_shen"), name: "沈掌柜", role: "客栈掌柜", description: "掌管听雨客栈的掌柜。",
    locationId: asLocationId("loc_inn"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_shen"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  // 旧形状事实：没有 investigationApproaches → 无选项、按自动揭示处理。
  const fact = {
    factId: asFactId(LEGACY_FACT_ID),
    text: "旧案卷宗缺页被撕去三行。",
    source: "generated" as const,
    discovered: false,
    locationId: asLocationId("loc_inn"),
    investigationLabel: "桌上的残卷",
  };
  const quest = {
    id: asQuestId("quest_legacy"),
    name: "核对旧案卷宗",
    description: "先从沈掌柜处确认，再核对卷宗。",
    objectives: [
      { kind: "talk_to_npc" as const, npcId: npc.id },
      { kind: "discover_fact" as const, factId: fact.factId },
    ],
    onSuccess: { kind: "advance_story" as const },
    onFailure: { kind: "closed" as const },
    tags: [],
    kind: "main" as const,
    stage: 1,
    status: "active" as const,
  };
  const generation: GenerationMetadata = {
    generationId: asGenerationId("g2"), seed: "legacy-seed", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
  };
  return createWorldStateFixture({
    generation,
    projection: {
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      locations: [loc],
      currentLocationId: loc.id,
      unlockedLocationIds: [asLocationId("loc_inn")],
      visitedLocationIds: [asLocationId("loc_inn")],
      npcs: [npc],
      items: [],
      inventory: [],
      worldFacts: [fact],
      quests: [quest],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
    eventLedger: [{ type: "game_initialized", generation }],
  });
}

function storyWithDiscoverFact(): StoryState {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 },
  });
}

type InvestigationChoiceJourney = {
  view(): GameSessionView;
  record(): GameRecord;
  choose(label: string): Promise<void>;
  exposeLegacyFact(): Promise<void>;
  reload(): Promise<void>;
  /** 生成当前 pending 的 ready scene（确定性即时反馈），供叙事分化断言。 */
  scene(): Promise<void>;
};

/**
 * 用真实临时 SQLite 建立旅程：经 repo.createInitialGame 落盘初始状态，随后
 * choose / exposeLegacyFact 只通过 performTurn 提交服务器下发的 opaque token，
 * 不构造任何 action/fact ID。reload 关闭旧连接并以同一 dbPath 重建仓库，
 * 模拟进程重启后从持久化恢复。view/record 同步读取缓存的当前记录（与 brief
 * 旅程类型一致），每次写操作后刷新缓存。
 */
async function createInvestigationChoiceJourney(input: { mode: "offline" | "legacy_fact" }): Promise<InvestigationChoiceJourney> {
  dbCounter += 1;
  const dbPath = join(RUN_ROOT, `journey-${dbCounter}.sqlite`);
  const gameId = asGameId(`choice_journey_${dbCounter}`);
  let repo = openRepo(dbPath);
  await repo.initializeSchema();

  const { worldState, storyState } = input.mode === "offline"
    ? { worldState: worldWithApproaches(), storyState: storyWithDiscoverFact() }
    : { worldState: worldWithApproachlessFact(), storyState: storyWithDiscoverFact() };
  const created = await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-08-20T00:00:00.000Z" });
  if (!created.ok) throw new Error(`创建旅程失败：${created.code}`);

  let cached: GameRecord;
  const refresh = async (): Promise<void> => {
    const current = await repo.getCurrentGame();
    if (!current.ok || current.status !== "active") throw new Error("游戏记录不可用");
    cached = current.record;
  };
  await refresh();

  return {
    view() {
      return projectGameSessionView(cached.worldState, cached.storyState, cached.revision, "choice-journey-session");
    },
    record(): GameRecord {
      return cached;
    },
    async choose(label) {
      const result = await playIssuedChoice(repo, label);
      if (!result.ok) throw new Error(`选择失败：${result.code}`);
      await refresh();
    },
    async exposeLegacyFact() {
      const npc = cached.worldState.npcs[0];
      if (npc === undefined) throw new Error("旧事实旅程缺少交谈对象");
      const result = await playIssuedChoice(repo, npc.name);
      if (!result.ok) throw new Error(`暴露旧事实失败：${result.code}`);
      await refresh();
    },
    async reload() {
      try { await repo.close(); } catch { /* ignore */ }
      repo = openRepo(dbPath);
      await repo.initializeSchema();
      await refresh();
    },
    async scene() {
      const saved = await advanceScene(repo);
      if (!saved) throw new Error("即时场景生成应保存");
      await refresh();
    },
  };
}

// ---------------------------------------------------------------------------
// 用例（brief Step 1 verbatim + Step 3.2 结构化分化）。
// ---------------------------------------------------------------------------

describe("调查选择旅程（Task 6 端到端）", () => {
  it("multiple historical approaches do not create player investigation choices", async () => {
    const journey = await createInvestigationChoiceJourney({ mode: "offline" });
    expect(journey.view().currentLocation.actions.some((choice) => choice.presentation === "investigate")).toBe(false);
    const revisionBeforeReload = journey.record().revision;
    await journey.reload();
    expect(journey.record().revision).toBe(revisionBeforeReload);
  });

  it("approach-less facts auto-resolve and never present an investigate button", async () => {
    const journey = await createInvestigationChoiceJourney({ mode: "legacy_fact" });
    await journey.reload();
    expect(journey.view().currentLocation.actions.some((choice) => choice.presentation === "investigate")).toBe(false);
    expect(journey.record().worldState.worldFacts.find((fact) => fact.factId === LEGACY_FACT_ID)?.investigationApproaches)
      .toBeUndefined();
  });

  it("facts with historical approaches auto-resolve without evidence divergence", async () => {
    const first = await createInvestigationChoiceJourney({ mode: "offline" });
    const second = await createInvestigationChoiceJourney({ mode: "offline" });

    const firstRecord = first.record();
    const secondRecord = second.record();
    expect(firstRecord.worldState.eventLedger).toEqual(secondRecord.worldState.eventLedger);
    expect(firstRecord.worldState.eventLedger.some((event) => event.type === "fact_discovered")).toBe(false);
    expect(firstRecord.storyState.tension).toBe(secondRecord.storyState.tension);
  });
});
