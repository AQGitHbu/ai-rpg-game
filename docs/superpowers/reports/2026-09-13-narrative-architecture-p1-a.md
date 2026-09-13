# Narrative Architecture P1-A 验收报告

## 范围

本报告记录 P1-A Task 3/4“破庙来信”离线 production journey 的规则证据。旅程每次在临时 SQLite 中创建独立存档，经 createGame、performTurn、generatePendingNarrativeBundle、正式读模型与 choice map 推进；测试没有在回合间注入状态。剧情候选由 fixture 提供，因此不证明真实模型叙事质量。

## 验收结果

- private：先选 promise_confidentiality，建立保护事实、允许听众与 story_delivery 履约条件，再选引用真实 open promise 的 request_introduction。交付前承诺保持 open，真实送达后 fulfilled；通用 kept_promise 不提前关闭保密条款。
- public：玩家通过 share_known_fact 向实际同场听众披露自己已知事实，留下事件和知识变化。不能向远程听众传播，未选提案不产生披露。
- verify_first：自由输入后仍持有信筒；选择真实 request_verification 后仍须显式 give_item，核验本身不算送达。
- exit_return：在开局委托人同场时使用获批 give_item 续接，实际归还给 npc_0，再选择 abandon_quest；物品归委托人、承诺 released。无 prepared give 与旧 token 均被拒绝，SQLite 记录不变。
- exit_keep：先建立同样的保密承诺，再持有信筒放弃；物品仍归玩家、承诺 broken。
- 泄密分支：真实承诺后向不被允许的同场接应人披露，reload 后再交付和选择 support，承诺仍 broken、结局维持违约后果。
- 中途关闭并重新打开 SQLite 后仍可完成最终幕，物品 owner、承诺状态和结局不丢失。
- 普通离场与自由输入“我走了”均不等于放弃；真实送达后 UI choice map 不再提供弃约，规则边界也拒绝直接弃约。

交付由 StoryState.delivery 的唯一物品、开局委托人与后续实际具象化接应人引用，加物品当前 owner 和成功 item_given 事件共同判定。核验、对白和通用任务信号均不能代替物品转移。NPC 私密判断能看到自己的已解决承诺及条款，不能读到其他 NPC 的私人关系。

## 审核与命令

独立审核发现并修正了“交给接应人后伪称归还”及“新承诺未进入弃约结算”两个问题，复审 Spec/Quality 均通过。

- npx vitest run src/game/application/testing/templeLetterJourney.test.ts：8 项通过。
- npx vitest run src/game/application/approveNarrativeBundle.test.ts：33 项通过。
- npx vitest run src/game/application/testing/deliveryExitContract.test.ts：2 项通过，覆盖可选归还 prompt 投影和送达后禁弃约。
- npm run typecheck、npm run check:docs：通过；完整工程门禁与 live 状态以[总验收报告](2026-09-12-narrative-p1-acceptance.md)为准。

P1-A 此次保密—引荐—交付/违约/归还的规则缺口已关闭；真实响应重放、完整 live 矩阵与人工剧情质量评估仍属于后续验收，不能由上述离线结果替代。