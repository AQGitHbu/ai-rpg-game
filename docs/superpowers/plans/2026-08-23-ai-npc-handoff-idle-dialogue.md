# AI NPC 交接与非焦点闲聊修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让幕交接时旧 NPC 必须说完承接下一目标的最后一句，并让同一次场景 API 同步生成所有非焦点 NPC 的零回合闲聊，避免玩家看到确定性 `fallback` 台词。

**Architecture:** 扩展 live scene proposal，在同一个 JSON 响应中携带 `npcDialogues`，其中只允许非 `npcLine` 发言者；场景审批负责强制 handoff 发言归属、检查新目标引用并要求 generated 场景补齐非焦点对白，失败时进入既有 content repair。最终 scene 为每个 AI 生成的 NPC 对白记录来源，read model 不再把这些对白标成 fallback；旧存档和 offline 场景继续使用兼容的确定性闲聊。

**Tech Stack:** TypeScript、Vitest、Next.js、现有 SceneSource/approveScenePerformance/CAS 写回链路。

**Spec:** `docs/agent/NPC对话驱动叙事场景触发.md`、`docs/agent/地图与地点冒险.md`、`docs/策划文档/AI生成RPG_MVP.md`

## Global Constraints

- 非焦点 NPC 闲聊是零回合、零写入、零额外 API 请求，不得创建 pending 或推进剧情。
- generated 场景不得把确定性 NPC 兜底台词作为成功结果写入；AI 对白缺失或不合格必须进入现有内容修复/失败链路。
- handoff 的 `npcLine` 必须由当前旧焦点 NPC 说出，并在交接节拍中明确承接到权威新目标。
- 所有 NPC 台词仍必须是直接对白，不能包含角色名、动作或“说道/答道”等舞台说明。
- `objectiveLink`、candidateId、事实引用和交互归属继续由服务端权威校验。
- 旧存档必须兼容：缺少新字段时仍可用既有确定性闲聊读取，但不影响新 generated 场景。

### Task 1: 建立 handoff 与非焦点 AI 对白的失败测试

**Files:**
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/game/domain/narrative.test.ts`

**Interfaces:**
- Consumes: 当前 `ScenePerformanceProposal`、`SceneGenerationContext` 和 `buildNpcDialoguePages` 的现有测试 fixture。
- Produces: 明确锁定 `npcDialogues` 解析、handoff 发言归属、目标引用失败、AI 非焦点来源投影的回归行为。

- [ ] **Step 1: 为 live JSON 解析添加非焦点对白成功用例**

在 `liveScenePerformanceSource.test.ts` 的 handoff fixture 中让响应包含：旧焦点 `npcLine`、新目标 NPC 的 `npcDialogues` 条目和正确 `referencedEntityIds`，断言 proposal 保留这两类对白。

- [ ] **Step 2: 为 live JSON 解析添加非法非焦点对白用例**

覆盖未知 NPC、重复 NPC、空文本以及把焦点 NPC 放入 `npcDialogues` 的情况，断言解析或审批返回稳定失败，不静默丢弃后写成功场景。

- [ ] **Step 3: 为 handoff 审批添加失败用例**

在 `approveAndWriteScene.test.ts` 添加两个用例：`npcLine.npcId` 选择新目标而不是旧焦点时返回 `handoff_npc_unanswered`；`quest_advanced` 缺少新目标实体引用时返回 `handoff_missing_objective_reference`。

- [ ] **Step 4: 为 generated 场景添加非焦点对白缺失用例**

构造一个有两个在场 NPC 的 generated proposal，只返回焦点 `npcLine`，断言审批返回 `missing_non_focus_npc_dialogue`；补齐对白后断言 scene 中保存对应 `speechSource: "generated"`。

- [ ] **Step 5: 为读模型添加来源回归用例**

构造带 AI 非焦点 `npcDialogues` 的 scene，断言非焦点台词不带 `【fallback】`；再构造旧 scene 缺少来源字段的情况，断言仍按兼容路径生成并标记确定性 fallback。

- [ ] **Step 6: 运行定向测试确认测试先失败**

Run: `npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/gameSessionView.test.ts src/game/domain/narrative.test.ts`

Expected: 新增断言失败，现有实现尚未提供 handoff 强制约束和 AI 非焦点对白字段。

### Task 2: 扩展 proposal、AI prompt 和 parser

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`

**Interfaces:**
- Consumes: `SceneGenerationContext.presentNpcs`、`focusNpcContext`、`objectiveTransition` 和已有 scene JSON。
- Produces: `ScenePerformanceNpcDialogue` 类型；`ScenePerformanceProposal.npcDialogues`；解析后的非焦点对白数组；handoff prompt 中的旧焦点 speaker contract 与目标实体引用 contract。

- [ ] **Step 1: 增加 proposal 类型**

在 `sceneSource.ts` 增加：

```ts
export type ScenePerformanceNpcDialogue = {
  readonly npcId: string;
  readonly text: string;
};
```

并在 `ScenePerformanceProposal` 增加可选 `npcDialogues?: readonly ScenePerformanceNpcDialogue[]`。

- [ ] **Step 2: 增加 parser 结构校验**

解析 `raw.npcDialogues`：必须是数组；每条必须是已在场 NPC、文本非空、NPC 不得等于 `npcLine.npcId`、NPC ID 不得重复；文本通过 `normalizeNpcSpeech`，拒绝通用问候、通用确认和空泛反问。缺少字段保留为 `undefined`，由审批层根据 generated/offline 语义决定是否失败。

- [ ] **Step 3: 扩展 prompt 输出 schema**

在 `buildLiveScenePrompt` 的 JSON schema 增加：

```json
"npcDialogues":[
  {"npcId":"非焦点在场NPC ID","text":"一句到两句符合身份和当前场景的直接闲聊"}
]
```

要求 generated 场景为除 `npcLine.npcId` 外的每个在场 NPC 各生成一条；不得推进任务、泄露私密事实或制造新实体；这是同一次 API 响应的一部分，不产生额外调用。

- [ ] **Step 4: 强化 handoff prompt**

当 `objectiveTransition.mode === "advanced_act"` 时，明确要求 `npcLine.npcId` 必须等于旧焦点 ID `context.focusNpcContext.id`，旧 NPC 的最后一句必须自然引出 `objectiveTarget.entityName`；`quest_advanced.referencedEntityIds` 必须包含精确的 `objectiveTarget.entityId`。

- [ ] **Step 5: 运行 live parser 定向测试**

Run: `npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts`

Expected: Task 1 中与 parser 相关的测试通过。

### Task 3: 审批 handoff、目标引用和非焦点对白完整性

**Files:**
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`

**Interfaces:**
- Consumes: `ScenePerformanceProposal.npcDialogues`、`SceneGenerationContext.objectiveTransition`、`focusNpcContext` 和 `objectiveTarget`。
- Produces: 稳定审批码 `handoff_npc_unanswered`、`handoff_missing_objective_reference`、`missing_non_focus_npc_dialogue`；通过审批的 generated scene 使用 AI 非焦点对白并触发现有 content repair。

- [ ] **Step 1: 增加审批失败码**

扩展 `SceneRejectionCode`，加入上述三个失败码；保持 `generatePendingScene` 对 generated 审批失败自动执行一次 content repair 的既有行为。

- [ ] **Step 2: 强制 handoff speaker**

在 NPC 台词校验后、目标一致性校验前加入规则：advanced_act 且存在 `focusNpcContext` 时，`npcLine` 必须存在并且 `npcLine.npcId` 等于旧焦点 ID，否则返回 `handoff_npc_unanswered`。玩家有无 `player_utterance` 都适用。

- [ ] **Step 3: 将 handoff grounding warning 升级为可修复失败**

完成现有 `qualityWarnings` 计算后，advanced_act 若缺少目标 surface、存在非法目标引用或未引用 `objectiveTarget.entityId`，返回 `handoff_missing_objective_reference`，使 `generatePendingScene` 使用 `repairAttempt` 重试，而不是保存 warning-only 场景。

- [ ] **Step 4: 校验 generated 非焦点对白覆盖面**

对 generated proposal 要求 `npcDialogues` 恰好覆盖所有在场且不是 `npcLine.npcId` 的 NPC；offline/fallback proposal 保留旧确定性路径。任何缺失、重复、焦点混入或未知 NPC 返回 `missing_non_focus_npc_dialogue`。

- [ ] **Step 5: 将 AI 对白写入最终 scene**

把 proposal 的 `npcDialogues` 转成 `Map<string, string>` 传给 `buildNpcDialoguePages`，并让每个写入条目带 `speechSource: "generated"`；焦点 `npcLine` 仍按现有流程写入。不要把小闲聊写入 eventLedger、choiceRegistry 或回合状态。

- [ ] **Step 6: 运行审批与生成定向测试**

Run: `npx vitest run src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts`

Expected: handoff speaker、目标引用和非焦点对白缺失均进入 content repair/失败路径，合法 proposal 写入 generated 非焦点对白。

### Task 4: 修正 narrative domain 与 read model 的 fallback 来源

**Files:**
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Consumes: `generatedNpcLines` 和持久化 `NpcDialogueInScene.speechSource`。
- Produces: generated 非焦点对白不带 `【fallback】`；旧存档和缺失 AI 对白仍走兼容 fallback。

- [ ] **Step 1: 扩展 NPC dialogue state 来源字段**

在 `NpcDialogueInScene` 增加可选 `speechSource?: "generated" | "fallback"`，保持旧存档字段可缺省。

- [ ] **Step 2: 扩展 `buildNpcDialoguePages`**

增加 `generatedNpcLines?: ReadonlyMap<string, string>` 参数；焦点优先使用 `focusSpeech`，非焦点命中 map 时使用 AI 文本，否则才调用 `composeDeterministicNpcLine`。写入对应 `speechSource`，不能把 generated map 条目标成 fallback。

- [ ] **Step 3: 让 read model 尊重持久化来源**

在 `gameSessionView.ts` 中优先使用 `supplied.speechSource`；只有旧 entry 没有来源字段时，才按 `sceneLineNpcId === npc.id ? scene.source : "fallback"` 兼容推断。这样 generated handoff 中老 NPC、新目标 NPC和其他非焦点 NPC都不会出现 `【fallback】`。

- [ ] **Step 4: 保留旧存档兼容测试**

断言旧 `npcDialogues` 没有 `speechSource` 时行为不变；新 generated entry 的 speech pages 不包含 fallback marker，焦点/非焦点选择权仍由当前权威目标决定。

- [ ] **Step 5: 运行 domain/read model 定向测试**

Run: `npx vitest run src/game/domain/narrative.test.ts src/game/application/gameSessionView.test.ts`

Expected: 新来源规则和旧存档兼容测试全部通过。

### Task 5: 更新实现文档并执行全量验证

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/agent/闲聊功能实现说明.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/Agent文档索引.md` only if the implementation fact summary needs a new entry.

**Interfaces:**
- Consumes: 已实现的 same-call `npcDialogues`、handoff speaker contract 和来源字段。
- Produces: 文档明确非焦点闲聊由场景 API 同步生成、零回合展示，handoff 由旧 NPC 最后一句引出新目标；确定性闲聊只作为旧存档/offline 兼容。

- [ ] **Step 1: 更新实现事实**

删除“新 generated 场景由 read model 生成确定性闲聊”的表述，改为“live scene API 同步生成非焦点 NPC 对白并持久化来源；缺失时 content repair/失败；旧存档兼容确定性闲聊”。

- [ ] **Step 2: 更新策划交接规则**

明确交接场景先展示旧焦点 NPC 的最后回应/引导，再将当前目标切换到新 NPC；新 NPC 的场景闲聊由同次 API 生成，不创建额外回合。

- [ ] **Step 3: 运行类型检查、相关测试和 lint**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run lint`

Expected: 类型检查、Vitest 全量和 lint 均通过。

- [ ] **Step 4: 检查工作区差异**

Run: `git diff --check && git status --short`

Expected: 只包含本计划列出的代码、测试和文档变更，没有运行时存档或日志被修改。
