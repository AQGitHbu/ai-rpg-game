# 无 AI 试玩验收

## 职责

本流程验证由测试注入的 offline fixture source 驱动的规则闭环，供自动回归使用。当前正式 UI 没有 fixture 选择入口；它证明规则、read model、SQLite CAS、地图/城镇/场景、战斗和结局能够连续运行，不代表生产 AI 失败时会自动切换为 fixture。

## 当前契约

- 测试 fixture 可创建确定性开局，覆盖观察、交谈、事实推进、移动、拾取、任务、战斗以及战斗失败恢复和成功结局；这些能力通过注入 source 与 repository 测试驱动，不是正式 UI 菜单。
- fixture 仍经 application facade、gameplay ruleEngine、GameSessionView 和 SQLite repository；UI 不读取 domain state、seed 或持久化层。
- 生产 narrative source 与 offline fixture source 是两条显式配置路径。生产 provider 失败会保留 `provider_failed` 和同一 job，不能用 deterministic 文案伪装成功。
- 试玩不要求清理用户存档；测试使用独立 fixture 与临时 SQLite repository，避免触碰正式开发存档。

## 必要流程

```text
测试注入 fixture source / SQLite repository
  → 创建确定性 GameState
  → GameSessionView
  → 交谈 / 探索 / 移动 / 拾取
  → 规则战斗与失败恢复
  → victory
  → reload 验证状态仍可恢复
```

## 主要源码和验证

- `src/game/application/createGame.ts` 中的 offline 创建分支
- `src/game/application/deterministicSceneSource.ts`、`src/game/application/deterministicEvolutionSource.ts`
- `src/game/application/testing/foundationJourney.test.ts`、`src/game/application/testing/foundationJourney.testutil.ts`
- `scripts/foundationJourney.mjs`

可执行的 offline 回归命令是 `npm run test:foundation-journey` 和 `npm run journey:foundation`；完整门禁可运行 `npm test`、`npm run lint`、`npm run typecheck`、`npm run test:fast`、`npm run build`。真实 AI 验收不属于本文件的 offline 证明。

## 按条件关联文档

- 整体生产/离线边界见 [MVP 核心闭环](./MVP核心闭环.md)。
- 地图、战斗和物品的规则范围见 [地图与地点冒险](./地图与地点冒险.md)、[战斗与结局](./战斗与结局.md)、[物品与任务奖励](./物品与任务奖励.md)。
