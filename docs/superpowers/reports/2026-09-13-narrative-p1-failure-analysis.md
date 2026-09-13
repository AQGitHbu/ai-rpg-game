# P1 真实验收失败根因与修复验证

## 诊断范围

基于 `d0e2c4b1` 的代码、[原验收记录](2026-09-12-narrative-p1-acceptance.md)、`artifacts/narrative-p1/p1-07/` 和 `p1-08/` 的本地原始审计。本次由主智能体定位并审核，子智能体分别修复生成契约、验收 runner、请求等待边界。历史失败样本保留，不覆盖或重新计为成功。

## 根因

### 作者与审阅器使用不同的事实契约

`p1-07/audit/S2-public/events.jsonl` 的审阅响应把 `opening.world.publicFacts[5]` 与 `opening.npc.privateFactKeys` 的交集判为泄密，并称玩家会直接读到该目录。实际上开局 parser/compiler 要求 privateFactKeys 引用该历史命名的事实目录；是否公开由知识/披露投影决定。作者被要求删除一个结构上必须存在的引用源，下一稿又因字段错误被拒。

原 opening reviewer 只拿玩家 setup 和候选，没有作者的完整输出契约与 local key→正式 fact ID 映射。它还把允许在开局建立的核验证据判为“玩家输入中没有”，或要求首屏两个选项同时覆盖完整故事的全部路线。这些审阅条件不等于真实泄密或事实矛盾，不能靠反复重采解决。

### 修订只有拒绝原因，没有上一稿

自动内容修复仅传递上一轮错误信息，未把同 job 的上一完整候选和累计已指出缺陷带回作者。模型重新生成目录、人物与说法，旧问题可能复发，局部语义修正又引入新的 schema 错误。应保持候选版本身份并提供实际待修订内容；已提交玩家行动与世界事实仍不可改写。

### P1 能力没有完整接到真实作者

代码已存在 interaction proposal parser、规则与离线旅程，但 live prompt 仍有“顶层只能四个旧字段”等约束，也没有完整说明新互动 schema 与 candidate 身份。`createLiveNpcDeliberation`、`projectNpcDeliberation` 和向外披露授权函数仅见定义与测试，没有生产调用。

`p1-08/audit/S1-verify_first/events.jsonl` 中多轮审阅通过的文本持续承诺“核验/递送办法”，实际候选仍是无 interactionId 的 support/challenge，currentScene 后没有 continuation；这说明文案通过不代表玩家获得可执行的新策略。离线 fixture 能提交结构化方案，并不证明真实作者知道如何提交。

### 实验矩阵与选路实现偏离协议

旧 runner 为六条路线分别调用 createGame，并非 S1/S2 两次获批开局各分出三条路线。同一 scenario 标签下的世界并不相同，无法用于比较策略后果。选路使用 label 关键词并默认第一项，自由核验输入在首次可输入时发送，而非交付机会；还把累计 HTTP 数写成各路线 HTTP。

因此旧批次的“0/6”仍是六次路线尝试均未完成的事实，但不能解释为符合预登记的同开局三策略矩阵。需要先纠正实验实现，再新建批次；不能改写旧样本为新协议结果。

### 超时仅发取消信号，不能保证等待结束

共享 transport 的非流式 timer 并非收到 headers 就清除；实际问题是它依赖 fetch/response body 遵守 AbortSignal。RPG client 直接等待 transport Promise，若 body、适配器或排队过程不结束，传入 timeout 并不能保证调用者在期限内返回。

这一缺口可用 headers 已返回而 body 不结束的测试复现。它解释了为什么需要独立的 RPG 等待截止与迟到结果隔离，但现存审计只记录已完成请求，不能据此断言 `p1-08` 中断时具体卡在网络、body 还是队列。真实 provider 延迟仍是外部因素，不应一概归因于本地 bug。

## 修复与审核

- 开局作者与 reviewer 共用语义契约和实际编译后的事实映射，保留真实秘密及其引用，不屏蔽审阅结果。用 `p1-07/S2-public` 的原始 provider 候选走 live parser → opening compiler → review 输入回归，证明修复的是契约解释而非删除秘密绕过检查。
- 同一生成 epoch 的下一版携带上一完整已解析候选、hash 与累计修订意见，仍以已提交世界为权威。解析失败时不能提供该次未解析正文；跨进程恢复尚不保存候选全文与累计意见，仅恢复持久化原因。
- 正式生成接入受权限约束的 NPC 判断；只有获准 outward 进入作者、reviewer 和 hash。作者选用的互动在完整 worldDelta 预览后绑定真实 Action；新增第三项核验可进入两项候选，不改变实体存储顺序、不按文案替换动作。
- runner 改为两次获批初始化、关闭并 checkpoint 后各复制三份 SQLite；按已批准操作和真实结算事件推进，核验自由输入绑定实际交付机会和接应 NPC。HTTP 使用差分统计，预算/中断写出部分 summary。旧 replay 仅相信摘要的实现被删除，现明确拒绝；正式响应 replay 现已实现并通过新 SQLite 生产装配集成测试；原始真实批次重放仍须执行。
- RPG 请求使用独立等待截止，覆盖 transport 排队与 body 等待；取消不依赖 provider 响应，迟到结果不能提交。生成器取消路径停止心跳、失败写回并释放 lease。取消不意味着 provider 停止计费。
- 主审核追加修正了保密承诺人和候选槽问题：承诺由玩家作出，保密操作不虚报事实揭露；成功消费过的互动不再占槽。相关测试同时验证事件与正式候选构建。

## 尚未关闭的验收缺口

P1-A 的保密—真实引荐缺口已通过具体条款、独立引荐动作、真实送达/违约/归还及 SQLite 重载旅程关闭，见 [P1-A 验收报告](2026-09-13-narrative-architecture-p1-a.md)。独立审核额外发现并修正了把送达接应人当作归还、以及弃约遗漏新承诺的问题。响应 replay 已具备严格原始响应与存档对照能力；新 live 样本、实际重放和矩阵仍须执行。

本次没有调用真实 API，没有覆盖历史失败样本，没有得到新的完整故事或人工质量分。P1-C 仍未通过；新的固定完整矩阵和人工评分不能由 mock 审阅或历史候选回放代替。

## 验证结果

- 主智能体执行 `npm run accept`：通过。lint 为 0 errors / 50 处既有 warnings；212 个测试文件通过、1 个跳过，2717 个测试通过、1 个跳过；typecheck、fast gates（含文档检查与 128 项依赖边界）、生产 build 全部通过。输出保存在本地 `artifacts/p1-repair-accept.log`。
- 独立 `npm run test:narrative-p1-script`：11 项通过；变更文档相对路径人工辅助检查及 `git diff --check` 通过。
- 全仓检查发现并修正了新增 `prefer-const` 错误，以及旧 scene source 测试未预期新增 AbortSignal 参数的问题；保留超时参数断言并新增 signal 类型断言后，重跑完整门禁通过。
- `phase:status` 仍显示原阶段指针，本次未修改它；它不代表 P1 验收成绩。
