# P3 Plan 独立审阅与修订

## 范围与结论

按用户要求，由一个独立子智能体只读审阅提交 `8157011e` 的 [P3 Plan](../plans/2026-09-15-narrative-architecture-p3.md)、关联总 Spec、范围报告和相关生产代码；主智能体核实发现并修订文档。审阅没有执行 P3 实现、测试旅程或真实 API。

发现四项高优先级契约缺口和一项中优先级范围缺口，均在原 Plan 内修订。范围仍是主动证据、目标与合作后果、两类受控生成和完整短篇；没有增加互动 operation、房间移动系统、检索器或生成器。工程与玩法完成条件和文学质量独立报告的口径保持。

## 发现与处理

下列 Plan 行号指原审阅提交 `8157011e`，源码路径相对仓库根；修订后的接口与执行步骤只在 Plan 维护。

| 编号 | 优先级与原问题 | 代码依据及影响 | 文档修订 |
| --- | --- | --- | --- |
| R1 | 高：同批新目标没有统一引用契约，原 Task 3 第 212–225 行只有绑定目标用的 goalOrdinal | `src/game/application/approveNarrativeBundle.ts:240` 仅解析 goal_status 的 NPC ID，原样保留 goalId；新目标由 compiler 铸造，调查/任务/互动无法可靠引用 | Task 3 区分 provider 条件和正式条件，所有条件消费者通过同一映射取得真实 goalId；补同批新目标、跨角色和越界测试 |
| R2 | 高：合作可以换 proposalKey 重建无门槛版本，原第 54–56、195、235 行没有跨 job 的权威约束 | `src/game/application/approveNarrativeBundle.ts:331` 按 job/key 铸互动 ID，`src/game/gameplay/rpg/entityWorld/entityMutation.ts:924` 只按完整 ID 去重；目标 blocked 后可能重开合作 | Task 2/3/5 将引荐、核验的不可变静态前提与效果范围保存在 NPC；以 NPC＋operation 限定身份，具体提案只能受同一门槛约束。定义可先批准，实际互动须等知识与真实事件成立后安装；不预授知识、不造未来 EventId |
| R3 | 高：其他发现入口可以跳过调查，原第 62、122、133、231 行及 C1 只充分限制自动 helper | `src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.ts:156` 的信息互动及 `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts:110` 都能直接 discover_fact；随后调查目标满足，实际调查被重复校验拒绝 | Task 1 统一显式调查来源与披露门槛，覆盖互动、candidate、开局、正文和续接；调查 Fact 表示必须取得的证据，普通可披露内容用普通 Fact，不扩第二套“已听说/已查证”状态 |
| R4 | 高：B 内目标变化后任务/释放/阶段可能未推进，原 Task 6 第 370 行只重建目标和选择 | `src/game/application/generatePendingNarrativeBundle.ts:713` 起的 B 发布没有 A 的任务/释放/阶段后果链；`src/game/application/server/ai/narrativeDraftProjection.ts:94` 又在最终审批前按旧状态固定 slots | Task 6 增加 A/B 共用的有界纯后果组合，并前移到正式 draft 的动态槽编译；最终审批复算并核对来源/候选版本。本幕完成但缺下一段覆盖时修订或拒绝，不能发布后补状态、重做 Action 或再开生成入口 |
| R5 | 中：同镇不同建筑的见证判断没有玩家位置依据，原 Task 1 第 122 行无法直接实施 | `src/game/domain/entity/entityComponents.ts:16` 只有地点位置，`src/game/domain/townState.ts:18` 的建筑绑定不是玩家进入证据；按 town ID 授知会混淆现场 | 主动调查限定独立 scene；town 的显式调查绑定拒绝，原自动观察保留，不从 UI 选中建筑推断见证 |

合作静态定义是 R2 所需的最小新增规则数据：每 NPC 每种合作 operation 至多一条，只存条件和效果范围，无 permission/status 副本；首次启用后未声明 operation 不回退到无门槛旧模式。它与一次互动的具体证据事件分开，避免尚未调查时无法批准合作规则的循环依赖。

## 执行文档修正

- 将 Task 5/6 中有目录歧义的源码入口改为完整仓库根相对路径，并显式写出 UI 测试路径。
- Task 1 新增 required discoveryMode 后，开局和 worldDelta 的 Fact 创建者必须同时补默认 automatic；已把这些适配前移，确保 Task 1 可独立通过 typecheck，新的 provider 提案仍在 Task 3 实施。
- 总 Spec 与范围核查同步场景限制、固定合作条款和 B 后果一致性；P3 的八个 Task 均仍未执行。

## 验证边界

同一子智能体完成一次定向复核，确认 R1/R2/R3/R5 已实质修复，并指出 R4 的旧固定槽编译仍会提前拒绝候选。主智能体核对 `liveNarrativeBundleSource.ts:474` 与 `narrativeDraftProjection.ts:94–119` 后，将共享预览前移到 draft 编译、补入版本核对与正式 source 装配测试要求；R4 的最后修订由主智能体静态核对。

`npm run check:docs` 通过：0 个错误，1 个既有运行时 AI 文档篇幅提醒。另核对五份变更文档的 75 处本地链接和 Plan 的 144 处源码引用，已有文件路径有效、新文件明确归属 Create；diff 空白检查通过。

本轮验证对象是设计契约与文档入口。修订为后续实现规定了必须复现的失败场景，不能把它们视为已经通过的运行测试；真实规则、权限、恢复与故事完成仍须按 P3 Plan 验收。
