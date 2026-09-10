import type { WorldState } from "@/game/domain/worldState";
import type { FactChange } from "@/game/domain/resolvedEvent";
import { PLAYER_ENTITY_ID, type NpcId } from "@/game/domain/worldEntity";
import type { EventId } from "@/game/domain/events";
import { eventIdFor, type NarrativeEventDraft, type TurnId } from "@/game/domain/events";
import {
  applyEntityMutations,
  EntityMutationInvariantError,
  knowledgeReferences,
  type EntityMutation,
} from "@/game/gameplay/rpg/entityWorld";
import type { NpcEntityRecord } from "@/game/domain/entity";
import { knowledgeWritesFromFactChange } from "@/game/gameplay/rpg/npcMemory";

// ---------------------------------------------------------------------------
// P4 Step 1：把本轮 discovered/revealed 事实传播给在场 NPC（Task 5B 改线）。
// 写入只走窄通道 record_npc_knowledge：一条 entry 一支 mutation，绝不整块替换组件。
//
// 「哪种 mode 要求/禁止说话人」「change 是不是新增类」「audience 里谁不存在」「同一
// Fact 第二次到达保留哪个来源」全部由 npcMemory 的 knowledgeWritesFromFactChange 与
// writeNpcKnowledge 裁决——它们是 mode/speaker/additive/幂等策略的唯一所有者，本文件
// 一条都不重算（重算就是第二事实来源，Task 4A 起就是这么定的）。
// Fact 与 NPC 的存在性取 knowledgeReferences：entityWorld 为 record_npc_knowledge 派生
// 引用上下文的同一份 active-only canonical 集合。两侧共用一把尺子，才不会出现
// 「传播按兼容读模型放行、写入按 canonical 集合拒绝」的分叉。
//
// `deps.speakerNpcId` 目前没有生产调用方（R5-4a）：规则层对无说话人的 npc_revealed 一律
// 整条拒绝，而改线之前这条是写得下去的，所以说话人必须由调用方给、不能凭空推——真正的
// NPC↔NPC 透露生产者属 Task 5C / Task 6。
// ---------------------------------------------------------------------------

export function propagateKnownFacts(
  ws: WorldState,
  factChanges: readonly FactChange[],
  deps: Readonly<{ actionId: string; turnNumber: number; eventId: EventId; turnId?: TurnId; speakerNpcId?: NpcId; stagedNarrative?: boolean }>,
): WorldState {
  return propagateKnownFactsWithDrafts(ws, factChanges, deps).worldState;
}

export type PropagateKnownFactsResult = Readonly<{
  worldState: WorldState;
  drafts: readonly NarrativeEventDraft[];
}>;

/** Apply knowledge writes and return the matching event drafts for the same turn batch. */
export function propagateKnownFactsWithDrafts(
  ws: WorldState,
  factChanges: readonly FactChange[],
  deps: Readonly<{ actionId: string; turnNumber: number; eventId: EventId; turnId?: TurnId; speakerNpcId?: NpcId; stagedNarrative?: boolean }>,
): PropagateKnownFactsResult {
  if (factChanges.length === 0) return { worldState: ws, drafts: [] };
  // staged 叙事模式（Plan Task 4 Step 4）：计划披露的认知不在这里自动写入——
  // collectDisclosures 核对过的观察在整包发布消费时（Task 9）才转成真实事件提交，
  // 避免 talk 规则阶段抢先把尚未发布的剧情披露写进权威知识组件。
  if (deps.stagedNarrative === true) return { worldState: ws, drafts: [] };

  const references = knowledgeReferences(ws.entityStore.records);
  const mutations: EntityMutation[] = [];
  const drafts: NarrativeEventDraft[] = [];
  for (const change of factChanges) {
    // 规则层的结果只有三种对待方式，且逐条对应改线前的可观察行为：
    // - ok:false ⇒ 整条 change 零写入，继续下一条。这正是改线前对非法来源与未知 fact 的
    //   `continue`；缺说话人或说话人不存在时的 npc_revealed 也落在这一支——它是**全有或全无**，
    //   连同本条合法的听众一起不写，因为 knowledgeWritesFromFactChange 就是这么契约化的，
    //   本层不把它软化掉（R5-4a）。
    // - skipped[] ⇒ 只有那个 audience 成员不存在，同条其他成员照写。
    // - reason: no_audience / change_is_not_additive ⇒ 合法零写入，不是错误。
    // code 与 skipped 都不上浮：本函数的签名只回一个 WorldState，没有承载逐条诊断的通道，
    // 这是改线之前就存在的局限，不在此发明新返回形状去绕开它。
    const mapped = knowledgeWritesFromFactChange(change, deps, references);
    if (!mapped.ok) continue;
    for (const write of mapped.writes) {
      const foundRecord = ws.entityStore.records.find((record) =>
        record.core.kind === "npc" && String(record.core.id) === String(write.npcId));
      const npcRecord: NpcEntityRecord | undefined = foundRecord !== undefined && foundRecord.core.kind === "npc"
        ? foundRecord as NpcEntityRecord
        : undefined;
      const existing = npcRecord === undefined
        ? undefined
        : npcRecord.knowledge.entries.find((entry) => String(entry.factId) === String(write.factId));
      const changesKnowledge = existing === undefined
        || (existing.certainty === "suspected" && write.certainty === "known");
      const eventKey = `npc_knowledge_changed:${write.npcId}:${write.factId}:${deps.actionId}`;
      const writeEventId = deps.turnId === undefined ? deps.eventId : eventIdFor(deps.turnId, eventKey);
      const source = { ...write.source, eventId: writeEventId };
      // certainty / disclosure / source 一律照映射结果原样交给写入面：来源策略不在这里再判一次。
      mutations.push({
        kind: "record_npc_knowledge",
        npcId: write.npcId,
        factId: write.factId,
        certainty: write.certainty,
        disclosure: write.disclosure,
        source,
      });
      if (changesKnowledge) {
        const sourceNpcId = source.kind === "action" ? source.sourceNpcId : undefined;
        drafts.push({
          eventKey,
          episodeKey: "turn",
          actorIds: sourceNpcId === undefined ? [PLAYER_ENTITY_ID] : [sourceNpcId],
          targetIds: [write.npcId],
          locationId: ws.currentLocationId,
          causeKeys: [],
          factIds: [write.factId],
          questIds: [],
          outcome: "success",
          salience: 30,
          payload: {
            type: "npc_knowledge_changed",
            npcId: write.npcId,
            factId: write.factId,
            change: existing === undefined ? "learned" : "certainty_upgraded",
          },
        });
      }
    }
  }

  // 零写入的唯一证据仍是「原样带回调用方那个对象」：幂等来自权威的 changed:false，
  // 而不是本地再去重（改线前的 Map + 兼容 knownFactIds 过滤器两者都在这里被删掉）。
  if (mutations.length === 0) return { worldState: ws, drafts: [] };
  // 存在性与说话人已按 canonical 引用集合预筛。certainty 只可能来自 deps 的缺省：本层签名不提供该
  // 字段，默认 known 是映射面 npcKnowledge 给的，本层只是原样转发。R5-4b 已定归属——将来要实现
  // 「传闻不得硬化」，是在调用方传 certainty，不是回来加预筛过滤器；那一天这一支必须改成逐条失败处理，
  // 不能整批抛。所以此刻整批被拒只剩「存档本身不合法」或有人新增了本层看不到的写入条件：真不变量违背，
  // 不再是改线前那种「拿合法输入也会撞墙」的正常路径。
  const applied = applyEntityMutations(ws, mutations);
  if (!applied.ok) throw new EntityMutationInvariantError(applied);
  return { worldState: applied.worldState, drafts };
}
