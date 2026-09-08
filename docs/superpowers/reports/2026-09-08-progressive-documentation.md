# 文档整理验收记录

日期：2026-09-08。基线：`cee878a`。任务：渐进阅读、当前事实单点维护与文档门禁。

## 变更范围

- 重写根入口、索引、开发规范、当前阶段入口与系统模板，系统文档按职责分组。
- 退役评测、量表、闲聊旧协议、小镇 Demo 和旧生图制作草案归档；相关历史文件只更新迁移路径。
- 入口初始读取资料从 14 项收敛为 5 项；当前 Task 按 Plan 追加系统与 Spec 章节。Plan 5 状态仍为 planned/not_started。
- 文档检查与回归测试接入 test:fast，文档检查同时接入两个 handoff 命令；accept 通过 test:fast 执行门禁。
- 未修改游戏源码、公共 package、共同规范副本或存档。

## 事实复核

- `performTurn.ts`、`consumeNarrativeBundle.ts`：生产线性动作必须消费匹配步骤；无图直接拾取属于 offline fixture。
- `actionConverter.ts`：自由输入映射为中性 talk/ask，不产生独立 intent 调用。
- `npcSpeechAuthority.ts`、`narrative.ts`：对白使用 usedEventIds，引用真实 Event，不能恢复 actionId 证据协议。
- `deriveEvolutionNeed.ts`：stable 状态也可派生节奏需求；生产 world delta 使用同一 decision context。
- `generatePendingNarrativeBundle.ts`：逻辑 pending 生成最多四次完整尝试；内部 transport 次数独立。
- `sqliteGameRepository.ts`：旧版本、未知版本、不可解析和当前结构损坏分别分类；不静默清档。
- `newGame.ts`、`storyBudget.ts`、表单和战斗规则：保留当前输入/预算，删除交易、经验经济和图片服务等未实现承诺。
- 普通日志与专用 AI 审计分开；当前输入可参与回应，历史 memory card 不携带玩家原文。

## 验证

- `npm run check:docs`：33 份当前文档，0 错误、0 提醒。
- `npm run test:docs`：13 项通过，覆盖中文/编码/括号路径、标题锚点、引用链接、坏入口、退役入口、未登记系统、阶段副本、失效 npm 命令及 CLI 退出码。
- `npm run handoff:check:docs`：通过；未运行要求 Plan 5 分支的严格交接，不更改该阶段配置以迎合本任务分支。
- `npm run test:fast`：通过，包含类型检查与 123 项依赖边界测试；后续 CLI 补充用例由 test:docs 验证通过。
- 新检查器及其测试 ESLint 通过，`git diff --check` 通过。
- 未运行真实 AI、生产构建或游戏完整旅程；本任务不改变游戏行为。

## 体量与限制

按同一组当前入口、规则、系统、策划与运维文件统计，整理前正文 254945 字符（包含移出的四份退役文档），整理后 55700 字符，减少约 78%。历史资料保留，不计入默认阅读量。

门禁检查当前 Markdown 和命令引用，不执行网络链接检查，不证明语义正确。篇幅、历史标题和重复长段落只提醒；本次由主代理核对关键代码事实并修正子代理遗漏。脚本由 npm 入口执行，不安装 Git hook 或远端 CI。
