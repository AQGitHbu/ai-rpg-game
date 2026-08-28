import type { AiMessage } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import { parseStructuredJsonObject } from "@/game/core/json";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { parseOpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type {
  NarrativeBundleSource,
  NarrativeBundleSourceContext,
  NarrativeBundleSourceResult,
  NarrativeBundleRepairReason,
} from "../../narrativeBundleSource";
import type { RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";
import type { OpeningNarrativeBundleProposal } from "../../narrativeBundleSource";

// ---------------------------------------------------------------------------
// Task 5：统一叙事生成包 live source。
// 一次 generate 调用 = 一次 aiClient.complete("narrative_bundle", ...) 调用。
// 只做 JSON 解析和提案校验，不做审批/铸造 ID/写状态。
// ---------------------------------------------------------------------------

export type LiveNarrativeBundleSourceDeps = {
  readonly aiClient?: RpgAiClient;
  readonly logger?: GameLogger;
  readonly jsonMode?: ProviderJsonMode;
};

function failBundle(
  category: Parameters<typeof classifyAiFailure>[0]["category"],
  repairReason?: NarrativeBundleRepairReason,
): Extract<NarrativeBundleSourceResult, { readonly ok: false }> {
  const failure: AiGenerationFailure = classifyAiFailure({ phase: "scene", category });
  return repairReason === undefined
    ? { ok: false, failure }
    : { ok: false, failure, repairReason };
}

function buildDecisionPrompt(
  worldState: WorldState,
  storyState: StoryState,
  job: PendingNarrativeJob,
): string {
  const descriptorGraph = buildNarrativeBundleDescriptors({
    worldState,
    storyState,
    transition: job.objectiveTransition,
  });
  const nextActProjection = storyState.evolution.status === "needs_next_act"
    ? {
        locationId: `loc_dyn_${storyState.evolution.nextLocationOrdinal}`,
        npcId: `npc_dyn_${storyState.evolution.nextNpcOrdinal}`,
      }
    : null;
  // A next-act delta is materialized after this response is received, but its
  // entity IDs are deterministically minted from the current evolution ledger.
  // Project that post-materialization first step here.  Otherwise the prompt
  // would demand the old graph while approval validates the new graph.
  const expectedChoices = nextActProjection !== null
    ? "当前场景不允许 choices；终点步骤的 choices 必须使用下方对应候选。"
    : descriptorGraph.currentChoiceCandidates.length === 0
      ? "当前场景不允许 choices；终点步骤的 choices 必须使用下方对应候选。"
      : descriptorGraph.currentChoiceCandidates.map((candidate) => candidate.candidateId).join("、");
  const expectedSteps = nextActProjection !== null
    ? `- move:${nextActProjection.locationId}；choices: move:${nextActProjection.locationId}_choice_1、move:${nextActProjection.locationId}_choice_2；到达 NPC: ${nextActProjection.npcId}`
    : descriptorGraph.steps.length === 0
      ? "无 continuation step。"
      : descriptorGraph.steps.map((step) => {
        const choices = step.choiceCandidates.map((candidate) => candidate.candidateId).join("、") || "无";
        return `- ${step.stepKey}；choices: ${choices}`;
      }).join("\n");
  const expectedTerminal = nextActProjection !== null
    ? { kind: "next_decision", target: { kind: "continuation_step", stepKey: `move:${nextActProjection.locationId}` } }
    : descriptorGraph.terminal;
  const questSummary = worldState.quests.length > 0
    ? worldState.quests.map((q) => `- ${q.name}（${q.status}）: ${q.description}`).join("\n")
    : "（无活跃任务）";

  const locationSummary = worldState.locations
    .map((l) => `- ${l.name}（${l.id}）: ${l.description}`)
    .join("\n");

  const npcSummary = worldState.npcs
    .map((n) => `- ${n.name}（${n.id}）: ${n.role}`)
    .join("\n");

  const playerSummary = `玩家：${worldState.player.name}（${worldState.player.identity}）`;

  const storySummary = `第 ${storyState.currentAct} 幕 / 共 ${storyState.targetActs} 幕`;

  const actionSummary = job.utterance !== undefined
    ? `玩家自定义输入：${job.utterance}`
    : `玩家行动：${job.actionSummary.kind}`;
  const evolutionRequirement = storyState.evolution.status === "needs_next_act"
    ? `本回合已进入第 ${storyState.currentAct} 幕：worldDelta 绝不能为 null，必须提供 newLocation、newNpc、newItem、newEnemy、nextMainQuest；其余字段可为 null。`
    : storyState.evolution.status === "needs_ending_pair"
      ? "本回合需要结局：worldDelta 绝不能为 null，且必须严格为 {\"beatSummary\":\"...\",\"newLocation\":null,\"newNpc\":null,\"newItem\":null,\"newEnemy\":null,\"newFact\":null,\"nextMainQuest\":null,\"endingPair\":[{\"themeKey\":\"trust\",\"name\":\"...\",\"description\":\"...\"},{\"themeKey\":\"doubt\",\"name\":\"...\",\"description\":\"...\"}] }。不能创建地点、NPC、物品、敌人、任务；terminal 必须严格为 {\"kind\":\"ending\"}，continuationScenes 必须为 []。"
      : "本回合不需要世界演化：worldDelta 必须为 null。";
  const genreRequirement = worldState.generation.gameType === "wuxia"
    ? "武侠写实约束：角色、冲突与叙述只能采用江湖、人事、武学、机关等武侠元素；禁止鬼魂、幽灵、灵魂、超自然、魔法、法术、咒语、法阵、圣光、精灵、异界等玄幻/西幻元素。"
    : "叙述必须严格贴合当前题材，不混入其他题材的设定。";

  return `你是武侠 RPG 的叙事 AI。你将在一次响应中生成完整的叙事生成包。

# 当前世界状态
${storySummary}
${playerSummary}

## 地点
${locationSummary}

## NPC
${npcSummary}

## 任务
${questSummary}

## 玩家本轮行动
${actionSummary}

## 世界演化要求
${evolutionRequirement}

# 输出要求

生成一个 JSON 对象，包含以下字段：
- worldDelta: 世界增量提案（可为 null）
- currentScene: 当前场景（segments 数组、npcLine、objectiveLink、choices）
- continuationScenes: 后续可消费场景数组
- terminal: 终点声明

## 规则

1. 符号引用白名单（只允许以下符号，不允许直接使用实体 ID 之外的引用）：
   - @current.location
   - @current.focus_npc
   - @new.location
   - @new.npc
   - @new.item
   - @new.enemy
   - @new.fact
   - @new.quest
   - @ending.trust
   - @ending.doubt

2. continuationScenes 最多 12 步。

3. terminal 有两种合法形式：
   - current_scene: 当前场景就是下一决策点（continuationScenes 必须为空）
   - continuation_step: 需要先消费线性步骤（continuationScenes 至少一步）

4. 终点必须有恰好两个选项（一个焦点 NPC 的两种正式回应）。

5. 战斗失败会恢复到战斗前检查点，因此不需要生成战斗失败/撤退的分支。

6. 所有文本必须是中文。

6.1. ${genreRequirement}

7. 这是服务端已经重建的唯一合法图，必须逐字使用其中的 stepKey 与 candidateId，
不得自创步骤或候选：
   - terminal: ${JSON.stringify(expectedTerminal)}
   - currentScene choices: ${expectedChoices}
   - continuationScenes:
${expectedSteps}

8. choices 每项必须为 {"candidateId":"服务器给出的候选 ID","label":"中文选项文本"}；
npcLine 必须为 {"npcId":"实体 ID","text":"中文对白","emotion":"neutral|warm|guarded|afraid|angry|sad","answeredBeatIds":[],"usedFactIds":[],"usedInteractionActionIds":[]}，不能是字符串。

9. 若上方要求 worldDelta，严格使用：
{"beatSummary":"...","newLocation":{"name":"...","description":"...","scale":"scene","placement":"world","connectFromLocationId":"现有地点 ID"},"newNpc":{"name":"...","role":"...","description":"...","locationRef":{"kind":"new_location"},"goals":["..."]},"newItem":{"name":"...","description":"...","locationRef":"new_location"},"newEnemy":{"name":"...","tier":"normal","locationRef":"new_location"},"newFact":null,"nextMainQuest":{"name":"...","description":"...","objectiveText":"..."},"endingPair":null}

10. 当 worldDelta 要求 nextMainQuest 时，currentScene 只收束旧场景且 choices 必须为空；必须生成唯一的 continuationScenes[0]，其 stepKey、两个 choices 的 candidateId 和 npcLine.npcId 必须完全等于第 7 条给出的下一幕投影。该 continuation scene 表现玩家抵达新地点并与新 NPC 相遇。

## JSON 格式

\`\`\`json
{
  "worldDelta": null,
  "currentScene": {
    "segments": [{ "beatId": "atmosphere", "text": "..." }],
    "npcLine": null,
    "objectiveLink": null,
    "choices": []
  },
  "continuationScenes": [],
  "terminal": { "kind": "next_decision", "target": { "kind": "current_scene" } }
}
\`\`\`
`;
}

function buildOpeningPrompt(context: Extract<NarrativeBundleSourceContext, { readonly kind: "opening" }>): string {
  const { input } = context;
  const setup = input.setup;
  const targetActs = input.gameLength === "medium" ? 5 : 3;
  return `你是 RPG 的叙事 AI。一次调用必须生成开局世界切片与第一处正式剧情二选一，不能要求后续生成调用。

# 开局输入
- 题材：${input.gameType}
- 长度：${input.gameLength}
- 玩家名：${setup?.characterName ?? "由你生成"}
- 玩家身份：${setup?.characterIdentity ?? "由你生成"}
- 世界前提：${setup?.worldPremise ?? "由你生成"}
- 故事开端：${setup?.storyOpening ?? "由你生成"}

# 输出要求
返回一个 JSON 对象，顶层必须只有 opening、currentScene、continuationScenes、terminal。
- opening 必须是下方字段名完全一致的 OpeningGenerationCandidate；不得使用 world.name、fact.id、player.background、storyContract.goal、opening.task 等替代字段。任何未列出的字段均不会被读取。
- currentScene 是第一处正式决策：npcLine.npcId 必须为 "npc_0"，npcLine.usedFactIds 只能引用 opening.world.publicFacts 的顺序 ID（fact_0、fact_1……）；含恰好两个 choices，candidateId 必须恰为 "support" 与 "challenge"。
- continuationScenes 必须为 []。
- terminal 必须为 {"kind":"next_decision","target":{"kind":"current_scene"}}。
- 所有玩家可见文本必须为中文。

# opening 的严格结构
- world.summary、world.tone 是字符串，world.themes 是字符串数组；world.publicFacts 每项必须是 {"key":"fact_xxx","text":"..."}。
- player 必须是 {"name":"...","identity":"...","backgroundSummary":"...","baseStats":{"hp":100,"attack":10,"defense":5}}。姓名与身份必须保留开局输入。
- storyContract 必须是 {"version":1,"targetActs":${targetActs},"centralConflict":"...","endingDirections":[{"key":"trust","theme":"..."},{"key":"doubt","theme":"..."}]}。
- opening.location 必须有 name、description、buildingName 和固定 scale:"town"。
- opening.npc 必须有 name、role、description、knownFactKeys、privateFactKeys、goals；两个 factKeys 数组只能引用 world.publicFacts 的 key。
- opening.quest 必须有 name、description 和固定 objective:{"kind":"talk_to_opening_npc"}。

# JSON 轮廓
\`\`\`json
{
  "opening": {
    "world": { "summary": "...", "tone": "...", "themes": ["..."], "publicFacts": [{ "key": "fact_0", "text": "..." }] },
    "player": { "name": "${setup?.characterName ?? "..."}", "identity": "${setup?.characterIdentity ?? "..."}", "backgroundSummary": "...", "baseStats": { "hp": 100, "attack": 10, "defense": 5 } },
    "prologue": "...",
    "storyContract": { "version": 1, "targetActs": ${targetActs}, "centralConflict": "...", "endingDirections": [{ "key": "trust", "theme": "..." }, { "key": "doubt", "theme": "..." }] },
    "opening": {
      "location": { "name": "...", "description": "...", "buildingName": "...", "scale": "town" },
      "npc": { "name": "...", "role": "...", "description": "...", "knownFactKeys": ["fact_0"], "privateFactKeys": [], "goals": ["..."] },
      "quest": { "name": "...", "description": "...", "objective": { "kind": "talk_to_opening_npc" } }
    }
  },
  "currentScene": {
    "segments": [{ "beatId": "opening", "text": "..." }],
    "npcLine": { "npcId": "npc_0", "text": "...", "emotion": "guarded", "answeredBeatIds": [], "usedFactIds": [], "usedInteractionActionIds": [] },
    "objectiveLink": null,
    "choices": [{ "candidateId": "support", "label": "..." }, { "candidateId": "challenge", "label": "..." }]
  },
  "continuationScenes": [],
  "terminal": { "kind": "next_decision", "target": { "kind": "current_scene" } }
}
\`\`\``;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: readonly unknown[]): string {
  return values.find((value): value is string => typeof value === "string") ?? "";
}

/**
 * Some compatible providers still emit the prior opening vocabulary despite
 * the current prompt. This is structural normalization only: it reuses text
 * already returned by the provider and never writes a rule-owned narrative.
 */
function normalizeOpeningCandidateShape(value: unknown, targetActs: 3 | 5): unknown {
  const raw = asRecord(value);
  const opening = asRecord(raw?.opening);
  const world = asRecord(opening?.world);
  const player = asRecord(opening?.player);
  const storyContract = asRecord(opening?.storyContract);
  const openingDetail = asRecord(opening?.opening);
  if (raw === null || opening === null || world === null || player === null || storyContract === null || openingDetail === null) {
    return value;
  }

  const facts = Array.isArray(world.publicFacts)
    ? world.publicFacts.map((fact) => {
      const entry = asRecord(fact);
      return entry === null ? fact : { ...entry, key: firstString(entry.key, entry.id) };
    })
    : world.publicFacts;
  const providerNpc = asRecord(openingDetail.npc)
    ?? (Array.isArray(openingDetail.startingNpcs) ? asRecord(openingDetail.startingNpcs[0]) : null);
  const location = asRecord(openingDetail.location);
  const locationName = firstString(location?.name, openingDetail.location);
  const locationDescription = firstString(location?.description, openingDetail.locationDescription);
  const quest = asRecord(openingDetail.quest);
  const legacyQuest = firstString(openingDetail.initialQuest, openingDetail.initialTask, openingDetail.task);
  const existingDirections = Array.isArray(storyContract.endingDirections) ? storyContract.endingDirections : null;

  return {
    ...raw,
    opening: {
      ...opening,
      world: {
        ...world,
        summary: firstString(world.summary, world.worldState, world.name),
        tone: firstString(world.tone, storyContract.tone, storyContract.narrativeFocus),
        themes: Array.isArray(world.themes) ? world.themes : [],
        publicFacts: facts,
      },
      player: {
        ...player,
        backgroundSummary: firstString(player.backgroundSummary, player.background),
        baseStats: asRecord(player.baseStats) ?? { hp: 100, attack: 10, defense: 5 },
      },
      storyContract: {
        ...storyContract,
        version: 1,
        targetActs,
        centralConflict: firstString(storyContract.centralConflict, storyContract.coreConflict, storyContract.corePremise, storyContract.goal),
        endingDirections: existingDirections ?? [
          { key: "trust", theme: firstString(storyContract.playerAgency, storyContract.tone) },
          { key: "doubt", theme: firstString(storyContract.tone, storyContract.stakes, storyContract.narrativeFocus) },
        ],
      },
      opening: {
        ...openingDetail,
        location: {
          ...(location ?? {}),
          name: locationName,
          description: locationDescription,
          buildingName: firstString(location?.buildingName, locationName),
          scale: "town",
        },
        npc: {
          ...(providerNpc ?? {}),
          name: firstString(providerNpc?.name),
          role: firstString(providerNpc?.role, providerNpc?.description),
          description: firstString(providerNpc?.description, providerNpc?.role),
          knownFactKeys: Array.isArray(providerNpc?.knownFactKeys) ? providerNpc.knownFactKeys : [],
          privateFactKeys: Array.isArray(providerNpc?.privateFactKeys) ? providerNpc.privateFactKeys : [],
          goals: Array.isArray(providerNpc?.goals) ? providerNpc.goals : [],
        },
        quest: {
          ...(quest ?? {}),
          name: firstString(quest?.name, legacyQuest),
          description: firstString(quest?.description, legacyQuest),
          objective: { kind: "talk_to_opening_npc" },
        },
      },
    },
  };
}

/** Normalize legacy presentation aliases without changing any AI-authored text. */
function normalizeDecisionBundleShape(
  value: unknown,
  worldState: WorldState,
  storyState: StoryState,
  job: PendingNarrativeJob,
): unknown {
  const raw = asRecord(value);
  const currentScene = asRecord(raw?.currentScene);
  if (raw === null || currentScene === null) return value;

  const graph = buildNarrativeBundleDescriptors({
    worldState,
    storyState,
    transition: job.objectiveTransition,
  });
  const nextActProjection = storyState.evolution.status === "needs_next_act"
    ? {
        stepKey: `move:loc_dyn_${storyState.evolution.nextLocationOrdinal}`,
        npcId: `npc_dyn_${storyState.evolution.nextNpcOrdinal}`,
      }
    : null;

  const normalizeChoices = (
    sourceChoices: unknown,
    candidates: readonly { readonly candidateId: string }[],
  ): unknown => (Array.isArray(sourceChoices) ? sourceChoices : []).map((choice, index) => {
    const entry = asRecord(choice);
    const candidate = candidates[index];
    return entry === null ? choice : {
      candidateId: candidate?.candidateId ?? entry.candidateId,
      label: firstString(entry.label, entry.text),
    };
  });
  const normalizeNpcLine = (source: unknown, fallbackNpcId: string): unknown => {
    const sourceNpcLine = asRecord(source);
    return sourceNpcLine ?? (typeof source === "string"
    ? {
        npcId: fallbackNpcId,
        text: source,
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedInteractionActionIds: [],
      }
    : source);
  };

  const normalizeObjectiveLink = (source: unknown): unknown => {
    const objectiveLink = asRecord(source);
    const objectiveIsValid = objectiveLink !== null
    && worldState.quests.some((quest) => String(quest.id) === objectiveLink.questId)
    && typeof objectiveLink.objectiveIndex === "number"
    && (objectiveLink.mode === "hint" || objectiveLink.mode === "progress");
    // Invalid legacy objective prose cannot carry server authority. Dropping
    // it preserves the generated scene while keeping objective state rule-owned.
    return objectiveIsValid ? objectiveLink : null;
  };

  const normalizeScene = (
    scene: Record<string, unknown>,
    candidates: readonly { readonly candidateId: string }[],
    fallbackNpcId: string,
  ): Record<string, unknown> => ({
    segments: scene.segments,
    npcLine: normalizeNpcLine(scene.npcLine, fallbackNpcId),
    ...(scene.npcDialogues === undefined ? {} : { npcDialogues: scene.npcDialogues }),
    objectiveLink: normalizeObjectiveLink(scene.objectiveLink),
    choices: normalizeChoices(scene.choices, candidates),
    ...(scene.handoffAcknowledgement === undefined ? {} : { handoffAcknowledgement: scene.handoffAcknowledgement }),
  });

  const continuationScenes = Array.isArray(raw.continuationScenes)
    ? raw.continuationScenes.map((step, index) => {
      const entry = asRecord(step);
      if (entry === null) return step;
      // Compatible providers commonly emit a scene directly in the array
      // instead of the contract's { stepKey, scene } wrapper.  This is only
      // a vocabulary/shape repair: all displayed text remains provider text.
      const scene = asRecord(entry.scene) ?? entry;
      const projectedCandidates = nextActProjection !== null && index === 0
        ? [
            { candidateId: `${nextActProjection.stepKey}_choice_1` },
            { candidateId: `${nextActProjection.stepKey}_choice_2` },
          ]
        : graph.steps[index]?.choiceCandidates ?? [];
      return {
        stepKey: nextActProjection !== null && index === 0
          ? nextActProjection.stepKey
          // Some providers emit direct scene objects and omit the wrapper's
          // stepKey entirely.  The position is not narrative authority: it
          // maps to the already server-projected, ordered descriptor graph.
          : firstString(entry.stepKey, graph.steps[index]?.stepKey),
        scene: normalizeScene(
          scene,
          projectedCandidates,
          nextActProjection?.npcId ?? String(job.focusNpcId ?? ""),
        ),
      };
    })
    : raw.continuationScenes;

  return {
    ...raw,
    currentScene: normalizeScene(
      currentScene,
      nextActProjection === null ? graph.currentChoiceCandidates : [],
      String(job.focusNpcId ?? ""),
    ),
    continuationScenes,
  };
}

type ParseOpeningBundleResult =
  | { readonly ok: true; readonly proposal: OpeningNarrativeBundleProposal }
  | { readonly ok: false; readonly reason: string };

function parseOpeningBundleProposal(value: unknown, targetActs: 3 | 5): ParseOpeningBundleResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "root_not_object" };
  const raw = normalizeOpeningCandidateShape(value, targetActs) as Record<string, unknown>;
  const opening = parseOpeningGenerationCandidate(raw.opening);
  if (!opening.ok) return { ok: false, reason: `opening_${opening.code}` };
  const narrative = parseNarrativeBundleProposal({
    worldDelta: null,
    currentScene: raw.currentScene,
    continuationScenes: raw.continuationScenes,
    terminal: raw.terminal,
  });
  if (!narrative.ok) return { ok: false, reason: `narrative_${narrative.code}` };
  if (
    narrative.proposal.terminal.kind !== "next_decision"
    || narrative.proposal.terminal.target.kind !== "current_scene"
    || narrative.proposal.continuationScenes.length !== 0
  ) return { ok: false, reason: "invalid_terminal" };
  return {
    ok: true,
    proposal: {
      opening: opening.value,
      currentScene: narrative.proposal.currentScene,
      continuationScenes: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    },
  };
}

export function createNarrativeBundleSource(
  deps: LiveNarrativeBundleSourceDeps = {},
): NarrativeBundleSource {
  const { logger, aiClient } = deps;

  return {
    async generate(context: NarrativeBundleSourceContext): Promise<NarrativeBundleSourceResult> {
      if (aiClient === undefined) {
        logger?.warn("narrative_bundle_source_unavailable");
        return failBundle("unavailable");
      }

      try {
        const prompt = context.kind === "decision"
          ? buildDecisionPrompt(context.worldState, context.storyState, context.job)
          : buildOpeningPrompt(context);

        const messages: readonly AiMessage[] = [
          { role: "system", content: prompt },
          { role: "user", content: context.kind === "decision" ? "生成决策叙事包" : "生成初始化叙事包" },
        ];

        const result = await aiClient.complete(
          "narrative_bundle",
          messages,
          {
            ...(context.auditLink ?? {}),
            purpose: "narrative_bundle_generation",
            trigger: context.kind === "decision"
              ? context.job.utterance === undefined ? "narrative_choice" : "npc_free_text"
              : "initialization",
            jobId: context.kind === "decision" ? String(context.job.jobId) : String(context.jobId),
            turnNumber: context.kind === "decision" ? context.job.turnNumber : 0,
            action: context.kind === "decision" ? context.job.actionSummary : undefined,
          },
        );

        if (!result.ok) {
          logger?.warn("narrative_bundle_ai_failed", { code: result.code });
          const category = transportFailureCodeToCategory(result.code);
          return result.code === "empty_response"
            ? failBundle(category, "invalid_json")
            : failBundle(category);
        }

        const parsed = parseStructuredJsonObject(result.content);
        if (parsed.ok && parsed.normalization === "json_fence") {
          logger?.warn("narrative_bundle_json_fence_normalized");
        }
        if (!parsed.ok) {
          logger?.warn("narrative_bundle_parse_failed", { reason: parsed.reason });
          return failBundle(
            parsed.reason === "root_not_object" ? "invalid_schema" : "invalid_json",
            parsed.reason === "root_not_object" ? "invalid_schema" : "invalid_json",
          );
        }

        if (context.kind === "decision") {
          const proposalResult = parseNarrativeBundleProposal(normalizeDecisionBundleShape(
            parsed.value,
            context.worldState,
            context.storyState,
            context.job,
          ));
          if (!proposalResult.ok) {
            logger?.warn("narrative_bundle_invalid_schema", { code: proposalResult.code });
            return failBundle("invalid_schema", "invalid_schema");
          }
          return { ok: true, kind: "decision", proposal: proposalResult.proposal };
        }
        const openingResult = parseOpeningBundleProposal(parsed.value, context.input.gameLength === "medium" ? 5 : 3);
        if (!openingResult.ok) {
          logger?.warn(`narrative_bundle_invalid_opening_schema_${openingResult.reason}`);
          return failBundle("invalid_schema", "invalid_schema");
        }
        return { ok: true, kind: "opening", proposal: openingResult.proposal };
      } catch (error) {
        logger?.error("narrative_bundle_source_error", {
          error: error instanceof Error ? error.message : "unknown",
        });
        return failBundle("unknown");
      }
    },
  };
}
