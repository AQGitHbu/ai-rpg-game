import { STORY_INTERACTION_OPERATIONS } from "@/game/domain/storyInteraction";

/** The provider contract mirrors the existing closed rules, not a free patch DSL. */
export function storyInteractionPrompt(opening: boolean): string {
  return [
    "可选顶层 interactionProposals：需要让选择产生明确保密/引荐/核验/告知后果时提出；仅写 talk 文案不产生这些规则后果。",
    `operation 只能为 ${STORY_INTERACTION_OPERATIONS.join("、")}。`,
    '每项精确为 {"proposalKey":"局部唯一key","npcId":"焦点NPC ID","operation":"上述枚举","condition":[],"factIds":[],"goalIds":[],"promiseId":null,"audienceIds":["player_0"],"evidenceEventIds":[]}。不得输出 id 或状态 patch。',
    "condition 只允许 has_item{itemId,ownerId}、knows_fact{actorId,factId}、promise_status{npcId,promiseId,status}、goal_status{npcId,goalId,status}，各项还必须有 kind。所有引用必须来自提供的权威 ID；不确定条件时不要编造 ID。",
    "promise_confidentiality 是玩家向 NPC 作出保密承诺，factIds 可以为空；request_introduction/request_verification 的 factIds 非空且 NPC 必须已知，audienceIds 为实际听众且不可包含说话 NPC、不能为空。share_known_fact 是玩家向当前NPC分享玩家已知事实，audienceIds 必须包含目标NPC且全部为同场NPC；不要求目标NPC预先知道，不允许远程或玩家自己作为听众。request_verification 必须有真实已提交 evidenceEventIds，不能以待发生事件自证。goalIds/promiseId 未引用已有目标或承诺时用 []/null。",
    '保密互动另须 confidentiality:{"protectedFactIds":["真实已知事实ID"],"allowedAudienceIds":["player_0","当前NPC ID"],"fulfillment":{"kind":"story_delivery"}}。它保护指定信息，允许名单外的实际披露会违约，直到本故事递送契约中的物品显式交给已绑定接应人才履行；未来NPC无需提前创建。普通任务完成或最终相信不能消除此承诺。引荐须另提 request_introduction，用 promise_status 引用已成立承诺的真实ID与open状态；许诺本身不会引荐。',
    '如玩家准备归还本局递送物，且 delivery.giverNpcId 当前在场、delivery.itemId 仍由玩家持有，可提出唯一 give_item:<itemId>:<giverNpcId> 返还 continuation，并以该step为next_decision终点、提供两个合法后续talk候选。只审批权威绑定对象，不能用任意物品或NPC代替；返还仍需玩家实际选择give_item，解除委托另选abandon_quest。',
    "新提出互动尚未执行：正文不可写成已保密、已核验、已告知或已交付；只有玩家选择并经规则结算才产生结果。私密事实不得因出现在提案条件/引用中就写进当前台词。",
    opening
      ? '开局 npcId="npc_0"；事实 ID 为目录索引 fact_N；开局尚无可供 provider 引用的 runtime EventId，不能编造 verification 证据。choices 可选 situation.responses 的 key 或同包 "interaction:"+proposalKey，总数仍为二；优先给当前冲突的两项实际回应。'
      : "决策包先安装有效提案再由服务器重建候选图；新提案 choices 用 interaction:proposalKey 显式绑定该操作，不能按位置猜测或交换。同包 @new 实体只能引用合法 worldDelta 实际建立的符号；已有互动使用图中精确 candidateId。已有互动以提供的 operation/condition 为准，不能用核验文案冒充闲聊或另一操作。",
  ].join("\n");
}
