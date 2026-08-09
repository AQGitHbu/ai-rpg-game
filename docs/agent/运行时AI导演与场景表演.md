# 运行时 AI 导演与场景表演

## 系统定位

Phase 10 建立第一条真实运行时 AI 剧情闭环；Phase 14 将其收敛为“一个原子叙事事件”的生成闭环：先由触发上下文锁定对白、调查、物品、战斗、观察或移动中的一种事件，再按该事件生成场景内容。对白选项是 NPC 对话中的玩家回应，世界行动仍由规则行动候选承载。

## 当前状态

- 状态：已实现（Phase 14 P0 + 事件级懒生成，待本分支验收）。
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
- `NarrativeSceneState.event` 只允许一个原子事件：dialogue 绑定一个焦点 NPC；investigate/item/battle 分别绑定一个事实、物品或敌人；travel/observe 绑定一个地点。
- 对白事件的两个选项必须是不同的 `dialogueIntent` 与自然语言回应（例如询问状况、质疑维修），不再伪装成“调查第几条线索”等规则行动；世界事件选项仍必须映射合法 `AvailableAction`。
- 规则 resolver、quest reconciliation、battle、ending 和 SQLite CAS 继续独占正式状态写入。
- 每个角色最多三次有界尝试；只重试当前失败角色，不重跑已经批准的上游角色。正常生产局的初始开场启用快速路径，每个角色只尝试一次且单次 provider 上限为 30 秒，失败立即使用确定性 fallback；后续场景和 story-eval 保留最多三次尝试与 120 秒单次上限。耗尽后整场使用确定性 fallback，不拼接部分 AI 输出。
- active battle、ending 或合法非战斗行动少于两个时，不生成普通 narrative scene。
- 场景生成中“新人物/地点/道具”表示首次向玩家引入蓝图已有实体。导演可额外提议新地点/NPC，或为当前原子调查/物品/战斗事件懒提议一个事实、物品或敌人；均经 `approveBlueprintExpansion` 闸门审批后由 `compileBlueprintExpansion` 铸 ID 并以 CAS 追加进蓝图。每场最多一种新资源。
- 不做自由输入、意图解析 AI、streaming、AI 图片、语音或视觉描述生成。
- 对白场景在本次原子场景生成时同步准备两个确定性对白后续分支；它们不是额外 provider 请求，也不向客户端暴露内部 action key。玩家选择后先立即显示对应 NPC 回复与下一行动提示，下一次对白选择才重新进入三角色原子场景生成。
- 美术只保留后续 `VisualAssetPort` 的设计方向；本阶段不创建未使用 production port，继续使用本地 SVG。

## 已实现的运行时约束

- 三个角色使用独立真实请求，均关闭 provider 思考模式；普通场景单次 timeout 为 120 秒，初始开场快速路径覆盖为 30 秒，避免三角色串行失败时等待约 6 分钟。
- provider 不支持 guided grammar（缺少 `xgrammar`），因此使用 prompt-only JSON、严格本地解析和审批。
- source 在审批前只做机械归一化：action key、NPC ID、fact ID 从最小上下文复制；writer/NPC 的枚举和长度收敛到领域 schema；不修改场景叙述、NPC 正文、选项策略或任何规则结果。
- `narrative_choice` 的对白回应优先消费场景内预生成分支；没有预生成分支时才写入 `narrative_dialogue_choice` 并排队下一次 `dialogue_response`。世界选项才解出既有规则 action。战斗仍必须进入正式 battle facade，AI 不能直接决定胜负。
- provider 延迟不会阻塞创建或 choice 请求。pending 场景经 `POST /api/game/narrative/ensure` 触发，客户端每 750ms 读取 current-game，并每 10 秒重新 ensure 一次以恢复异常退出的后台任务；进程重启后同一 pending 标记可恢复。进程内 coordinator 负责单飞，并对 stale revision 做最多两次有界重试。
- 生成 UI 可显示脱敏的角色阶段进度（已批准完成的不同角色阶段 / 3、当前角色、当前角色的尝试次数）；同一导演重试不会把完成数重复累加。该进度只存在 server process 内，不写入 GameState，不参与 CAS。

## 最近维护

- 2026-08-09：v2.1 固定选择与焦点 NPC 自定义输入统一为 `/api/v2/game/actions` 的 discriminated union；浏览器逐次生成 UUID，composition root 直接装配 `performTurn` 并随同一响应返回最新 view。独立 `/api/v2/game/npc/dialogue` 与 `handleNpcDialogueV2` 已删除。
- 2026-08-09：v2.1 `SceneSource` 收敛为只返回 `ChoiceProposal` 的场景包提案；审批边界逐字段重建 ready scene 与 `ApprovedChoice` registry，并按写回后的 revision 铸造不透明 token。scene、registry、candidate pool 由同一次 CAS 写回；消费时同时校验当前 scene、当前 revision 与当前规则合法性。live source 只能回传服务端候选 ID，不再接收任意 `actionKey`。
- 2026-08-06：修复运行时叙事任务异常退出后长期保持 `pending` 的问题。编排边界现在将未预期异常收敛为确定性 fallback，并与 `narrative_scene_presented`、memory 归约一起通过 CAS 写入 `currentScene` 与 `generation: idle`；只有持久化本身失败才返回 `unavailable`。初始开场增加 30 秒单次 provider 上限，避免三个角色各等 120 秒导致 5–6 分钟无反馈。序幕 ack 与后台生成并发时，生成器会在仅 `prologueShown` 改变的最新 revision 上安全重基准；其它 stale 由 coordinator 最多重试两次。客户端每 10 秒重新 ensure，连续基础设施失败才停止并提示刷新。pending UI 展示角色阶段进度；fallback 对话绑定当前触发 NPC，并始终提供两个 `dialogue_response` 选项。
- 2026-08-06：修复角色进度按“响应次数”累计导致“导演第 3 次尝试却显示 2/3”的语义错误；现在只有 director/writer/npc 各自审批完成后才分别计入 1 个阶段。对白场景同步预生成两个 NPC 回复，选择后即时显示连续对白与安全的下一行动提示；后续选择才进入 pending，避免对白回应被错误替换成无关“剧情事件”。

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
→ 对白回应先消费预生成 NPC 分支；无预生成分支时写入 dialogueIntent + 玩家自然语言，世界选项解析为合法 AvailableAction
→ 既有规则裁决 / quest / ending
→ 预生成分支以 idle + 下一句对白一次 CAS 写入；需要新场景时才以 pending 一次 CAS 写入并立即返回
→ director 只选一个原子事件 → writer 生成该事件内容 → npc 只回答当前玩家输入
→ 场景以 CAS 写入 ready → 视图只展示该事件对应的 NPC/调查/物品/战斗内容
```

## 验收重点

- 记录型 fixture 证明 NPC 请求不包含未知事实正文和其他 NPC 私密知识。
- writer 请求不包含数据库、provider 配置或无关战斗数值。
- 篡改、过期和重复 choiceToken 零写入。
- AI 开关不改变同一选择对应的确定性规则结果。
- reload 恢复相同场景、NPC 台词和两个选项。
- 日常回归零网络零计费；完整真实认证仅由 `RUN_REAL_AI_JOURNEY=1` 显式开启。
- 2026-07-31 收口验收：`npm run lint`、`npm run typecheck`、`npm test`、`npm run test:fast`、`npm run build`、`npm run journey:phase10` 均通过；全量测试为 124 个文件、1,360 个通过、2 个显式跳过。此次未执行真实 AI 调用。

## 修改注意事项

- 不把完整 blueprint、GameState 或 GameRecord 作为通用 AI 上下文。
- NPC prompt builder 只能接受 `NpcPerformanceRequest`，不能接受 blueprint/state 后再“自行过滤”。
- AI 输出先经过 pure approval，再构造新的批准对象；不能把 AI 原对象直接持久化。
- CAS 冲突时默认丢弃已生成内容；仅序幕 ack 这种只改变 `prologueShown` 的安全并发写入允许在最新 revision 上复用已生成内容，其它 stale 不重复调用 AI而由后台 coordinator 有界重试。
- pending 时 application 拒绝行动；少于两个合法世界行动时清除 pending，不让 AI 或 fallback 伪造行动选项；对白事件的两个玩家口吻回应由 writer 生成，并在场景生成时同步准备两条确定性 NPC 回复。
- `NarrativeRuntimeState.mode` 由服务端保存：正常局为 `ai`；开发环境“使用已有数据开始”创建 `offline` 局，固定使用 Phase 10 完整旅程的输入/seed，既不调用开局 AI，也不排队运行时 AI。该模式只用于开发现有地图、地点和 NPC UI，不是玩家可配置的 AI 开关。
- 场景内人物、地点、道具首次登场仅能引用既有蓝图 ID；运行时蓝图扩展（新地点/NPC/事实/物品/敌人）经独立闸门审批后追加，见 `docs/agent/蓝图动态化.md`。
- 真实 smoke 是否执行必须按事实记录，不能把 fixture 通过写成真实调用成功。
