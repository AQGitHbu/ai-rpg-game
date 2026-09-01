import {
  EntityStoreInvariantError,
  NPC_HISTORY_CAP,
  createEntityStore,
  projectEntityStore,
  validateEntityReferences,
  type EntityRecord,
  type ItemEntityRecord,
  type LocationComponent,
  type NpcDynamicStateComponent,
  type NpcEntityRecord,
  type NpcHistoryComponent,
  type NpcKnowledgeCertainty,
  type NpcKnowledgeComponent,
  type NpcKnowledgeDisclosure,
  type NpcRelationshipComponent,
  type PossessionComponent,
  type RelationshipSignal,
  type RelationshipSource,
} from "@/game/domain/entity";
import type { NpcInteraction, WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID, type EnemyId, type FactId, type ItemId, type LocationId, type NpcId, type QuestId } from "@/game/domain/worldEntity";
import {
  applyRelationshipCommitment,
  applyRelationshipSignalToComponent,
  findRelationshipEdge,
  setNpcKnowledgeDisclosure,
  upsertRelationshipEdge,
  writeNpcKnowledge,
  type NpcKnowledgeErrorCode,
  type NpcKnowledgeReferences,
  type NpcKnowledgeSourceInput,
  type RelationshipCommitmentOperation,
  type RelationshipPolicyErrorCode,
  type RelationshipTargetId,
} from "@/game/gameplay/rpg/npcMemory";

/**
 * 过渡桥载荷：四个分层组件的 exact-key 集合，由 domain 的 compileLegacyNpcSync 产出。
 * 桥不携带 identity/anchors/position/core，也永远不携带 legacy memory 本体。
 */
export type NpcLegacySyncLayers = Readonly<{
  dynamicState: NpcDynamicStateComponent;
  knowledge: NpcKnowledgeComponent;
  relationships: NpcRelationshipComponent;
  history: NpcHistoryComponent;
}>;

/**
 * 关系写入声明的来源：**直接沿用 domain 的判别联合**（npcComponents.ts 的 `RelationshipSource`），
 * 本层不再手抄任何一支——domain 新增第三支时这里不可能悄悄漂移。
 * 但「类型里有这一支」不等于「本通道能用这一支」：本层只放行 `action` 一支，
 * `initial_world` 在 checkRelationshipSource 里一律以 invalid_relationship_source 拒掉。
 * 原因是 3A 规则层建边与铸承诺 ID 都固定按 action 起源写（`applyRelationshipSignal` 内
 * origin = { kind: "action", … }），所以背景种子关系只能在 Task 6 的规则层入口里落
 * initial_world；在本层放行会静默把「创建期背景」伪造成「某次行动」。
 * 这一支保留在类型里是刻意的：形状由 domain 定权，Task 6 只需补能力、不必改载荷。
 */
export type RelationshipMutationSource = RelationshipSource;

/**
 * 知识写入声明的来源：**直接沿用规则层的判别联合**（npcMemory 的 `NpcKnowledgeSourceInput`），
 * 本层不再手抄任何一支——规则层新增一支时这里不可能悄悄漂移。
 * 与 RelationshipMutationSource 同理，「类型里有这一支」不等于「本通道能用这一支」：
 * 本层只放行 `action` 一支，`initial_world` 在 checkKnowledgeSource 里一律以
 * invalid_knowledge_source 拒掉。理由是背景知识的 provenance 属于**创建期**事实
 * （由 Task 6 的锚定创建材料一次性给出），在一次运行时行动里写它等于把「世界一开始就是这样」
 * 伪造成「某次行动让这条 NPC 知道的」；而本通道的 entry.source 一旦写下永不可改（首次来源是历史），
 * 所以放行即是不可撤销的伪造。这一支保留在类型里是刻意的：形状由规则层定权，
 * Task 6 只需补能力（届时也只需补一个开关，不必改载荷）。
 */
export type KnowledgeMutationSource = NpcKnowledgeSourceInput;

/** 规则层唯一允许的实体写入语言；AI 输入不使用此联合。 */
export type EntityMutation =
  | { readonly kind: "move_player"; readonly toLocationId: LocationId; readonly markVisited: true }
  | { readonly kind: "move_npc"; readonly npcId: NpcId; readonly toLocationId: LocationId }
  | { readonly kind: "set_location_unlocked"; readonly locationId: LocationId; readonly unlocked: boolean }
  | { readonly kind: "set_location_visited"; readonly locationId: LocationId; readonly visited: boolean }
  | { readonly kind: "sync_npc_legacy_memory"; readonly npcId: NpcId; readonly npc: NpcLegacySyncLayers }
  /**
   * 关系信号：一支 mutation 只提交一个 signal（同行动内的提交顺序由批次数组顺序决定，
   * 规则层的同行动累计预算对该顺序敏感，见 npcMemory 文件头 (b)/(c)）。
   * 载荷里没有数值 delta、没有 stage、没有 trend、没有证据对象：那些全由规则表决定。
   */
  | { readonly kind: "apply_relationship_signal"; readonly fromNpcId: NpcId; readonly targetId: RelationshipTargetId; readonly signal: RelationshipSignal; readonly source: RelationshipMutationSource }
  /** 承诺操作：只接受封闭六类操作名，且不建边（目标边必须已存在）。 */
  | { readonly kind: "apply_relationship_commitment"; readonly fromNpcId: NpcId; readonly targetId: RelationshipTargetId; readonly operation: RelationshipCommitmentOperation; readonly source: RelationshipMutationSource }
  | { readonly kind: "transfer_item"; readonly itemId: ItemId; readonly owner: PossessionComponent["owner"] }
  | { readonly kind: "discover_fact"; readonly factId: FactId }
  /**
   * 知识写入：一支只写「某 NPC 知道某 Fact」这一条 entry。
   * 载荷里没有整块组件、没有 entries 数组、没有兼容 memory——那三样都在类型层被
   * 下面的键集合锁挡在门外，因为「替换整块知识」就是第二条写入通道。
   * certainty / disclosure 只是首次写入的声明：既有条目的披露只能由下一支改。
   */
  | { readonly kind: "record_npc_knowledge"; readonly npcId: NpcId; readonly factId: FactId; readonly certainty: NpcKnowledgeCertainty; readonly disclosure: NpcKnowledgeDisclosure; readonly source: KnowledgeMutationSource }
  /** 披露改动：唯一的 disclosure 写入通道，evidence 逐字段声明（不给 initial_world 留后门）。 */
  | { readonly kind: "set_npc_knowledge_disclosure"; readonly npcId: NpcId; readonly factId: FactId; readonly disclosure: NpcKnowledgeDisclosure; readonly actionId: string; readonly turnNumber: number }
  | { readonly kind: "set_quest_status"; readonly questId: QuestId; readonly status: "locked" | "active" | "completed" | "failed" | "closed" }
  | { readonly kind: "set_enemy_defeated"; readonly enemyId: EnemyId; readonly defeated: boolean }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: NpcId; readonly lifecycle: "active" | "inactive" }
  /**
   * 交互历史追加：载荷就是「存下来的那条 NpcInteraction 减去两个由实体层盖章的字段」。
   * 少写的两支正好是 `relationshipDelta` 与 `summary`（R5-2）：整批里唯一知道裁剪后真实
   * delta 的一方是批次本身，调用方再报一个数字就是给关系引擎已经拥有的数字立第二事实来源，
   * 而 `summary` 把同一个数字嵌进了 prose，所以两支都不能从外面进来。
   * 批次数组顺序是契约的一部分：signal 必须在前面，见 interactionRelationshipDelta。
   */
  | ({ readonly kind: "record_npc_interaction"; readonly npcId: NpcId } & NpcInteractionPayload)
  /** 情绪写入：唯一的 dynamicState.emotion 通道，一支只写这一个字段。 */
  | { readonly kind: "set_npc_emotion"; readonly npcId: NpcId; readonly emotion: NpcDynamicStateComponent["emotion"] }
  /**
   * 初遇标记：`met` 的字面量类型就是 true——「撤销初遇」在类型层没有写法，运行时也一律
   * 返回 invalid_npc_met_value（单调只抬不降，与知识 certainty 只升同因）。
   * `isCompanion` 与 `goals` 刻意没有通道：同伴与任务语义属 Task 7。
   */
  | { readonly kind: "set_npc_met"; readonly npcId: NpcId; readonly met: true }
  | { readonly kind: "replace_location_component"; readonly locationId: LocationId; readonly location: LocationComponent }
  | { readonly kind: "create_entities"; readonly records: readonly EntityRecord[] };

/**
 * `record_npc_interaction` 的载荷形状：**派生自** domain 的 NpcInteraction，
 * 只挖掉实体层自己盖章的两支。为什么派生而不是手抄一份字段清单：
 * domain 给 NpcInteraction 新增任何字段时，本载荷会立刻多出一个键，
 * 于是下面的键集合锁当场编译失败，逼调用方对新字段做一次「谁拥有它」的决定，
 * 而不是让兼容载荷悄悄漂到组件形状之外。
 */
export type NpcInteractionPayload = Omit<NpcInteraction, "relationshipDelta" | "summary">;

type Expect<T extends true> = T;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * 关系载荷的键集合封闭锁：谁想「顺手」在 mutation 上多带一个数值 / stage / 证据字段，
 * 先在 typecheck 失败，而不是悄悄开出第二条关系写入通道。
 */
export type RelationshipSignalPayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "apply_relationship_signal" }>,
  "kind" | "fromNpcId" | "targetId" | "signal" | "source"
>>;
export type RelationshipCommitmentPayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "apply_relationship_commitment" }>,
  "kind" | "fromNpcId" | "targetId" | "operation" | "source"
>>;

/**
 * 知识载荷的键集合封闭锁：「整块替换 knowledge」与「顺手写兼容 memory」在这里就是类型错误。
 * 载荷能携带的只有单条 entry 的四个维度，组件本体永远进不来。
 */
export type RecordKnowledgePayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "record_npc_knowledge" }>,
  "kind" | "npcId" | "factId" | "certainty" | "disclosure" | "source"
>>;
export type SetKnowledgeDisclosurePayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "set_npc_knowledge_disclosure" }>,
  "kind" | "npcId" | "factId" | "disclosure" | "actionId" | "turnNumber"
>>;

/**
 * 历史 / 情绪 / 初遇载荷的键集合封闭锁（Task 5A）。
 *
 * `record_npc_interaction` 的期望键是**派生载荷的展开**：它比存下来的那条 NpcInteraction 恰好
 * 少 `relationshipDelta` 与 `summary`（见 NpcInteractionPayload 与 R5-2）。这里必须逐字把十个键
 * 写出来，而不是 `keyof NpcInteractionPayload`：锁的对象是「这条 mutation 能携带什么」，
 * 用派生式写出来就等于永远锁不上——domain 新增字段时载荷会跟着长，锁却永远成立。
 * 手抄才是本锁的意义：新字段一出现就编译失败，逼调用方对它做一次归属判定。
 */
export type RecordInteractionPayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "record_npc_interaction" }>,
  "kind" | "npcId" | "turnNumber" | "actionId" | "locationId" | "dialogueAct" | "topic" | "topicSummary" | "outcome" | "learnedFactIds"
>>;
/** 情绪一支只写 dynamicState.emotion：met / isCompanion / goals 与整块组件都在门外。 */
export type SetEmotionPayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "set_npc_emotion" }>,
  "kind" | "npcId" | "emotion"
>>;
/** 初遇一支只写 dynamicState.met；`isCompanion` 与 `goals` 刻意没有通道（Task 7）。 */
export type SetMetPayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "set_npc_met" }>,
  "kind" | "npcId" | "met"
>>;

export type EntityMutationErrorCode =
  | "unknown_entity_id"
  | "duplicate_entity_id"
  | "wrong_entity_kind"
  | "invalid_reference"
  | "invalid_lifecycle_transition"
  | "structure_invalid"
  // 关系 mutation 专用：与 RelationshipPolicyErrorCode 一一映射，逐个可判别，绝不折叠成消息字符串。
  | "relationship_self_edge"
  // 本通道不可达（store 禁止同一 targetId 两条边，组件入口按 targetId 取边）：留着只为映射表穷尽性，没有对应用例。
  | "relationship_edge_mismatch"
  | "invalid_relationship_signal"
  | "invalid_relationship_source"
  | "invalid_relationship_turn"
  | "invalid_commitment_operation"
  | "unknown_relationship_commitment"
  | "illegal_relationship_commitment_transition"
  // 知识 mutation 专用：下表逐项覆盖 NpcKnowledgeErrorCode，每个码都可判别，绝不折叠成消息字符串；
  // 合并只发生在「调用方拿到细分码也只会做同一件事」的地方（见下表注释）。
  | "unknown_knowledge_fact"
  | "unknown_knowledge_source_npc"
  | "invalid_knowledge_source"
  | "invalid_knowledge_turn"
  | "invalid_knowledge_certainty"
  | "invalid_knowledge_disclosure"
  | "knowledge_certainty_demotion_rejected"
  | "knowledge_entry_not_found"
  // 历史 mutation 专用（Task 5A）。为什么不复用 domain 的 duplicate_history_action_id：
  // 那道门在 createEntityStore 里，而它的所有 issue 都会被折叠成 invalid_component_value，
  // 最终只以 structure_invalid + entityId 见客——调用方就分不出「这条行动已记过」与「形状不合法」。
  // 本层要在任何写入之前失败并给出可判别的指令（换一个已铸造的 actionId），所以自持一个码。
  | "duplicate_npc_interaction"
  // met 的唯一合法取值就是 true：false / 非布尔都表达「撤销初遇」，而这条通道刻意不存在。
  // 同样不能借 structure_invalid 表达——那是「数据形状不对」，这是「这个意图没有写入语言」。
  | "invalid_npc_met_value";

/**
 * 规则层封闭错误码 → 本层错误码：`satisfies` 锁住覆盖性，
 * domain/规则层新增一个 code 而本表漏一行时直接编译失败（不存在吞掉错误的默认分支）。
 */
const RELATIONSHIP_POLICY_ERROR_CODES: Readonly<Record<RelationshipPolicyErrorCode, EntityMutationErrorCode>> = {
  self_edge_rejected: "relationship_self_edge",
  edge_target_mismatch: "relationship_edge_mismatch",
  invalid_signal: "invalid_relationship_signal",
  invalid_action_source: "invalid_relationship_source",
  invalid_turn_number: "invalid_relationship_turn",
  invalid_commitment_operation: "invalid_commitment_operation",
  unknown_commitment: "unknown_relationship_commitment",
  illegal_commitment_transition: "illegal_relationship_commitment_transition",
} as const satisfies Record<RelationshipPolicyErrorCode, EntityMutationErrorCode>;

/**
 * 知识规则层封闭错误码 → 本层错误码：同样是 `satisfies` 锁覆盖性，规则层新增一个 code
 * 而本表漏一行就直接编译失败。折叠只发生在「调用方无法据此改变行为」的地方：
 * 来源支不合法（kind 表外 / mode 表外 / 说话人策略不符 / 缺证据）都归一个码，
 * 因为它们对调用方的指令完全相同——重新提供一份真实行动证据。
 */
const KNOWLEDGE_POLICY_ERROR_CODES: Readonly<Record<NpcKnowledgeErrorCode, EntityMutationErrorCode>> = {
  unknown_fact: "unknown_knowledge_fact",
  unknown_source_npc: "unknown_knowledge_source_npc",
  // 主体 NPC 不存在本来就是 store 级引用错误：与 recordOfKind 走同一个码，调用方不必分派两次。
  unknown_npc: "unknown_entity_id",
  // 本通道只放行 action 支（见 KnowledgeMutationSource），规则层的四类来源缺陷合并成一个码。
  invalid_source_kind: "invalid_knowledge_source",
  invalid_mode: "invalid_knowledge_source",
  invalid_source_npc: "invalid_knowledge_source",
  invalid_action_source: "invalid_knowledge_source",
  invalid_turn_number: "invalid_knowledge_turn",
  invalid_certainty: "invalid_knowledge_certainty",
  invalid_disclosure: "invalid_knowledge_disclosure",
  certainty_demotion_rejected: "knowledge_certainty_demotion_rejected",
  knowledge_entry_not_found: "knowledge_entry_not_found",
  // 以下三支从**已提交的 store** 出发不可达（domain validator 已钉住 npc 必带 knowledge 组件），
  // 留着只为映射表的穷尽性。唯一例外是同一批里的 create_entities：它原样收下调用方给的 record，
  // 而整批校验要等 applyOne 全部跑完、createEntityStore 才做，所以
  // [create_entities(缺 knowledge 的 npc), record_npc_knowledge] 会真的走到这道门上——
  // 这正是它返回 structure_invalid 而不是抛裸 TypeError 的意义。
  invalid_component: "structure_invalid",
  // 引用上下文永远由 knowledgeReferences 现场构造（两个 Set 字面量），
  invalid_reference_context: "structure_invalid",
  // change 三取值只存在于 FactChange 广播入口，本通道不调用它。
  invalid_change_kind: "structure_invalid",
} as const satisfies Record<NpcKnowledgeErrorCode, EntityMutationErrorCode>;

export type ApplyEntityMutationsResult =
  | { readonly ok: true; readonly worldState: WorldState }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId?: string };

/** 供必须把内部不变量失败升级为异常的上游调用点使用。 */
export class EntityMutationInvariantError extends Error {
  readonly code: EntityMutationErrorCode;
  readonly entityId?: string;

  constructor(input: { readonly code: EntityMutationErrorCode; readonly entityId?: string }) {
    super(`entity mutation invariant violated: ${input.code}`);
    this.name = "EntityMutationInvariantError";
    this.code = input.code;
    this.entityId = input.entityId;
  }
}

type MutationResult =
  | { readonly ok: true; readonly records: readonly EntityRecord[] }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId?: string };

type EntityRecordOfKind<K extends EntityRecord["core"]["kind"]> = Extract<EntityRecord, { readonly core: { readonly kind: K } }>;

function isNpcRecord(record: EntityRecord): record is NpcEntityRecord {
  return record.core.kind === "npc";
}

function isItemRecord(record: EntityRecord): record is ItemEntityRecord {
  return record.core.kind === "item";
}

function failure(code: EntityMutationErrorCode, entityId?: string): MutationResult {
  return entityId === undefined ? { ok: false, code } : { ok: false, code, entityId };
}

function recordOfKind<K extends EntityRecord["core"]["kind"]>(
  records: readonly EntityRecord[],
  entityId: string,
  kind: K,
): { readonly ok: true; readonly record: EntityRecordOfKind<K> } | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId: string } {
  const record = records.find((entry) => entry.core.id === entityId);
  if (record === undefined) return { ok: false, code: "unknown_entity_id", entityId };
  if (record.core.kind !== kind) return { ok: false, code: "wrong_entity_kind", entityId };
  const typedRecord = records.find((entry): entry is EntityRecordOfKind<K> => entry.core.id === entityId && entry.core.kind === kind);
  if (typedRecord === undefined) return { ok: false, code: "unknown_entity_id", entityId };
  return { ok: true, record: typedRecord };
}

function hasKind(records: readonly EntityRecord[], entityId: string, kind: EntityRecord["core"]["kind"]): boolean {
  return records.some((record) => record.core.id === entityId && record.core.kind === kind);
}

function replaceRecord(records: readonly EntityRecord[], entityId: string, replacement: EntityRecord): readonly EntityRecord[] {
  return records.map((record) => record.core.id === entityId ? replacement : record);
}

function maxNpcOrder(records: readonly EntityRecord[], locationId: LocationId): number {
  return records.reduce((max, record) => (
    isNpcRecord(record)
      && record.core.lifecycle === "active"
      && record.position.locationId === locationId
      ? Math.max(max, record.position.locationOrder)
      : max
  ), -1);
}

function ownerKey(owner: PossessionComponent["owner"]): string {
  if (owner.kind === "player") return `player:${owner.playerId}`;
  if (owner.kind === "location") return `location:${owner.locationId}`;
  if (owner.kind === "npc") return `npc:${owner.npcId}`;
  return "none";
}

function sameOwner(left: PossessionComponent["owner"], right: PossessionComponent["owner"]): boolean {
  return ownerKey(left) === ownerKey(right);
}

function maxItemOrder(records: readonly EntityRecord[], owner: PossessionComponent["owner"]): number {
  if (owner.kind === "none") return 0;
  return records.reduce((max, record) => (
    isItemRecord(record) && sameOwner(record.possession.owner, owner)
      ? Math.max(max, record.possession.ownerOrder)
      : max
  ), -1);
}

function questLifecycle(status: Extract<EntityMutation, { readonly kind: "set_quest_status" }>["status"]): "active" | "inactive" | "resolved" {
  if (status === "active") return "active";
  if (status === "locked") return "inactive";
  return "resolved";
}

// ---------------------------------------------------------------------------
// NPC 写入主体的共用闸门（Task 4B 知识两支 + Task 5A 历史/情绪/初遇三支）
// ---------------------------------------------------------------------------

type NpcSubject =
  | { readonly ok: true; readonly npc: NpcEntityRecord }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId: string };

/**
 * 写入主体：必须是一条 npc record，且必须仍然活着。
 * 4B 的知识两支与 5A 的历史 / 情绪 / 初遇三支共用这一道门——「主体非活」对六支的含义完全相同，
 * 抄第二份只会让两边在未来各自漂移。
 * 规则层的引用集合只做**存在性**判定（4A 明示不查 lifecycle），所以主体自己的存活
 * 只能由本 mutation 校验——沿用 3B `relationshipParties` 的处理：非活跃主体一律
 * invalid_lifecycle_transition。否则「停用/已结算的 NPC」就会成为新的写入目标，
 * 而它随时可能被 projector 重新折叠回兼容数组，看不出差别。
 */
function activeNpcSubject(records: readonly EntityRecord[], npcId: NpcId): NpcSubject {
  const npc = recordOfKind(records, npcId, "npc");
  if (!npc.ok) return npc;
  if (npc.record.core.lifecycle !== "active") {
    return { ok: false, code: "invalid_lifecycle_transition", entityId: npcId };
  }
  return { ok: true, npc: npc.record };
}

// ---------------------------------------------------------------------------
// 知识 mutation 的边界校验（Task 4B）
// ---------------------------------------------------------------------------

/**
 * 引用上下文：两个 ID 集合都从**传入的 records 数组**现场派生，只收活跃实体。
 * 为什么不取 `ws.worldFacts` / `ws.npcs`：
 * 1. `applyOne` 的签名里根本没有 WorldState——它只拿到 records，写不出别的事实来源。
 * 2. `ws.worldFacts` 与 `ws.npcs` 是 `projectEntityStore` 每次重建的**兼容读模型**，
 *    且 `entitiesOfKind` 逐条投影、完全不看 lifecycle：拿它当上下文就会放行
 *    一条已停用（inactive / resolved / destroyed）的 Fact Entity。
 * 3. 说话人同理：死掉的 NPC 不得借一条新知识洗白成 provenance（entry.source 永不可改写）。
 * canonical 判定权在实体层，兼容数组只是它的一个视图，视图不是依据。
 * 本函数就是这份派生的唯一公开面（纯读 helper，不开任何写通道）：规则层的传播与这里的
 * `record_npc_knowledge` 共用它，两边对「这条 Fact / 这个 NPC 存不存在」才不会有两种答案。
 */
export function knowledgeReferences(records: readonly EntityRecord[]): NpcKnowledgeReferences {
  return {
    factIds: new Set(records.filter((record) => record.core.kind === "fact" && record.core.lifecycle === "active").map((record) => record.core.id)),
    npcIds: new Set(records.filter((record) => record.core.kind === "npc" && record.core.lifecycle === "active").map((record) => record.core.id)),
  };
}

/**
 * 来源判别式校验：本层只放行 `action` 一支，`initial_world` 一律拒绝（理由见
 * KnowledgeMutationSource）。这里**不**重复检查 actionId / turnNumber 的形状——
 * 那是规则层 `createNpcKnowledgeSource` 的唯一职责（`writeNpcKnowledge` 是 entry 写入的唯一入口），
 * 在此再抄一遍就是第二事实来源。
 * 也刻意不返回「闸门收紧后的那份来源」：写下去的就是调用方自己的 `mutation.source`，
 * 闸门只回答「这一支能不能写」。
 */
function checkKnowledgeSource(declared: KnowledgeMutationSource): EntityMutationErrorCode | undefined {
  if (typeof declared !== "object" || declared === null || declared.kind !== "action") {
    return "invalid_knowledge_source";
  }
  return undefined;
}

/**
 * 诊断 ID 沿用本文件的既有约定（`relationshipParties`、`move_player`、`transfer_item` 都如此）：
 * `entityId` 报**越界的那个引用**，不是行动主体。未知 Fact 报 Fact ID、幽灵说话人报说话人 ID；
 * 主体侧的失败（NPC 不存在、主体非活跃、certainty 阶梯冲突、条目不存在）里主体本身就是越界者，照旧报主体。
 */
function knowledgeOffenderId(
  code: NpcKnowledgeErrorCode,
  mutation: Readonly<{ npcId: NpcId; factId: FactId; source?: KnowledgeMutationSource }>,
): string {
  if (code === "unknown_fact") return mutation.factId;
  // 说话人只存在于 action 支，且只在 npc_revealed 上可能被引用（mode 策略由规则层裁决）。
  if (code === "unknown_source_npc" && mutation.source?.kind === "action") {
    return mutation.source.sourceNpcId ?? mutation.npcId;
  }
  return mutation.npcId;
}

// ---------------------------------------------------------------------------
// 关系 mutation 的边界校验（Task 3B）
// ---------------------------------------------------------------------------

type RelationshipSourceCheck =
  | { readonly ok: true; readonly actionId: string; readonly turnNumber: number }
  | { readonly ok: false; readonly code: EntityMutationErrorCode };

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * 来源判别式校验：本层只放行 `action` 一支，并要求 actionId 非空白、turnNumber 为非负整数。
 * 「actionId 指向真实已提交行动」这件事本层无法自查——WorldState 里没有行动账本
 * （eventLedger 的 GameEvent 不携带 actionId），所以调用方必须传服务端已铸造的那个 ID。
 * initial_world 的拒绝理由见 RelationshipMutationSource。
 */
function checkRelationshipSource(declared: RelationshipMutationSource): RelationshipSourceCheck {
  if (typeof declared !== "object" || declared === null) return { ok: false, code: "invalid_relationship_source" };
  if (declared.kind !== "action") return { ok: false, code: "invalid_relationship_source" };
  const { actionId, turnNumber } = declared;
  // 下面两条形状检查与规则层 checkActionSource（relationshipSignalPolicy.ts:478-482）刻意重复：
  // 本层要在任何写入之前失败，且 code 比 store 级 structure_invalid 精确得多。
  if (isBlank(actionId)) return { ok: false, code: "invalid_relationship_source" };
  if (typeof turnNumber !== "number" || !Number.isInteger(turnNumber) || turnNumber < 0) {
    return { ok: false, code: "invalid_relationship_turn" };
  }
  return { ok: true, actionId, turnNumber };
}

type RelationshipParties =
  | { readonly ok: true; readonly npc: NpcEntityRecord }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId: string };

/**
 * 关系两端的存在性与类型：来源必须是 NPC，目标只能是 NPC 或玩家本体——
 * 地点 / 物品 / 敌人 / 任务都拿不到 wrong_entity_kind 之外的通道，非活跃与已结算实体一律不能当任一方。
 */
function relationshipParties(
  records: readonly EntityRecord[],
  fromNpcId: NpcId,
  targetId: RelationshipTargetId,
): RelationshipParties {
  const npc = recordOfKind(records, fromNpcId, "npc");
  if (!npc.ok) return npc;
  const target = targetId === PLAYER_ENTITY_ID
    ? recordOfKind(records, PLAYER_ENTITY_ID, "player_character")
    : recordOfKind(records, targetId, "npc");
  if (!target.ok) return target;
  if (npc.record.core.lifecycle !== "active") {
    return { ok: false, code: "invalid_lifecycle_transition", entityId: fromNpcId };
  }
  if (target.record.core.lifecycle !== "active") {
    return { ok: false, code: "invalid_lifecycle_transition", entityId: targetId };
  }
  return { ok: true, npc: npc.record };
}

// ---------------------------------------------------------------------------
// 历史 / 情绪 / 初遇 mutation 的批次内盖章（Task 5A）
// ---------------------------------------------------------------------------

/**
 * 主体在**本批首次触及它那一刻**的对玩家 affinity。
 * 只有这一样进批次：条目的 relationshipDelta = 应用后的读数 − 这一刻的读数，
 * 而「这一刻」必须是批次开始动它之前——records 是逐步替换的，不记就回不去。
 * `met` 刻意**不**在这里快照：摘要用的是追加那一刻的 live 值，
 * 所以同批里排在交互之前的 `set_npc_met` 会（也应当）把措辞翻成「再次交谈」。
 */
type NpcBatchBaseline = Readonly<{ playerAffinity: number }>;

/**
 * 一次 `applyEntityMutations` 调用私有的上下文：一张「主体 → 本批首次触及时的 affinity」表。
 * 它不是第二事实来源——只在批内存活，不写盘、不进结果、不外露，函数返回即随栈丢弃。
 */
type MutationBatch = { readonly baselines: Map<NpcId, NpcBatchBaseline> };

/**
 * 主体指向玩家的那条边的 affinity；没有这条边就是 0（与 projector 折叠 legacy affinity 同一读法）。
 * 「查不到」在这里不是错误：同一批里新建、还没有任何 player 边的 NPC，第一条交互当然盖 0。
 */
function playerAffinityOf(npc: NpcEntityRecord): number {
  return findRelationshipEdge(npc.relationships, PLAYER_ENTITY_ID)?.dimensions.affinity ?? 0;
}

/**
 * 确保主体的本批前态已登记（首次触及才记，之后再来只读数）。
 * 能改动玩家 affinity 的两支在**写入之前**调它并丢掉返回值——它们只要「这一刻被记住」；
 * 交互一支则要用它记下的数算出本批实际应用的变化。
 */
function ensureBatchBaseline(npc: NpcEntityRecord, batch: MutationBatch): NpcBatchBaseline {
  const existing = batch.baselines.get(npc.core.id);
  if (existing !== undefined) return existing;
  const baseline: NpcBatchBaseline = { playerAffinity: playerAffinityOf(npc) };
  batch.baselines.set(npc.core.id, baseline);
  return baseline;
}

/**
 * 本批至今对该玩家边**实际**写入的 affinity 变化（R5-2 的盖章依据）。
 * 读的是当前 records 上的数，所以规则层的单维/总量预算（同行动多条信号的累计裁剪）
 * 天然已经生效：两条 normal 信号在 ±5 预算下合成 5，这里就得到 5，而不是表内相加的 7。
 * 本函数一个数字都不重算，只做两次读数相减。
 */
function interactionRelationshipDelta(npc: NpcEntityRecord, baseline: NpcBatchBaseline): number {
  return playerAffinityOf(npc) - baseline.playerAffinity;
}

/**
 * 交互摘要的**唯一**模板：本文件与 dialogueResolution 共用这一份（后者只做排版转发）。
 * 输入全部由持有事实的一方给定——数字是盖章后的真实变化，met 是追加那一刻主体自己的值——
 * 所以这段 prose 与条目里的 relationshipDelta 不可能互相矛盾。
 * 它只读入参、不写任何东西：放在本文件是为了跟盖章处贴在一起，不构成第二条写入通道。
 */
export function formatNpcInteractionSummary(input: Readonly<{
  met: boolean;
  dialogueAct: NpcInteraction["dialogueAct"];
  outcome: NpcInteraction["outcome"];
  relationshipDelta: number;
}>): string {
  const meetPart = input.met ? "再次交谈" : "首次见面";
  const moodPart = input.outcome === "positive" ? "气氛融洽"
    : input.outcome === "negative" ? "氛围紧张"
    : input.outcome === "mixed" ? "气氛复杂"
    : "语气平淡";
  const deltaText = input.relationshipDelta >= 0 ? `+${input.relationshipDelta}` : `${input.relationshipDelta}`;
  return `${meetPart}，${input.dialogueAct}，${moodPart}，关系${deltaText}`;
}

/**
 * oldest→newest 追加并裁到共享上限：常量直接取 domain 的 NPC_HISTORY_CAP（唯一权威，本层不另立数字），
 * 于是永远不可能出现「写入侧以为能存 10 条、校验侧按别的数判 history_cap_exceeded」。
 * slice 从尾部保留，所以被裁掉的永远是最旧那条，新写入永不因为「装满了」而丢失。
 */
function appendNpcInteraction(
  interactions: readonly NpcInteraction[],
  entry: NpcInteraction,
): NpcHistoryComponent {
  return { interactions: [...interactions, entry].slice(-NPC_HISTORY_CAP) };
}

function applyOne(records: readonly EntityRecord[], mutation: EntityMutation, batch: MutationBatch): MutationResult {
  switch (mutation.kind) {
    case "move_player": {
      const player = recordOfKind(records, PLAYER_ENTITY_ID, "player_character");
      if (!player.ok) return player;
      const location = recordOfKind(records, mutation.toLocationId, "location");
      if (!location.ok) return failure("invalid_reference", mutation.toLocationId);
      const nextRecords = replaceRecord(records, player.record.core.id, {
        ...player.record,
        position: { ...player.record.position, locationId: mutation.toLocationId },
      });
      return {
        ok: true,
        records: replaceRecord(nextRecords, mutation.toLocationId, {
          ...location.record,
          location: { ...location.record.location, visited: mutation.markVisited || location.record.location.visited },
        }),
      };
    }
    case "move_npc": {
      const npc = recordOfKind(records, mutation.npcId, "npc");
      if (!npc.ok) return npc;
      const location = recordOfKind(records, mutation.toLocationId, "location");
      if (!location.ok) return failure("invalid_reference", mutation.toLocationId);
      const position = npc.record.position.locationId === mutation.toLocationId
        ? npc.record.position
        : { ...npc.record.position, locationId: mutation.toLocationId, locationOrder: maxNpcOrder(records, mutation.toLocationId) + 1 };
      return { ok: true, records: replaceRecord(records, mutation.npcId, { ...npc.record, position }) };
    }
    case "set_location_unlocked":
    case "set_location_visited": {
      const location = recordOfKind(records, mutation.locationId, "location");
      if (!location.ok) return location;
      const locationComponent = mutation.kind === "set_location_unlocked"
        ? { ...location.record.location, unlocked: mutation.unlocked }
        : { ...location.record.location, visited: mutation.visited };
      return { ok: true, records: replaceRecord(records, mutation.locationId, { ...location.record, location: locationComponent }) };
    }
    case "sync_npc_legacy_memory": {
      const npc = recordOfKind(records, mutation.npcId, "npc");
      if (!npc.ok) return npc;
      const { dynamicState, knowledge, relationships, history } = mutation.npc;
      // 逐键写入而非展开载荷：桥只覆盖四个分层组件，core/identity/position 不在其权限内。
      return {
        ok: true,
        records: replaceRecord(records, mutation.npcId, {
          ...npc.record,
          dynamicState,
          knowledge,
          relationships,
          history,
        }),
      };
    }
    case "apply_relationship_signal": {
      // 边界校验在前，数值/stage/trend/证据/承诺一律交回规则层：本分支一个数字都不重算。
      const parties = relationshipParties(records, mutation.fromNpcId, mutation.targetId);
      if (!parties.ok) return failure(parties.code, parties.entityId);
      if (mutation.fromNpcId === mutation.targetId) return failure("relationship_self_edge", mutation.fromNpcId);
      const checkedSource = checkRelationshipSource(mutation.source);
      if (!checkedSource.ok) return failure(checkedSource.code, mutation.fromNpcId);
      // 写入之前先登记本批前态：同批稍后的交互要靠这一刻算出「本批实际应用了多少」。
      ensureBatchBaseline(parties.npc, batch);
      const applied = applyRelationshipSignalToComponent({
        relationships: parties.npc.relationships,
        fromNpcId: mutation.fromNpcId,
        targetId: mutation.targetId,
        signal: mutation.signal,
        actionId: checkedSource.actionId,
        turnNumber: checkedSource.turnNumber,
      });
      // applied.code 是规则层自己的封闭字面量 union（不是调用方数据），所以裸下标即可：
      // 表覆盖性由上面的 satisfies 锁定，漏一行在 typecheck 就失败，不会落回 undefined。
      if (!applied.ok) return failure(RELATIONSHIP_POLICY_ERROR_CODES[applied.code], mutation.fromNpcId);
      // changed:false 是同行动重放的幂等结果：零写入，但不是失败。
      if (!applied.changed) return { ok: true, records };
      // 只替换 relationships 一个组件：其余组件按引用继承，兼容 memory 由 projector 重建。
      return {
        ok: true,
        records: replaceRecord(records, mutation.fromNpcId, {
          ...parties.npc,
          relationships: applied.relationships,
        }),
      };
    }
    case "apply_relationship_commitment": {
      const parties = relationshipParties(records, mutation.fromNpcId, mutation.targetId);
      if (!parties.ok) return failure(parties.code, parties.entityId);
      if (mutation.fromNpcId === mutation.targetId) return failure("relationship_self_edge", mutation.fromNpcId);
      const checkedSource = checkRelationshipSource(mutation.source);
      if (!checkedSource.ok) return failure(checkedSource.code, mutation.fromNpcId);
      // 防御性登记：承诺本身不动维度（relationshipSignalPolicy 只重写 commitments 与
      // lastChangedAtTurn），但登记时机与上一支一致——一律在写入之前——以免将来给承诺加数值语义时漏登记。
      ensureBatchBaseline(parties.npc, batch);
      // 承诺不建边：没有边就是引用了不存在的东西，与「未知 commitmentId」是两类错误。
      const edge = findRelationshipEdge(parties.npc.relationships, mutation.targetId);
      if (edge === undefined) return failure("invalid_reference", mutation.targetId);
      const applied = applyRelationshipCommitment({
        edge,
        operation: mutation.operation,
        actionId: checkedSource.actionId,
        turnNumber: checkedSource.turnNumber,
      });
      if (!applied.ok) return failure(RELATIONSHIP_POLICY_ERROR_CODES[applied.code], mutation.fromNpcId);
      if (!applied.changed) return { ok: true, records };
      return {
        ok: true,
        records: replaceRecord(records, mutation.fromNpcId, {
          ...parties.npc,
          // 写回仍经 upsert：targetId 顺序由 domain 比较器裁决，本层不手抄排序规则。
          relationships: { outgoing: upsertRelationshipEdge(parties.npc.relationships.outgoing, applied.edge) },
        }),
      };
    }
    case "transfer_item": {
      const item = recordOfKind(records, mutation.itemId, "item");
      if (!item.ok) return item;
      const owner = mutation.owner;
      if (owner.kind === "location" && !hasKind(records, owner.locationId, "location")) return failure("invalid_reference", owner.locationId);
      if (owner.kind === "npc" && !hasKind(records, owner.npcId, "npc")) return failure("invalid_reference", owner.npcId);
      if (owner.kind === "player" && !hasKind(records, owner.playerId, "player_character")) return failure("invalid_reference", owner.playerId);
      const possession = sameOwner(item.record.possession.owner, owner)
        ? item.record.possession
        : { ...item.record.possession, owner, ownerOrder: maxItemOrder(records, owner) + 1 };
      return { ok: true, records: replaceRecord(records, mutation.itemId, { ...item.record, possession }) };
    }
    case "discover_fact": {
      const fact = recordOfKind(records, mutation.factId, "fact");
      if (!fact.ok) return fact;
      if (fact.record.fact.discovered) return { ok: true, records };
      return { ok: true, records: replaceRecord(records, mutation.factId, { ...fact.record, fact: { ...fact.record.fact, discovered: true } }) };
    }
    case "record_npc_knowledge": {
      // 三道边界（主体存活 / 来源支 / 引用上下文）先过，entry 语义一条都不在这里重算：
      // 幂等键、certainty 阶梯、说话人策略、取值闭集全是规则层的判定，抄一遍就是第二事实来源。
      const subject = activeNpcSubject(records, mutation.npcId);
      if (!subject.ok) return failure(subject.code, subject.entityId);
      const sourceCode = checkKnowledgeSource(mutation.source);
      if (sourceCode !== undefined) return failure(sourceCode, mutation.npcId);
      const applied = writeNpcKnowledge({
        npcId: mutation.npcId,
        knowledge: subject.npc.knowledge,
        factId: mutation.factId,
        certainty: mutation.certainty,
        disclosure: mutation.disclosure,
        source: mutation.source,
        references: knowledgeReferences(records),
      });
      // applied.code 是规则层自己的封闭字面量 union（不是调用方数据），所以裸下标即可：
      // 表覆盖性由 KNOWLEDGE_POLICY_ERROR_CODES 的 satisfies 锁住，漏一行在 typecheck 就失败。
      if (!applied.ok) {
        return failure(KNOWLEDGE_POLICY_ERROR_CODES[applied.code], knowledgeOffenderId(applied.code, mutation));
      }
      // changed:false 是同一条事实重放的幂等结果：records 数组按引用原样返回，不是失败。
      if (!applied.changed) return { ok: true, records };
      // 只替换这一个主体的知识组件：其余组件按引用继承，兼容 memory 由 projector 重建。
      return {
        ok: true,
        records: replaceRecord(records, mutation.npcId, { ...subject.npc, knowledge: applied.knowledge }),
      };
    }
    case "set_npc_knowledge_disclosure": {
      // 披露通道的 evidence 是扁平字段（actionId + turnNumber），
      // 所以 initial_world 这一支在本载荷里根本表达不出来——不需要、也不再有第二道开关。
      const subject = activeNpcSubject(records, mutation.npcId);
      if (!subject.ok) return failure(subject.code, subject.entityId);
      const applied = setNpcKnowledgeDisclosure({
        npcId: mutation.npcId,
        knowledge: subject.npc.knowledge,
        factId: mutation.factId,
        disclosure: mutation.disclosure,
        actionId: mutation.actionId,
        turnNumber: mutation.turnNumber,
        references: knowledgeReferences(records),
      });
      if (!applied.ok) {
        // 本载荷没有说话人字段，可越界的引用只有 factId，因此不需要 source 一支。
        return failure(
          KNOWLEDGE_POLICY_ERROR_CODES[applied.code],
          knowledgeOffenderId(applied.code, { npcId: mutation.npcId, factId: mutation.factId }),
        );
      }
      // 同值披露重放同样是零写入的成功；未知 Fact 与「不知道这件事」的区分由规则层的 code 给出。
      if (!applied.changed) return { ok: true, records };
      return {
        ok: true,
        records: replaceRecord(records, mutation.npcId, { ...subject.npc, knowledge: applied.knowledge }),
      };
    }
    case "set_quest_status": {
      const quest = recordOfKind(records, mutation.questId, "quest");
      if (!quest.ok) return quest;
      return {
        ok: true,
        records: replaceRecord(records, mutation.questId, {
          ...quest.record,
          core: { ...quest.record.core, lifecycle: questLifecycle(mutation.status) },
          quest: { ...quest.record.quest, status: mutation.status },
        }),
      };
    }
    case "set_enemy_defeated": {
      const enemy = recordOfKind(records, mutation.enemyId, "enemy");
      if (!enemy.ok) return enemy;
      return {
        ok: true,
        records: replaceRecord(records, mutation.enemyId, {
          ...enemy.record,
          core: { ...enemy.record.core, lifecycle: mutation.defeated ? "resolved" : "active" },
          enemy: { ...enemy.record.enemy, defeated: mutation.defeated },
        }),
      };
    }
    case "set_npc_lifecycle": {
      const npc = recordOfKind(records, mutation.npcId, "npc");
      if (!npc.ok) return npc;
      if (npc.record.core.lifecycle === "resolved" || npc.record.core.lifecycle === "destroyed") {
        return failure("invalid_lifecycle_transition", mutation.npcId);
      }
      return { ok: true, records: replaceRecord(records, mutation.npcId, { ...npc.record, core: { ...npc.record.core, lifecycle: mutation.lifecycle } }) };
    }
    case "record_npc_interaction": {
      // 主体闸门与知识两支同一道门；地点必须是 store 里真实的 location 实体，
      // 诊断照本文件惯例报**越界的那个引用**（locationId），不是主体。
      const subject = activeNpcSubject(records, mutation.npcId);
      if (!subject.ok) return failure(subject.code, subject.entityId);
      if (!hasKind(records, mutation.locationId, "location")) return failure("invalid_reference", mutation.locationId);
      const baseline = ensureBatchBaseline(subject.npc, batch);
      // 重复就是重复：本通道永不静默去重、永不覆盖。同一 NPC 的同一个 actionId 第二次出现，
      // 意味着调用方在拿一次已铸造的行动重放，静默吞掉会让「这条行动记过没有」变成不可查的问题。
      // 边界：判定只看保留中的 ≤NPC_HISTORY_CAP 条，被裁掉的最旧条目的 actionId 因此可以合法重现——
      // 「一行动一交互」由调用方保证，本层不承诺跨裁剪窗口的唯一性。
      if (subject.npc.history.interactions.some((entry) => entry.actionId === mutation.actionId)) {
        return failure("duplicate_npc_interaction", mutation.npcId);
      }
      // 两个盖章字段：数字来自本批实际应用的变化（预算裁剪已在规则层生效，这里只读数），
      // prose 由唯一模板拼出，met 读的是追加那一刻主体自己的值——同批先 set 再记就写成「再次交谈」。
      const relationshipDelta = interactionRelationshipDelta(subject.npc, baseline);
      const entry: NpcInteraction = {
        turnNumber: mutation.turnNumber,
        actionId: mutation.actionId,
        locationId: mutation.locationId,
        dialogueAct: mutation.dialogueAct,
        // 逐键装配而非展开载荷：外部多给的键（伪造的 delta / summary / 整块数组）永远进不了条目。
        ...(mutation.topic === undefined ? {} : { topic: mutation.topic }),
        topicSummary: mutation.topicSummary,
        outcome: mutation.outcome,
        relationshipDelta,
        learnedFactIds: mutation.learnedFactIds,
        summary: formatNpcInteractionSummary({
          // 只读取一个字段（点号访问，不重建组件）：dynamicState 的写入通道仍然只有那三支。
          met: subject.npc.dynamicState.met,
          dialogueAct: mutation.dialogueAct,
          outcome: mutation.outcome,
          relationshipDelta,
        }),
      };
      // 只替换 history 一个组件：其余组件按引用继承，兼容 interactionHistory 由 projector 重建。
      return {
        ok: true,
        records: replaceRecord(records, mutation.npcId, {
          ...subject.npc,
          history: appendNpcInteraction(subject.npc.history.interactions, entry),
        }),
      };
    }
    case "set_npc_emotion": {
      const subject = activeNpcSubject(records, mutation.npcId);
      if (!subject.ok) return failure(subject.code, subject.entityId);
      // 同值重放是幂等成功：连组件对象都不重建，调用方可以用引用身份验出「确实零写入」。
      // 取值闭集的判定权在 domain（validateNpcDynamicState），本层不抄第二份表——
      // 表外情绪照样在任何写入之前失败，只是 code 落到 store 级 structure_invalid。
      if (subject.npc.dynamicState.emotion === mutation.emotion) return { ok: true, records };
      return {
        ok: true,
        records: replaceRecord(records, mutation.npcId, {
          ...subject.npc,
          // 展开旧组件、只覆盖一个键：goals 数组按引用继承，isCompanion 与 met 动不了。
          dynamicState: { ...subject.npc.dynamicState, emotion: mutation.emotion },
        }),
      };
    }
    case "set_npc_met": {
      const subject = activeNpcSubject(records, mutation.npcId);
      if (!subject.ok) return failure(subject.code, subject.entityId);
      // 类型层 `met: true` 已经把 false 写成编译错误，但 mutation 也可能来自已存盘 JSON 的回读，
      // 所以运行时同样要有一道门：以 unknown 读数，任何非 true 一律 invalid_npc_met_value。
      const declared: unknown = mutation.met;
      if (declared !== true) return failure("invalid_npc_met_value", mutation.npcId);
      // 已 met 再抬一次是幂等成功（零写入）：met 单调只升，与知识 certainty 只升同因，
      // 「撤销初遇」在本语言里没有对应字段可写（isCompanion / goals 同理，Task 7 才谈）。
      if (subject.npc.dynamicState.met) return { ok: true, records };
      return {
        ok: true,
        records: replaceRecord(records, mutation.npcId, {
          ...subject.npc,
          dynamicState: { ...subject.npc.dynamicState, met: true },
        }),
      };
    }
    case "replace_location_component": {
      const location = recordOfKind(records, mutation.locationId, "location");
      if (!location.ok) return location;
      return { ok: true, records: replaceRecord(records, mutation.locationId, { ...location.record, location: mutation.location }) };
    }
    case "create_entities": {
      const seen = new Set(records.map((record) => record.core.id));
      for (const record of mutation.records) {
        if (seen.has(record.core.id)) return failure("duplicate_entity_id", record.core.id);
        seen.add(record.core.id);
      }
      return { ok: true, records: [...records, ...mutation.records] };
    }
  }
}

/**
 * 先在局部 records 执行整批命令，再集中运行 store/reference 校验并投影。
 * 任一失败都不返回部分状态，传入 WorldState 也不会被修改。
 */
export function applyEntityMutations(
  worldState: WorldState,
  mutations: readonly EntityMutation[],
): ApplyEntityMutationsResult {
  if (mutations.length === 0) return { ok: true, worldState };

  // 批内上下文：只服务本次调用，函数返回即丢弃；它记得「本批首次触及某主体时的前态」，
  // 所以数组顺序就是契约的一部分——交互只会盖到排在它之前的信号实际造成的变化。
  const batch: MutationBatch = { baselines: new Map() };
  let records = worldState.entityStore.records;
  for (const mutation of mutations) {
    const applied = applyOne(records, mutation, batch);
    if (applied.ok === false) {
      return {
        ok: false,
        code: applied.code,
        ...(applied.entityId === undefined ? {} : { entityId: applied.entityId }),
      };
    }
    records = applied.records;
  }

  let entityStore;
  try {
    entityStore = createEntityStore(records);
  } catch (error) {
    if (error instanceof EntityStoreInvariantError && error.code === "duplicate_entity_id") {
      return { ok: false, code: "duplicate_entity_id", ...(error.entityId === undefined ? {} : { entityId: error.entityId }) };
    }
    return {
      ok: false,
      code: "structure_invalid",
      ...(!(error instanceof EntityStoreInvariantError) || error.entityId === undefined ? {} : { entityId: error.entityId }),
    };
  }
  const [referenceIssue] = validateEntityReferences(entityStore);
  if (referenceIssue !== undefined) return { ok: false, code: "invalid_reference", entityId: referenceIssue.entityId };

  return { ok: true, worldState: { ...worldState, entityStore, ...projectEntityStore(entityStore) } };
}
