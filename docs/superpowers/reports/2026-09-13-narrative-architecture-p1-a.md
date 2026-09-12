# Narrative Architecture P1-A 验收报告

## 范围

本报告记录 P1-A Task 4 “破庙来信”离线 production journey 的验收证据。旅程每次在临时 SQLite 中创建独立存档，经 `createGame`、`performTurn`、`generatePendingNarrativeBundle`、正式读模型与 choice map 推进；测试没有在回合间注入状态，也没有使用 legacy scene fixture。

## TDD 证据

- RED：初始五路线测试无法解析缺失的 `templeLetterJourney.testutil`；补齐测试工具后，真实交付动作返回 `NARRATIVE_CONTINUATION_MISSING`。
- GREEN：增加最终幕交付 continuation、交付动作释放校验、story-exit 路由及结局对已存在时的幂等处理后，五条路线与负向探针全部通过。

## 验收结果

- `private`、`public`、`verify_first`：各完成正式交付；三种互动分别留下保密、公开披露、核验事件。
- `exit_return`：先经 `give_item` 再 `abandon_quest`，物品 owner 为接应人。
- `exit_keep`：不发生 `give_item`，保留玩家 owner 后经 `abandon_quest` 进入失败结局。
- 普通返回移动被 bundle 消费边界拒绝但不结束游戏；自由输入“我走了”按中性 `talk/ask` 记录，不猜测为放弃或交付。
- 中途关闭并重新打开 SQLite 后仍可完成最终幕，物品 owner、承诺状态和结局不丢失。

## 执行命令

- `npx vitest run src/game/application/testing/templeLetterJourney.test.ts`
- `npx vitest run src/game/application/performTurn.test.ts src/game/application/consumeNarrativeBundle.test.ts src/game/application/generatePendingNarrativeBundle.test.ts src/game/gameplay/rpg/narrativeBundle/descriptors.test.ts src/game/gameplay/rpg/worldEvolution/storyReveal.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- `npm run typecheck`
- `npm run lint`（0 errors；仓库既有 warnings）
- `git diff --check`

提交前全量 `npm test`：201 个测试文件通过、1 个跳过；2653 个测试通过、1 个跳过。
