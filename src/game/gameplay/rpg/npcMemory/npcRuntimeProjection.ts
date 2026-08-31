import {
  compareRelationshipTargetIds,
  type DirectedRelationshipEdge,
  type EntityRecord,
  type FactEntityRecord,
  type NpcEntityRecord,
  type NpcGoal,
  type NpcIdentityAnchors,
  type NpcKnowledgeCertainty,
  type NpcKnowledgeDisclosure,
  type NpcKnowledgeSource,
  type PlayerEntityRecord,
} from "@/game/domain/entity";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type { NpcInteraction } from "@/game/domain/worldEntries";
import type { FactId, NpcId } from "@/game/domain/worldEntity";
import { findRelationshipEdge, type RelationshipTargetId } from "./relationshipSignalPolicy";
import { knowledgeVisibilityOf, type NpcKnowledgeVisibility } from "./npcKnowledge";

// ---------------------------------------------------------------------------
// Plan 3 Task 4C：NPC 运行时投影的唯一读取面（gameplay/rpg/npcMemory）。
//
// 本模块是 NPC **读取侧**的唯一权威：对话、调查、赠物、明确 NPC 任务与共同战斗
// （Task 5 / 7 / 8）都读同一个 `projectNpcRuntimeProfile`，不得各自再拼一份 NPC 视图。
// 它是纯函数：不 import application / prompt / persistence，不持 IO、不读时钟、不用随机数，
// 也绝不被 domain 反向 import；与写入侧同用一个 `records` 数组口径（`applyOne` 收到的那一份），
// 因此规则层内部可以在不改数据通路的前提下读同一个视图。
//
// ## 一次遍历，两个视图（`mode` 只有 "prompt" 与 "rule"）
// `rule`：返回结构化权威值——certainty、disclosure、visibility、完整 source、stage/trend/dimensions。
// `prompt`：只返回**允许披露的正文**。两者由同一次遍历产出，所以同一个字段不可能在
// 两个视图里互相否定。授权差量只有两处，且都由表驱动：
//   - 正文：`PROSE_PERMISSIONS`（shareable 两模式都给；rule_required 只进 rule；
//     withheld 两模式都不给——它只以 id 出现在 `withheldFactIds`）；
//   - 目标：`prompt` 侧只保留 active/blocked 目标，口径与 domain 的兼容投影
//     `npcProjection.visibleGoals` 一致（该函数是私有的，故本表必须由
//     `npcRuntimeProjection.test.ts` 的「与 projectNpcMemory 逐字相同」用例钉住，
//     漂移会在测试里失败，而不是靠两处注释互相指认）。
// 其余字段（锚点、isCompanion/met/emotion、边、交互、卡片集合与顺序、扣留 id）两模式逐字相同。
//
// ## 私密知识隔离为什么是结构性的
// 私密事实的正文只存在 `FactComponent.text` 上（domain 的注释即规则），NPC 的知识条目只携带
// `factId + certainty + disclosure + source`。因此：
// 1. 正文只按**主体自己的**条目取，且只在 `PROSE_PERMISSIONS` 放行时才去读那条 Fact 记录；
//    表外（withheld / prompt 侧的 rule_required）连 Fact 记录都不查，泄漏不需要靠记得过滤来防。
// 2. 本模块**永不读第二条 NPC 记录的 knowledge 组件**。回边只从被指名的那条记录上取
//    `relationships`——关系不是秘密，知识才是。这条被 Proxy 访问日志测试钉死。
// 3. 披露→可见性的映射只有 `npcKnowledge` 里那一份：本文件只 import `knowledgeVisibilityOf`，
//    绝不手抄第二张 disclosure 表（那正是本 Plan 一路在消灭的东西）。
//
// ## 「无明确参与者时不猜关系后果」
// `input.targetId` 缺省 ⇒ `outgoingEdge` / `incomingEdge` 都不存在（不是空边、不是零值边）。
// incoming 永远是对**被指名那条记录**的定点查表，绝不枚举全部 NPC 找指向主体的边。
// 主体自己的 `outgoingEdges` 仍然返回：它是主体组件的一部分，不是推断出的关系结论。
//
// ## 失败一律封闭 code，绝不抛，也绝不含部分 profile
// `npc_not_found` / `not_an_npc` / `target_not_found` / `invalid_mode`，与 `npcKnowledge.ts`
// 一样只返回码（调用方自己传入了 id，故不带 entityId 诊断）。两条刻意记在类型之外的读法：
// - `mode` 先于任何 store 查表判定：请求形状错误与 store 内容无关。
// - 引用不到的 Fact 记录（悬空 factId）不是整体失败，只让那张卡片没有正文：
//   读取面不因单个悬空引用拒绝整个 NPC 视图，但绝不因此伪造正文。
// 读取侧刻意**不**做 lifecycle 闸门：存活判定是写入纪律（`entityMutation` 已把非活跃主体拒在
// 门外），而「这位 NPC 还活着吗」是调用方的枚举职责；在 selector 里再关一次只会让
// Task 7 的战斗结算读不到刚阵亡 NPC 的组件。
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type UnknownRecord = Readonly<Record<string, unknown>>;

/** 运行时投影的两种读法：封闭两项，表外值一律 invalid_mode。 */
export const NPC_RUNTIME_PROFILE_MODES = Object.freeze(["prompt", "rule"] as const);
export type NpcRuntimeProfileMode = (typeof NPC_RUNTIME_PROFILE_MODES)[number];

/**
 * 交互历史的读取窗口：最近 5 条。`history.interactions` 是旧→新（写入侧一律追加，
 * `npcProjection.normalizeLegacyNpcMemory` 也按 `slice(length - CAP)` 保尾），
 * 所以这里取尾、并原序返回。上限 10 条的组件权威是 domain 的 `NPC_HISTORY_CAP`。
 */
export const NPC_PROFILE_INTERACTION_TAIL = 5;

/**
 * prompt 侧可见的目标状态。与 domain 兼容投影 `npcProjection.visibleGoals` 同口径，
 * 由测试逐字比对 `projectNpcMemory(record).goals` 防漂移（domain 那份是私有的，
 * 本表是读取面的第二处声明——把它钉在测试上，而不是钉在注释上）。
 */
const NPC_PROMPT_GOAL_STATUSES: readonly NpcGoal["status"][] = Object.freeze(["active", "blocked"] as const);

/**
 * 模式 × 可见性 → 能否给出正文。`satisfies` 双向锁住覆盖性：domain 新增披露档或本模块
 * 新增模式而漏一格，都在 typecheck 阶段失败，不存在「默认可说」的兜底分支。
 * withheld 一列两模式都是 false：secret 条目根本不进卡片（只进 withheldFactIds），
 * 这一格是把「读不到就是不能说」写成表，而不是留给调用方判断。
 */
const PROSE_PERMISSIONS = Object.freeze({
  prompt: Object.freeze({ shareable: true, rule_required: false, withheld: false }),
  rule: Object.freeze({ shareable: true, rule_required: true, withheld: false }),
} as const satisfies Record<NpcRuntimeProfileMode, Readonly<Record<NpcKnowledgeVisibility, boolean>>>);

/** 模式行与可见性列都必须逐项覆盖两张封闭 union：漏一格即编译失败。 */
export type NpcProfileProseTableLock = Expect<
  IsExactly<keyof typeof PROSE_PERMISSIONS, NpcRuntimeProfileMode>
>;
export type NpcProfileProseColumnLock = Expect<
  IsExactly<keyof (typeof PROSE_PERMISSIONS)[NpcRuntimeProfileMode], NpcKnowledgeVisibility>
>;

export type NpcRuntimeProfileRequest = Readonly<{
  /** 投影主体：只读这一条 NPC 记录的组件。 */
  npcId: NpcId;
  /** 被指名的对手方（NPC 或玩家本体）。缺省即「无明确参与者」：不返回任何关系结论。 */
  targetId?: RelationshipTargetId;
  mode: NpcRuntimeProfileMode;
}>;

/**
 * 一张可说 Fact 卡片：结构化权威值两模式同形，正文按 `PROSE_PERMISSIONS` 放行。
 * `text` 缺省即「本视图不许说、或引用的 Fact 记录不存在」——绝不给空字符串冒充正文。
 */
export type NpcProfileFactCard = Readonly<{
  factId: FactId;
  certainty: NpcKnowledgeCertainty;
  disclosure: NpcKnowledgeDisclosure;
  visibility: NpcKnowledgeVisibility;
  source: NpcKnowledgeSource;
  text?: string;
}>;

export type NpcRuntimeProfile = Readonly<{
  npcId: NpcId;
  mode: NpcRuntimeProfileMode;
  /** 被指名参与者原样回显：调用方可据此判定这份视图是否含关系结论。 */
  targetId?: RelationshipTargetId;
  /** 长期人格锚点：主体组件里的同一对象。 */
  anchors: NpcIdentityAnchors;
  /** 动态状态中与目标无关的那三项；goals 单独成列，因为它按模式过滤。 */
  dynamicState: Readonly<{
    isCompanion: boolean;
    met: boolean;
    emotion: NarrativeEmotion;
  }>;
  goals: readonly NpcGoal[];
  /** 主体全部出边，一律按 domain 唯一比较器排序（不是存储顺序）。 */
  outgoingEdges: readonly DirectedRelationshipEdge[];
  /** 对指定 target 的出边；无指名或无此边时键不存在。 */
  outgoingEdge?: DirectedRelationshipEdge;
  /** 指名那条记录持有且指向主体的那条边；玩家记录不承载组件，故恒不存在。 */
  incomingEdge?: DirectedRelationshipEdge;
  factCards: readonly NpcProfileFactCard[];
  withheldFactIds: readonly FactId[];
  interactions: readonly NpcInteraction[];
}>;

export type NpcProfileErrorCode =
  | "npc_not_found"
  | "not_an_npc"
  | "target_not_found"
  | "invalid_mode";

export type NpcRuntimeProfileResult =
  | Readonly<{ ok: true; profile: NpcRuntimeProfile }>
  | Readonly<{ ok: false; code: NpcProfileErrorCode }>;

// ---------------------------------------------------------------------------
// 原语：未受信字段一律只认自有属性
// ---------------------------------------------------------------------------

function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as UnknownRecord)[key] : undefined;
}

function ownString(value: unknown, key: string): string | undefined {
  const field = ownField(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function ownEntry<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function failure(code: NpcProfileErrorCode): NpcRuntimeProfileResult {
  return { ok: false, code };
}

function isProfileMode(value: unknown): value is NpcRuntimeProfileMode {
  return typeof value === "string"
    && (NPC_RUNTIME_PROFILE_MODES as readonly string[]).includes(value);
}

function isNpcRecord(record: EntityRecord): record is NpcEntityRecord {
  return record.core.kind === "npc";
}

function isPlayerRecord(record: EntityRecord): record is PlayerEntityRecord {
  return record.core.kind === "player_character";
}

function isFactRecord(record: EntityRecord): record is FactEntityRecord {
  return record.core.kind === "fact";
}

function recordOf(records: readonly EntityRecord[], id: string): EntityRecord | undefined {
  return records.find((record) => record.core.id === id);
}

function prosePermitted(mode: NpcRuntimeProfileMode, visibility: NpcKnowledgeVisibility): boolean {
  const row = ownEntry(PROSE_PERMISSIONS, mode);
  return row === undefined ? false : ownEntry(row, visibility) ?? false;
}

/**
 * 正文只在被放行时才去取：于是「withheld 永不泄漏」不需要任何人记得过滤。
 * 悬空引用（records 里没有这条 Fact，或该 id 不是 Fact）同样只返回 undefined。
 */
function factTextOf(records: readonly EntityRecord[], factId: FactId): string | undefined {
  const record = recordOf(records, factId);
  return record !== undefined && isFactRecord(record) ? record.fact.text : undefined;
}

/**
 * 相关入边：只在**被指名那条记录**上定点查边。玩家记录的组件集合里没有 relationships
 * （domain 的 record 形状决定，不是本模块的约定），所以他对任何 NPC 都没有可返回的回边；
 * 玩家侧的关系事实就是主体那条 outgoingEdge。这里绝不枚举全部 NPC 找指向主体的边。
 */
function incomingEdgeOf(
  target: EntityRecord | undefined,
  npcId: NpcId,
): DirectedRelationshipEdge | undefined {
  if (target === undefined || !isNpcRecord(target)) return undefined;
  return findRelationshipEdge(target.relationships, npcId);
}

function orderedOutgoing(subject: NpcEntityRecord): readonly DirectedRelationshipEdge[] {
  // 唯一比较器来自 domain；存储顺序本应已排序（validator 会拒未排序组件），
  // 这里再排一次是为了让读取面的顺序由权威比较器决定，而不是由谁手搓过 record 决定。
  return Object.freeze(
    [...subject.relationships.outgoing].sort((left, right) => compareRelationshipTargetIds(
      left.targetId,
      right.targetId,
    )),
  );
}

function profileGoals(subject: NpcEntityRecord, mode: NpcRuntimeProfileMode): readonly NpcGoal[] {
  const goals = subject.dynamicState.goals;
  if (mode !== "prompt") return Object.freeze([...goals]);
  const visible = goals.filter((goal) => (NPC_PROMPT_GOAL_STATUSES as readonly string[]).includes(goal.status));
  return Object.freeze(visible);
}

/** 按存储顺序逐条走：条目顺序就是持久化权威，绝不分桶再拼接。 */
function knowledgeView(
  records: readonly EntityRecord[],
  subject: NpcEntityRecord,
  mode: NpcRuntimeProfileMode,
): Readonly<{ factCards: readonly NpcProfileFactCard[]; withheldFactIds: readonly FactId[] }> {
  const cards: NpcProfileFactCard[] = [];
  const withheld: FactId[] = [];
  for (const item of subject.knowledge.entries) {
    const visibility = knowledgeVisibilityOf(item);
    if (visibility === "withheld") {
      withheld.push(item.factId);
      continue;
    }
    const text = prosePermitted(mode, visibility) ? factTextOf(records, item.factId) : undefined;
    cards.push(Object.freeze({
      factId: item.factId,
      certainty: item.certainty,
      disclosure: item.disclosure,
      visibility,
      source: item.source,
      ...(text === undefined ? {} : { text }),
    }));
  }
  return Object.freeze({ factCards: Object.freeze(cards), withheldFactIds: Object.freeze(withheld) });
}

/**
 * NPC 运行时投影的唯一入口：七个必读面一次给全（锚点、目标/情绪、指名出边、相关回边、
 * 可说卡片、扣留 Fact ID、最近 5 条交互）。纯函数、无 IO、无 provider 调用，
 * 也不拼任何 prompt 文本——渲染归 Task 8。
 */
export function projectNpcRuntimeProfile(
  records: readonly EntityRecord[],
  input: NpcRuntimeProfileRequest,
): NpcRuntimeProfileResult {
  // 请求形状先判：与 store 内容无关的错误必须先进同一把门，`mode` 只认自有属性且闭集。
  const mode = ownField(input, "mode");
  if (!isProfileMode(mode)) return failure("invalid_mode");
  const npcId = ownString(input, "npcId");
  if (npcId === undefined) return failure("npc_not_found");
  const found = recordOf(records, npcId);
  if (found === undefined) return failure("npc_not_found");
  if (!isNpcRecord(found)) return failure("not_an_npc");
  const subject = found;

  const targetRef = ownString(input, "targetId");
  let target: EntityRecord | undefined;
  if (targetRef !== undefined) {
    // 自己不是自己的对手方：关系结论必须发生在两个参与者之间，否则同一条边会同时
    // 落进出边与回边两个槽位（方向性测试禁止的正是这种镜像）。
    if (targetRef === npcId) return failure("target_not_found");
    const foundTarget = recordOf(records, targetRef);
    // 目标只能是 NPC 或玩家本体：地点/物品/任务/敌人都不是关系参与者。
    if (foundTarget === undefined || !(isNpcRecord(foundTarget) || isPlayerRecord(foundTarget))) {
      return failure("target_not_found");
    }
    target = foundTarget;
  }

  const outgoingEdge = targetRef === undefined
    ? undefined
    : findRelationshipEdge(subject.relationships, targetRef as RelationshipTargetId);
  const incomingEdge = incomingEdgeOf(target, npcId as NpcId);
  const knowledge = knowledgeView(records, subject, mode);
  const interactions = subject.history.interactions;

  return {
    ok: true,
    profile: Object.freeze({
      npcId: npcId as NpcId,
      mode,
      anchors: subject.identity.anchors,
      dynamicState: Object.freeze({
        isCompanion: subject.dynamicState.isCompanion,
        met: subject.dynamicState.met,
        emotion: subject.dynamicState.emotion,
      }),
      goals: profileGoals(subject, mode),
      outgoingEdges: orderedOutgoing(subject),
      factCards: knowledge.factCards,
      withheldFactIds: knowledge.withheldFactIds,
      interactions: Object.freeze(
        interactions.slice(Math.max(interactions.length - NPC_PROFILE_INTERACTION_TAIL, 0)),
      ),
      ...(targetRef === undefined ? {} : { targetId: targetRef as RelationshipTargetId }),
      ...(outgoingEdge === undefined ? {} : { outgoingEdge }),
      ...(incomingEdge === undefined ? {} : { incomingEdge }),
    }),
  };
}
