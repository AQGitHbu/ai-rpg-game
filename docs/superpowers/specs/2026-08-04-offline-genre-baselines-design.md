# 开发环境离线七题材开局下拉设计

> 日期：2026-08-04
> 状态：设计已确认（待写实现 Plan）
> 范围：仅 `ai-rpg-game`（`sharedInfrastructureChangeAllowed: false`，零 foundation 改动）

## 1. 背景与动机

当前开发环境的新开局表单有一个 dev-only 入口「使用已有数据开始」（`NewGameSetupForm.tsx`），点击后服务端用 `data/fixtures/phase1/wuxia.json` 的固定 input+seed 创建一个 **offline 模式**存档：确定性 fallback 蓝图 + `runtimeNarrativeMode:"offline"`，不调用开局 AI 或运行时 AI。它只服务于**一个题材（武侠）**。

目标是把它扩展为可在**7 个题材**间选择的下拉，供开发/测试**非 AI 部分的系统与 UI**（世界地图、地点场景、小镇层、NPC 对话界面、物品/背包、战斗、结局、任务追踪、HUD 等）时，有一个零 AI、可复现、题材多样的开局基线。

数据来源已确认：`data/story-eval/cases/v2.json` 在 main 与 feat/ai-story-quality-eval 两分支均有（入 git），含 10 个 case 跨 7 个 `gameType`。真正的 AI 旅程产物 `artifacts/story-eval/` 是 gitignored 的 worktree 本地文件，main 没有，不作为本次数据源。

## 2. 目标与成功标准

- 开发环境下，「使用已有数据开始」Panel 内增加一个 7 题材下拉；选择题材后点击按钮，按该题材的离线基线创建 offline 存档并进入游戏。
- 全程零 AI 调用（开局与运行时均不调用）；纯确定性 fallback 蓝图 + offline 叙事模式。
- 7 个题材的 offline 基线均可正常开局并可走到结局（新增零 AI 通关回归测试提供全部 7 条端到端证据，含 wuxia）。
- 既有 7 case 的内容调整（input 修改）经 `v2.json` 实时生效，无需同步/复制；新增 case 需同步登记题材→case 映射（见 §6.3）。
- 生产环境该入口不可用（沿用现有 dev 门禁）；浏览器无法注入任意 input/seed。

## 3. 非目标（明确不做）

- **不回放 AI 叙事旅程**（解读 C）：不消费 `artifacts/story-eval/` 记录，不做 director/writer/NPC 回放。原因：artifact 的 `calls.jsonl` 是 `StoryEvalCallRecord` 格式，与回放源所需的 `RuntimeNarrativeRecordedCall` 不兼容；回放靠请求指纹匹配，玩家偏离记录的行动序列即漂移报错，与自由游玩语义冲突。
- **不渲染 `NarrativeScenePanel`**（AI 叙事场景面板）：offline 模式永不排队 pending 叙事场景（`performAction.ts:385-388` 闸门 `narrative.mode !== "offline"`），故该面板不会出现。如需离线渲染它，需另加「静态叙事场景注入」机制，属独立特性，不在本次范围。
- 不调用任何开局 AI 或运行时 AI；不改规则、战斗、任务、物品、地图、蓝图、持久化或 AI 契约。
- 不修改 foundation / 任何 `@ai-game/*` 共享包；不把 artifact 入 git。
- 不覆盖 `v2.json` 的 `gameLength`（保持 `long`，8 主线幕，内容多便于测全 UI）。

## 4. 数据来源决策

**复用 `data/story-eval/cases/v2.json`，不复制、不新建 fixture。**

- 离线基线按 caseId 从 `v2.json` 取 `NewGameInput`；seed 由 caseId 确定性派生（FNV-1a 哈希，零新数据、可复现）。
- v2.json 中既有 case 的内容调整自动生效（运行期解析，无同步负担）；新增 caseId 需在 §6.3 的映射与白名单登记后才进入下拉。
- 耦合控制：新建一个薄模块集中持有"题材→代表 caseId"映射与解析逻辑，compositionRoot 只依赖该命名模块。
- `v2.json` 的 case 已在真实 AI 旅程中被 `createGame` 校验通过（domain 校验），输入合法性有保证。

## 5. 题材 → 代表 case 映射（7 个）

| 下拉显示 | gameType | caseId |
|---|---|---|
| 武侠 | wuxia | wuxia-a |
| 仙侠 | xianxia | xianxia-a |
| 奇幻 | fantasy | fantasy-a |
| 科幻 | science_fiction | science-fiction-a |
| 都市 | urban | urban-a |
| 架空历史 | alternate_history | alternate-history-a |
| 末日 | post_apocalypse | post-apocalypse-a |

后续可一键扩展到 v2.json 全部 10 个 case（武侠/科幻/都市各有第二个前提 case）。

## 6. 架构与组件

### 6.1 前端 `src/components/NewGameSetupForm.tsx`
- 在现有「使用已有数据开始」Panel（按钮上方）增加一个 `<select>`，选项为上述 7 题材，默认「武侠」。
- `handleOfflineJourneyStart` 提交时携带所选 caseId：`{ developmentPreset: "phase10-journey-v1", caseId }`。
- 仅 `developmentTools` 为 true 时渲染（沿用现有条件）。

### 6.2 API `src/app/api/game/createGameHandler.ts`
- 保留 `developmentPreset === "phase10-journey-v1"` 独占标记语义，**放宽**排他判断：请求体**至多**允许 `developmentPreset` 与 `caseId` 两个字段（`Object.keys(record)` 为 `["developmentPreset"]` 或 `["caseId","developmentPreset"]` 二者之一，顺序无关）；出现其它字段 → 仍走 `UNEXPECTED_FIELDS` 拒收。
- `caseId` 必须是字符串；非字符串 → `400 { code: "INVALID_FIELD_TYPES", fields: ["caseId"] }`（沿用现有类型守卫语义）。
- `caseId` 必须命中服务端白名单（上述 7 个 caseId）；缺失 → 沿用现有 legacy 武侠基线（向后兼容）；命中 → 传给 `createOfflineJourneyGame(caseId)`；未知 → `400 { code: "UNEXPECTED_FIELDS", fields: ["caseId"] }`。
- 浏览器仍无法注入任意 input/seed/state；caseId 只是白名单枚举。

### 6.3 Server 新增 `src/game/application/server/offlineBaselines.ts`
- 编译期 import `data/story-eval/cases/v2.json`（server-only，零运行时 IO）。
- 持有 `GENRE_TO_CASE` 映射与 `OFFLINE_CASE_IDS` 白名单（7 个）。两处一一对应：新增 case 需同时登记映射与白名单，构成下拉的全部入口（这是「新 case 可用」的前置条件，见 §2/§4）。
- `resolveOfflineBaseline(caseId)` → `{ input: NewGameInput, seed: string }`：input 取自 v2.json 对应 case；seed = `fnv1aHex("offline-baseline:" + caseId)` 派生。
- 未知 caseId → 返回 `null`（由调用方映射为 400）。

### 6.4 compositionRoot `src/game/application/server/compositionRoot.ts`
- `createOfflineJourneyGame` 扩展签名接受可选 `caseId`。
- `caseId` 缺失 → 现有 `PHASE10_JOURNEY_BASELINE`（legacy 武侠，向后兼容，现有测试不变）。
- `caseId` 命中白名单 → `offlineBaselines.resolveOfflineBaseline(caseId)` 取 input+seed，复用现有 `offlineJourneyDependencies`（`createOfflineJourneyScenarioSource()` 恒 unavailable → fallback + `runtimeNarrativeMode:"offline"`）。
- 仍 dev-gated（`NODE_ENV === "development"`），非 dev 返回 `DEVELOPMENT_TOOLS_DISABLED`。

### 6.5 复用现有 offline 链路
- 不新增 scenario source 变体；unavailable source → fallback 蓝图 → `validateScenarioBlueprintCandidate` + `compileScenarioBlueprint` 闸门 → `initializeGameState(offline)`。
- 不改 `performAction`、规则、持久化、AI source 工厂。

## 7. 数据流

下拉选题材 → `POST /api/game {developmentPreset, caseId}` → handler 校验白名单 + dev 门禁 → `createOfflineJourneyGame(caseId)` → `offlineBaselines.resolveOfflineBaseline(caseId)` → `createGame({input, seed}, offlineJourneyDependencies)` → fallback 蓝图 → validate/compile → `initializeGameState(offline)` → repository 原子保存 → `GameSessionView` → `onCreated` → `AdventureGameShell`（零 AI）。

## 8. 完整性与可通关保证（回应"数据不完整"风险）

- **开局可行性**：fallback 蓝图必经 `validateScenarioBlueprintCandidate` + `compileScenarioBlueprint`；若某题材 fallback 编译失败 → `GENERATION_INVALID`，游戏不会带残缺数据启动。现有测试已证 7 个 gameType 的 fallback 候选全部通过结构校验（`createFallbackBlueprint.test.ts`：「全部 7 种类型的候选通过结构校验」）。
- **结局可达性**：`validateScenarioBlueprintCandidate` 校验 `UNREACHABLE_ENDING`/`LOOP_WITHOUT_CLOSURE`/`HIDDEN_LOCATION_OBJECTIVE_UNREACHABLE`；`analyzeQuestReachability` 断言每个任务图恰有 2 个可达结局。
- **通关证据现状核实**：`phase10FullJourney` / `runtimeNarrativeJourney` 是 **AI 叙事模式**旅程——注入 `runtimeNarrativeSources`、以 `narrative_choice` 意图驱动（`aiCalls` 计数），其「零调用」指回放录制时零**网络**调用，并非零 AI 的规则循环通关。因此**不存在**「wuxia 零 AI 规则通关已被既有测试证明」的现成证据；全部 7 条基线的规则驱动通关证据统一由本次新增回归测试一次性提供（见 §9）。
- **offline 通关**：offline 下玩家靠纯规则行动（move/talk/investigate/take_item/battle）推进任务图，最终任务完成→结局_1、失败→结局_2。现有 wuxia 的 town 层已验证规则行动在 offline 下可用（`townMainLoopRegression`「离线全旅程」），但未贯通到结局；本次新增回归测试补齐 7 条端到端证据。

## 9. 测试

- **`offlineBaselines` 单元**：caseId→input+seed 解析正确、seed 确定性、未知 caseId→null、白名单恰好 7 个。
- **`createGameHandler`**：白名单 caseId 通过并传给 use case；未知 caseId→400；缺失 caseId→legacy 路径；非 dev→403。
- **compositionRoot**：各 caseId 产出的 input 经 `createGame(offlineDeps)` 成功创建存档（`source:"fallback"`、`narrative.mode:"offline"`）；非 dev 拒绝。
- **新增 7 题材零 AI 规则通关回归（新 harness，不复用 narrative_choice harness）**：对 7 条离线基线各驱动 `createGame(offlineDeps)` + `performAction` 规则循环到结局，断言到达 ending、零 `fetch`。**注意**：不能直接复用 `phase10FullJourney`/`runtimeNarrativeJourney` 的 harness——它们是 AI 模式、以 `narrative_choice` 意图驱动；offline 模式无叙事场景，须新建 harness：每轮从 `view.availableActions` 中按目标导向选择器（类似 `storyEvalJourney` 的 `pickerFor("objective")`）选规则行动（优先推进 active main quest 的行动：take_item/talk/investigate/目标地点 move/battle，否则取合法兜底行动），带回合上限与失败断言；deps 的 `runtimeNarrativeSources` 置 `undefined`（顺带验证 performAction 闸门在 offline 下不排队叙事场景，即 §3 断言）。
- **`NewGameSetupForm` UI**：dev 下渲染 7 选项、prod 下隐藏、点击发送正确 caseId；现有「请求不含玩家输入」断言保持（caseId 非 player input）。

## 10. 边界与失败处理

- 已有存档 → `409 ACTIVE_GAME_EXISTS`（现有）。
- 某题材 fallback 编译失败 → `422 GENERATION_INVALID`（现有优雅路径，不残缺启动）。
- 未知 caseId → `400 UNEXPECTED_FIELDS`（`fields: ["caseId"]`，与 §6.2 一致）。
- 非 dev 环境 → `403 DEVELOPMENT_TOOLS_DISABLED`（现有）。
- 网络异常 → 现有前端兜底文案。

## 11. 已定决策

- 数据来源：复用 v2.json + 派生 seed（不复制、不新建 fixture；既有 case 内容调整自动生效，新增 case 登记 §6.3 映射与白名单后即进入下拉）。
- 7 题材下拉，每题材取代表 `-a` case；下拉 7 个选项（含武侠）**统一发送 caseId**，均经 `offlineBaselines` 解析为 v2.json 基线（来源一致）。
- 向后兼容：handler 保留"无 caseId → legacy `PHASE10_JOURNEY_BASELINE`"路径，仅供旧请求/旧测试；现有 `NewGameSetupForm` 点击测试需更新以预期 caseId 字段（caseId 非 player input，"请求不含玩家输入"语义不变）。
- `gameLength` 保持 v2.json 的 `long`。
- `NarrativeScenePanel` 离线渲染不在范围。

## 12. 实现边界

- 新建 feature worktree（遵循 AGENTS.md：分支放 `.worktrees/`，不用 `git checkout`）。
- 仅改 `ai-rpg-game`；零 foundation/共享包改动。
- 验收命令：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`（全部离线）。
- 实现事实变化后同步 `docs/agent/` 与索引（无AI试玩验收 / 地图与地点冒险 相关条目）。

