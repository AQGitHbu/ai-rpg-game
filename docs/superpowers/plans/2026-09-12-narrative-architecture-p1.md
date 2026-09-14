# 完整小故事 P1 收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 先让真实 AI 从正式新游戏创建，完成三幕公开递送、实际交付与成功结局，确认规则和持久化闭环，再验证主动退出和选择后果。

**Architecture:** 保留 main 继承的完整场景作者、Entity/History/Thread、正式规则、权限与 A/B 提交。服务端投影并编译续接结构；AI 一次生成完整场景内容和具体选择。固定初态仅用于诊断，后续均走生产 provider 和仓储。

**Tech Stack:** TypeScript、Next.js Node runtime、Node 24 内置 SQLite、Vitest；不引入自编译原生驱动。数据库替换覆盖 RPG 持久化与 foundation 共享日志，其余叙事范围不变。

## Global Constraints

- 唯一总 Spec：[架构设计](../specs/2026-09-12-narrative-architecture-design.md)。本 Plan 原位取代旧十项建设任务；已实现能力和失败证据见 [验收记录](../reports/2026-09-12-narrative-p1-acceptance.md)。
- 在 `codex/narrative-architecture`、`.worktrees/narrative-architecture` 工作，起始代码 `fe9c2859`；不修改 main/staged，不修改 current-phase.json，不合并分支。
- “质量与游戏性优先于 token、调用数和耗时。”不增加 Entity 字段、reviewer、互动操作或记忆类别。
- “规则已结算结果不可被后续循环改写”；“AI 失败显式重试，确定性内容只用于规则反馈和显式 fixture”。
- 固定初态诊断必须标 `claimScope=fixed_opening_story`；不叫自由开局，不修改原数据库或旧响应，不重用旧代码的 pass 作为新生成 pass。
- 先 core 三幕递送生产主线，再交付/退出专项；每路线最多 24 动作、每 epoch 3 候选/24 HTTP；core 与 focused 各批 200 HTTP、90 分钟。focused 内先 deliver 成功再 withdraw，不用短退出增加完成数。
- 必须使用实际 read model 选项/token，经正式 performTurn、ensure、SQLite；无开发状态补丁，无替代剧情。
- 所有已有规则/权限回归保留。六路线综合覆盖移到核心诊断后，不删除失败分母、不改旧报告为通过。

## 已有基础与当前边界

已实现 History、Thread、双向召回、角色判断、条件披露、交付/退出规则、有限修订和严格响应重放；不重新建设。工程门禁不代表 live 成功。Task 16 已完成一条正式创建的三幕递送核心故事，规则、正文、持久化均通过；实机 UI 链路已完成，交付/退出同初态对照仍未验收。详细数字只在验收报告维护。历史失败批次保留原结论，不再作为重跑入口；后续只进入尚未完成的交付/退出专项，不重开已完成建设任务。

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

- [ ] deliver 先完成才执行 withdraw；两路都从同一获批初态独立开始。若第一路失败，保存第二路未执行及失败层；只对明确根因允许一个新冻结修复批次，不连续重采。`p1-focused-03` 已按该规则封存：deliver 第 8 个动作后 `AI_GENERATION_FAILED`，withdraw 保留未执行分母。
- [ ] 严格 replay 新流，逐步比较状态并保存原始响应/调用计数；失败重放一致不算故事成功。`p1-focused-03` 已完成零网络 replay，27 次传输尝试与 live 失败状态一致，但不算故事成功。
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
- [x] core04 的审阅路径解析失败已修复；统一请求显式 proposal 包装前缀与内部候选路径，原两条缺陷保留并可修订，不改审阅事实判断。5a0b4154 完整 accept 与独立复审通过。
- [ ] 冻结后验证真实创建到终局的无中断短篇及完整响应重放；数据库故障已排除，core06 在 4 行动后遇到角色知情/可回答性与审批契约阻断。

### 数据库前置：排除原生持久化崩溃

core05 与同故事恢复均发生原生异常，转储与准确上游版本源码指向 libsql 0.9.30 重复关闭缺陷。现已以 Node 内置 SQLite 替换并完成验证；唯一后续样本 core06 正常退出但剧情生成失败。证据与边界见验收报告，不追加提示补丁或继续新故事抽样。

- [x] 捕获单游戏进程转储，独立核对故障模块、版本与第一层调用点；确认准确发布源码及未合并的上游修复，不把随机探针未复现当作排除。
- [x] 使用现成的 Node 24 `node:sqlite` 替换 libsql，禁止自编译原生依赖。旧存档无需兼容迁移，验收创建新数据库；历史故障证据保留。
- [x] 核对 RPG 存档与共享日志两个实际消费者的依赖解析和供应链固定方式；foundation 公共 package 在同名工作树修改并完成消费者合同和 family 门禁，通过官方脚本同步规范副本。
- [x] 依赖修复通过持久化 CAS/回滚/租约/重载及日志合同后，再冻结普通故事 live 与严格 replay 验收。core06 进程正常、数据库完整性通过、失败状态重放一致；成功终局 ready 仍未取得，数据库修复不改变故事目标或放宽规则。

### Task 10：现成 SQLite 驱动与完整故事前置

**Files:** RPG `src/game/application/server/persistence/sqliteClient.ts`、同目录测试、`src/dependencyBoundaries.test.ts`、`package.json`/lock、开发规范及数据库/AI 环境文档；foundation 同名 worktree 的 `packages/logging/src/sqlite/logDatabase.ts`、公共类型、package/lock、测试与 dist。

**Interfaces:** RPG 保留仓储实际使用的 `execute(statement)`、`batch(statements, mode)`、`transaction(mode)`、`close()`，仅声明所需本地接口，不再依赖 libsql 类型。事务必须隔离异步调用间的写入，提交后释放，未提交 close 回滚，重复 close 安全；同文件多个 client 的竞争不能同步等待锁而阻止持锁调用继续。日志保留已公开的查询/事务/迁移/retention 契约，驱动仅用于 Node 服务端。Node 下限固定为 24.15.0，使用当前现成安装，不构建 Node/SQLite/Rust/C++。

- [x] 写并运行真实 SQLite 回归：参数绑定（含特殊路径）、提交与未提交回滚、双 client 并发 CAS、失败后重用、关闭幂等、重开读回；现有 lease 与 repository 测试保留。

```ts
const first = await client.transaction("write");
await first.execute("INSERT INTO sample (id) VALUES (1)");
first.close();
expect((await client.execute("SELECT * FROM sample")).rows).toHaveLength(0);
client.close();
client.close();
```

- [x] 实现上述最小适配；共享日志在 foundation 自己的工作树安装/构建/测试，两个消费者通过公开 API 消费，不编辑 sibling main，不复制共享实现。
- [x] 独立审核事务与关闭语义，运行覆盖 RPG 完整 accept 各项命令的 family 门禁及日志公共测试/消费者合同，确认实际进程不加载 libsql 原生模块。RPG 2811 tests/131 boundaries 通过。
- [ ] 冻结代码与依赖，新建 core 普通故事；正式 createGame → 真实选项 → 成功 ending 且 narrative ready → 严格零网络 replay。core06 已执行，4 行动/15 HTTP 后剧情审批失败；零网络重放 15 响应/6 状态一致，但不算成功通关。实际阻断为新 NPC 事实知情、任务提问与可回答内容的契约；Task 11 已修复创建与权限边界，旧故事重试尚未执行，不补提示、不重采掩盖失败。

### Task 11：P1 动态 NPC 既有事实声明与说话权限一致性

**范围：** 只修 core06 暴露的 NPC 创建知识契约及对应审阅权限。不得新增 Entity 持久字段、知识修复/迁移接口、记忆类别、reviewer、对话操作枚举或故事专属提示；不修改 foundation，不新增故事抽样。

**实现契约：** newNpc 增加可省略的显式既有事实 ID 声明，省略等于空。严格解析保留声明，拒绝非法类型、重复和未知引用；审批只允许当前实体上下文闭包内、有可验证公开初始化来源的事实，不能用 player discovered 或角色描述推定知识。沿用现有 knowledge entries/initial_world/public 与同批 newFact 私密初始化，不自动授予未声明事实。作者获得同一资格投影与准确 schema，这是接口同步，不追加剧情措辞规则。

**审阅契约：** 用确定性审批已认可的候选场景/角色身份生成逐说话人权限依据。核实目前 focus NPC 的单一权限是否被套给续接 NPC，若有则修复该实际缺口；候选新 NPC 必须使用获批创建知识，不能用模型台词自证授权。保留候选 hash、场景受众与秘密边界，不把未来状态替换整个当前世界。

- [x] 离线回归覆盖显式 public 引用、空声明、unknown/duplicate/secret/conditional/越界拒绝、同批 private 保持秘密、物化与持久化后权限一致；用 core06 原始候选验证缺失声明不被自动补齐，修改候选必须显式声明，不造金额。
- [x] 完成最小实现与对应系统契约原位更新；独立审阅及相关测试、typecheck、boundaries、check:docs 通过，再运行必要完整门禁。
- [ ] 冻结后在 core06 原始证据的独立副本上执行同 job 正式 retry，保留原始失败与行动，不直接修改知识或强迫生成分享选项。新增调用单独登记有限预算及来源；完成后严格 replay 并阅读全文，未达到 ending 且 narrative ready 就如实记录未通关。代码修复 801139ff，实际冻结运行 0bd094e4。用户确认后已执行：原故事一次正式 retry 新增 3 行动/9 HTTP，累计 7 行动后审批失败，严格重放 9 响应/6 状态一致。另按用户要求独立新建中篇，28 行动/69 HTTP、五项主线完成及中途真实重载通过，但结局入口与生成需求不一致导致失败；69 响应/33 状态严格重放一致。未达到 ending 且 narrative ready，不勾选通关。

### Task 12：终幕线程闭合、结局需求与入口一致性

**范围：** 修复独立中篇 medium-story-01 暴露的规则契约，保留已提交行动和原始失败证据；不添加剧情提示补丁、不新增抽样、不直接改存档。

**契约：** Thread 只能由实际已提交事件及可验证规则条件闭合。以关联 Quest/目标/承诺和显式 closure 判定，不以数组中第一个 question 代表所有主线；无依据或尚未满足条件的线程保持未解决。结局对已存在时不得重复请求，作者与审批使用相同演化需求。满足终幕条件后开放正式玩家结局立场选项，由规则结算结局。正式 retry 必须能重建失效的派生状态，保持原 Action、任务、事件和候选证据，不重执行事务 A、不直接授予 ending。

- [x] 最小实现与离线回归：多个关联线程、无关/未满足线程不误闭合、已有结局对不重复生成、同一失败 job 正式重试及真实结局入口。179 项受影响测试通过，独立 Spec/Quality 审核通过。
- [x] 独立审核、受影响测试及 typecheck/boundaries/check:docs 通过；完整测试 2830 passed、1 skipped，lint 0 errors（保留既有 warning）。冻结后执行同局续跑。
- [x] 冻结 3c40de6e，从 medium-story-01 副本正式 retry 一次；新增 3 HTTP、1 次结局立场行动后成功 ending 且 narrative ready，累计 29 行动/72 HTTP。新段严格 replay 0 HTTP、3 响应/4 状态一致，原证据哈希未变，全文已读。规则通关成立，正文结果收束仍不足；原失败运行不改为单一版本无中断通过。

### Task 13：中心冲突与终幕结果闭环

**目标：** 普通短篇中，最终幕实际处理开局冲突；玩家看到针对该冲突的两种选择，正式选择后展示对应已批准结果。禁止用完成开场问话或旧场景加结局标题冒充收束。

**范围与接口：** 保留现有 Action、trust/doubt、主线目标类型、唯一 author/reviewer、A/B 与 SQLite。不新增 Entity 字段、记忆、规划器、互动枚举或生成链。允许在现有 NarrativeBundle 提案/状态增加有界 endingOutcomes 呈现契约（两条固定分支），因为现有 endingPair 仅有名称/200字描述，不能承载选择与完整场景；不增加通用分支图。

**Files:** `src/game/domain/narrativeBundle.ts`；`src/game/gameplay/rpg/narrativeBundle/endingDecision.ts`；`src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`、`approveWorldDelta.ts`；`src/game/gameplay/rpg/storyThreads/advanceStoryThreads.ts`、`src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts` 与结算 facade；`src/game/application/server/ai/narrativeDraftProjection.ts`、`narrativeContext/narrativeBundleContext.ts`、必要的 `worldNarrativeContext.ts`；`src/game/application/approveNarrativeBundle.ts`、`performTurn.ts`、`gameSessionView.ts` 与现有审阅投影；`src/components/CurrentGameScreen.tsx` 及测试只接入获批结果正文的结局显示；对应测试及系统文档。可抽出同目录 ending outcome helper，禁止顺手重构其他系统。

**终幕职责：** 从 currentAct/targetActs 派生最终幕职责，作者与审批投影一致。最终幕的地点、NPC 和现有目标应承接中心冲突处理，而非继续把核心处理推给不存在的下一幕。清除对最终幕仍一律禁止收束的冲突指令。模型不得把普通分享/核验/引荐操作解释为通用开船效果，不得替未在场且无依据的人达成协议。

**Thread：** 仅沿已有明确主线 Quest 绑定延续后续获批主线 ID，不自动绑定无关/承诺线程。完成问话只证明准备推进。最终决策许可与 Thread 已解决分开：满足全部绑定任务及其他现有约束可进入终幕决定，但主线 concern 的收束依据须包含实际 ending 事件。未满足显式 closure/goal/promise 的问题不可被清空；终局文字必须明确说明仍保留的争议，不把任务状态当成开船事实。

**有界结果契约：** 作者提交 `endingOutcomes` 两项，每项只有 `themeKey: trust|doubt`、`choiceLabel` 与现有 `BundleSceneProposal` 场景；服务端绑定真实 ending ID 与既有 support/challenge Action，标签不改变动作能力。结果场景无后续 choices，仅在相应结果真正结算后发布。当前场景在选择前停止，两结果作为条件内容接受同次完整候选审批/审阅，不提前写 History、知识或事实。结果中只能使用已有授权事实、事件与当前规则可产生的结局后果，不能发明未结算行动。实际 resolveEnding 结果优先于按钮主题，保密违约强制 doubt 等既有规则保持。

**正式消费：** performTurn 按实际 endingId 消费获批结果场景，与 Action/ending_reached/场景已展示记录/History 一次 CAS 提交；不再沿用选择前 currentScene，不新增结局后的 provider 调用。不匹配、缺失或失效场景须在写入前失败，不授予空正文结局。重放、重复提交、重载、失败零写入沿用现有契约。旧 offline fixture 可以明确走既有 fixture 路径，生产不得静默回退。

- [x] 写失败回归并实现：两个分支绑定与未知/重复/缺失拒绝，未选择结果不发布，实际选中结果更新场景与 History，重复 Action 不二次写入，保密强制 doubt 消费真实结果，无合法结果零写入；开场问话不闭合中心 Thread，后续主线绑定及 ending 证据闭合，无关约束不被忽略。

```ts
expect(before.worldState.ending).toBeNull();
expect(after.worldState.ending?.endingId).toBe(expectedEndingId);
expect(after.storyState.narrative.status).toBe("ready");
// 结果正文必须来自对应获批槽，不能复制选择前正文或未选分支。
expect(publishedScene.sceneId).not.toBe(decisionScene.sceneId);
expect(publishedScene.narration).toBe(approvedOutcomeScene.narration);
expect(newEndingEvents).toHaveLength(1);
```

- [x] 完成独立范围审核及限定复审；受影响回归、typecheck、131 项 boundaries、完整 2834 tests（1 skipped）与 check:docs 通过，lint 无错误（50 项既有 warning）。中篇选择后保留旧正文的失败形态由实际结果消费回归覆盖，不修改旧存档/审计或补写旧正文。
- [ ] 冻结实现后只登记一局普通短篇，正式 createGame → 实际选择 → 成功 ending/ready → 严格零网络 replay，阅读全文核对起因、阻碍、选择、后果与收束。已冻结 2f6b2dd7 执行 short-closure-01：2 行动、13 HTTP 后换幕审批失败，无 ending；严格零网络重放 13 响应、5 状态一致。该批未到中途重载及终幕。后经用户授权，在 5101ec42 验证 short-closure-02：18 行动、32 HTTP，成功 ending/ready，中途重载与严格零网络 32 响应/23 状态通过；但 scene.turn 保留生成回合且结果补写未执行的返程/复航后果，协议与正文规则仍未通过，不勾选整体验收。失败证据保留，不连续抽样或追加剧情提示批次。本任务不执行交付/退出扩展、实机 UI 全流程专项或 main 对照；结局正文实际可见的最小 UI 接入属于本任务。

### Task 14：结构错误定位与同次修订材料保真

**范围：** 只修 short-closure-01 的结构错误反馈及失败候选在同一 job/epoch 内的修订传递。保持终幕、NPC 知识审批、三候选预算和唯一生产链；不添加剧情提示、自动授知、跨候选静默合并或新样本。

**Files:** `src/game/application/server/ai/liveWorldEvolutionSource.ts`、`liveNarrativeBundleSource.ts` 与测试；`src/game/application/narrativeBundleSource.ts`、`generatePendingNarrativeBundle.ts` 与必要的既有修订上下文类型/投影、同目录测试；系统文档 `docs/agent/运行时AI导演与场景表演.md`。

**契约：** 未知 worldDelta 字段必须给出准确路径与错误种类（本例 `$.worldDelta.newFact2`），共享严格解析逻辑，不复制一套宽松 schema；保留现有合法值与其他错误的拒绝语义。结构失败后下一版获得上一份作者原始 draft（包括合法 existingFactIds）与结构错误依据，明确是未批准的修订材料；不把它伪装为 compiled proposal 或已授权事实。保留合法内容是修订输入的保真，不保证模型输出自动继承；任何新版本仍完整解析、审批和审阅。仅同次调用链内传递，不放入日志、存档或跨 job 缓存；失败没有原始材料时不得复用无关旧稿。

- [x] 失败回归与最小实现完成：unknown `newFact2` 精确定位；真实 generatePending/live source/client 链把首版含 existingFactIds 的原稿传入第二次请求；后续删除声明不回填，无原稿的 provider 失败清除修订材料。已保存 HTTP 9 候选仅移除未知字段即可通过原严格 parser 并完整保留声明；原审批显式/空声明知识回归通过。

```ts
expect(failure.repairDetail).toContain('$.worldDelta.newFact2');
// 用注入 source/client 检查实际第二次请求，而不是仅测字符串辅助函数。
expect(secondAuthorRequest).toContain('existingFactIds');
expect(secondAuthorRequest).toContain('newFact2');
```

- [x] 独立限定审核及复审通过；122 项定向测试、typecheck、131 boundaries、check:docs 通过，完整 npm test 为 2837 passed、1 skipped，lint 0 errors（50 项既有 warning）。原 tape/audit/数据库哈希未变，未新增 live 调用；本项不代表故事通关。

### Task 15：终局发布回合与条件后果规则依据

**目标与范围：** 仅修 short-closure-02 暴露的两项：结果场景实际发布回合错误，以及结局标签/正文越过实际 Action 补写关键行动。沿用 Task 13 两槽结果、现有 support/challenge、唯一 author/reviewer、审批和结算链。不得新增动作/实体/记忆/终幕架构，不为渡船案例追加剧情提示，不降低正文验收。

**Files:** `src/game/application/performTurn.ts` 与测试；`src/game/application/server/ai/narrativeDraftProjection.ts`、`narrativeReviewRules.ts`、`narrativeContext/narrativeBundleContext.ts` 与测试，必要时抽取同目录有界 ending resolution helper；可按真实接口修正 `generatePendingNarrativeBundle.ts` 的审阅输入。系统事实维护 `docs/agent/运行时AI导演与场景表演.md`。不修改旧 tape、数据库、验收比较器或 shared foundation。

**契约：** 预批准结果保留生成时元数据，正式 ending 消费时只将发布场景 turn 设为实际提交回合，其余已批准正文、ID 和表达保持一致，History/事件/场景回合一致。回归必须使用真实 approval 生产的结果再执行后续 Action，禁止用手填未来 turn 的 fixture 掩盖故障。

**条件结局依据：** 在既有投影中为 trust/doubt 结果和对应 choiceLabel 提供服务端生成的条件 Action/结算权限依据，作者与审阅共用。以当前真实目标 NPC、地点、已授权事实和既有规则效果为边界；NPC 自行赶来或代办关键事项也必须有既有规则依据，投影须显式保留相关 NPC 的前后地点，不能仅列玩家地点。结局概要 description 与两条结果正文使用同一边界，不得以概要补造未结算后果；worldDelta.beatSummary 属于选择前本回合摘要，必须按当前已结算 Action 依据审阅，不能把任一未来条件结果当事实；支持/质疑及 ending 事件不隐式执行移动、交付、支付、核验或尚未兑现的承诺。审阅可通过精确 endingOutcomes 路径及 ruleBasis key 将越权后果反馈给原候选修订，仍遵守既有审阅有效性校验。不要仅复制警告文字或用关键词封禁替代实际槽与规则绑定；不得将未选结果当同时发生，不得提前授知。

- [x] 先写并运行失败回归：真实审批→下一回合发布；两条件槽 action/target/location 与既有规则一致、标签和正文均可引用审阅依据；非终局不增加依据；未执行返程/核验等因果缺口有可验证结构证据和修订反馈路径。
- [x] 完成最小实现及独立 Spec/Quality 审核；34e48e92 已通过真实修订链、190 定向 tests、typecheck、131 boundaries、完整 2840 tests（1 skipped）、check:docs 和 lint（0 errors、50 既有 warning）。short-closure-03 实际回合发布及机械通关通过，但修订结局仍替未到场 NPC 完成关键对账，概要仍含未经结算的复航后果。同一 Task 的限定修复已补 NPC 前后地点、结局概要主题依据和选择前摘要边界；独立复审通过，191 定向 tests、typecheck、131 boundaries、完整 2841 tests（1 skipped）、check:docs 通过，lint 0 errors（50 既有 warning）。不以离线审核代替正文验收。
- [ ] 首轮 short-closure-03 已机械通过、正文失败；限定修复冻结 1d635bfa 后仅执行 short-closure-04：4 行动、20 HTTP 后第二幕普通 NPC 事实/听众审批失败；严格零网络 20 响应、6 状态一致，数据库正常，未到终局。保留失败，不连续重采或扩展本任务修复范围。原有 createGame→实际选择→中途关闭重载→终局协议不变；严格零网络 replay 并阅读全文。必须同时满足实际成功 ending/ready、发布回合/内容一致、中心冲突有已发生的结果且无未执行关键行动，才勾选 Task 13 普通短篇验收。失败保留且定位，不连续重采或补写正文；后续 P1 验收边界保持。
## 后续 P1 验收边界

普通生产短篇通过后执行交付/退出专项、同条件 main 共同玩法对照及实际 UI 创建→中途重载→终局；这部分仍属于 P1，未完成前不合并 main、不进入 P2。六路线保密/公开/核验综合矩阵保留为扩展验收，非首个故事前置。

## Gates

- C1：实现与独立复审通过；17 个脚本测试通过，退出任务失败事件与交付前分叉均已验证。
- C2：实现与独立复审通过；相关 87 tests、typecheck、130 项边界通过。
- C3：focused01、focused02、focused03 均未完成，退出路线均按 deliver-first 规则未执行；focused03 完成 8 个 deliver 动作、27 次 HTTP，零网络 replay 保持同一失败状态。格式契约已修复，focused03 的剩余阻断是候选内容连续触发 `ACTION_MISMATCH`、`UNSUPPORTED_FACT`、`DISCLOSURE` 等正确审阅拒绝，不放宽审阅或补写剧情。
- D1/D2：规则审阅与入口收集完成；b6cc0e5b 的真实短篇经进程中断恢复后完成 18 次行动和成功终局。恢复段 9 次响应、12 状态严格重放，原中断流无完整封存，不算全程无中断通过。
- [x] 完成一次实机 UI 创建→游玩→刷新重载→结局：`ui-live-01` 在独立 SQLite 中创建 `60d6aaf9-1d4d-4b84-a24d-c8dd32c0ebbe`，刷新后继续 8 回合，显式重试一次生成失败，最终显示“胜利 / 先信一步，渡口有望”；终态 revision 16、turn 9、`ending_dyn_0/success`、`narrative=ready`。详见验收报告；本项未做界面打磨。
- P1 总结论：仍未通过。核心交付故事与一次实机 UI 闭环已取得；focused 同初态交付/退出对照尚未取得两路成功，退出路按安全规则未执行；main 对照和六路线矩阵仍不在本次范围。

### Task 16：围绕可执行中心结果收敛三幕主线

**目标与范围：** 承接 Spec §9.1，以现有递送规则证明完整小故事可达。不继续修补渡口事故台词，不重新设计终幕，不增加 Action、Entity、记忆、reviewer、知识传播权限或通用规划器。Task 13/15 的未通过 live 验收由本项新的核心协议继续验证；旧样本保持失败，不重新执行旧普通纠纷输入。

**Files:** `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`、`openingSemanticContract.ts`、`narrativeDraftProjection.ts` 及既有相关测试；可在同目录增加一个纯函数投影及其测试，复用现有 StoryContract/StoryState，不增加持久化字段。仅在生产旅程证实交付步骤缺失时修改 `src/game/gameplay/rpg/narrativeBundle/descriptors.ts` 与相关测试。系统事实原位维护 `docs/agent/运行时AI导演与场景表演.md`；不改 shared foundation。根任务负责 Spec/Plan、独立验证 driver 和报告。

**契约：** 对已有 delivery 合同，从现有状态给作者/既有审阅提供同一中心动作、角色绑定、物品归属、完成证据及当前幕职责依据；不能只追加场景专用警告。第二幕与第三幕只需服务交付的地点、NPC 和主线，现有 nullable newItem/newEnemy 不再被提示为必填；最终幕必须保留绑定接应人的 talk 与真实 give 步骤。普通公开约定可作为 verificationFactKeys 的依据，通过现有对话使用，不要求额外身份谜题或新核验状态。需要陈述开局公开依据的后续 NPC 沿既有 existingFactIds 显式声明；不静默复制玩家知识或从台词反推授权。非递送故事保留既有能力。

**最小验证：** 先用现有正式管线测试证明跨幕前瞻、抵达与 talk 不会吞掉 give；从真实 read model 选择经 performTurn，交付前不通关，交付后唯一归属和事件一致，结束后重载一致。可用测试 provider，但不得手造绕过实际投影的 bundle，且不称为真实 AI 通过。只修复被这条流程证实的断点。

- [x] 完成上述最小生产契约与旅程回归；独立审核 Spec/Quality 通过。131 项定向测试、typecheck、131 项 boundaries、check:docs 通过，完整测试以 2 workers 运行 2842 passed、1 skipped；默认并行两轮仅文件扫描超时，保留记录。lint 0 errors、50 项既有 warning。正式 AI 核心验收已完成，见本任务后两项及验收报告。
- [x] 冻结 f95883a8 并完成 delivery-core-01 全新 production_core_story 协议：三幕公开递送短篇、S1-complete、正式 createGame、24 动作/200 HTTP/90 分钟上限；必须产生 delivery 合同和实际交付，缺失即失败。沿实际选项推进，中途重载，成功 ending/ready 后严格零网络 replay。
- [x] 根任务阅读与独立正文审计完成，规则、正文、持久化三项通过本条核心范围，证据见验收报告 Task 16。未付款、未更新双边关系，不把情感收束措辞当额外世界结算。停止本项修复和抽样；后续仅按已有专项验收，不扩展 UI、main 对照或后续 P 阶段，也不据单条核心宣布整个 P1 通过。

### Task 17：公开递送的最小主动退出对照

**目标：** 仅补当前最小 P1 缺项。以 delivery-core-01 已通过的公开递送为交付基准，在完全一致的开局与四行动前缀后改选正式 abandon_quest；证明退出有真实、不同的世界后果和完整结尾。旧保密核验样本保持失败，不重采。

**已确认断点：** 第四行动后 buildChoiceMap 已生成合法 abandon_quest，但 gameSessionView 和实机没有显示它。禁止用隐藏 token 或直接 Action 代替真实选项。

**Files / 范围：** 最小修改 `src/game/application/gameSessionView.ts`、`src/components/LocationSceneScreen.tsx` 及必要既有消费类型/对应测试，使已有合法放弃动作通过明确的安全展示语义进入场景入口；不按文案识别，不新增 Action/Entity/记忆或退出规则，不挤掉 NPC 原有两个选择。沿既有提交/禁用/错误处理链，pending、战斗、已交付、已结束时不显示不可执行入口。系统事实原位维护 `docs/agent/地图与地点冒险.md`。根任务负责 artifacts 下的恢复/退出驱动与 Spec/Plan/验收报告，生产实现交子智能体审核。

**同初态与原证据：** 使用原始 27 响应磁带，经正式 createGame/performTurn 完整零网络 replay，必须匹配全部 15 个语义状态；在 ready 的创建点和第四行动重载点备份新生成 SQLite，原库只读不变。只允许数据库备份/复制，不把 JSON 状态灌入仓储、不截掉磁带余项假称严格 replay。恢复证明包括代码版本、源文件哈希、初态/分叉点完整状态哈希、原交付完成证据。新增入口不得改变原基准的已录制请求与状态；匹配失败时停止，不放宽比较器。

**退出协议：** claimScope=fixed_opening_story，明确基准交付为已发生的 delivery-core-01，恢复与四行动前缀为旧响应重放，新增 live 仅退出分支，不计作两条新 live。备份分叉库复制到独立 live/replay 库，校验状态一致；从真实 read model 选择 abandon_quest，检查任务放弃/失败事件、仍未交付、物品真实归属、退出结局及 ready 正文。新流严格重放并重载核对。最多 24 总行动、200 新 HTTP、90 分钟；原三候选预算、失败策略不变，不自动手动 retry。

- [x] 最小入口修复与独立审核通过；真实 projector→实际按钮→opaque token 提交及状态抑制回归通过。98 项定向、typecheck、131 项 boundaries、完整 2855 passed/1 skipped、lint 0 errors/50 既有 warning、docs 检查通过。
- [ ] 冻结并严格恢复公开递送基准，校验同初态/四行动前缀与真实可见退出入口；审核新协议后只执行一条退出 live。
- [ ] 退出新流严格零网络 replay，核对两路任务、物品、事件和结局差异，阅读全文并独立审核。通过后记录最小 P1 收尾完成及 P2 准入；广泛矩阵、main 对照和 UI 打磨后移，不开展 P2 代码。

**本次退出发布断点的限定修复：** 原可见退出已结算；验证脚本误将规则 `closed` 当失败，零 HTTP 停止后从独立副本续跑原 pending job。两次真实响应生成退出 ending/ready，但退出 currentScene.turn 使用提交 revision 9，与实际 Action/History/ending 的 turn 5 不一致。仅修 `generatePendingNarrativeBundle.ts` 的退出结果发布回合及对应真实审批→提交回归，使其与同一 job 的实际回合一致，保持正文、选择 token、审批与幂等契约。不得扩展终幕架构或提示。原失败严格重放保留；修复后用同一 pending DB 和已录制的两份真实响应做明确标注的离线修复验证，不称新 live 或修改旧磁带使之通过。
