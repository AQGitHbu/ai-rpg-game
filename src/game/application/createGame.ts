import type { GameRepository } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId, GameLength, GameSetup, NewGameInput } from "@/game/domain/newGame";
import { validateNewGameInput } from "@/game/domain/newGame";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { parseWorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { validateWorldGenerationCandidate } from "@/game/gameplay/rpg/worldGeneration";
import { compileWorldGenerationCandidate } from "@/game/gameplay/rpg/worldGeneration";
import { asGenerationId } from "@/game/domain/scenarioBlueprint";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { TARGET_ACTS } from "@/game/domain/storyBudget";

// ---------------------------------------------------------------------------
// Task 14 Step 2：世界生成编排改为 source → parse → validate → compile。
// WorldGenerationSource.generate 返回 WorldGenerationCandidate（原始字符串 ID）。
// createGame 内：schema parse → gameplay validate → compile 为单一 World/Story
// State，任何失败返回明确错误码，绝不用 `as never` 透传。
// ---------------------------------------------------------------------------

export type WorldGenerationSource = {
  generate(input: {
    gameType: GameTypeId;
    seed: string;
    gameLength: GameLength;
    /** 玩家开局配置：生成源必须消费（角色/世界观/故事开端），不得丢弃。 */
    setup?: GameSetup;
  }): Promise<WorldGenerationCandidate>;
};

export type CreateGameInput = {
  readonly gameId: GameId;
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
  readonly seed: string;
  readonly setup?: GameSetup;
  readonly replaceCurrent?: {
    readonly expectedGameId: GameId;
    readonly expectedRevision: number;
  };
};

export type CreateGameResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" | "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "GAME_NOT_ENDED" | "GENERATION_FAILED" | "INFRASTRUCTURE_FAILURE" };

// ---------------------------------------------------------------------------
// 开局配置解析：路由层不得直连 domain，统一经 application 层调用
// validateNewGameInput；提交任一配置字段时必须整体通过校验。
// ---------------------------------------------------------------------------

export type ParseGameSetupInput = {
  readonly gameType: string;
  readonly gameLength: string;
  readonly characterName?: unknown;
  readonly characterIdentity?: unknown;
  readonly characterProfile?: unknown;
  readonly personalityTags?: unknown;
  readonly worldPremise?: unknown;
  readonly storyOpening?: unknown;
  readonly narrativeStyle?: unknown;
  readonly contentIntensity?: unknown;
};

export type ParseGameSetupResult =
  | { readonly ok: true; readonly setup: GameSetup }
  | { readonly ok: false; readonly errors: readonly { readonly field: string; readonly code: string }[] };

const SETUP_FIELD_KEYS = [
  "characterName", "characterIdentity", "characterProfile", "personalityTags",
  "worldPremise", "storyOpening", "narrativeStyle", "contentIntensity",
] as const;

/** 无任一配置字段时返回 null；有则整体校验，产出 GameSetup 或字段错误列表。 */
export function parseGameSetup(raw: ParseGameSetupInput): ParseGameSetupResult | null {
  if (!SETUP_FIELD_KEYS.some((key) => raw[key] !== undefined)) return null;
  const stringOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");
  const input: NewGameInput = {
    gameType: raw.gameType as NewGameInput["gameType"],
    characterName: stringOrEmpty(raw.characterName),
    characterIdentity: stringOrEmpty(raw.characterIdentity),
    ...(typeof raw.characterProfile === "string" ? { characterProfile: raw.characterProfile } : {}),
    personalityTags: Array.isArray(raw.personalityTags) && raw.personalityTags.every((entry) => typeof entry === "string")
      ? (raw.personalityTags as string[])
      : [],
    worldPremise: stringOrEmpty(raw.worldPremise),
    storyOpening: stringOrEmpty(raw.storyOpening),
    narrativeStyle: (typeof raw.narrativeStyle === "string" ? raw.narrativeStyle : "concise") as NewGameInput["narrativeStyle"],
    contentIntensity: (typeof raw.contentIntensity === "string" ? raw.contentIntensity : "normal") as NewGameInput["contentIntensity"],
    gameLength: raw.gameLength as GameLength,
  };
  const validation = validateNewGameInput(input);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors.map((error) => ({ field: error.field, code: error.code })) };
  }
  const value = validation.value;
  return {
    ok: true,
    setup: {
      characterName: value.characterName,
      characterIdentity: value.characterIdentity,
      ...(value.characterProfile === undefined ? {} : { characterProfile: value.characterProfile }),
      personalityTags: value.personalityTags,
      worldPremise: value.worldPremise,
      storyOpening: value.storyOpening,
      narrativeStyle: value.narrativeStyle,
      contentIntensity: value.contentIntensity,
    },
  };
}

export type CreateGameDeps = {
  readonly repository: GameRepository;
  readonly source: WorldGenerationSource;
  readonly now: () => string;
  /** Whether AI config is available (determines narrative.mode) */
  readonly aiEnabled?: boolean;
};

export async function createGame(
  input: CreateGameInput,
  deps: CreateGameDeps,
): Promise<CreateGameResult> {
  if (input.replaceCurrent !== undefined) {
    const current = await deps.repository.getCurrentGame();
    if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    if (current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
    if (
      current.record.gameId !== input.replaceCurrent.expectedGameId
      || current.record.revision !== input.replaceCurrent.expectedRevision
    ) {
      return { ok: false, code: "STALE_GAME_REVISION" };
    }
    if (current.record.worldState.ending === null) {
      return { ok: false, code: "GAME_NOT_ENDED" };
    }
  }

  const generated = await deps.source.generate({
    gameType: input.gameType,
    seed: input.seed,
    gameLength: input.gameLength,
    ...(input.setup === undefined ? {} : { setup: input.setup }),
  });
  if (!generated) return { ok: false, code: "GENERATION_FAILED" };

  // Step 2.2：schema parse → validate → compile。
  const parsed = parseWorldGenerationCandidate(generated);
  if (!parsed.ok) return { ok: false, code: "GENERATION_FAILED" };

  const validated = validateWorldGenerationCandidate(parsed.value, {
    gameLength: input.gameLength,
    targetActs: TARGET_ACTS[input.gameLength],
  });
  if (!validated.ok) return { ok: false, code: "GENERATION_FAILED" };

  const generation = {
    generationId: asGenerationId(`gen_${input.seed}`),
    seed: input.seed,
    templateVersion: "v2" as const,
    inputDigest: "",
    gameType: input.gameType,
    ...(input.setup === undefined ? {} : { setup: input.setup }),
  };

  const { worldState, storyState } = compileWorldGenerationCandidate({
    candidate: validated.validated,
    generation,
    gameType: input.gameType,
    gameLength: input.gameLength,
  });

  // Set narrative to pending so the first scene (prologue) gets generated
  // by the ensure polling mechanism (spec §9.1: 生成序幕场景).
  // pending 唯一载体是带 job 的 PendingNarrativeJob（Spec §10.3），
  // 不再使用无 job 的 requestedAt legacy 形式。
  const narrativeMode = deps.aiEnabled ? "ai" : "offline";
  const jobResult = createPendingNarrativeJob({
    jobId: asNarrativeJobId(`job_${input.seed}_0`),
    turnId: asTurnId(`turn_${input.seed}_0`),
    actionId: `start_${input.seed}`,
    expectedRevision: 0,
    turnNumber: 0,
    actionSummary: { kind: "explore" },
    resolvedEvent: {
      actionId: `start_${input.seed}`,
      status: "success",
      eventKind: "observe",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    requestedAt: deps.now(),
  });
  if (!jobResult.ok) return { ok: false, code: "GENERATION_FAILED" };

  const storyStateWithPending: StoryState = {
    ...storyState,
    narrative: {
      ...storyState.narrative,
      mode: narrativeMode,
      generation: { status: "pending", job: jobResult.job },
    },
  };

  const persistedInput = {
    gameId: input.gameId,
    worldState,
    storyState: storyStateWithPending,
    createdAt: deps.now(),
  };
  const createResult = input.replaceCurrent === undefined
    ? await deps.repository.createInitialGame(persistedInput)
    : await deps.repository.replaceCurrentGame({
        ...persistedInput,
        expectedCurrentGameId: input.replaceCurrent.expectedGameId,
        expectedRevision: input.replaceCurrent.expectedRevision,
      });

  if (!createResult.ok) return createResult;
  return { ok: true, revision: 0 };
}

export function createFixtureWorldSource(): WorldGenerationSource {
  return {
    async generate(input) {
      const profiles = {
        wuxia: {
          genre: "武侠", tone: "江湖沧桑", identity: "流浪剑客", start: "听雨客栈",
          contacts: ["沈掌柜", "顾账房", "陆驿丞", "叶药师"],
          routes: ["青石古道", "芦苇渡口", "断桥驿道", "药王山径"],
          guards: ["伏虎关", "鸣沙哨", "铁索隘", "落雁口"],
          archives: ["旧盟书库", "漕帮密仓", "驿路档房", "药王石室"],
          lairs: ["黑风寨", "沉钟水寨", "赤焰山庄", "寒鸦别院"],
          clues: ["残月密函", "潮痕账册", "焦边路引", "药香手札"],
          relics: ["盟誓印谱", "私盐航图", "劫镖名录", "禁药方笺"],
          bosses: ["黑风寨主", "沉钟舵主", "赤焰庄主", "寒鸦院主"],
        },
        xianxia: {
          genre: "仙侠", tone: "缥缈玄奇", identity: "寻道散修", start: "望仙驿",
          contacts: ["闻鹤道人", "素月丹师", "青檀执事", "玄砂客"],
          routes: ["流云栈道", "星落古径", "悬灯天桥", "归墟石阶"],
          guards: ["镇妖台", "问心关", "锁灵阵", "渡劫坪"],
          archives: ["太虚藏经阁", "月华丹库", "青帝碑林", "归墟秘殿"],
          lairs: ["噬月魔窟", "烬仙遗宫", "无相天牢", "血莲洞天"],
          clues: ["裂纹玉简", "逆火丹书", "青帝残碑", "归墟星盘"],
          relics: ["镇魔真诀", "九转炉谱", "万木灵契", "星河阵图"],
          bosses: ["噬月魔君", "烬仙尊者", "无相妖王", "血莲圣使"],
        },
        fantasy: {
          genre: "奇幻", tone: "史诗幽邃", identity: "边境佣兵", start: "星火旅店",
          contacts: ["艾琳店主", "矮人账官", "白塔信使", "鹿角药师"],
          routes: ["银松大道", "雾沼木桥", "狮鹫山径", "荆棘古路"],
          guards: ["石像鬼门", "暮钟关", "巨人隘", "蔷薇堡垒"],
          archives: ["王家秘库", "沉没档案馆", "白塔书室", "古树记忆庭"],
          lairs: ["黑龙巢穴", "深潮王庭", "灰烬要塞", "猩红高塔"],
          clues: ["断翼纹章", "潮汐契据", "烧焦谕令", "荆棘王冠"],
          relics: ["龙语盟约", "海王航志", "王室族谱", "精灵誓书"],
          bosses: ["黑翼领主", "深潮公爵", "灰烬骑士", "猩红女巫"],
        },
        science_fiction: {
          genre: "科幻", tone: "冷峻未知", identity: "自由领航员", start: "远港中继站",
          contacts: ["林站长", "奎因技师", "赫兹领航员", "伊芙研究员"],
          routes: ["蓝移航道", "碎星走廊", "静默轨道", "日冕捷径"],
          guards: ["哨戒阵列", "引力闸门", "量子封锁线", "无人机蜂巢"],
          archives: ["零点数据库", "失落黑匣库", "观测者档案舱", "冷冻记忆室"],
          lairs: ["熵增母舰", "深空采掘城", "奇点实验站", "红矮星堡垒"],
          clues: ["损坏黑匣", "加密矿权证", "折叠坐标", "日冕观测谱"],
          relics: ["跃迁密钥", "自治协议", "先驱者星图", "聚变控制核"],
          bosses: ["熵核指挥官", "采掘城总督", "奇点主脑", "红星执政官"],
        },
        urban: {
          genre: "都市", tone: "现实悬疑", identity: "独立调查员", start: "夜班便利店",
          contacts: ["周店长", "许记者", "陈调度", "苏医生"],
          routes: ["临江旧街", "地铁末班线", "高架辅路", "城南医院道"],
          guards: ["封锁工地", "废弃站台", "物流闸口", "隔离病区"],
          archives: ["市政档案室", "报社资料库", "交通数据中心", "医院病案库"],
          lairs: ["湾区烂尾楼", "地下控制室", "城郊物流园", "私立研究院"],
          clues: ["匿名录音", "删改采访稿", "异常调度单", "缺页病历"],
          relics: ["产权转移清单", "加密采访带", "车辆轨迹盘", "临床试验名册"],
          bosses: ["幕后董事", "黑网管理员", "物流园主", "研究院院长"],
        },
        alternate_history: {
          genre: "历史架空", tone: "庙堂暗涌", identity: "边郡游侠", start: "长安驿馆",
          contacts: ["裴驿丞", "崔司书", "霍校尉", "谢医官"],
          routes: ["河西官道", "漕渠古渡", "北岭驿路", "盐铁栈道"],
          guards: ["玉门别塞", "巡漕关", "玄甲营门", "盐铁司卡"],
          archives: ["鸿胪寺档阁", "漕运总册库", "兵部舆图房", "太医秘录院"],
          lairs: ["朔方王帐", "东厂水牢", "玄甲行宫", "盐铁私府"],
          clues: ["伪造节钺", "漕银底账", "调兵虎符", "御药密录"],
          relics: ["盟国国书", "河运密图", "边军花名册", "宫禁药案"],
          bosses: ["朔方摄政王", "缇骑提督", "玄甲大将军", "盐铁使"],
        },
        post_apocalypse: {
          genre: "末日", tone: "荒凉坚韧", identity: "废土行者", start: "灰烬营地",
          contacts: ["罗塔守望者", "米娅修理师", "老秦向导", "岚医生"],
          routes: ["辐尘公路", "干涸河床", "倾覆铁路线", "菌林边界"],
          guards: ["掠夺者哨塔", "污染检查站", "装甲路障", "孢子隔离墙"],
          archives: ["避难所主控室", "气象观测库", "旧世列车档案", "生态种子库"],
          lairs: ["熔炉要塞", "沉没避难所", "钢铁列车城", "菌群母巢"],
          clues: ["褪色通行证", "气象记录芯片", "军列货单", "污染样本盒"],
          relics: ["净水核心图", "避难所日志", "聚变机车钥匙", "免疫种子谱"],
          bosses: ["熔炉霸主", "避难所监理", "铁轨军阀", "菌巢意识"],
        },
      } as const;

      let hash = 2166136261;
      for (const char of `${input.gameType}:${input.seed}`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      const profile = profiles[input.gameType];
      const pick = <T,>(values: readonly T[], shift: number): T => values[(hash >>> shift) % values.length]!;
      const variant = {
        npc: pick(profile.contacts, 0),
        route: pick(profile.routes, 3),
        guard: pick(profile.guards, 6),
        archive: pick(profile.archives, 9),
        lair: pick(profile.lairs, 12),
        clue: pick(profile.clues, 15),
        relic: pick(profile.relics, 18),
        boss: pick(profile.bosses, 21),
      };
      const medium = input.gameLength === "medium";
      const finalQuestId = "quest_climax";
      const locations = medium
        ? [
            {
              id: "loc_start", name: profile.start, description: `一处临近${variant.route}的落脚点。`, kind: "main" as const, scale: "town" as const,
              connectedLocationIds: ["loc_street"], npcIds: ["npc_innkeeper"], availableItemIds: [], tags: [input.gameType],
            },
            {
              id: "loc_street", name: variant.route, description: `通往${variant.guard}的危险路线。`, kind: "main" as const,
              connectedLocationIds: ["loc_start", "loc_guard"], npcIds: [], availableItemIds: ["item_clue"], tags: ["route"],
            },
            {
              id: "loc_guard", name: variant.guard, description: `守卫封锁着前往${variant.archive}的道路。`, kind: "main" as const,
              connectedLocationIds: ["loc_street", "loc_archive"], npcIds: [], availableItemIds: [], tags: ["guard"],
            },
            {
              id: "loc_archive", name: variant.archive, description: `这里保存着足以揭露${variant.boss}的证据。`, kind: "main" as const,
              connectedLocationIds: ["loc_guard", "loc_lair"], npcIds: [], availableItemIds: ["item_archive"], tags: ["archive"],
            },
            {
              id: "loc_lair", name: variant.lair, description: `${variant.boss}盘踞的最终据点。`, kind: "main" as const,
              connectedLocationIds: ["loc_archive"], npcIds: [], availableItemIds: [], tags: ["climax"],
            },
          ]
        : [
            {
              id: "loc_start", name: profile.start, description: `一处临近${variant.route}的落脚点。`, kind: "main" as const, scale: "town" as const,
              connectedLocationIds: ["loc_street"], npcIds: ["npc_innkeeper"], availableItemIds: [], tags: [input.gameType],
            },
            {
              id: "loc_street", name: variant.route, description: `通向${variant.lair}的必经之路。`, kind: "main" as const,
              connectedLocationIds: ["loc_start", "loc_lair"], npcIds: [], availableItemIds: ["item_clue"], tags: ["route"],
            },
            {
              id: "loc_lair", name: variant.lair, description: `${variant.boss}盘踞的最终据点。`, kind: "main" as const,
              connectedLocationIds: ["loc_street"], npcIds: [], availableItemIds: [], tags: ["climax"],
            },
          ];
      const quests = medium
        ? [
            {
              id: "quest_main", name: `取得${variant.npc}的信任`, description: "从关键线人口中确认追索方向。", kind: "main" as const, stage: 1,
              objectives: [{ kind: "talk_to_npc" as const, npcId: "npc_innkeeper" }],
              onSuccess: { kind: "unlock_quests" as const, questIds: ["quest_clue"], locationIds: ["loc_street"] }, onFailure: { kind: "closed" as const }, tags: ["main"],
            },
            {
              id: "quest_clue", name: `追查${variant.clue}`, description: "沿途取得第一份证物。", kind: "main" as const, stage: 2,
              objectives: [{ kind: "visit_location" as const, locationId: "loc_street" }, { kind: "obtain_item" as const, itemId: "item_clue" }],
              onSuccess: { kind: "unlock_quests" as const, questIds: ["quest_guard"], locationIds: ["loc_guard"] }, onFailure: { kind: "closed" as const }, tags: ["main"],
            },
            {
              id: "quest_guard", name: `突破${variant.guard}`, description: "击败封锁道路的守卫。", kind: "main" as const, stage: 3,
              objectives: [{ kind: "visit_location" as const, locationId: "loc_guard" }, { kind: "defeat_enemy" as const, enemyId: "enemy_guard" }],
              onSuccess: { kind: "unlock_quests" as const, questIds: ["quest_archive"], locationIds: ["loc_archive"] }, onFailure: { kind: "closed" as const }, tags: ["main"],
            },
            {
              id: "quest_archive", name: `夺取${variant.relic}`, description: "从档案中取得决定性的证据。", kind: "main" as const, stage: 4,
              objectives: [{ kind: "visit_location" as const, locationId: "loc_archive" }, { kind: "obtain_item" as const, itemId: "item_archive" }],
              onSuccess: { kind: "unlock_quests" as const, questIds: [finalQuestId], locationIds: ["loc_lair"] }, onFailure: { kind: "closed" as const }, tags: ["main"],
            },
            {
              id: finalQuestId, name: `决战${variant.boss}`, description: "击败幕后强敌，为选择承担结果。", kind: "main" as const, stage: 5,
              objectives: [{ kind: "visit_location" as const, locationId: "loc_lair" }, { kind: "defeat_enemy" as const, enemyId: "enemy_boss" }],
              onSuccess: { kind: "reach_ending" as const, endingId: "ending_trust" }, onFailure: { kind: "closed" as const }, tags: ["main", "climax"],
            },
          ]
        : [
            {
              id: "quest_main", name: `取得${variant.npc}的信任`, description: "从关键线人口中确认追索方向。", kind: "main" as const, stage: 1,
              objectives: [{ kind: "talk_to_npc" as const, npcId: "npc_innkeeper" }],
              onSuccess: { kind: "unlock_quests" as const, questIds: ["quest_clue"], locationIds: ["loc_street"] }, onFailure: { kind: "closed" as const }, tags: ["main"],
            },
            {
              id: "quest_clue", name: `追查${variant.clue}`, description: "沿途取得证物并查明其中秘密。", kind: "main" as const, stage: 2,
              objectives: [{ kind: "visit_location" as const, locationId: "loc_street" }, { kind: "obtain_item" as const, itemId: "item_clue" }],
              onSuccess: { kind: "unlock_quests" as const, questIds: [finalQuestId], locationIds: ["loc_lair"] }, onFailure: { kind: "closed" as const }, tags: ["main"],
            },
            {
              id: finalQuestId, name: `决战${variant.boss}`, description: "击败幕后强敌，为选择承担结果。", kind: "main" as const, stage: 3,
              objectives: [{ kind: "defeat_enemy" as const, enemyId: "enemy_boss" }],
              onSuccess: { kind: "reach_ending" as const, endingId: "ending_trust" }, onFailure: { kind: "closed" as const }, tags: ["main", "climax"],
            },
          ];
      return {
        world: {
          summary: `一场从${profile.start}延伸到${variant.lair}的${profile.genre}追索。`,
          tone: profile.tone,
          themes: ["探索", "抉择"],
          publicFacts: [{ id: "fact_inn", text: `${variant.npc}守着通往${variant.route}的消息。` }],
          hiddenFacts: [{ id: "fact_secret", text: `${variant.clue}与${variant.relic}共同指向${variant.boss}的隐秘计划。` }],
          tags: [profile.genre, input.gameType],
        },
        player: {
          name: input.setup?.characterName ?? "无名旅者",
          identity: input.setup?.characterIdentity ?? profile.identity,
          backgroundSummary: input.setup?.characterProfile ?? `为追寻一段被掩埋的${profile.genre}真相独自上路。`,
          startingLocationId: "loc_start",
          startingItemIds: [],
          baseStats: { hp: 100, attack: 10, defense: 5 },
        },
        startAnchor: {
          locationId: "loc_start",
          npcId: "npc_innkeeper",
          startQuestId: "quest_main",
          mainThreadId: "thread_main",
        },
        locations,
        npcs: [
          {
            id: "npc_innkeeper", name: variant.npc, role: "关键线人", description: `掌握${variant.route}沿途消息的知情人。`,
            locationId: "loc_start", isCompanion: false,
            knownFactIds: ["fact_inn"], hiddenFactIds: ["fact_secret"], goals: ["查明幕后势力"], tags: ["key_npc"],
          },
        ],
        items: [
          { id: "item_clue", name: variant.clue, description: "能指向下一处封锁点的关键证物。", kind: "clue", tags: ["quest"] },
          ...(medium ? [{ id: "item_archive", name: variant.relic, description: "能揭露最终据点的决定性证据。", kind: "clue", tags: ["quest", "archive"] }] : []),
        ],
        enemies: [
          ...(medium ? [{ id: "enemy_guard", name: `${variant.boss}的守卫`, tier: "normal" as const, stats: { hp: 8, attack: 4, defense: 0 }, locationId: "loc_guard", tags: ["guard"] }] : []),
          { id: "enemy_boss", name: variant.boss, tier: "boss", stats: { hp: 24, attack: 6, defense: 2 }, locationId: "loc_lair", tags: ["boss"] },
        ],
        factions: [],
        quests,
        endings: [
          { id: "ending_trust", name: "并肩破局", description: `你与${variant.npc}以信任守住了胜利。`, requirements: [{ kind: "quest_completed", questId: "quest_climax" }, { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 6 }] },
          { id: "ending_doubt", name: "孤身远行", description: "你赢下决战，却因猜疑独自离开。", requirements: [{ kind: "quest_completed", questId: "quest_climax" }, { kind: "npc_affinity_at_most", npcId: "npc_innkeeper", value: 5 }] },
        ],
        openingBudget: { locationsCount: locations.length, npcsCount: 1, sideQuestsCount: 0, endingsCount: 2, townLocationsCount: 0 },
      };
    },
  };
}
