# 运行时 AI 导演与场景表演

## 系统定位

Phase 10 建立第一条真实运行时 AI 剧情闭环：玩家从两个服务端批准的固定选项中选择，既有规则先裁决对应行动，世界导演、剧情编剧和当前 NPC 再以三份不同知识权限生成下一场景，最终与规则结果一次 CAS 保存。

## 当前状态

- 状态：已设计（designed）/ 待实现（not_started）。
- Spec：`docs/superpowers/specs/2026-07-30-runtime-ai-director-scene-performance-design.md`。
- 唯一 Plan：`docs/superpowers/plans/2026-07-30-mvp-phase-10-runtime-ai-director.md`。
- 目标分支：`codex/phase10-runtime-ai-director`。
- 工作区：`.worktrees/phase10-runtime-ai-director`。
- 修改范围：仅 `ai-rpg-game`；复用现有 `@ai-game/ai-transport@0.1.0` public API，不改 foundation。

## 已冻结设计

- 三个逻辑角色也是三个独立 AI 请求：
  - director：全局剧情、隐藏事实、任务结构、当前内容预算和合法行动候选；
  - writer：已批准导演计划、相关剧情真相、角色动机和两个已批准行动；
  - npc：自己的档案、获准使用且属于 `knownFactIds` 的事实、表演指令和有限历史。
- 客户端只提交 `choiceToken + revision`，不获得 actionKey、事实 ID、导演计划、生成来源或 diagnostics。
- 两个选项必须映射两个不同且当前合法的既有 `AvailableAction`；AI 不能创建行动语义。
- 规则 resolver、quest reconciliation、battle、ending 和 SQLite CAS 继续独占正式状态写入。
- 任一 AI 阶段失败后整场使用确定性 fallback，不拼接部分 AI 输出。
- active battle、ending 或合法非战斗行动少于两个时，不生成普通 narrative scene。
- Phase 10 中“新人物/地点/道具”只表示首次向玩家引入开局蓝图已有实体；不运行时追加蓝图 ID。
- 不做自由输入、意图解析 AI、streaming、AI 图片、语音或视觉描述生成。
- 美术只保留后续 `VisualAssetPort` 的设计方向；本阶段不创建未使用 production port，继续使用本地 SVG。

## 最小运行链路

```text
createGame 初始化规则状态
→ director → 规则批准
→ writer → 规则批准
→ npc 最小知识表演
→ 初始 NarrativeSceneState 与存档一次写入

narrative_choice(choiceToken, revision)
→ token 解析为当前合法 AvailableAction
→ 既有规则裁决 / quest / ending
→ director → writer → npc 或完整 fallback
→ 规则结果与下一 NarrativeSceneState 一次 CAS 写入
→ GameSessionView 安全投影两个新选项
```

## 验收重点

- 记录型 fixture 证明 NPC 请求不包含未知事实正文和其他 NPC 私密知识。
- writer 请求不包含数据库、provider 配置或无关战斗数值。
- 篡改、过期和重复 choiceToken 零写入。
- AI 开关不改变同一选择对应的确定性规则结果。
- reload 恢复相同场景、NPC 台词和两个选项。
- 日常回归零网络零计费；真实 smoke 仅由 `RUN_REAL_AI_RUNTIME_SMOKE=1` 显式开启。

## 修改注意事项

- 不把完整 blueprint、GameState 或 GameRecord 作为通用 AI 上下文。
- NPC prompt builder 只能接受 `NpcPerformanceRequest`，不能接受 blueprint/state 后再“自行过滤”。
- AI 输出先经过 pure approval，再构造新的批准对象；不能把 AI 原对象直接持久化。
- CAS 冲突时丢弃已生成内容，不重复调用 AI。
- 真实 smoke 是否执行必须按事实记录，不能把 fixture 通过写成真实调用成功。

