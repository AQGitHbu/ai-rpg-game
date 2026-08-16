import type { GameRepository } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { StoryState } from "@/game/domain/storyState";
import type { GameTypeId, GameLength, GameSetup, NewGameInput } from "@/game/domain/newGame";
import { validateNewGameInput } from "@/game/domain/newGame";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { parseOpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { validateOpeningGenerationCandidate, compileOpeningGenerationCandidate } from "@/game/gameplay/rpg/openingGeneration";
import {
  createOpeningNoveltyRecord,
  isOpeningTooSimilar,
  type OpeningNoveltyContext,
  type OpeningNoveltyRecord,
} from "@/game/domain/openingNovelty";
import { asGenerationId } from "@/game/domain/worldEntity";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { TARGET_ACTS } from "@/game/domain/storyBudget";

// ---------------------------------------------------------------------------
// Task 2：开局生成编排改为 source → parse → validate → compile。
// OpeningGenerationSource.generate 返回 OpeningGenerationCandidate（原始字符串
// fact key，无实体 ID——ID 一律由编译器铸造）。createGame 内：schema parse →
// gameplay validate → compile 为单一 World/Story State，任何失败返回明确错误码，
// 绝不用 `as never` 透传。
// ---------------------------------------------------------------------------

export type OpeningGenerationInput = {
    gameType: GameTypeId;
    seed: string;
    gameLength: GameLength;
    /** 玩家开局配置：生成源必须消费（角色/世界观/故事开端），不得丢弃。 */
    setup?: GameSetup;
    /** 只提供近期故事指纹，AI 仍自由生成实体名称与剧情文本。 */
    novelty?: OpeningNoveltyContext;
    /** 相似度重试次数，写入生成元数据以便同一存档可复现。 */
    attempt?: number;
};

export type OpeningGenerationSource = {
  generate(input: OpeningGenerationInput): Promise<OpeningGenerationCandidate>;
  /** 相似候选耗尽重试后生成另一条完整候选，不改写 AI 已返回的实体名。 */
  generateFallback?(input: OpeningGenerationInput): Promise<OpeningGenerationCandidate>;
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
  readonly source: OpeningGenerationSource;
  readonly now: () => string;
  /** Whether AI config is available (determines narrative.mode) */
  readonly aiEnabled?: boolean;
};

const OPENING_HISTORY_LOOKBACK = 12;
const MAX_OPENING_GENERATION_ATTEMPTS = 3;

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

  const historyResult = deps.repository.listOpeningHistory === undefined
    ? { ok: true as const, records: [] as readonly OpeningNoveltyRecord[] }
    : await deps.repository.listOpeningHistory({ gameType: input.gameType, limit: OPENING_HISTORY_LOOKBACK });
  if (!historyResult.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };

  const recentHistory = [...historyResult.records];
  const rejectedCandidates: OpeningNoveltyRecord[] = [];
  const prepareCandidate = (generated: OpeningGenerationCandidate) => {
    const parsed = parseOpeningGenerationCandidate(generated);
    if (!parsed.ok) return null;

    const validated = validateOpeningGenerationCandidate(parsed.value, {
      gameLength: input.gameLength,
      targetActs: TARGET_ACTS[input.gameLength],
    });
    if (!validated.ok) return null;

    return {
      candidate: validated.validated,
      novelty: createOpeningNoveltyRecord({
        candidate: validated.validated,
        gameType: input.gameType,
        createdAt: deps.now(),
      }),
    };
  };
  let accepted: {
    readonly candidate: OpeningGenerationCandidate;
    readonly novelty: OpeningNoveltyRecord;
    readonly attempt: number;
  } | null = null;

  for (let attempt = 0; attempt < MAX_OPENING_GENERATION_ATTEMPTS; attempt += 1) {
    let generated: OpeningGenerationCandidate;
    try {
      generated = await deps.source.generate({
        gameType: input.gameType,
        seed: input.seed,
        gameLength: input.gameLength,
        ...(input.setup === undefined ? {} : { setup: input.setup }),
        novelty: {
          recent: [...recentHistory, ...rejectedCandidates],
          attempt,
        },
        attempt,
      });
    } catch {
      continue;
    }
    if (!generated) continue;

    // schema parse → gameplay validate → compile。
    const prepared = prepareCandidate(generated);
    if (prepared === null) continue;

    const comparableHistory = [...recentHistory, ...rejectedCandidates];
    if (isOpeningTooSimilar(prepared.novelty, comparableHistory)) {
      rejectedCandidates.push(prepared.novelty);
      continue;
    }
    accepted = { candidate: prepared.candidate, novelty: prepared.novelty, attempt };
    break;
  }

  // API 可能在三次请求中仍返回同一结构。不能把最后一个重复候选
  // 当作成功；改用 source 提供的完整结构性兜底，仍走同一校验链。
  if (accepted === null && deps.source.generateFallback !== undefined) {
    try {
      const generated = await deps.source.generateFallback({
        gameType: input.gameType,
        seed: input.seed,
        gameLength: input.gameLength,
        ...(input.setup === undefined ? {} : { setup: input.setup }),
        novelty: { recent: [...recentHistory, ...rejectedCandidates], attempt: MAX_OPENING_GENERATION_ATTEMPTS },
        attempt: MAX_OPENING_GENERATION_ATTEMPTS,
      });
      const prepared = prepareCandidate(generated);
      if (prepared !== null && !isOpeningTooSimilar(prepared.novelty, recentHistory)) {
        accepted = {
          candidate: prepared.candidate,
          novelty: prepared.novelty,
          attempt: MAX_OPENING_GENERATION_ATTEMPTS,
        };
      }
    } catch {
      // 兜底也失败时返回稳定的 GENERATION_FAILED，不将重复故事伪装成成功。
    }
  }
  if (accepted === null) return { ok: false, code: "GENERATION_FAILED" };

  const generation = {
    generationId: asGenerationId(`gen_${input.seed}`),
    seed: input.seed,
    templateVersion: "v2" as const,
    inputDigest: "",
    gameType: input.gameType,
    ...(input.setup === undefined ? {} : { setup: input.setup }),
    ...(accepted.attempt === 0 ? {} : { openingAttempt: accepted.attempt }),
  };

  const { worldState, storyState } = compileOpeningGenerationCandidate({
    candidate: accepted.candidate,
    generation,
    gameLength: input.gameLength,
  });

  // Set narrative to pending so the first scene (prologue) gets generated
  // by the ensure polling mechanism (spec §9.1: 生成序幕场景)。
  // pending 唯一载体是带 job 的 PendingNarrativeJob（Spec §10.3），
  // 不再使用无 job 的 requestedAt legacy 形式。
  const narrativeMode = deps.aiEnabled ? "ai" : "offline";
  const openingNpcId = worldState.npcs[0]?.id;
  const jobResult = createPendingNarrativeJob({
    jobId: asNarrativeJobId(`job_${input.seed}_0`),
    turnId: asTurnId(`turn_${input.seed}_0`),
    actionId: `start_${input.seed}`,
    expectedRevision: 0,
    turnNumber: 0,
    actionSummary: openingNpcId === undefined ? { kind: "explore" } : { kind: "talk", npcId: openingNpcId },
    resolvedEvent: {
      actionId: `start_${input.seed}`,
      status: "success",
      eventKind: openingNpcId === undefined ? "observe" : "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    ...(openingNpcId === undefined ? {} : { focusNpcId: openingNpcId }),
    requestedAt: deps.now(),
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
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
    openingHistory: accepted.novelty,
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

// ---------------------------------------------------------------------------
// 确定性开局切片 fixture：只返回故事契约 + 开场切片（一个地点/NPC/任务），
// 不生成任何未来命名实体。同 seed+gameType+attempt 完全可重放；玩家配置为权威输入。
// ---------------------------------------------------------------------------

export function createFixtureOpeningSource(): OpeningGenerationSource {
  return {
    async generate(input) {
      const profiles = {
        wuxia: {
          genre: "武侠", tone: "江湖沧桑", identity: "流浪剑客",
          towns: ["青石镇", "临江镇", "雁回镇", "白沙镇"],
          venues: ["听雨客栈", "归舟茶肆", "长亭酒坊", "照影驿馆"],
          contacts: ["沈掌柜", "顾账房", "陆驿丞", "叶药师"],
          routes: ["青石古道", "芦苇渡口", "断桥驿道", "药王山径"],
          lairs: ["黑风寨", "沉钟水寨", "赤焰山庄", "寒鸦别院"],
          clues: ["残月密函", "潮痕账册", "焦边路引", "药香手札"],
          relics: ["盟誓印谱", "私盐航图", "劫镖名录", "禁药方笺"],
          bosses: ["黑风寨主", "沉钟舵主", "赤焰庄主", "寒鸦院主"],
        },
        xianxia: {
          genre: "仙侠", tone: "缥缈玄奇", identity: "寻道散修",
          towns: ["云岫镇", "栖霞集", "落星渡", "玄砂城"],
          venues: ["问月驿", "栖霞丹坊", "听潮道舍", "归鹤观"],
          contacts: ["闻鹤道人", "素月丹师", "青檀执事", "玄砂客"],
          routes: ["流云栈道", "星落古径", "悬灯天桥", "归墟石阶"],
          lairs: ["噬月魔窟", "烬仙遗宫", "无相天牢", "血莲洞天"],
          clues: ["裂纹玉简", "逆火丹书", "青帝残碑", "归墟星盘"],
          relics: ["镇魔真诀", "九转炉谱", "万木灵契", "星河阵图"],
          bosses: ["噬月魔君", "烬仙尊者", "无相妖王", "血莲圣使"],
        },
        fantasy: {
          genre: "奇幻", tone: "史诗幽邃", identity: "边境佣兵",
          towns: ["灰杉镇", "铜铃谷", "晨星集", "河湾城"],
          venues: ["星火旅店", "鹿角酒馆", "旧王冠驿站", "银叶工坊"],
          contacts: ["艾琳店主", "矮人账官", "白塔信使", "鹿角药师"],
          routes: ["银松大道", "雾沼木桥", "狮鹫山径", "荆棘古路"],
          lairs: ["黑龙巢穴", "深潮王庭", "灰烬要塞", "猩红高塔"],
          clues: ["断翼纹章", "潮汐契据", "烧焦谕令", "荆棘王冠"],
          relics: ["龙语盟约", "海王航志", "王室族谱", "精灵誓书"],
          bosses: ["黑翼领主", "深潮公爵", "灰烬骑士", "猩红女巫"],
        },
        science_fiction: {
          genre: "科幻", tone: "冷峻未知", identity: "自由领航员",
          towns: ["远港环城", "曙光栖地", "赫利俄斯站", "蓝湾殖民地"],
          venues: ["远港中继站", "零重力酒吧", "轨道修造坞", "蓝湾联络舱"],
          contacts: ["林站长", "奎因技师", "赫兹领航员", "伊芙研究员"],
          routes: ["蓝移航道", "碎星走廊", "静默轨道", "日冕捷径"],
          lairs: ["熵增母舰", "深空采掘城", "奇点实验站", "红矮星堡垒"],
          clues: ["损坏黑匣", "加密矿权证", "折叠坐标", "日冕观测谱"],
          relics: ["跃迁密钥", "自治协议", "先驱者星图", "聚变控制核"],
          bosses: ["熵核指挥官", "采掘城总督", "奇点主脑", "红星执政官"],
        },
        urban: {
          genre: "都市", tone: "现实悬疑", identity: "独立调查员",
          towns: ["临江城区", "南栅街区", "栖霞新城", "白榆片区"],
          venues: ["夜班便利店", "旧报社接待室", "南站咖啡馆", "临江修车铺"],
          contacts: ["周店长", "许记者", "陈调度", "苏医生"],
          routes: ["临江旧街", "地铁末班线", "高架辅路", "城南医院道"],
          lairs: ["湾区烂尾楼", "地下控制室", "城郊物流园", "私立研究院"],
          clues: ["匿名录音", "删改采访稿", "异常调度单", "缺页病历"],
          relics: ["产权转移清单", "加密采访带", "车辆轨迹盘", "临床试验名册"],
          bosses: ["幕后董事", "黑网管理员", "物流园主", "研究院院长"],
        },
        alternate_history: {
          genre: "历史架空", tone: "庙堂暗涌", identity: "边郡游侠",
          towns: ["雁门镇", "河西城", "临漕县", "北岭关城"],
          venues: ["长安驿馆", "河西茶楼", "漕渠脚店", "北岭马行"],
          contacts: ["裴驿丞", "崔司书", "霍校尉", "谢医官"],
          routes: ["河西官道", "漕渠古渡", "北岭驿路", "盐铁栈道"],
          lairs: ["朔方王帐", "东厂水牢", "玄甲行宫", "盐铁私府"],
          clues: ["伪造节钺", "漕银底账", "调兵虎符", "御药密录"],
          relics: ["盟国国书", "河运密图", "边军花名册", "宫禁药案"],
          bosses: ["朔方摄政王", "缇骑提督", "玄甲大将军", "盐铁使"],
        },
        post_apocalypse: {
          genre: "末日", tone: "荒凉坚韧", identity: "废土行者",
          towns: ["灰烬营地", "北风聚落", "旧铁路站", "盐碱避难区"],
          venues: ["灰烬营地指挥棚", "北风修理站", "铁轨补给点", "盐碱诊疗所"],
          contacts: ["罗塔守望者", "米娅修理师", "老秦向导", "岚医生"],
          routes: ["辐尘公路", "干涸河床", "倾覆铁路线", "菌林边界"],
          lairs: ["熔炉要塞", "沉没避难所", "钢铁列车城", "菌群母巢"],
          clues: ["褪色通行证", "气象记录芯片", "军列货单", "污染样本盒"],
          relics: ["净水核心图", "避难所日志", "聚变机车钥匙", "免疫种子谱"],
          bosses: ["熔炉霸主", "避难所监理", "铁轨军阀", "菌巢意识"],
        },
      } as const;

      const attempt = input.attempt ?? 0;
      const historySalt = input.novelty?.recent.map((record) => record.fingerprint).join("|") ?? "";
      const fixtureSeed = attempt === 0 && historySalt === ""
        ? input.seed
        : `${input.seed}#opening-attempt-${attempt}#history-${historySalt}`;
      let hash = 2166136261;
      for (const char of `${input.gameType}:${fixtureSeed}`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      const genreProfile = profiles[input.gameType];
      const pick = <T,>(values: readonly T[], shift: number): T => values[(hash >>> shift) % values.length]!;
      const variant = {
        town: pick(genreProfile.towns, 0),
        venue: pick(genreProfile.venues, 3),
        npc: pick(genreProfile.contacts, 6),
        route: pick(genreProfile.routes, 9),
        lair: pick(genreProfile.lairs, 12),
        clue: pick(genreProfile.clues, 15),
        relic: pick(genreProfile.relics, 18),
        boss: pick(genreProfile.bosses, 21),
      };
      const variationProfile = {
        sceneFrame: pick(["street", "market", "inn", "outskirts", "station", "workshop", "shrine", "other"] as const, 24),
        npcArchetype: pick(["witness", "keeper", "courier", "merchant", "official", "craftsperson", "guide", "other"] as const, 26),
        leadType: pick(["trace", "document", "testimony", "token", "message", "object", "other"] as const, 28),
        conflictMode: pick(["concealment", "misdirection", "dispute", "pursuit", "betrayal", "other"] as const, 30),
      } as const;

      const setup = input.setup;
      return {
        world: {
          summary: `一场从${variant.town}的${variant.venue}延伸到${variant.lair}的${genreProfile.genre}追索。`,
          tone: genreProfile.tone,
          themes: ["探索", "抉择"],
          publicFacts: [
            { key: "fact_inn", text: `${variant.npc}守着${variant.route}的消息。` },
            { key: "fact_pact", text: `${variant.clue}与${variant.relic}共同指向${variant.boss}的隐秘计划。` },
          ],
        },
        player: {
          name: setup?.characterName ?? "无名旅者",
          identity: setup?.characterIdentity ?? genreProfile.identity,
          backgroundSummary: setup?.characterProfile ?? `为追寻一段被掩埋的${genreProfile.genre}真相独自上路。`,
          baseStats: { hp: 100, attack: 10, defense: 5 },
        },
        prologue: `你在${variant.town}的${variant.venue}醒来，${variant.route}方向传来异动。`,
        storyContract: {
          version: 1,
          targetActs: input.gameLength === "short" ? 3 : 5,
          centralConflict: `旧案背后的${variant.boss}正在瓦解${genreProfile.genre}世界的秩序。`,
          endingDirections: [
            { key: "trust", theme: `与${variant.npc}共同承担真相` },
            { key: "doubt", theme: "独自揭露真相" },
          ],
        },
        opening: {
          location: {
            name: variant.town,
            description: `一座临近${variant.route}、以${variant.venue}为落脚点的城镇。`,
            buildingName: variant.venue,
            scale: "town",
          },
          npc: {
            name: variant.npc,
            role: "关键线人",
            description: `掌握${variant.route}沿途消息的知情人。`,
            knownFactKeys: ["fact_inn"], privateFactKeys: ["fact_pact"], goals: ["查明幕后势力"],
          },
          quest: {
            name: `取得${variant.npc}的信任`,
            description: "从关键线人口中确认追索方向。",
            objective: { kind: "talk_to_opening_npc" },
          },
          variationProfile,
        },
      };
    },
  };
}
