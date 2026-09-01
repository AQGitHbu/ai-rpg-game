import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { asGameId, type GameId, type GameRecord } from "@/game/application/server/persistence/gameRepository";
import { commitState } from "@/game/application/stateCommit";
import { createSqliteClient } from "@/game/application/server/persistence/sqliteClient";
import { createSqliteGameRepository, type SqliteGameRepository } from "@/game/application/server/persistence/sqliteGameRepository";
import { createGame } from "@/game/application/createGame";
import { createJourneyEvolutionSource, journeyNow } from "./foundationJourney.testutil";
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";
import type { EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { applyEntityMutations, knowledgeReferences } from "@/game/gameplay/rpg/entityWorld";
import { createEntityStore, entitiesOfKind, projectEntityStore, type NpcEntityRecord } from "@/game/domain/entity";
import type { NpcId } from "@/game/domain/worldEntity";
import type { PreparedContinuationState } from "@/game/domain/preparedContinuation";
import type { FactChange } from "@/game/domain/resolvedEvent";
import {
  knowledgeWritesFromFactChange,
  type NpcKnowledgeBroadcastRequest,
} from "@/game/gameplay/rpg/npcMemory";
import { propagateKnownFacts } from "@/game/gameplay/rpg/ruleEngine/propagateKnownFacts";

const RUN_ROOT = mkdtempSync(join(tmpdir(), "ai-rpg-npc-continuity-journey-"));
let journeyOrdinal = 0;

export type SqliteNpcJourney = {
  readonly gameId: GameId;
  readonly dbPath: string;
  readonly evolutionSource: WorldEvolutionSource;
  repo: SqliteGameRepository;
  readonly reloadCount: () => number;
  reload(): Promise<void>;
  record(): Promise<GameRecord>;
  close(): Promise<void>;
};

function openRepo(dbPath: string): SqliteGameRepository {
  return createSqliteGameRepository({
    clientFactory: () => createSqliteClient(dbPath),
    logError: () => {},
  });
}

export async function createSqliteNpcJourney(seed = "npc-continuity-seed"): Promise<SqliteNpcJourney> {
  journeyOrdinal += 1;
  const dbPath = join(RUN_ROOT, `journey-${journeyOrdinal}.sqlite`);
  const gameId = asGameId(`npc_continuity_${journeyOrdinal}`);
  let repo = openRepo(dbPath);
  await repo.initializeSchema();
  const created = await createGame(
    { gameId, gameType: "wuxia", gameLength: "medium", seed },
    {
      repository: repo,
      source: (await import("@/game/application/createGame")).createFixtureOpeningSource(),
      now: journeyNow,
      aiEnabled: false,
    },
  );
  if (!created.ok) throw new Error(`创建 NPC 连续性旅程失败：${created.code}`);

  const evolutionSource = createJourneyEvolutionSource({ relationshipSeedTargetNpcId: "npc_0" });
  let reloads = 0;
  return {
    gameId,
    dbPath,
    evolutionSource,
    get repo() { return repo; },
    reloadCount: () => reloads,
    async reload() {
      await repo.close();
      repo = openRepo(dbPath);
      await repo.initializeSchema();
      reloads += 1;
    },
    async record() {
      const current = await repo.getCurrentGame();
      if (!current.ok || current.status !== "active") throw new Error("NPC 连续性旅程存档不可用");
      return current.record;
    },
    async close() {
      await repo.close();
    },
  };
}

export function authoritativeNpcs(worldState: GameRecord["worldState"]): readonly NpcEntityRecord[] {
  return entitiesOfKind(worldState.entityStore, "npc");
}

export function npcComponentsSnapshot(worldState: GameRecord["worldState"]): readonly unknown[] {
  return authoritativeNpcs(worldState).map((npc) => ({
    id: npc.core.id,
    identity: npc.identity,
    position: npc.position,
    dynamicState: npc.dynamicState,
    knowledge: npc.knowledge,
    relationships: npc.relationships,
    history: npc.history,
  }));
}

export async function commitNpcMutations(
  journey: SqliteNpcJourney,
  mutations: readonly EntityMutation[],
): Promise<GameRecord> {
  const current = await journey.record();
  const applied = applyEntityMutations(current.worldState, mutations);
  if (!applied.ok) throw new Error(`NPC mutation failed: ${applied.code}`);
  const committed = await commitState(journey.repo, {
    gameId: journey.gameId,
    expectedRevision: current.revision,
    nextWorldState: applied.worldState,
    nextStoryState: current.storyState,
  });
  if (!committed.ok) throw new Error(`NPC mutation commit failed: ${committed.code}`);
  return committed.record;
}

/**
 * Test-only bridge for an explicit FactChange audience. The production
 * `propagateKnownFacts` facade intentionally defaults disclosure to public;
 * this journey also needs to prove a secret disclosure, so the bridge reuses
 * the production audience mapper and only applies its returned writes through
 * the existing entity mutation boundary before committing SQLite.
 */
export async function commitNpcFactChangeForTest(
  journey: SqliteNpcJourney,
  change: FactChange,
  request: NpcKnowledgeBroadcastRequest,
): Promise<GameRecord> {
  const current = await journey.record();
  const nextWorldState = request.disclosure === undefined && request.certainty === undefined
    ? propagateKnownFacts(current.worldState, [change], request)
    : (() => {
        const mapped = knowledgeWritesFromFactChange(
          change,
          request,
          knowledgeReferences(current.worldState.entityStore.records),
        );
        if (!mapped.ok) throw new Error(`FactChange knowledge mapping failed: ${mapped.code}`);
        const applied = applyEntityMutations(current.worldState, mapped.writes.map((write) => ({
          kind: "record_npc_knowledge" as const,
          npcId: write.npcId,
          factId: write.factId,
          certainty: write.certainty,
          disclosure: write.disclosure,
          source: write.source,
        })));
        if (!applied.ok) throw new Error(`FactChange knowledge mutation failed: ${applied.code}`);
        return applied.worldState;
      })();
  const committed = await commitState(journey.repo, {
    gameId: journey.gameId,
    expectedRevision: current.revision,
    nextWorldState,
    nextStoryState: current.storyState,
  });
  if (!committed.ok) throw new Error(`FactChange knowledge commit failed: ${committed.code}`);
  return committed.record;
}

export async function patchNpcForTest(
  journey: SqliteNpcJourney,
  npcId: NpcId,
  patch: Partial<Pick<NpcEntityRecord, "dynamicState" | "knowledge" | "relationships" | "history">>,
): Promise<GameRecord> {
  const current = await journey.record();
  const npc = authoritativeNpcs(current.worldState).find((entry) => entry.core.id === npcId);
  if (npc === undefined) throw new Error(`NPC not found: ${String(npcId)}`);
  const entityStore = createEntityStore(current.worldState.entityStore.records.map((entry) =>
    entry.core.id === npcId ? { ...npc, ...patch } : entry,
  ));
  const nextWorldState = { ...current.worldState, entityStore, ...projectEntityStore(entityStore) };
  const committed = await commitState(journey.repo, {
    gameId: journey.gameId,
    expectedRevision: current.revision,
    nextWorldState,
    nextStoryState: current.storyState,
  });
  if (!committed.ok) throw new Error(`NPC patch commit failed: ${committed.code}`);
  return committed.record;
}

export async function installPreparedContinuationForTest(
  journey: SqliteNpcJourney,
  preparedContinuation: PreparedContinuationState,
): Promise<GameRecord> {
  const current = await journey.record();
  if (current.storyState.narrative.status !== "ready") throw new Error("prepared continuation needs ready narrative");
  const committed = await commitState(journey.repo, {
    gameId: journey.gameId,
    expectedRevision: current.revision,
    nextWorldState: current.worldState,
    nextStoryState: {
      ...current.storyState,
      narrative: { ...current.storyState.narrative, preparedContinuation },
    },
  });
  if (!committed.ok) throw new Error(`prepared continuation install failed: ${committed.code}`);
  return committed.record;
}
