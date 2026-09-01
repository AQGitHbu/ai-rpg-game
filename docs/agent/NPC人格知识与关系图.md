# NPC 人格、知识与关系图（Plan 3 实现事实，待验收）

## 系统定位

Plan 3 将 NPC 的固定人格、动态状态、知识来源、结构化交互、承诺和 NPC→玩家 / NPC→NPC 有向关系边收敛到 Entity Store 的唯一权威组件。对话、调查、赠物、明确 NPC 任务和共同战斗都读取同一投影；AI 只能在创建 NPC 时提出有界材料，不能直接修改既有 NPC 或提交关系数值。

当前实现位于目标分支 `codex/npc-personality-knowledge-relationship-graph`，已完成代码与离线验收，尚未合并 `main`。

## 权威组件

`NpcEntityRecord` 的组件形状固定为：

- `identity`：角色资料与 `NpcIdentityAnchors`（`selfConcept`、`values`、`speechStyle`、`capabilityBoundaries`、`taboos`）。普通场景、关系信号和 `ProposedEntityCommand` 没有更新 anchors 的入口。
- `position`：当前地点引用。
- `dynamicState`：`isCompanion`、`met`、`emotion` 和 1–4 个有状态/优先级的 typed goals。
- `knowledge`：按 `FactId` 唯一的条目，保存 `known/suspected`、`public/conditional/secret` 与 `initial_world` 或真实行动 provenance。
- `relationships`：按 target 唯一、稳定排序的 outgoing directed edges。每条边保存 `affinity/trust/fear/hostility`（均为 `[-100,100]`）、stage、trend、open commitments、最近 12 条 evidence、origin 和最后变更回合。
- `history`：最多 10 条去重的结构化交互，不保存玩家原文。

`NpcEntry/NpcMemory/relationship.affinity` 只由 `projectNpcEntry/projectNpcMemory` 派生为兼容 read model。`importNpcLayers` 是兼容/测试 fixture adapter；生产规则写入走细粒度 `EntityMutation`，不替换整块组件。规则裁决读取面（对话裁决、`give_item` 去重等）消费这份每次提交都重建的兼容 read model；`projectNpcRuntimeProfile`（npcMemory facade）是单测锁定的统一读取投影，其知识可见性分区与台词权威同源，但规则路径不直接调用它——唯一权威事实源始终是 Entity Store 分层组件，不存在第二状态源。

## 创建、知识与关系规则

- opening NPC 与 world-delta 新 NPC 必须通过 anchors/goals parser 和 approval；动态 NPC 的 `relationshipSeeds` 只接受既有 active NPC、定性 stance 和有界 reason。服务器铸造 goal/source/evidence/commitment ID 与固定 reason key。
- seed 只创建 `newNpc → targetNpc`，不自动创建 `targetNpc → newNpc`。关系 signal 仅来自封闭集合（如 `supported`、`challenged`、`threatened`、`gave_item`、`shared_fact`、`fought_together`、承诺信号），AI 不提交 numeric delta、stage 或 patch。
- `normal/major` signal 受单维与总变化 cap、stage 邻接迁移、action 幂等和 evidence 上限约束；每个 action 对同一边最多一档。`debt/promise` 只经封闭 open/fulfill/forgive/break/release 操作改变。
- `FactChange` 的 `audience` 是知识传播边界：没有 audience 不写入；`npc_revealed` 必须携带真实 `sourceNpcId`。同一 NPC 的同一 Fact 只保留一条 entry，certainty 只能从 suspected 升为 known，disclosure 只能由显式规则操作改变。
- action provenance 使用真实 `actionId + turnNumber`；本 Plan 不伪造 `eventId`，稳定事件证据留给 Plan 4。
- `record_npc_interaction` 对同一 `actionId` 重放以 `duplicate_npc_interaction` 硬拒绝（兄弟 mutation 是零写入）；生产重放由 `performTurn` 的 CAS `expectedRevision` 挡住，mutation 批是原子的，不会产生部分状态。
- `cooperative` stage 正向门槛（trust 20 / affinity 20 / 正向证据 1）与对话 `statusFor` 的 hostile-ask `partial_success` 分支是超出计划阈值表的保守补充，用于保留定性语义；`relationshipSignalPolicy.ts` 的 stage 门槛表是唯一数值权威。
- 证据老化后果：每条边只保留最近 12 条证据（`RELATIONSHIP_EVIDENCE_CAP`），被裁掉的旧条目不再阻止同一 `actionId+signal` 重放，`trusted/bonded` 可以仅因证据被淘汰而降档（无需负向信号）；以 `relationshipSignalPolicy.ts` 头部注释为准，不应读作缺陷。

## Speech authority 与隐私

`src/game/application/npcSpeechAuthority.ts` 的 `NpcSpeechAuthority` 是所有 NPC 台词路径共享的引用权限投影。它以 speaker 的 Entity Components、scene-visible FactId、当前目标和该 NPC 的交互历史为输入，输出：

- 可披露/扣留的 FactId 与只含允许正文的 fact cards；`secret` 不会因为 speaker 知道就自动可说，`conditional` 需要足够关系 stage；
- 允许引用的 interaction actionId、最近五条结构化交互、identity anchors、active goals、目标关系 stage/trend/open commitments 和最多三条 evidence key；
- 不包含裸 affinity 数字、其他 NPC 私密事实正文、其他 NPC 历史或玩家自由文本。

`validateNpcSpeechReferences` 对 Fact/Interaction 引用执行格式、重复、speaker 归属、当前可见性和 authority allowlist 校验；引用错误拒绝整包/场景，不静默删除。opening preview、`approveNarrativeBundle`、`approvePreparedContinuation` 和 `approveAndWriteScene` 共用这一把门，所有 line/dialogue 结构都保留 `usedFactIds` 与 `usedInteractionActionIds`。

## 运行时与回滚

- `WorldState.version=4`、`EntityStore.version=2` 严格解析；旧 v3/v1 存档 `UNSUPPORTED_RECORD`，坏嵌套组件 `ENTITY_STATE_INVALID`。
- opening 先以候选编译内存 preview store，再用同一 authority 审批首句，之后才持久化；动态 materialization 使用 approved `npcCreationComponentsById`，不保留 production `legacy_import` 回退。
- 对话、赠物、明确 NPC 任务和共同战斗都通过规则 mutation 作用于同一 store；没有明确参与者时不猜测关系后果。战斗失败/撤退恢复完整战前 store，只有真实参战同伴在胜利后获得 `fought_together`。
- provider 调用白名单、六个 API route、一次生成逐步消费和单次 CAS 语义不变。Prepared continuation 在 v7 生产链外仅作为显式 offline fixture 能力保留。

## 主要文件

- `src/game/domain/entity/npcComponents.ts` — 固定组件、封闭值域和 validator。
- `src/game/domain/entity/npcProjection.ts` — 组件与兼容 NPC read model 的唯一投影/测试 adapter。
- `src/game/gameplay/rpg/npcMemory/npcKnowledge.ts` — FactChange audience、来源、certainty/disclosure 和幂等规则。
- `src/game/gameplay/rpg/npcMemory/relationshipSignalPolicy.ts` — signal、cap、stage、evidence 与 commitment 规则。
- `src/game/gameplay/rpg/entityWorld/entityMutation.ts` — 细粒度关系、承诺、知识和历史 mutation。
- `src/game/application/npcSpeechAuthority.ts`、`src/game/domain/npcSpeechReferences.ts` — 台词引用权限与引用格式校验。
- `src/game/application/focusNpcContext.ts`、`sceneGenerationContext.ts`、四条 approval path — 最小权限上下文和台词审批。
- `src/game/application/testing/npcContinuityJourney.test.ts` — 跨玩法、跨 reload 的离线连续性证明。

## 主要测试与验收

- 组件/存档：`npcComponents.test.ts`、`entityStore.test.ts`、`npcProjection.test.ts`、`sqliteGameRepository.test.ts`。
- 规则：`npcKnowledge.test.ts`、`relationshipSignalPolicy.test.ts`、`entityMutation.test.ts`、`propagateKnownFacts.test.ts`。
- 台词隐私：`npcSpeechAuthority.test.ts`、`focusNpcContext.test.ts`、`approveNarrativeBundle.test.ts`、`approvePreparedContinuation.test.ts`、`approveAndWriteScene.test.ts`、`createGame.test.ts`。
- 连续性：`npcContinuityJourney` 完成离线五幕、至少 18 个成功回合和至少 3 次 reload，覆盖 NPC-to-NPC directed seed、audience 隔离、赠物、明确任务、战斗失败/胜利、prepared continuation 和最终结局；`narrativeGroundingJourney` 同时硬断言物品、战斗和 NPC 响应链，不再允许空内容跳过。

## 后续边界

Plan 4 负责稳定 `eventId`、Event/Episode 与 misinformation/因果模型；Plan 5 负责 Living Outline、Arc、Milestone、Story Thread。长篇 segmented ledger、snapshot/cursor、归档和容量承诺仍需另立 Spec/Plan。本 Plan 不接入 provider 的 `EntityCommand`，不增加 provider 调用或共享 package。

## 最近维护

2026-09-01：Plan 3 代码、测试与离线门禁完成；当前阶段标记为 `implemented / implemented`，人读入口保持“待验收”，目标分支尚未合并 main。

2026-09-01（code review 修复）：重复引用拒绝码 `duplicate_npc_reference` 不再被误归为 `invalid_fact_reference`；过期候选事件丢弃改为发出 `candidate_event_rejected` 审计事件；战斗形状校验器统一收敛到 `src/game/application/battleShapeValidation.ts`；`buildNpcSpeechAuthority` 对未知 speaker 返回 `null`（调用方改为稳定拒绝，不再 try/catch）。统一读取路径的执行偏差已同步记录在 plan 的 Acceptance Checklist。
