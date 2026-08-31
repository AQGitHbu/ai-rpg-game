import {
  type NpcKnowledgeCertainty,
  type NpcKnowledgeComponent,
  type NpcKnowledgeDisclosure,
  type NpcKnowledgeEntry,
  type NpcKnowledgeSource,
} from "@/game/domain/entity";
import type { FactChange, FactChangeSource } from "@/game/domain/resolvedEvent";
import type { FactId, NpcId } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// Plan 3 Task 4A：知识 entry 语义规则层（gameplay/rpg/npcMemory）。
//
// 本模块是「一条知识能否进入某个 NPC 的知识组件、以什么来源/确定度进入、
// 披露能不能被顺手改掉」的**唯一裁决场所**。它只 import domain，不持 IO、
// 不读时钟、不用随机数，也绝不被 domain 反向 import（分层：domain → gameplay/rpg → application）。
//
// ## 五条不变量（Task 4B 的 mutation 与 Task 5 的传播链改线都建立在这上面）
// 1. **引用先于写入**：Fact 必须是已存在的 canonical Fact Entity，target NPC 与
//    `sourceNpcId` 必须是已存在的 NPC。存在性由调用方以**封闭的 ID 集合**传入
//    （`NpcKnowledgeReferences`，两个 ReadonlySet）：本模块是纯函数，不查 store，
//    但也不接受任何通用 lookup 回调——集合之外没有第二条判定通道。
// 2. **来源可追踪**：`initial_world` 只用于背景知识；行动来源必须携带真实
//    `{ actionId, turnNumber }`。缺证据/非法证据一律拒绝，绝不退化成背景来源，
//    也不伪造 eventId。条目一旦写入，`source` 永不被后续写入改写（首次来源是历史）。
// 3. **幂等**：同一 Fact 在同一 NPC 上最多一条 entry（domain 的 `duplicate_fact_id`
//    判定把它钉在组件层），重复写入返回同一组件对象，不是错误也不产生第二条。
// 4. **certainty 单调**：`suspected → known` 允许；`known → suspected` 永不隐式发生，
//    只能被拒绝。升级只改 certainty，`source` 与 `disclosure` 逐字保留。
// 5. **disclosure 只能由显式规则改**：只有 `setNpcKnowledgeDisclosure` 能动披露，
//    且它只动披露——绝不顺手创建条目、绝不改 certainty、绝不改来源。
//
// ## FactChange.source / audience → entry 的完整映射
// `knowledgeWritesFromFactChange` 把现有事件的 `source/audience` 折叠成接收者写入，
// 不给 `FactChange` 增加任何字段，也不把 actionId 重复存进每条事实：真实行动证据
// 由规则上下文（`{ actionId, turnNumber }`，Task 2 桥接时已落地）一次性传入。
//
// | FactChange.source  | entry source mode | sourceNpcId（透露者） | audience 要求 | 无 audience 时 |
// | ------------------ | ----------------- | --------------------- | ------------- | -------------- |
// | scene_witness      | scene_witness     | 禁止（世界事件无说话人） | 必须显式列出在场 NPC | 零写入 |
// | player_told        | player_told       | 禁止（说话人是玩家，不是 NPC） | 必须显式列出被告知的 NPC | 零写入 |
// | npc_revealed       | npc_revealed      | **必填**且必须是已存在 NPC | 必须显式列出被告知的 NPC | 零写入 |
// | public_broadcast   | public_broadcast  | 禁止（公共广播无单一 NPC） | 必须显式列出（「全城」由调用方枚举） | 零写入 |
// | faction_shared     | faction_shared    | 禁止（来源是阵营，成员解析属调用方） | 必须显式列出（阵营成员由调用方枚举） | 零写入 |
//
// `change` 三取值同样逐一定义：`discovered` / `revealed` → 按 audience 写入；
// `hidden` → **零写入**（隐藏是披露策略，只能走 `setNpcKnowledgeDisclosure`）。
// 关键推论：**sourceNpcId 不等于 audience**——NPC 透露某事实不会让它因此自动知道
// 该事实，也不会让它把事实扩散给任何其他 NPC；要写它必须显式列进 audience。
//
// ## 未受信字符串一律走闭集查表
// `mode`、`certainty`、`disclosure`、`change`、以及 audience 里的 NPC ID 都可能来自
// 持久化 JSON 或 AI 输出。所有以这些字符串为键的表读取都必须经 `ownEntry`
// （`hasOwnProperty`）：裸下标会读穿 `Object.prototype`，让 "toString" / "constructor" /
// "__proto__" 骗过 `=== undefined` 守门。引用存在性一律用 `Set`（天然不受原型链影响），
// 且上下文集合缺失或非 Set 时直接拒绝，而不是当作「没有引用可查」。
// **引用字段本身也只认自有属性**：`factId` / `sourceNpcId` 必须是自有的非空白字符串
// （`ownString`）。`Object.create({ factId: "fact_1" })` 这类只把引用挂在原型链上的输入
// 不算提供了引用——空白判定守不住继承来的键。
// **同一个对象上只允许一把门**：规则上下文里的 `certainty` / `disclosure` /
// `actionId` / `turnNumber` 与 `references` 的两个集合同样经 `ownField` 读取。
// 邻居走 ownField 而某个字段裸读，等于让继承来的值单独获得「已声明」的资格。
// **组件本体也在契约内**：`knowledge` 不是组件（缺失 / null / 数组 / `entries` 只挂在
// 原型链上）时以 `invalid_component` 收口，绝不逃成裸 `TypeError`——调用方不得为一条
// 规则判断包 try/catch。这不代表可以伪造：本模块仍不 `?? { entries: [] }`，
// 因为零写入的证据是「原样带回调用方那个对象」，没有对象可带回时就让 `knowledge` 为
// `undefined`（`invalid_component` 是结果类型里唯一不带组件的那条臂）。
//
// ## 与 domain 过渡桥的关系（Task 4A 遗留的唯一分叉，见 task-4A-report）
// `src/game/domain/entity/npcProjection.ts` 的 `compileLegacyNpcSync` 里有一份
// `knowledgeSource()` 过渡实现（addedKnowledge → NpcKnowledgeSource）。本模块是它的
// 目标替代，但 domain 不得 import gameplay（`src/dependencyBoundaries.test.ts` 的
// `game/domain` 目录规则机械禁止），因此桥接尚未改为复用这里的构造函数：
// **两份构造同一 source 的实现同时存活，只到 Task 5 拆除过渡桥为止**。
// Task 5 改线后必须删除 `npcProjection.ts` 的 `knowledgeSource()` / `compileKnowledge()`，
// 不要让这份拷贝作为第二事实来源继续存活。
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type UnknownRecord = Readonly<Record<string, unknown>>;

/** 递归冻结：导出的规则表连嵌套行一起冻结，调用方不得在运行时改写。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * 闭集查表：只认**自有**属性。以未受信字符串为键的表一律经此读取——
 * 裸下标会读穿 `Object.prototype`，让 "toString" / "constructor" / "__proto__"
 * 返回一个真值成员，从而骗过 `=== undefined` 的合法性守门（详见文件头）。
 */
function ownEntry<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** 输入对象的字段读取同样只认自有属性：继承来的 `kind` 不算提供了来源。 */
function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as UnknownRecord)[key] : undefined;
}

/**
 * 引用字段：必须是**自有**的非空白字符串。`factId` / `sourceNpcId` 这类引用若只挂在
 * 原型链上（`Object.create({ factId: "fact_1" })`）就不算调用方提供了引用——
 * 否则继承来的键会绕过空白判定，写进一条从未被声明的知识。
 */
function ownString(value: unknown, key: string): string | undefined {
  const field = ownField(value, key);
  return isBlank(field) ? undefined : (field as string);
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function isTurnCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function sameId(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a === b;
}

// ---------------------------------------------------------------------------
// 稳定失败码：只有 code，不带正文、不带 prose
// ---------------------------------------------------------------------------

export type NpcKnowledgeErrorCode =
  | "invalid_component"
  | "invalid_reference_context"
  | "unknown_fact"
  | "unknown_npc"
  | "unknown_source_npc"
  | "invalid_source_kind"
  | "invalid_mode"
  | "invalid_source_npc"
  | "invalid_action_source"
  | "invalid_turn_number"
  | "invalid_certainty"
  | "invalid_disclosure"
  | "invalid_change_kind"
  | "certainty_demotion_rejected"
  | "knowledge_entry_not_found";

/**
 * 除 `invalid_component` 外的拒绝码：它们的失败**一定**原样带回入参组件
 * （对象同一性即零写入的证据）。只有组件本体缺失时才可能没有对象可带回，
 * 所以那两个码在结果类型里分属两条臂。
 */
type RejectedCode = Exclude<NpcKnowledgeErrorCode, "invalid_component">;

function fail<C extends NpcKnowledgeErrorCode = NpcKnowledgeErrorCode>(code: C): { ok: false; code: C } {
  return { ok: false, code };
}

// ---------------------------------------------------------------------------
// 闭集表：certainty 阶梯、source mode 的说话人策略、disclosure 可见性
// ---------------------------------------------------------------------------

/** 确定度阶梯：只有严格更高才允许写入，相等即幂等，更低即拒绝。 */
const CERTAINTY_RANK: Readonly<Record<NpcKnowledgeCertainty, number>> = deepFreeze({
  suspected: 0,
  known: 1,
} as const satisfies Record<NpcKnowledgeCertainty, number>);

/** 阶梯表必须逐项覆盖 domain 的 certainty union：漏一格或多一格都编译失败。 */
export type NpcKnowledgeCertaintyRankLock = Expect<
  IsExactly<keyof typeof CERTAINTY_RANK, NpcKnowledgeCertainty>
>;

function certaintyRank(value: unknown): number | undefined {
  return typeof value === "string" ? ownEntry(CERTAINTY_RANK, value) : undefined;
}

/** mode → 是否允许/要求 `sourceNpcId`。domain 增删 mode 时本表漏一行即编译失败。 */
const MODE_SOURCE_NPC_POLICY: Readonly<Record<FactChangeSource, "required" | "forbidden">> = deepFreeze({
  scene_witness: "forbidden",
  player_told: "forbidden",
  npc_revealed: "required",
  public_broadcast: "forbidden",
  faction_shared: "forbidden",
} as const satisfies Record<FactChangeSource, "required" | "forbidden">);

export type NpcKnowledgeSourceNpcPolicyLock = Expect<
  IsExactly<keyof typeof MODE_SOURCE_NPC_POLICY, FactChangeSource>
>;

/** 表外的 mode（含原型链键名）一律 undefined ⇒ 稳定 invalid_mode。 */
function sourceNpcPolicyOf(mode: unknown): "required" | "forbidden" | undefined {
  return typeof mode === "string" ? ownEntry(MODE_SOURCE_NPC_POLICY, mode) : undefined;
}

/**
 * 知识可见性取值表：`secret` 永不离开主体，`conditional` 必须经显式规则才进
 * 其他 NPC 的读取面（对话/Prompt 的裁决在 Task 4B），只有 `public` 可直接分享。
 */
export const KNOWLEDGE_VISIBILITIES = Object.freeze(["shareable", "rule_required", "withheld"] as const);
export type NpcKnowledgeVisibility = (typeof KNOWLEDGE_VISIBILITIES)[number];

export const KNOWLEDGE_DISCLOSURE_VISIBILITY: Readonly<Record<
  NpcKnowledgeDisclosure,
  Readonly<{ visibility: NpcKnowledgeVisibility; mayEnterOtherNpcProjection: boolean }>
>> = deepFreeze({
  public: { visibility: "shareable", mayEnterOtherNpcProjection: true },
  conditional: { visibility: "rule_required", mayEnterOtherNpcProjection: false },
  secret: { visibility: "withheld", mayEnterOtherNpcProjection: false },
} as const satisfies Record<
  NpcKnowledgeDisclosure,
  Readonly<{ visibility: NpcKnowledgeVisibility; mayEnterOtherNpcProjection: boolean }>
>);

export type NpcKnowledgeDisclosureVisibilityLock = Expect<
  IsExactly<keyof typeof KNOWLEDGE_DISCLOSURE_VISIBILITY, NpcKnowledgeDisclosure>
>;

/** 披露表外值（含未知 disclosure）落到 `withheld`：读不到就是不能说，而不是能说。 */
function visibilityOf(disclosure: unknown): NpcKnowledgeVisibility {
  return typeof disclosure === "string"
    ? ownEntry(KNOWLEDGE_DISCLOSURE_VISIBILITY, disclosure)?.visibility ?? "withheld"
    : "withheld";
}

// ---------------------------------------------------------------------------
// 引用上下文：封闭的两个 ID 集合
// ---------------------------------------------------------------------------

/**
 * 存在性判定的唯一输入。Task 4B 的 mutation 与 Task 5 的传播链必须传入：
 * - `factIds`：EntityStore 中**作为 canonical Fact Entity 存在**的 FactId 集合；
 * - `npcIds`：EntityStore 中存在的 NpcId 集合（target NPC 与 sourceNpcId 共用它）。
 */
export type NpcKnowledgeReferences = Readonly<{
  factIds: ReadonlySet<string>;
  npcIds: ReadonlySet<string>;
}>;

function isIdSet(value: unknown): value is ReadonlySet<string> {
  return value instanceof Set;
}

function checkReferences(references: unknown): RejectedCode | undefined {
  if (typeof references !== "object" || references === null) return "invalid_reference_context";
  // 两个集合同样只认自有属性：挂在原型链上的 ID 集合不算调用方提供了上下文，
  // 否则本文件就会出现「一半字段受信任、一半不受信任」的第二把门。
  const factIds = ownField(references, "factIds");
  const npcIds = ownField(references, "npcIds");
  if (!isIdSet(factIds) || !isIdSet(npcIds)) return "invalid_reference_context";
  return undefined;
}

type KnowledgeComponentGate =
  | Readonly<{ usable: true; knowledge: NpcKnowledgeComponent }>
  | Readonly<{ usable: false; knowledge: NpcKnowledgeComponent | undefined }>;

/**
 * 组件本体判定：`knowledge` 必须是带**自有** `entries` 数组的对象。
 * 缺失 / null / 数组 / `entries` 只挂在原型链上，一律以 `invalid_component` 收口——
 * 规则层的契约是「失败永远是封闭 code」，调用方不得为一个漏传包 try/catch。
 * 但这里绝不 `?? { entries: [] }` 造一份空组件：伪造组件会让漏传看起来像一次成功写入，
 * 而零写入的唯一证据正是「把调用方自己那个对象原样带回」。能带回就带回，
 * 真的没有对象可带回（undefined / null）时才让 `knowledge` 为 undefined。
 */
function gateKnowledgeComponent(value: unknown): KnowledgeComponentGate {
  const isObject = typeof value === "object" && value !== null;
  if (isObject && Array.isArray(ownField(value, "entries"))) {
    return { usable: true, knowledge: value as NpcKnowledgeComponent };
  }
  return { usable: false, knowledge: isObject ? (value as NpcKnowledgeComponent) : undefined };
}

/** 数组元素等非字段引用：只做空白判定，自有判定由 `ownString` 在读取处负责。 */
function textReference(value: unknown): string | undefined {
  return isBlank(value) ? undefined : (value as string);
}

/**
 * 引用存在性判定的**唯一通道**：入参必须是已经过 `ownString` / `textReference`
 * （自有 + 非空白）读出的值。`undefined` 一律按「没有提供引用」处理，
 * 因此集合永远不会被 `Object.prototype` 的成员名（"toString" / "constructor"）按名字命中。
 */
function isKnownFact(references: NpcKnowledgeReferences, reference: string | undefined): boolean {
  return reference !== undefined && references.factIds.has(reference);
}

function isKnownNpc(references: NpcKnowledgeReferences, reference: string | undefined): boolean {
  return reference !== undefined && references.npcIds.has(reference);
}

// ---------------------------------------------------------------------------
// 来源与 entry 构造
// ---------------------------------------------------------------------------

/**
 * 构造 entry 的来源：字段名沿用规则层的 `turnNumber`，由本函数编译成 domain 的
 * `learnedAtTurn`。`FactChangeSource` 与 domain 的 mode union 由 npcComponents 的
 * 编译期锁双向钉住，本模块不另立 mode 名单。
 */
export type NpcKnowledgeSourceInput =
  | Readonly<{ kind: "initial_world"; turnNumber: number }>
  | Readonly<{
      kind: "action";
      mode: FactChangeSource;
      actionId: string;
      turnNumber: number;
      sourceNpcId?: NpcId;
    }>;

export type CreateNpcKnowledgeSourceResult =
  | Readonly<{ ok: true; source: NpcKnowledgeSource }>
  | Readonly<{ ok: false; code: RejectedCode }>;

function checkSpeaker(
  policy: "required" | "forbidden",
  sourceNpcId: unknown,
): RejectedCode | undefined {
  if (policy === "required") return isBlank(sourceNpcId) ? "invalid_source_npc" : undefined;
  return sourceNpcId === undefined ? undefined : "invalid_source_npc";
}

export function createNpcKnowledgeSource(input: NpcKnowledgeSourceInput): CreateNpcKnowledgeSourceResult {
  const kind = ownField(input, "kind");
  if (kind === "initial_world") {
    const turnNumber = ownField(input, "turnNumber");
    if (!isTurnCounter(turnNumber)) return fail("invalid_turn_number");
    return { ok: true, source: Object.freeze({ kind: "initial_world", learnedAtTurn: turnNumber }) };
  }
  if (kind !== "action") return fail("invalid_source_kind");

  const mode = ownField(input, "mode");
  const policy = sourceNpcPolicyOf(mode);
  if (policy === undefined) return fail("invalid_mode");
  const actionId = ownField(input, "actionId");
  if (isBlank(actionId)) return fail("invalid_action_source");
  const turnNumber = ownField(input, "turnNumber");
  if (!isTurnCounter(turnNumber)) return fail("invalid_turn_number");
  const sourceNpcId = ownField(input, "sourceNpcId");
  if (sourceNpcId !== undefined && isBlank(sourceNpcId)) return fail("invalid_source_npc");
  const speakerCode = checkSpeaker(policy, sourceNpcId);
  if (speakerCode !== undefined) return fail(speakerCode);

  return {
    ok: true,
    source: Object.freeze({
      kind: "action",
      mode: mode as FactChangeSource,
      actionId: String(actionId),
      learnedAtTurn: turnNumber,
      ...(sourceNpcId === undefined ? {} : { sourceNpcId: sourceNpcId as NpcId }),
    }),
  };
}

export type CreateNpcKnowledgeEntryInput = Readonly<{
  factId: FactId;
  certainty: NpcKnowledgeCertainty;
  disclosure: NpcKnowledgeDisclosure;
  source: NpcKnowledgeSourceInput;
}>;

export type CreateNpcKnowledgeEntryResult =
  | Readonly<{ ok: true; entry: NpcKnowledgeEntry }>
  | Readonly<{ ok: false; code: RejectedCode }>;

/**
 * entry 构造：只保证形状与闭集取值，引用存在性由 `writeNpcKnowledge` 结合
 * `NpcKnowledgeReferences` 裁决（纯构造函数拿不到 store）。
 */
export function createNpcKnowledgeEntry(input: CreateNpcKnowledgeEntryInput): CreateNpcKnowledgeEntryResult {
  const factId = ownString(input, "factId");
  if (factId === undefined) return fail("unknown_fact");
  // 同一个 input 对象上的读取共用一把门：certainty / disclosure 也只认自有属性。
  const certainty = ownField(input, "certainty");
  if (certaintyRank(certainty) === undefined) return fail("invalid_certainty");
  const disclosure = ownField(input, "disclosure");
  if (typeof disclosure !== "string" || ownEntry(KNOWLEDGE_DISCLOSURE_VISIBILITY, disclosure) === undefined) {
    return fail("invalid_disclosure");
  }
  const created = createNpcKnowledgeSource(input.source);
  if (!created.ok) return fail(created.code);
  return {
    ok: true,
    entry: Object.freeze({
      factId: factId as FactId,
      certainty: certainty as NpcKnowledgeCertainty,
      disclosure: disclosure as NpcKnowledgeDisclosure,
      source: created.source,
    }),
  };
}

// ---------------------------------------------------------------------------
// 条目定位
// ---------------------------------------------------------------------------

/**
 * 既有条目是否仍落在两张闭集表内。表外既有值属于损坏组件，只能由存档 validator
 * 处理：写入口既不修正它，也不得借道把它改写成一个合法值（那是第二条写入通道）。
 */
function isExistingEntryIntact(entry: NpcKnowledgeEntry): boolean {
  return certaintyRank(entry.certainty) !== undefined
    && typeof entry.disclosure === "string"
    && ownEntry(KNOWLEDGE_DISCLOSURE_VISIBILITY, entry.disclosure) !== undefined;
}

/** 组件内按 FactId 取条目：FactId 在单个 NPC 内唯一，故最多一条。 */
export function findKnowledgeEntry(
  knowledge: NpcKnowledgeComponent,
  factId: FactId,
): NpcKnowledgeEntry | undefined {
  return knowledge.entries.find((entry) => sameId(entry.factId, factId));
}

function replaceEntry(
  knowledge: NpcKnowledgeComponent,
  index: number,
  entry: NpcKnowledgeEntry,
): NpcKnowledgeComponent {
  return Object.freeze({
    entries: Object.freeze(knowledge.entries.map((current, at) => (at === index ? entry : current))),
  });
}

function appendEntry(
  knowledge: NpcKnowledgeComponent,
  entry: NpcKnowledgeEntry,
): NpcKnowledgeComponent {
  // 追加而非排序：条目顺序就是该 NPC 的习得顺序，兼容 memory 由它逐字重建。
  return Object.freeze({ entries: Object.freeze([...knowledge.entries, entry]) });
}

// ---------------------------------------------------------------------------
// writeNpcKnowledge
// ---------------------------------------------------------------------------

export type WriteNpcKnowledgeInput = Readonly<{
  /** 知识主体：只写这一个 NPC 的组件，方向性由签名保证。 */
  npcId: NpcId;
  knowledge: NpcKnowledgeComponent;
  factId: FactId;
  certainty: NpcKnowledgeCertainty;
  /** 首次写入才生效：既有条目的披露一律保留，改动只能走 `setNpcKnowledgeDisclosure`。 */
  disclosure: NpcKnowledgeDisclosure;
  source: NpcKnowledgeSourceInput;
  references: NpcKnowledgeReferences;
}>;

export type WriteNpcKnowledgeResult =
  | Readonly<{
      ok: true;
      changed: true;
      reason: "recorded" | "certainty_upgraded";
      knowledge: NpcKnowledgeComponent;
      entry: NpcKnowledgeEntry;
    }>
  | Readonly<{
      ok: true;
      changed: false;
      reason: "already_known";
      knowledge: NpcKnowledgeComponent;
      entry: NpcKnowledgeEntry;
    }>
  | Readonly<{
      ok: false;
      changed: false;
      code: RejectedCode;
      /** 失败与零写入都原样返回入参组件：对象同一性即「没有写入」的证据。 */
      knowledge: NpcKnowledgeComponent;
    }>
  | Readonly<{
      ok: false;
      changed: false;
      /** 组件本体就没提供：唯一可能没有对象可带回的拒绝臂，也绝不伪造一份空组件。 */
      code: "invalid_component";
      knowledge: NpcKnowledgeComponent | undefined;
    }>;

/**
 * 唯一的知识写入入口：自己按 factId 查既有条目，调用方无法跳过查表。
 * 幂等键是 `npcId + factId`；已有条目时只可能升 certainty，`source`、`disclosure`
 * 与既有条目对象一律逐字保留。任何拒绝路径都不产生部分写入。
 */
export function writeNpcKnowledge(input: WriteNpcKnowledgeInput): WriteNpcKnowledgeResult {
  // 入参组件原样使用：绝不 `?? { entries: [] }` 造一份空组件——那会让调用方漏传
  // knowledge 时「成功写入」一条谁也读不到的新知识，而零写入的对象同一性证据也失效。
  const gated = gateKnowledgeComponent(input.knowledge);
  if (!gated.usable) return { ok: false, changed: false, code: "invalid_component", knowledge: gated.knowledge };
  const knowledge = gated.knowledge;
  const reject = (code: RejectedCode): WriteNpcKnowledgeResult => ({
    ok: false, changed: false, code, knowledge,
  });
  const contextCode = checkReferences(input.references);
  if (contextCode !== undefined) return reject(contextCode);
  // 引用字段一律先过自有属性判定：挂在原型链上的 factId / npcId 不算提供了引用。
  if (!isKnownNpc(input.references, ownString(input, "npcId"))) return reject("unknown_npc");
  if (!isKnownFact(input.references, ownString(input, "factId"))) return reject("unknown_fact");

  const created = createNpcKnowledgeEntry(input);
  if (!created.ok) return reject(created.code);
  const entry = created.entry;
  // 说话人只可能出现在 npc_revealed 上（createNpcKnowledgeSource 已按 mode 策略裁决），
  // 因此这里只需判定「提供了引用 ⇒ 引用必须存在」。
  const speakerId = entry.source.kind === "action" ? ownString(entry.source, "sourceNpcId") : undefined;
  if (speakerId !== undefined && !isKnownNpc(input.references, speakerId)) return reject("unknown_source_npc");

  const index = knowledge.entries.findIndex((current) => sameId(current.factId, entry.factId));
  if (index < 0) {
    const next = appendEntry(knowledge, entry);
    return { ok: true, changed: true, reason: "recorded", knowledge: next, entry };
  }
  const existing = knowledge.entries[index]!;
  if (!isExistingEntryIntact(existing)) {
    // 既有组件里的表外既有取值：写入口绝不借道改写，交由存档 validator 处理。
    return reject("knowledge_entry_not_found");
  }
  const incomingRank = certaintyRank(entry.certainty)!;
  const existingRank = certaintyRank(existing.certainty)!;
  if (incomingRank === existingRank) {
    return { ok: true, changed: false, reason: "already_known", knowledge, entry: existing };
  }
  if (incomingRank < existingRank) return reject("certainty_demotion_rejected");
  const upgraded: NpcKnowledgeEntry = Object.freeze({ ...existing, certainty: entry.certainty });
  return {
    ok: true, changed: true, reason: "certainty_upgraded",
    knowledge: replaceEntry(knowledge, index, upgraded), entry: upgraded,
  };
}

// ---------------------------------------------------------------------------
// setNpcKnowledgeDisclosure
// ---------------------------------------------------------------------------

export type SetNpcKnowledgeDisclosureInput = Readonly<{
  npcId: NpcId;
  knowledge: NpcKnowledgeComponent;
  factId: FactId;
  disclosure: NpcKnowledgeDisclosure;
  /** 披露改动同样必须引用真实行动证据；条目来源保持不变（首次来源是历史）。 */
  actionId: string;
  turnNumber: number;
  references: NpcKnowledgeReferences;
}>;

export type SetNpcKnowledgeDisclosureResult =
  | Readonly<{
      ok: true;
      changed: true;
      reason: "disclosure_set";
      knowledge: NpcKnowledgeComponent;
      entry: NpcKnowledgeEntry;
    }>
  | Readonly<{
      ok: true;
      changed: false;
      reason: "already_disclosure";
      knowledge: NpcKnowledgeComponent;
      entry: NpcKnowledgeEntry;
    }>
  | Readonly<{ ok: false; changed: false; code: RejectedCode; knowledge: NpcKnowledgeComponent }>
  | Readonly<{
      ok: false;
      changed: false;
      code: "invalid_component";
      knowledge: NpcKnowledgeComponent | undefined;
    }>;

/**
 * 披露的唯一改动通道：只动 `disclosure`。未知 Fact、NPC 不存在、非法取值、
 * 缺证据以及「该 NPC 并不知道这件事」都零写入——本函数绝不隐式创建条目。
 */
export function setNpcKnowledgeDisclosure(
  input: SetNpcKnowledgeDisclosureInput,
): SetNpcKnowledgeDisclosureResult {
  // 与写入口同一把门：组件本体缺失也不能逃成裸 TypeError。
  const gated = gateKnowledgeComponent(input.knowledge);
  if (!gated.usable) return { ok: false, changed: false, code: "invalid_component", knowledge: gated.knowledge };
  const knowledge = gated.knowledge;
  const reject = (code: RejectedCode): SetNpcKnowledgeDisclosureResult => ({
    ok: false, changed: false, code, knowledge,
  });
  const contextCode = checkReferences(input.references);
  if (contextCode !== undefined) return reject(contextCode);
  if (!isKnownNpc(input.references, ownString(input, "npcId"))) return reject("unknown_npc");
  // disclosure / actionId / turnNumber 与 factId 走同一把门：继承来的值一律不算提供，
  // 否则「只挂在原型链上的一份 evidence」就能推动一次真实的披露写入。
  const disclosure = ownField(input, "disclosure");
  if (typeof disclosure !== "string"
    || ownEntry(KNOWLEDGE_DISCLOSURE_VISIBILITY, disclosure) === undefined) {
    return reject("invalid_disclosure");
  }
  const actionId = ownString(input, "actionId");
  if (actionId === undefined) return reject("invalid_action_source");
  const turnNumber = ownField(input, "turnNumber");
  if (!isTurnCounter(turnNumber)) return reject("invalid_turn_number");
  const factId = ownString(input, "factId");
  if (!isKnownFact(input.references, factId)) return reject("unknown_fact");

  const existing = findKnowledgeEntry(knowledge, factId as FactId);
  if (existing === undefined || !isExistingEntryIntact(existing)) return reject("knowledge_entry_not_found");
  if (sameId(existing.disclosure, disclosure)) {
    return { ok: true, changed: false, reason: "already_disclosure", knowledge, entry: existing };
  }
  const index = knowledge.entries.indexOf(existing);
  const next: NpcKnowledgeEntry = Object.freeze({ ...existing, disclosure: disclosure as NpcKnowledgeDisclosure });
  return {
    ok: true, changed: true, reason: "disclosure_set",
    knowledge: replaceEntry(knowledge, index, next), entry: next,
  };
}

// ---------------------------------------------------------------------------
// FactChange.source / audience → 接收者写入
// ---------------------------------------------------------------------------

/** 规则上下文：本轮已提交行动的真实证据（Task 2 桥接时落地的签名，不重复存进 FactChange）。 */
export type NpcKnowledgeBroadcastRequest = Readonly<{
  actionId: string;
  turnNumber: number;
  /** `npc_revealed` 的透露者：只记进接收条目的来源，绝不自动成为 audience 成员。 */
  speakerNpcId?: NpcId;
  /** 缺省 "known" / "public"；需要「怀疑」或保密时必须显式声明。 */
  certainty?: NpcKnowledgeCertainty;
  disclosure?: NpcKnowledgeDisclosure;
}>;

/** 可直接交给 `writeNpcKnowledge` 的一条接收者写入。 */
export type FactChangeKnowledgeWrite = Readonly<{
  npcId: NpcId;
  factId: FactId;
  certainty: NpcKnowledgeCertainty;
  disclosure: NpcKnowledgeDisclosure;
  source: NpcKnowledgeSourceInput;
}>;

export type FactChangeKnowledgeSkipped = Readonly<{ npcId: NpcId; code: NpcKnowledgeErrorCode }>;

export type FactChangeKnowledgeResult =
  | Readonly<{
      ok: true;
      writes: readonly FactChangeKnowledgeWrite[];
      skipped: readonly FactChangeKnowledgeSkipped[];
      /** 仅在零写入时出现，说明是「无 audience」还是「非新增类变化」，不是错误。 */
      reason?: "no_audience" | "change_is_not_additive";
    }>
  | Readonly<{ ok: false; code: NpcKnowledgeErrorCode; writes: readonly []; skipped: readonly [] }>;

/** `change` 的三取值逐一定义：表外值（含原型链键名）走 invalid_change_kind。 */
const ADDITIVE_CHANGE_KINDS: readonly string[] = Object.freeze(["discovered", "revealed"] as const);
const NON_ADDITIVE_CHANGE_KINDS: readonly string[] = Object.freeze(["hidden"] as const);

type KnowledgeWritesAccepted = Extract<FactChangeKnowledgeResult, Readonly<{ ok: true }>>;

function emptyWrites(): KnowledgeWritesAccepted {
  return { ok: true, writes: Object.freeze([]), skipped: Object.freeze([]) };
}

function rejected(code: NpcKnowledgeErrorCode): FactChangeKnowledgeResult {
  return { ok: false, code, writes: Object.freeze([]), skipped: Object.freeze([]) };
}

/**
 * 纯映射：把一条 `FactChange` 折叠成「哪些 NPC 因这次行动知道这条 Fact」。
 * 无 audience、未知 Fact、非法 source、非法证据一律零写入；audience 中不存在的
 * NPC 单独进 `skipped`，不影响同一条 audience 里其他合法 NPC。
 * 传播链的改线（直接调 mutation 而非过渡桥）属于 Task 5。
 */
export function knowledgeWritesFromFactChange(
  change: FactChange,
  request: NpcKnowledgeBroadcastRequest,
  references: NpcKnowledgeReferences,
): FactChangeKnowledgeResult {
  const contextCode = checkReferences(references);
  if (contextCode !== undefined) return rejected(contextCode);
  // 规则上下文的每个字段都只认自有属性：本函数对 request 不存在「一半受信、一半不受信」。
  const actionId = ownString(request, "actionId");
  if (actionId === undefined) return rejected("invalid_action_source");
  const turnNumber = ownField(request, "turnNumber");
  if (!isTurnCounter(turnNumber)) return rejected("invalid_turn_number");

  const changeKind = ownField(change, "change");
  if (typeof changeKind !== "string"
    || (!ADDITIVE_CHANGE_KINDS.includes(changeKind) && !NON_ADDITIVE_CHANGE_KINDS.includes(changeKind))) {
    return rejected("invalid_change_kind");
  }
  if (NON_ADDITIVE_CHANGE_KINDS.includes(changeKind)) {
    return { ...emptyWrites(), reason: "change_is_not_additive" };
  }

  const mode = ownField(change, "source");
  const policy = sourceNpcPolicyOf(mode);
  if (policy === undefined) return rejected("invalid_mode");
  const factId = ownString(change, "factId");
  if (!isKnownFact(references, factId)) return rejected("unknown_fact");

  // 缺省值同样只认自有属性：继承来的 certainty / disclosure 是「没有声明」，
  // 既不能被当作调用方的显式选择，也不该因此被判成非法取值。
  const certainty = ownField(request, "certainty") ?? "known";
  if (certaintyRank(certainty) === undefined) return rejected("invalid_certainty");
  const disclosure = ownField(request, "disclosure") ?? "public";
  if (typeof disclosure !== "string" || ownEntry(KNOWLEDGE_DISCLOSURE_VISIBILITY, disclosure) === undefined) {
    return rejected("invalid_disclosure");
  }

  const audience = ownField(change, "audience");
  if (!Array.isArray(audience) || audience.length === 0) {
    return { ...emptyWrites(), reason: "no_audience" };
  }

  const speaker = ownField(request, "speakerNpcId");
  if (policy === "forbidden" && speaker !== undefined) return rejected("invalid_source_npc");
  if (policy === "required") {
    const speakerId = ownString(request, "speakerNpcId");
    if (speakerId === undefined) return rejected("invalid_source_npc");
    if (!isKnownNpc(references, speakerId)) return rejected("unknown_source_npc");
  }

  const source: NpcKnowledgeSourceInput = {
    kind: "action",
    mode: mode as FactChangeSource,
    actionId,
    turnNumber,
    ...(speaker === undefined ? {} : { sourceNpcId: speaker as NpcId }),
  };
  const writes: FactChangeKnowledgeWrite[] = [];
  const skipped: FactChangeKnowledgeSkipped[] = [];
  const seen = new Set<string>();
  for (const npcId of audience) {
    if (seen.has(String(npcId))) continue;
    seen.add(String(npcId));
    if (!isKnownNpc(references, textReference(npcId))) {
      skipped.push(Object.freeze({ npcId: npcId as NpcId, code: "unknown_npc" }));
      continue;
    }
    writes.push(Object.freeze({
      npcId: npcId as NpcId,
      factId: factId as FactId,
      certainty: certainty as NpcKnowledgeCertainty,
      disclosure: disclosure as NpcKnowledgeDisclosure,
      source,
    }));
  }
  return {
    ok: true,
    writes: Object.freeze(writes),
    skipped: Object.freeze(skipped),
    ...(writes.length === 0 && skipped.length === 0 ? { reason: "no_audience" as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// 读取面：Task 4B 的 projectNpcRuntimeProfile 与 Task 8 的说话权威共用
// ---------------------------------------------------------------------------

/** 该条目能否进入其他 NPC / Prompt 的读取面。 */
export function knowledgeVisibilityOf(entry: NpcKnowledgeEntry): NpcKnowledgeVisibility {
  return visibilityOf(entry.disclosure);
}

export type NpcKnowledgeVisibilityPartitions = Readonly<{
  /** public：可直接进可说 Fact cards。 */
  shareable: readonly NpcKnowledgeEntry[];
  /** conditional：必须由显式规则（关系档位、任务阶段）放行。 */
  ruleRequired: readonly NpcKnowledgeEntry[];
  /** secret：只属于本 NPC，永不出现在其他 NPC 的投影里。 */
  withheld: readonly NpcKnowledgeEntry[];
}>;

/**
 * 只分区主体自己的条目，不扫描任何其他 NPC 的组件——「secret 不进其他 NPC 投影」
 * 因此是结构性成立的，而不是靠调用方记得过滤。顺序沿用组件顺序（习得顺序）。
 */
export function partitionKnowledgeByVisibility(knowledge: NpcKnowledgeComponent): NpcKnowledgeVisibilityPartitions {
  const shareable: NpcKnowledgeEntry[] = [];
  const ruleRequired: NpcKnowledgeEntry[] = [];
  const withheld: NpcKnowledgeEntry[] = [];
  for (const entry of knowledge.entries) {
    const visibility = knowledgeVisibilityOf(entry);
    if (visibility === "shareable") shareable.push(entry);
    else if (visibility === "rule_required") ruleRequired.push(entry);
    else withheld.push(entry);
  }
  return Object.freeze({
    shareable: Object.freeze(shareable),
    ruleRequired: Object.freeze(ruleRequired),
    withheld: Object.freeze(withheld),
  });
}
