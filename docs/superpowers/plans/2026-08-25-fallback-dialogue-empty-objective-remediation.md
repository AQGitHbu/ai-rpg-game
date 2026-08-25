# Plan: 修复 NPC fallback 对话与空目标状态

## 目标

修复新游戏/存档续玩时出现的两类运行时错误：

1. 进入新的 `talk_to_npc` 目标后，读模型把尚未生成的 NPC 场景对白当成焦点对白，使用确定性 fallback 台词并展示正式选项。
2. 场景交接或幕边界期间 HUD 的当前目标为空，导致玩家只能点击 NPC 或其他入口后才重新看到目标。

同时保证正式 NPC 对话仍保持两项批准选项、自由输入和 AI 失败状态语义，不把 provider 未生成/失败伪装成已生成内容。

## 已确认的现场证据

- 当前存档在 `revision=14` 时，探索场景的 AI 原始输出为 `npcLine: null`，`source: generated`，且当前目标为“前往荒废义庄”；这不是模型生成了错误的 NPC 台词。
- 实机完成“检查尸体”后，HUD 目标正确变为“与哑巴阿福交谈”，但点击 NPC 卡片后读模型合成 `【fallback】有什么要问的，直接说……` 和两项 handoff 选项；此时存档仍为 `narrative.status=ready`，当前 scene 是调查场景，没有阿福的 AI `npcLine`。
- 因此 fallback 根因是 `gameSessionView` 的 `handoffFocusNpc` 在新 talk 目标尚未拥有 ready dialogue scene 时直接聚焦目标 NPC，并调用 `composeDeterministicNpcLine`；目标为空则需要结合交接期间的权威状态与持久化投影单独回归验证。

## 实施步骤（TDD）

### 1. 建立失败回归测试

- 在 `gameSessionView.test.ts` 增加“非对白场景切换到新的 talk 目标但没有 NPC scene line”用例：不能返回 fallback 台词、不能把未生成的 NPC 投影为可自由输入的正式对白；当前目标仍必须是该 talk 目标。
- 增加“目标已进入下一幕/边界预备状态”的投影用例，确认 HUD 目标不会因为上一场景或旧 dialogue session 被清空；若确实处于结构性待编排状态，必须显示稳定的继续追查入口。
- 在 `performTurn`/生成链路测试中锁定：只有用户正式提交 talk/freeform 后才创建 NPC provider job；点击 NPC 卡片本身不增加 turn/revision，也不应制造新场景。

### 2. 修复读模型和交接状态

- 将“目标 NPC 已生成的正式对白焦点”和“目标 NPC 只是下一步交接对象”分离：没有 `event.kind=dialogue` 且没有对应 `npcLine`/已审批 scene dialogue 时，不调用 deterministic NPC fallback 作为焦点台词。
- 保留 NPC 卡片与权威 talk action 的可见入口，但在 provider scene 未 ready 时只显示明确的等待/交接状态，不展示冒充 NPC 发言的 fallback 文本和可提交的正式对话选项。
- 校正目标投影的边界条件，使 active main quest、reveal 游标、`needs_next_act`/`needs_ending_pair` 和 provider pending/failed 之间始终有可见的 HUD 目标或稳定的继续入口；不得依赖点击 NPC 才补出目标。

### 3. 更新实现文档

- 按 `.agents/commands/aq-update-docs.md` 更新受影响的 `docs/agent/` 文档，记录“未生成/失败场景不得使用角色 fallback 冒充正式对白”及目标投影约束；如索引需要变化同步更新索引。

### 4. 验证与实机测试

- 先运行新增回归测试，确认红灯后实现，再运行受影响的 Vitest/TypeScript/build 检查。
- 通过本地浏览器从当前存档继续并完成至少 5 幕、涉及 3 名以上 NPC 的中篇流程，逐幕核验 HUD 当前目标、NPC 台词来源、选项数量、turn/revision 变化、provider pending/failed 行为和日志记录。
- 若实机发现新的 fallback、空目标、错误选项或场景卡死，继续按“先测试、再修复、再实机”循环直到通过。

## 验收标准

- 任何 live/generated scene 中都不会出现 `【fallback】` 作为 NPC 正式回应；旧 fixture 存档的兼容展示仍明确标记为 fallback，不影响真实失败诊断。
- 点击 NPC 卡片只打开已有读模型，不创建新回合；只有提交固定选项或自由输入才触发 provider job。
- 有活动任务时 HUD 始终显示权威当前目标；结构性幕边界待编排时显示继续追查入口而不是空白卡死。
- 相关单测、类型检查、构建和完整中篇浏览器实机测试均通过。
