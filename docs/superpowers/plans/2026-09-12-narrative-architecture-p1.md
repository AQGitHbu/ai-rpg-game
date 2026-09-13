# 完整小故事 P1 收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 先让真实 AI 从正式新游戏创建走到普通短篇的成功结局，确认规则与持久化闭环，再验证交付、主动退出和选择后果。

**Architecture:** 保留 main 继承的完整场景作者、Entity/History/Thread、正式规则、权限与 A/B 提交。服务端投影并编译续接结构；AI 一次生成完整场景内容和具体选择。固定初态仅用于诊断，后续均走生产 provider 和仓储。

**Tech Stack:** TypeScript、Next.js、SQLite/@libsql/client、Vitest；不新增运行时依赖，不改 foundation。

## Global Constraints

- 唯一总 Spec：[架构设计](../specs/2026-09-12-narrative-architecture-design.md)。本 Plan 原位取代旧十项建设任务；已实现能力和失败证据见 [验收记录](../reports/2026-09-12-narrative-p1-acceptance.md)。
- 在 `codex/narrative-architecture`、`.worktrees/narrative-architecture` 工作，起始代码 `fe9c2859`；不修改 main/staged，不修改 current-phase.json，不合并分支。
- “质量与游戏性优先于 token、调用数和耗时。”不增加 Entity 字段、reviewer、互动操作或记忆类别。
- “规则已结算结果不可被后续循环改写”；“AI 失败显式重试，确定性内容只用于规则反馈和显式 fixture”。
- 固定初态诊断必须标 `claimScope=fixed_opening_story`；不叫自由开局，不修改原数据库或旧响应，不重用旧代码的 pass 作为新生成 pass。
- 先 core 生产主线，再交付/退出专项；每路线最多 24 动作、每 epoch 3 候选/24 HTTP；core 与 focused 各批 200 HTTP、90 分钟。focused 内先 deliver 成功再 withdraw，不用短退出增加完成数。
- 必须使用实际 read model 选项/token，经正式 performTurn、ensure、SQLite；无开发状态补丁，无替代剧情。
- 所有已有规则/权限回归保留。六路线综合覆盖移到核心诊断后，不删除失败分母、不改旧报告为通过。

## 已有基础与当前边界

已实现 History、Thread、双向召回、角色判断、条件披露、交付/退出规则、有限修订和严格响应重放；不重新建设。工程门禁不代表 live 成功。真实故事已有中断恢复后的终局，尚无全程无中断且叙事状态正常的通过样本；详细数字只在验收报告维护。

## Task C1：固定初态与两路最小正式旅程

**Files:**
- Create: `scripts/narrativeP1Seed.mjs`、`scripts/narrativeP1Seed.node-test.mjs`。
- Modify: `scripts/narrativeP1Journey.mjs`、`scripts/narrativeP1Choices.mjs`、`scripts/narrativeP1Journey.node-test.mjs`。
- Modify: `src/game/application/testing/narrativeP1LiveJourney.ts` 及其测试、`package.json` 的脚本测试入口（若需登记新测试）。
- Docs: `docs/superpowers/reports/2026-09-12-narrative-p1-protocol.md`、`docs/agent/AI环境.md`。

**Interfaces:**
- CLI 新增 `--profile=focused --opening-source=<获批开局产物目录>`；register/live/replay 仍为同一脚本。
- `NarrativeP1RouteKind` 新增 `deliver|withdraw`，focused 登记 `S1-deliver`、`S1-withdraw` 两路；协议冻结源协议/代码、opening runtime/audit/database 哈希及 opening 语义状态哈希。
- `loadNarrativeP1Seed(sourceDirectory)` 返回已验证的源路径、manifest 和期望 opening 状态；不打开原 SQLite 写连接。复制后的 SQLite 由正式 repository 校验与期望状态一致，且 turn=0、ready、未结束。
- 其余 live/replay/runtime 契约复用，不为诊断新建生产 API。后续流在最底层记录/重放，seed 初始化本身不算 live HTTP。

- [x] 写源篡改、未获批/非零行动快照拒绝测试；新 focused 协议的两路分母、源哈希不匹配零调用测试。

```js
assert.throws(() => loadNarrativeP1Seed(tamperedDirectory), /SEED_/);
assert.equal(protocol.claimScope, 'fixed_opening_story');
assert.deepEqual(protocol.routes.map(route => route.kind), ['deliver', 'withdraw']);
```

- [x] 实现 seed 校验、独立复制和起始状态比较；若源码变化仍需新登记，但允许明确来源的历史获批初态，不伪称旧请求重放。
- [x] deliver 使用当前合法目标/真实 authored choices 推进，优先唯一已绑定接应人的 give_item；不强制保密/引荐/自由核验。withdraw 在交付前执行四次有效行动，再选当前合法 abandon_quest；两路都须真实 ending，完成交付或放弃有对应规则证据。
- [x] 取消按 label 关键词猜动作或猜 ID 的可能；无可见合法选择记失败，不能选未投影的 Action。完整记录玩家实际输入、NPC 台词、旁白、选择和状态引用供人工阅读。
- [x] node 脚本测试、focused protocol Vitest、typecheck 通过；独立复审，提交。

## Task C2：单一场景槽投影与编译

**Files:**
- Create: `src/game/application/server/ai/narrativeDraftProjection.ts` 及测试。
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`。
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.ts` 及测试。
- Docs: `docs/agent/运行时AI导演与场景表演.md`。

**Interfaces:**
- `projectNarrativeDraft({worldState,storyState,job,includeDeliveryReturn?})` 返回 current 和明确续接 slotKey、服务端 terminal；覆盖普通当前决策、下一幕抵达、终局和已有可选归还图。
- 决策作者输出 `{worldDelta, sceneDrafts:[{slotKey,scene}], interactionProposals?}`；scene 保留现有正文、引用和明确 candidateId/label。AI 不写 terminal 或 continuationScenes 包装。
- `compileNarrativeDraft(value, context)` 返回 `{ok:true,value:unknown}` 或 `{ok:false,path:string,code:string}`；只能组装当前运行时 NarrativeBundleProposal 的结构，不补正文或按位置换绑动作。
- 既有内部旧 DTO 测试/已记录内容只能经显式 allowLegacyDecisionDto 输入适配解析；生产 prompt 只要求新 draft，最终审批与存储保持唯一既有接口。

- [x] 写缺失/多余/重复槽和错误图选择拒绝测试，以及普通/换幕/终局的 terminal、顺序和原文逐字保留测试。

```ts
expect(compileNarrativeDraft({worldDelta:null,sceneDrafts:[]}, context))
  .toMatchObject({ok:false,code:'missing_slot'});
// 输入顺序不同不改变明确 slotKey 的归属；未知槽不得被静默丢弃。
```

- [x] prompt 与 compiler 共用投影；可选归还必须显式选择图且该图确实存在。下一幕/ending 仍遵循现有 worldDelta 审批，不因编译结构自行创造实体。
- [x] live source 编译后仍运行现有 parser、权限、审批与 review；修复反馈包含准确路径，未知引用继续拒绝。
- [x] 相关 source/approval 测试、typecheck、boundaries 通过；独立复审，提交。

## Task C3：冻结后执行核心诊断并据证据收束

**Files:**
- Artifacts: `artifacts/narrative-p1/p1-focused-01/`（被忽略）；后续 replay 写独立子目录。
- Reports: 原位更新 `docs/superpowers/reports/2026-09-12-narrative-p1-acceptance.md`，保留旧批次。
- Plan: 本文件 gates。

- [x] 完成一次 `npm run accept` 后冻结代码，登记 diag03 获批开局来源与固定政策。

```powershell
node scripts/narrativeP1Journey.mjs --mode=register --profile=focused --run-id=p1-focused-01 --opening-source=artifacts/narrative-p1/p1-diag-03 --protocol=artifacts/narrative-p1/p1-focused-01/protocol.json --output=artifacts/narrative-p1/p1-focused-01
$env:RUN_REAL_AI_JOURNEY='1'
node scripts/narrativeP1Journey.mjs --mode=live --profile=focused --run-id=p1-focused-01 --protocol=artifacts/narrative-p1/p1-focused-01/protocol.json --output=artifacts/narrative-p1/p1-focused-01
```

- [ ] deliver 先完成才执行 withdraw；两路都从同一获批初态独立开始。若第一路失败，保存第二路未执行及失败层；只对明确根因允许一个新冻结修复批次，不连续重采。
- [ ] 严格 replay 新流，逐步比较状态并保存原始响应/调用计数；失败重放一致不算故事成功。
- [ ] 人工完整读两路：起因、阻碍、输入回应、NPC 动机、真实后果和结局；按 Spec 五维门槛评分。未完成不评分。
- [ ] 分开写核心诊断结果、生产自由开局结果、UI结果、main 对照；后四者未执行就明确未执行，不借缩小范围宣布整个 P1 通过。
- [ ] check:docs、相对链接与事实归属复核、git diff --check，提交证据。

## 当前执行：规则正确与完整主线

用户重新明确先保证规则正确、完整跑通游戏，main 仅作成功路径参考。此前两批停止重采属于已结束诊断；本轮先作架构收敛后重新冻结生产主线验收，不重跑旧失败批次，也不要求先覆盖保密矩阵。

### D1：规则依据明确的审阅与稳定角色方案

**Files:** `src/game/application/server/ai/liveNarrativeCandidateReview.ts`、同目录规则审阅契约 helper/test、`narrativeContext/narrativeBundleContext.ts`、`src/game/application/generatePendingNarrativeBundle.ts` 及测试；运行时 AI 系统文档。

**Interfaces:** 规则审阅上下文明确列出当前合法 Action/续接步骤、正式物品、允许引用的事实及引用/披露边界；阻断缺陷必须提供能校验的正式依据和具体规则影响。无玩法效果的环境/服饰及风格意见属于质量观察，不指挥状态，不吞掉真实披露或行动绑定错误。`prepareNpcNarrativeContext` 的已批准 outward 在同一 worker/规则快照的候选修订中复用，刷新候选版本与预算回调，不缓存失败、不跨玩家行动复用。

- [x] 先写规则依据与质量观察的回归；以已保存的换幕稿验证无规则物品 ID 的斗笠不成为 inventory 违规依据，提前移动对应明确续接 step、泄露已保护事实和错误 Action 绑定仍拒绝。
- [x] 实现明确的审阅规则契约与结果解析，保持候选 hash 和确定性审批。不得按句子加白名单，不恢复 main 的位置猜测，不把质量建议变成规则状态。
- [x] 写并实现同次生成正文重试只调用一次成功 NPC 判断；不同 job 重新判断、失败/取消仍按显式失败恢复。此轮不新增持久化 schema；进程恢复重建依赖时不携带旧进程内候选修订。
- [x] 定向测试、typecheck、boundaries 与独立复审通过。

### D2：真实创建到终局的普通短篇

**Files:** `src/game/application/testing/narrativeP1LiveJourney.ts` 及测试、`scripts/narrativeP1Journey.mjs`、`scripts/narrativeP1Choices.mjs` 及测试、AI环境/协议/验收报告。

**Interfaces:** CLI `--profile=core` 登记 `claimScope=production_core_story`、单路线 `S1-complete`，必须真实 createGame，无 opening seed。固定新游戏输入是普通武侠短篇，明确玩家与当地 NPC 共同处理渡口纠纷，不强制秘密、保密、身份谜题或递送；剧情仍全部由生产 AI 创作。仅从 read model 的真实 opaque choices 推进当前主线，普通支持/质疑优先于非必要互动，必要时消费合法移动/物品/战斗动作。完成必须真实 ending 且非主动放弃；若生成递送契约仍验证实际交付。

- [x] 协议测试验证 core 输入/路线/来源冻结，不能注入 seed；政策测试验证实际 Action 选路，不用 label 关键词或状态补丁。
- [x] 实现 core 完成条件与正式选路；24 有效动作、200 HTTP、90 分钟、每 epoch 现有 3 版本/24 HTTP，上限不增加。
- [x] 通过完整门禁与独立复审后冻结，执行 p1-core-01；修复正式地图入口后执行 p1-core-02。原生进程中断后保留存档，正式恢复同故事至成功终局，证据见报告。
- [ ] 完成生产短篇后严格零网络 replay，检查任务/位置/物品/结局事件及中途重载；阅读完整正文但规则通关闭环与叙事质量分开报告。再回到交付/退出专项。

### D3：通关文本暴露的规则时序边界

**Files:** `narrativeDraftProjection.ts`、`narrativeBundleContext.ts`、`narrativeReviewRules.ts`、`liveNarrativeCandidateReview.test.ts`、`endingDecision.ts` 与对应系统文档。

- [x] 续接槽由真实 trigger 投影展示时已结算语义，作者与审阅共用；take/give 不再受生成时旧背包的限制，仍不允许 current 槽提前获取。增加正式 store/graph/prompt 与物品状态阻断回归。
- [x] 终幕规则按钮改为中性支持/疑虑，不凭空引入证据、真相；Action 和结局条件不变。独立复审通过。
- [ ] 后续冻结 live 验证新提示效果与无中断稳定性。59fe62b0 的 core03 已验证取物后持有时序，16 行动后终局结构失败；36 响应严格重放一致，不算全程通关。

### D4：终局作者结构契约收敛

**Files:** `narrativeDraftProjection.ts`、`liveNarrativeBundleSource.ts`、`narrativeBundleContext.ts` 及测试、运行时 AI 系统文档。

- [x] 编译作者省略的 NPC 表情与空引用元数据，保留显式值供严格解析与权限审批；不补正文、实体 ID 或节拍摘要。用 core03 实际终局候选验证，不放宽内部 DTO。
- [x] 终局明确 worldDelta 内必须有非空 beatSummary 与 endingPair，缺失摘要返回具体路径；移除通用结构失败对 newFact 的错误归因。
- [x] 定向测试、完整门禁与独立复审后冻结为 38b8ea51。core03 失败存档独立副本正式显式重试一次，追加一个行动后成功结局，7 HTTP；严格重放 7 响应、4 状态一致。范围为失败终局重试，不冒充原批连续成功。
- [x] 关闭实跑暴露的终止边界：合法终幕立场已经正式写入 ending_reached 时不再创建下一次 NPC 生成任务；纯 CAS 保留玩家历史与结局，退出故事仍保留正式 story_exit 生成。53 项相关回归、完整 accept 与独立复审通过；验收同时要求叙事 ready，不能以成功结局掩盖后台失败。
- [ ] 冻结后验证真实创建到终局的无中断短篇及完整响应重放。core04 在第一个候选的审阅路径解析失败，5 响应严格重放一致；统一请求显式 proposal 包装前缀与内部候选路径后再冻结，不改审阅事实判断。

## 后续 P1 验收边界

普通生产短篇通过后执行交付/退出专项、同条件 main 共同玩法对照及实际 UI 创建→中途重载→终局；这部分仍属于 P1，未完成前不合并 main、不进入 P2。六路线保密/公开/核验综合矩阵保留为扩展验收，非首个故事前置。

## Gates

- C1：实现与独立复审通过；17 个脚本测试通过，退出任务失败事件与交付前分叉均已验证。
- C2：实现与独立复审通过；相关 87 tests、typecheck、130 项边界通过。
- C3：focused01 与唯一修复批 focused02 均失败，各五行动后结束，退出路线未执行；两批全部 55 次真实响应均严格重放一致。格式契约已修复，剩余审阅判定和修订依赖边界见上节。完整故事仍未完成，不执行第三批连续重采。
- D1/D2：规则审阅与入口收集完成；b6cc0e5b 的真实短篇经进程中断恢复后完成 18 次行动和成功终局。恢复段 9 次响应、12 状态严格重放，原中断流无完整封存，不算全程无中断通过。
- P1 总结论：未通过；首个完整故事已取得，后续先验证规则时序修复和进程稳定性，交付/退出、UI 与 main 对照分别记证据。
