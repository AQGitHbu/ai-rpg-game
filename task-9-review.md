# Task 9 review

结论：NEEDS_FIXES

## Important

1. **知识 audience 的长旅程证明不成立** — `src/game/application/testing/npcContinuityJourney.test.ts:500-567`

   测试把 private fact 和 public fact 直接写入 `record_npc_knowledge` mutation，没有经过 `FactChange.audience`、`propagateKnownFacts` 或 `knowledgeWritesFromFactChange`。因此它验证了 authority/prompt 隐私和同一 mutation 的 knowledge 去重，但没有验证“事实只进入显式 audience”；即使传播层忽略 audience 或错误广播，当前测试也可能通过。重复传播断言同样只是重复直接 mutation，不是重复 propagation。应改为走真实调查/传播路径，传入包含单一目标的 audience，再断言非 audience NPC 不变，并重复同一传播调用验证 entry 不增加。

2. **既有 grounding journey 允许整段物品/战斗覆盖早退** — `src/game/application/testing/narrativeGroundingJourney.test.ts:213-216`

   `view.obtainableItems.length === 0` 时直接 `return`，所以物品拾取、其后的强制节拍/objectiveLink、战斗开始和战斗胜利断言都可被跳过而测试仍然通过。这与本次要求不得因 journey 断言宽松而漏掉既有 `mediumAct`/grounding 保证冲突。该早退在 `65e4e0f` 基线中已经存在，**不是 `a28e29c` 新引入的回归**，但在本次 Task 9 复审门槛下仍应移除或改为失败断言，否则不能把该 journey 当作完整覆盖证明。

## Critical / Minor

- Critical：无。
- Minor：无。

## 已独立验证的通过项

- 复审范围 `65e4e0f..a28e29c` 只有 `a28e29c` 一个提交；生产修改仅 `src/game/application/performTurn.ts`，未修改 `deterministicSceneSource.ts` 或 `approveAndWriteScene.ts`。生产 diff 为 15 additions / 5 deletions，且长旅程确实覆盖了新增的未注册 `talk/ask` 路由。
- 六文件 focused journey：6 files / 10 tests passed。
- `npcContinuityJourney` 实际使用临时 SQLite，重开同一数据库至少 3 次，成功回合计数至少 18，执行五幕并得到 ending；opening anchors、goals、knowledge source 和兼容 affinity 断言均存在。支持/威胁限速、关系证据/来源、重复 signal/history/commitment、A→B 方向、赠物语义、撤退恢复完整 NPC components、重赛胜利与 prepared continuation consumption 均有执行路径。
- 现有 battle 单测进一步覆盖参战/未参战 companion、alive/downed companion、非终结回合不写 `fought_together` 及重复幂等；本提交没有削弱这些测试。
- `providerTriggerMatrix.test.ts` 在范围内未变化；已有 CAS/revision 测试仍通过。
- `npm test`：172 test files / 2303 tests passed。
- `npm run typecheck`、`npm run lint`、`npm run test:boundaries`（105 tests）、`npm run check:standards`、`npm run build`、`git diff --check`：全部通过。
