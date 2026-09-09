// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateNewGameInput, type GameSetup, type GameTypeId, type NarrativeStyle } from "@/game/domain/newGame";
import type { OpeningNoveltyRecord } from "@/game/domain/openingNovelty";
import { createGame } from "../createGame";
import { buildChoiceMap } from "../buildChoiceMap";
import { generatePendingNarrativeBundle } from "../generatePendingNarrativeBundle";
import { performTurn } from "../performTurn";
import { commitState } from "../stateCommit";
import { createNarrativeBundleSourceFactory } from "../server/ai/sourceFactory";
import { compileDecisionNarrativeContext } from "../server/ai/narrativeContext";
import { createServerRpgAiClient } from "../server/ai/rpgAiClient";
import { createTextAuditRecorder } from "../server/ai/textAuditRecorder";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { asGameId, type GameRecord, type GameRepository } from "../server/persistence/gameRepository";

type LiveCase = Readonly<{
  group: number;
  gameType: GameTypeId;
  name: string;
  identity: string;
  style: NarrativeStyle;
  worldPremise: string;
  storyOpening: string;
}>;

const CASES: readonly LiveCase[] = [
  { group: 1, gameType: "wuxia", name: "沈砚", identity: "返乡郎中", style: "novel", worldPremise: "山城的诊所共同储备药材，街坊依赖行医者互相协助维持日常诊治。", storyOpening: "你回乡探亲时得知旧识为救治病人私自取药，旧识正在等你回应负责人对缺药的追问。" },
  { group: 2, gameType: "science_fiction", name: "陆宁", identity: "空间站维修员", style: "cinematic", worldPremise: "民用空间站依靠定期停机检修维持运转，各班组需要协商有限的维修时段。", storyOpening: "你接班时，同班技师要求延长停机检查，但货运安排即将受到影响，他请你回应这一请求。" },
  { group: 3, gameType: "urban", name: "周禾", identity: "社区店主", style: "concise", worldPremise: "老城区的商户共同使用装卸通道，邻里通过协商解决日常经营中的空间分配。", storyOpening: "相熟店主希望借用你店门前的空地接货，你的开门准备也因此受影响，对方正在等你答复。" },
  { group: 4, gameType: "fantasy", name: "黎安", identity: "学徒修复师", style: "novel", worldPremise: "城市依靠公共工坊维护照明器具，工匠按约定轮值，居民重视节庆前的修复工作。", storyOpening: "师傅请你回应一项临时加班安排，而你已计划回家照顾家人，他希望先听你的想法。" },
  { group: 5, gameType: "post_apocalypse", name: "许川", identity: "聚落炊事员", style: "concise", worldPremise: "灾后聚落统一分配饮水和食物，每个轮值岗位都要说明当天的资源使用情况。", storyOpening: "熟悉的值守员希望临时调整晚餐供水，你担心影响做饭，他当面询问你愿意如何安排。" },
  { group: 6, gameType: "alternate_history", name: "顾言", identity: "账房学徒", style: "cinematic", worldPremise: "河港作坊靠行会协调订单，账房记录工钱和交货时间，师徒共同承担记账责任。", storyOpening: "你的师兄要求先按旧账发放工钱，可你发现记录有一处不一致，他等你说明是否照办。" },
];

function setupOf(sample: LiveCase): GameSetup {
  const validation = validateNewGameInput({
    gameType: sample.gameType,
    gameLength: "short",
    characterName: sample.name,
    characterIdentity: sample.identity,
    personalityTags: ["冷静"],
    worldPremise: sample.worldPremise,
    storyOpening: sample.storyOpening,
    narrativeStyle: sample.style,
    contentIntensity: "normal",
  });
  if (!validation.ok) throw new Error(`invalid fixed setup for group ${sample.group}`);
  return {
    characterName: validation.value.characterName,
    characterIdentity: validation.value.characterIdentity,
    personalityTags: validation.value.personalityTags,
    worldPremise: validation.value.worldPremise,
    storyOpening: validation.value.storyOpening,
    narrativeStyle: validation.value.narrativeStyle,
    contentIntensity: validation.value.contentIntensity,
  };
}

function repositoryAt(dbPath: string) {
  return createSqliteGameRepository({ clientFactory: () => createSqliteClient(dbPath) });
}

function approvedSnapshot(record: GameRecord) {
  const narrative = record.storyState.narrative;
  return {
    gameId: String(record.gameId),
    revision: record.revision,
    generation: record.worldState.generation,
    prologue: record.storyState.prologueText,
    narrative,
    eventLedger: record.worldState.eventLedger,
  };
}

async function loadPrivateAiEnv(): Promise<Record<string, string | undefined>> {
  // Reuse the repository's environment parser; never duplicate dotenv parsing here.
  // @ts-expect-error scripts are intentionally plain ESM and do not publish declarations.
  const { readAiEnv } = await import("../../../../scripts/aiEnv.mjs");
  const values = readAiEnv(resolve(process.cwd(), ".env.local")) as Map<string, { decoded: string }>;
  return { ...process.env, ...Object.fromEntries([...values].map(([key, value]) => [key, value.decoded])) };
}

describe("opening quality live evaluation", () => {
  it.skipIf(process.env.RPG_OPENING_QUALITY_LIVE !== "1")(
    "captures the fixed 12 creations and six forked continuations through production AI",
    async () => {
      const env = await loadPrivateAiEnv();
      const runId = `opening-quality-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const runDir = resolve(process.cwd(), "logs", "opening-quality", runId);
      await mkdir(runDir, { recursive: true });
      const audit = createTextAuditRecorder(
        { ...env, AI_TEXT_AUDIT: "full", GAME_API_AUDIT: "off", AI_TEXT_AUDIT_RUN_ID: runId },
        { rootDir: resolve(runDir, "audit") },
      );
      const aiClient = createServerRpgAiClient(env, undefined, audit);
      const source = createNarrativeBundleSourceFactory(env, undefined, aiClient);
      const creations: unknown[] = [];
      const continuations: unknown[] = [];
      const approvedForFork = new Map<number, { seed: string; record: GameRecord }>();
      const failures: unknown[] = [];
      const persistProgress = async () => {
        await writeFile(resolve(runDir, "creations.json"), `${JSON.stringify(creations, null, 2)}\n`, "utf8");
        await writeFile(resolve(runDir, "continuations.json"), `${JSON.stringify(continuations, null, 2)}\n`, "utf8");
        await writeFile(resolve(runDir, "failures.json"), `${JSON.stringify(failures, null, 2)}\n`, "utf8");
        await writeFile(resolve(runDir, "run-summary.json"), `${JSON.stringify({ runId, creationCount: creations.length, continuationCount: continuations.length, failureCount: failures.length }, null, 2)}\n`, "utf8");
      };

      try {
        for (const sample of CASES) {
          let groupNovelty: readonly OpeningNoveltyRecord[] = [];
          for (const suffix of ["a", "b"] as const) {
            const seed = `opening-quality-${sample.group}-${suffix}`;
            const dbPath = resolve(runDir, `creation-${sample.group}-${suffix}.sqlite`);
            const repository = repositoryAt(dbPath);
            const originalList = repository.listOpeningHistory!.bind(repository);
            repository.listOpeningHistory = async (input) => {
              const own = await originalList(input);
              if (!own.ok || groupNovelty.length === 0) return own;
              return { ok: true, records: [...groupNovelty, ...own.records].slice(0, input.limit) };
            };
            try {
              const result = await createGame(
                { gameId: asGameId(`live-${sample.group}-${suffix}`), gameType: sample.gameType, gameLength: "short", seed, setup: setupOf(sample) },
                { repository, source, now: () => new Date().toISOString(), aiEnabled: true, auditLink: { traceId: `opening-${sample.group}-${suffix}` } },
              );
              if (!result.ok) {
                const failure = { kind: "creation", group: sample.group, seed, result };
                failures.push(failure);
                creations.push(failure);
                continue;
              }
              const loaded = await repository.getCurrentGame();
              if (!loaded.ok || loaded.status !== "active") throw new Error(`approved creation ${seed} did not reload`);
              const snapshot = { kind: "creation", group: sample.group, seed, setup: setupOf(sample), approved: approvedSnapshot(loaded.record) };
              creations.push(snapshot);
              if (sample.group <= 3 && !approvedForFork.has(sample.group)) approvedForFork.set(sample.group, { seed, record: structuredClone(loaded.record) });
              const history = await originalList({ gameType: sample.gameType, limit: 12 });
              if (history.ok) groupNovelty = history.records;
            } catch (error) {
              const failure = { kind: "creation", group: sample.group, seed, crashed: error instanceof Error ? error.name : "UnknownError" };
              failures.push(failure);
              creations.push(failure);
            } finally {
              await repository.close();
              await persistProgress();
            }
          }
        }

        for (const sample of CASES.slice(0, 3)) {
          const fork = approvedForFork.get(sample.group);
          if (fork === undefined) {
            for (let choiceIndex = 0; choiceIndex < 2; choiceIndex += 1) {
              const failure = { kind: "continuation", group: sample.group, choiceIndex, code: "APPROVED_OPENING_MISSING" };
              failures.push(failure);
              continuations.push(failure);
            }
            await persistProgress();
            continue;
          }
          const approved = fork.record;
          const choices = approved.storyState.narrative.status === "ready"
            ? approved.storyState.narrative.currentScene.choices
            : [];
          for (let choiceIndex = 0; choiceIndex < 2; choiceIndex += 1) {
            const repository = repositoryAt(resolve(runDir, `continuation-${sample.group}-${choiceIndex + 1}.sqlite`));
            try {
              const installed = await repository.createInitialGame({
                gameId: approved.gameId,
                worldState: structuredClone(approved.worldState),
                storyState: structuredClone(approved.storyState),
                createdAt: approved.createdAt,
              });
              if (!installed.ok) throw new Error("branch install failed");
              const ack = await commitState(repository, {
                gameId: approved.gameId,
                expectedRevision: approved.revision,
                nextWorldState: approved.worldState,
                nextStoryState: { ...approved.storyState, prologueShown: true },
                incrementRevision: false,
              });
              if (!ack.ok) throw new Error("prologue acknowledgement failed");
              const current = await repository.getCurrentGame();
              if (!current.ok || current.status !== "active") throw new Error("branch reload failed");
              const selected = choices[choiceIndex];
              if (selected === undefined) throw new Error("approved opening choice missing");
              const turn = await performTurn({
                gameId: current.record.gameId,
                actionId: `live-choice-${sample.group}-${choiceIndex + 1}`,
                expectedRevision: current.record.revision,
                interaction: { kind: "fixed_choice", choiceToken: selected.choiceToken },
                choiceMap: buildChoiceMap(current.record.worldState, current.record.storyState, current.record.revision),
              }, { repository, now: () => new Date().toISOString(), auditLink: { traceId: `continuation-${sample.group}-${choiceIndex + 1}` } });
              if (!turn.ok) throw new Error(`perform turn failed: ${turn.code}`);
              const pending = await repository.getCurrentGame();
              if (!pending.ok || pending.status !== "active" || pending.record.storyState.narrative.status !== "provider_pending") {
                throw new Error("pending narrative job missing after selected action");
              }
              const selectedAction = pending.record.storyState.narrative.job.selectedDialogue;
              const decisionContext = compileDecisionNarrativeContext({
                worldState: pending.record.worldState,
                storyState: pending.record.storyState,
                job: pending.record.storyState.narrative.job,
              });
              const generated = await generatePendingNarrativeBundle({
                repository,
                source,
                now: () => new Date().toISOString(),
                auditLink: { traceId: `continuation-${sample.group}-${choiceIndex + 1}`, retry: { origin: "normal", mechanism: "initial", attempt: 0 } },
              });
              const after = await repository.getCurrentGame();
              const entry = {
                kind: "continuation",
                group: sample.group,
                choiceIndex,
                forkSeed: fork.seed,
                forkGameId: String(approved.gameId),
                selectedChoice: selected,
                selectedAction,
                committedEvents: pending.record.worldState.eventLedger.slice(approved.worldState.eventLedger.length),
                decisionContext,
                generationResult: generated,
                approved: after.ok && after.status === "active" ? approvedSnapshot(after.record) : null,
              };
              continuations.push(entry);
              if (!generated.ok) failures.push(entry);
            } catch (error) {
              const failure = { kind: "continuation", group: sample.group, choiceIndex, crashed: error instanceof Error ? error.name : "UnknownError" };
              failures.push(failure);
              continuations.push(failure);
            } finally {
              await repository.close();
              await persistProgress();
            }
          }
        }
      } finally {
        await audit.close();
        await persistProgress();
      }

      expect(creations).toHaveLength(12);
      expect(continuations).toHaveLength(6);
      expect(creations.filter((entry) => typeof entry === "object" && entry !== null && "approved" in entry).length).toBeGreaterThanOrEqual(10);
      expect(continuations.filter((entry) => typeof entry === "object" && entry !== null && "generationResult" in entry && (entry as { generationResult?: { ok?: boolean } }).generationResult?.ok === true)).toHaveLength(6);
    },
    1_200_000,
  );
});
