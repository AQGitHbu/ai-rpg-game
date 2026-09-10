# 分阶段叙事生成实施验收报告

> 本报告是实施验收证据，不混入当前契约。当前契约以 `docs/agent/*` 与
> `docs/策划文档/*` 为准。

## 范围与环境

实施工作区：`.worktrees/staged-narrative-generation`，分支
`staged-narrative-generation`，起点 `60f0e87`。计划文档
`docs/superpowers/plans/2026-09-09-staged-narrative-generation.md`
（Task 1–11 已完成，Task 12 为本报告的验收对象）。

未操作用户当前存档：真实 smoke 使用独立临时 `GAME_DB_PATH`，退出时清理。
凭据不进入报告或提交，AI 配置检查通过（`npm run env:check` 只输出版本与存在性）。

### 提交链

| commit | 内容 |
| --- | --- |
| `5684807` | recover：对象库损坏后经工作树抢救保全全部实现（原 `1ee7fe8`/`96617da`/`500e348`/`0025ab9`/`4d9f9df`/`550bc67` 的独立提交历史合并于此） |
| `f679ac6` | feat(staged)：接入 `test:staged-smoke` / `smoke:ai:staged` 与 staged 角色说明 |
| `375f5e3` | docs(plan)：回填 Task 1–9 已完成 Step（纯记账） |
| `90c3cdf` | fix(staged)：修复观察披露链三处缺陷 |
| `22caaff` | docs(staged)：文档归位到分阶段叙事链路契约（Step 6） |
| `9b72a57` | fix(staged)：修复 certainty 冲突导致的 `unit_output_fact_unavailable`（缺陷 14）+ smoke 状态读取 |

## 工程证据

### 离线门禁

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过，无输出 |
| eslint | 通过，**0 error / 52 warning**（warning 全部为既有代码，非本次改动） |
| 全量 vitest | **218 files / 2890 passed**，1 skipped（既有 live 测试） |
| 分层边界 `test:boundaries` | **2 files / 127 passed** |
| smoke 门禁 `node --test scripts/stagedNarrativeSmoke.node-test.mjs` | **26 passed** |
| 文档检查 `check:docs` / `test:docs` | 34 份文档 0 error；13 passed |
| `npm run build` | 见下方 Step 4 门禁小节 |

定向测试明细（本报告相关）：

| 测试文件 | 用例数 |
| --- | --- |
| `src/game/domain/narrativePlan.test.ts` | 17 |
| `src/game/domain/narrativeUnit.test.ts` | 17 |
| `src/game/domain/narrativeBranch.test.ts` | 12 |
| `src/game/domain/narrativeObservation.test.ts` | 10 |
| `src/game/gameplay/rpg/narrativePlanning/branches.test.ts` | 22 |
| `src/game/gameplay/rpg/narrativePlanning/observations.test.ts` | 11 |
| `src/game/gameplay/rpg/narrativePlanning/approvePlan.test.ts` | 6 |
| `src/game/gameplay/rpg/narrativePlanning/unitGraph.test.ts` | 10 |
| `src/game/gameplay/rpg/narrativePlanning/sceneSnapshot.test.ts` | 10 |
| `src/game/application/narrativeGeneration/*.test.ts` | 见全量 |
| `src/game/application/server/ai/staged/stagedPrompts.test.ts` | 28 |
| `src/game/application/server/ai/staged/liveStageSource.test.ts` | 7 |
| `src/game/application/narrativeGeneration/approveUnit.test.ts` | 19 |
| `src/game/application/server/persistence/sqliteNarrativeJobs.test.ts` | 8 |

### Task 1–9 记账回填说明

Task 1–9 的 45 个 Step 此前从未回填勾选，使计划文档误显示为未完成。经逐项
核对交付物与测试后回填（`375f5e3`）：测试文件全部在位，对应 vitest 全绿，
四类 prompt、`narrativeJobRepository`、`publishJob` / `consumeNarrativeBundle`
/ `realizeObservations` 全部在位。**仅补记账，无代码改动。**

## 真实 AI 缺陷修复记录

真实 smoke 逐轮暴露失败码，全部经「读 `narrative_jobs` 单元状态 + 审计
`events.jsonl` 的 prompt/响应原文」交叉取证定位，非猜测。

| 轮次 | 失败码 | 性质 | 根因与修复 |
| --- | --- | --- | --- |
| 1 | `unit_output_parts_invalid` | prompt 契约 | narration/character prompt 缺 `parts[]` 元素契约，模型写裸事实键数组。补 parts 元素契约 |
| 2 | `unit_output_fact_unavailable` | prompt 契约 | prompt 并存两套命名：可见事实用实体 id（`fact_0`）、必选节拍用计划语义键。删除节拍段的语义键，声明唯一权威 |
| 3 | `observation_without_source` | prompt 契约 | choices 单元跨 step 引用观察。prompt 升级措辞并禁止 choices 单元引用观察 |
| 4 | `unknown_speaker` | prompt 契约 | opening prompt 完全不含实体 id，模型自造 `speakerId`。新增服务端固定实体 id 清单（`player_0`/`npc_0`/`loc_0`/`quest_0`/`fact_<index>`） |
| 5 | `observation_not_disclosed`（wuxia） | **代码缺陷** | `observationsForUnit` 只按 stage+speakerId 过滤、未按 `point` 限定，同一 NPC 多 step 说话时前一个单元被迫披露后续场景观察 → 任何输出都无法通过。新增 `atOrBefore`（同 `stepKey` 且 `order ≤` 本单元），与 `checkUnitGraph` 时点约束同语义 |
| 5 | `observation_disclosure_unavailable`（urban） | **代码缺陷** | `checkObservation` 要求输出 certainty 精确等于观察声明；观察声明 `suspected` 而知识组件为 `known` 时，prompt 教模型写 `known`、判定要 `suspected` → 必败。改为「不得升级」：允许 `known→suspected` 降级，仍拒 `suspected→known` |
| 5 | `observation_not_disclosed`（两局共有） | prompt 契约 | character/narration prompt 完全没声明本单元必须披露哪条观察。`SafeContext` 新增 `requiredObservations` 安全投影；两 prompt 新增「必须披露的观察」硬性段，明确必须写进 `facts`（写进 `beatIds`/`evidence` 不算披露） |
| 6 | `unit_output_fact_unavailable`（character 第二单元） | **代码缺陷（回归）** | `approveUnit.checkParts` 要求输出 certainty 与 `visibleFacts` **严格相等**，与缺陷 12 修复后的 `checkObservation`「不得升级」规则矛盾。编译层把 NPC 知识一律标 `known`，而规划观察标 `suspected`；模型按披露段写 `suspected`（合法降级）被 `approveUnit` 判 `unit_output_fact_unavailable`。修复：`approveUnit` 改为「不得超过参考上限」（可见事实与披露要求取更严的一个），与 `collectDisclosures` 统一规则 |

修复提交：`90c3cdf`（缺陷 11–13）、`9b72a57`（缺陷 14）。回归：全量 218 files /
2890 tests 通过，typecheck 与 eslint 干净。

### 缺陷 14 的取证与定位

首次全量 smoke 报告 `INITIALIZATION_TIMEOUT` + `requestCount: 0`，**这是误导性摘要**，
真因是 smoke 脚本自身缺陷掩盖了真实失败码：

1. **脚本缺陷**：`awaitInitialization` 读 `result.status`，而 `getInitialization`
   的真实返回形状是 `{ ok: true, view: InitializationView }`（状态在 `result.view.status`）。
   状态永远读不到 → 失败 job 也只会轮询到 5 分钟超时，真实失败码被掩盖成
   `INITIALIZATION_TIMEOUT`。分阶段链路已完成 planning + 3/4 表达单元，摘要却显示
   「零请求秒失败」。修复：读 `view.status`，失败时取 `view.failureKind`。
2. **真实失败码**（从遗留临时 SQLite 的 `narrative_jobs` 恢复）：
   `unit_output_fact_unavailable`，单元 `char_liu_2`；同 NPC 的 `char_liu_1` 已通过，
   planning 与两个 narration 单元也已 approved。
3. **离线复现**（`tmp/diagRepro4.mjs`，纯函数、不触网）：

   | 模型输出 | 修复前 | 修复后 |
   | --- | --- | --- |
   | `suspected`（按披露段合法降级） | ❌ `unit_output_fact_unavailable` | ✅ 通过 |
   | `known`（与观察声明相比属升级） | ✅ 通过 | ❌ `unit_output_fact_unavailable` |

**教训（供同类 smoke 复用）**：摘要里的稳定诊断码必须与存储任务记录交叉验证；
`requestCount: 0` 与「有真实失败码」不可能同时成立，二者矛盾时必须先查脚本读取路径。

### 修复后的真实探测推进

修复前两局均在 planning + 部分 narration 后失败；修复后两局均已深入表达阶段
（urban：planning 7 + narration 4 + character 2；wuxia：planning 4 + narration 4
+ character 1）。**失败点从 planning 契约前移到 character 披露校验，再前移到
更深单元。**

## 真实质量评审

> **本节数据待 Step 4 真实 smoke 完成后回填。**

- 模型标识：`ai-slg-game-model`
- 请求参数：`temperature=0.2`、`jsonMode=json_object`、`thinking=off`
  （按用户决策优先关闭推理；若质量不足再考虑提高思考深度）
- 预算上限：**160 provider transport 请求 / 45 分钟 / 单局 40 回合**
- 通过标准：3/3 开局 + 6/6 续接在预算内成功，至少 1 局完整短篇通关；
  失败样本全部留存

*（待填：批次表、实际延迟、请求数、transport 重试、质量拒绝、剩余限制）*

## 人工逐条检查

> **本节数据待真实 smoke 完成后回填。**

需逐条检查：旁白/台词秘密泄露、纯对白、事实来源、两条策略分化。

*（待填）*

## 已知限制

- 本报告不声称自然语言绝对安全。审批覆盖已列格式与结构，不宣称理解任意语义；
  隐喻与意图细节由人工验收判断。
- 无 provider 幂等支持，不声称「恰好一次」。
- 仅证明已列格式和结构合规，不把引用合规当作正文安全证明。

## Step 5 浏览器验证

> **未执行。** 需实机验证：202 开局刷新恢复、失败同任务重试、NPC/旁白阅读
> 顺序、两个 label 无小说前缀、选择导致不同目标。不以静态截图代替实际交互。

## Step 6 文档归位

> **进行中。** 原位更新事实归属文档（运行时链/预算归 runtime，知识归
> NPC/记忆，API 恢复与配置归 operations/AI环境，玩家纯对白和分支归策划）。
