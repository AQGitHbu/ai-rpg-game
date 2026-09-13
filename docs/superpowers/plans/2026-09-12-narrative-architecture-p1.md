# 完整小故事 P1 收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 先让真实 AI 在固定、获批的初始世界中完成一个交付故事，再用同一初态验证主动退出的不同后果。

**Architecture:** 保留 main 继承的完整场景作者、Entity/History/Thread、正式规则、权限与 A/B 提交。服务端投影并编译续接结构；AI 一次生成完整场景内容和具体选择。固定初态仅用于诊断，后续均走生产 provider 和仓储。

**Tech Stack:** TypeScript、Next.js、SQLite/@libsql/client、Vitest；不新增运行时依赖，不改 foundation。

## Global Constraints

- 唯一总 Spec：[架构设计](../specs/2026-09-12-narrative-architecture-design.md)。本 Plan 原位取代旧十项建设任务；已实现能力和失败证据见 [验收记录](../reports/2026-09-12-narrative-p1-acceptance.md)。
- 在 `codex/narrative-architecture`、`.worktrees/narrative-architecture` 工作，起始代码 `fe9c2859`；不修改 main/staged，不修改 current-phase.json，不合并分支。
- “质量与游戏性优先于 token、调用数和耗时。”不增加 Entity 字段、reviewer、互动操作或记忆类别。
- “规则已结算结果不可被后续循环改写”；“AI 失败显式重试，确定性内容只用于规则反馈和显式 fixture”。
- 固定初态诊断必须标 `claimScope=fixed_opening_story`；不叫自由开局，不修改原数据库或旧响应，不重用旧代码的 pass 作为新生成 pass。
- 先 deliver，再 withdraw；各最多 24 动作、每 epoch 3 候选/24 HTTP；批次 200 HTTP、90 分钟。首路失败不启动短退出路线来增加完成数。
- 必须使用实际 read model 选项/token，经正式 performTurn、ensure、SQLite；无开发状态补丁，无替代剧情。
- 所有已有规则/权限回归保留。六路线综合覆盖移到核心诊断后，不删除失败分母、不改旧报告为通过。

## 已有基础与当前边界

已实现 History、Thread、双向召回、角色判断、条件披露、交付/退出规则、有限修订和严格响应重放；不重新建设。2749 tests 的工程门禁不代表 live 成功。旧诊断最新停在开局，尚未产生完整故事；详细数字只在验收报告维护。

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

## 唯一剩余收敛任务：审阅判定契约

两批固定初态诊断结束，停止继续重采。本项对应 Spec §9.3 的待实现边界，先完成离线设计与真实候选回归，再另行冻结执行验收；不能把写入 Plan 视为已实现。

- [ ] 定义规则事实/可创作细节、行动意图/已结算效果的边界；用 focused02 换幕三版原文验证提前移动与新威胁仍被拒，普通无效果服饰不要求补 Entity，冲突服饰/假造持有关键道具仍拒绝。不是给斗笠或某个句子开白名单。
- [ ] 同一权限投影区分 reference-only 与正文可披露事实，包含授权来源、操作范围和候选绑定；作者与 reviewer 消费同一边界。复用现有领域状态，不增加记忆类别或秘密正文可见范围。
- [ ] 将获准 NPC 方案作为候选修订依赖；正文修订复用，方案重判须显式换版本并清理过时反馈。保留 candidateHash、失败恢复与有界预算。
- [ ] 用 focused02 原始审阅请求和候选做回归及独立复审，记录稳定旁白缺陷的覆盖情况；这些是离线验证，不伪称新 live 已成功。通过后再冻结完整交付→同初态退出的验收入口。

## 后续 P1 验收边界

核心诊断通过后才执行真实自由开局、同条件 main 共同玩法对照及实际 UI 创建→中途重载→终局；这部分仍属于 P1，未完成前不合并 main、不进入 P2。六路线保密/公开/核验综合矩阵保留为扩展验收，非首个故事前置。

## Gates

- C1：实现与独立复审通过；17 个脚本测试通过，退出任务失败事件与交付前分叉均已验证。
- C2：实现与独立复审通过；相关 87 tests、typecheck、130 项边界通过。
- C3：focused01 与唯一修复批 focused02 均失败，各五行动后结束，退出路线未执行；两批全部 55 次真实响应均严格重放一致。格式契约已修复，剩余审阅判定和修订依赖边界见上节。完整故事仍未完成，不执行第三批连续重采。
- P1 总结论：未通过；核心诊断、生产创建、UI 与 main 对照分别记证据。
