# 运行时 AI 导演与场景表演

## 系统定位

Phase 10 建立第一条真实运行时 AI 剧情闭环：玩家从两个服务端批准的固定选项中选择，既有规则先裁决对应行动并持久化下一幕的 pending 标记；世界导演、剧情编剧和当前 NPC 随后以三份不同知识权限生成场景，后台任务再用 CAS 保存为 ready。

## 当前状态

- 状态：真实链路与双模式完整旅程已实现（in_progress，待 Phase 10 最终阶段交接）。
- Spec：`docs/superpowers/specs/2026-07-30-runtime-ai-director-scene-performance-design.md`。
- 唯一 Plan：`docs/superpowers/plans/2026-07-30-mvp-phase-10-runtime-ai-director.md`。
- 当前实现已合入主仓 `main`。
- 修改范围：仅 `ai-rpg-game`；复用现有 `@ai-game/ai-transport@0.1.0` public API，不改 foundation。

## 已冻结设计

- 三个逻辑角色也是三个独立 AI 请求：
  - director：全局剧情、隐藏事实、任务结构、当前内容预算和合法行动候选；
  - writer：已批准导演计划、相关剧情真相、角色动机和两个已批准行动；
  - npc：自己的档案、获准使用且属于 `knownFactIds` 的事实、表演指令和有限历史。
- 客户端只提交 `choiceToken + revision`，不获得 actionKey、事实 ID、导演计划、生成来源或 diagnostics。
- 两个选项必须映射两个不同且当前合法的既有 `AvailableAction`；AI 不能创建行动语义。
- 规则 resolver、quest reconciliation、battle、ending 和 SQLite CAS 继续独占正式状态写入。
- 每个角色最多三次有界尝试；只重试当前失败角色，不重跑已经批准的上游角色。耗尽后整场使用确定性 fallback，不拼接部分 AI 输出。
- active battle、ending 或合法非战斗行动少于两个时，不生成普通 narrative scene。
- Phase 10 中“新人物/地点/道具”只表示首次向玩家引入开局蓝图已有实体；不运行时追加蓝图 ID。
- 不做自由输入、意图解析 AI、streaming、AI 图片、语音或视觉描述生成。
- 美术只保留后续 `VisualAssetPort` 的设计方向；本阶段不创建未使用 production port，继续使用本地 SVG。

## 已实现的运行时约束

- 三个角色使用独立真实请求，均关闭 provider 思考模式，单次 timeout 为 120 秒。
- provider 不支持 guided grammar（缺少 `xgrammar`），因此使用 prompt-only JSON、严格本地解析和审批。
- source 在审批前只做机械归一化：action key、NPC ID、fact ID 从最小上下文复制；writer/NPC 的枚举和长度收敛到领域 schema；不修改场景叙述、NPC 正文、选项策略或任何规则结果。
- `narrative_choice` 解出 `start_battle` 后进入正式 battle facade；AI 不能直接启动战斗或决定胜负。
- provider 延迟不会阻塞创建或 choice 请求。pending 场景经 `POST /api/game/narrative/ensure` 触发，客户端每 750ms 读取 current-game；进程重启后同一 pending 标记可恢复。进程内 coordinator 只负责单飞，不承担可靠队列语义。

## 小镇空间语义上下文（townSpatial）

- 当当前地点为已就绪的 town（`scale === "town"` 且 `GameState.towns` 已含该地点）时，`toDirectorContext` / `toSceneScriptContext`（`runtimeNarrativeContexts.ts`）注入可选 `townSpatial?: TownSpatialContext`，使导演与编剧可引用建筑位置关系（如“铁匠铺位于大石镇北侧”）。
- `TownSpatialContext = { townName; sentences: readonly string[]; buildings: readonly { displayName; area; buildingType }[] }`：由 `projectTownLayerView` 的 `semanticView` 投影，**只含方位/邻近的确定性句子，不含坐标、seed、footprint、planKey**，继续遵守“不把完整 blueprint/GameState 作为通用 AI 上下文”。
- 非 town 地点或 town 未就绪时，`townSpatial` 为 `undefined`（条件 spread，不写入 context）；context 对象直接序列化作为 prompt 载荷，无需单独改 prompt builder。详见 `docs/agent/小镇程序化生成.md`。

## 双模式完整旅程

- `npm run journey:phase10` 从 `data/fixtures/phase10-journey/v1/` 零网络回放 14 条真实 AI 候选。
- 每条回放按角色、全局顺序、契约版本和安全上下文 hash 匹配，且仍重新经过 director/writer/NPC 审批。
- 完整覆盖 6 次 choiceToken、2 次 NPC 台词、3 个首次到访地点、1 个首次交谈 NPC、1 个道具、战斗和成功结局。
- `RUN_REAL_AI_JOURNEY=1 npm run smoke:ai:phase10-journey` 才会真实调用；默认只写 `artifacts/phase10-journey/<run-id>/`，真实旅程成功后立即执行一次零网络 replay，二者都通过才落盘。
- fixture 只保存解析后的候选、角色/顺序和上下文 hash；不保存 prompt、原始 provider 输出、URL、Key 或完整隐藏状态。
- `sceneId` 和 `choiceToken` 是跨运行波动标识，不参与上下文 hash；地点、事件、候选动作、NPC/事实卡和批准计划继续参与漂移检测。

## 最小运行链路

```text
createGame 初始化规则状态 + narrative pending 一次写入
→ 客户端 POST ensure / 轮询恢复
→ director → 规则批准 → writer → 规则批准 → npc 最小知识表演
→ NarrativeSceneState 以 CAS 写入 ready

narrative_choice(choiceToken, revision)
→ token 解析为当前合法 AvailableAction
→ 既有规则裁决 / quest / ending
→ 规则结果与下一场景 pending 一次 CAS 写入并立即返回
→ 客户端 ensure → director → writer → npc 或完整 fallback
→ 场景以 CAS 写入 ready → GameSessionView 安全投影两个新选项
```

## 验收重点

- 记录型 fixture 证明 NPC 请求不包含未知事实正文和其他 NPC 私密知识。
- writer 请求不包含数据库、provider 配置或无关战斗数值。
- 篡改、过期和重复 choiceToken 零写入。
- AI 开关不改变同一选择对应的确定性规则结果。
- reload 恢复相同场景、NPC 台词和两个选项。
- 日常回归零网络零计费；完整真实认证仅由 `RUN_REAL_AI_JOURNEY=1` 显式开启。

## 修改注意事项

- 不把完整 blueprint、GameState 或 GameRecord 作为通用 AI 上下文。
- NPC prompt builder 只能接受 `NpcPerformanceRequest`，不能接受 blueprint/state 后再“自行过滤”。
- AI 输出先经过 pure approval，再构造新的批准对象；不能把 AI 原对象直接持久化。
- CAS 冲突时丢弃已生成内容，不重复调用 AI。
- pending 时 application 拒绝行动；少于两个合法行动时清除 pending，不让 AI 或 fallback 伪造选项。
- `NarrativeRuntimeState.mode` 由服务端保存：正常局为 `ai`；开发环境“使用已有数据开始”创建 `offline` 局，固定使用 Phase 10 完整旅程的输入/seed，既不调用开局 AI，也不排队运行时 AI。该模式只用于开发现有地图、地点和 NPC UI，不是玩家可配置的 AI 开关。
- Phase 10 的人物、地点、道具首次登场仅能引用既有蓝图 ID；动态创建 ID 是后续独立、受审批的蓝图扩展阶段。
- 真实 smoke 是否执行必须按事实记录，不能把 fixture 通过写成真实调用成功。
