## 文档路由

- 设计玩法/系统：先读 `docs/游戏设计原则.md`、`docs/Agent文档索引.md` 和对应 `docs/agent/<系统>.md`
- 编写/修改代码：先读 `docs/游戏开发规范.md`、`docs/Agent文档索引.md` 和对应 `docs/agent/<系统>.md`
- 执行已规划 MVP 阶段：再读 `docs/agent/当前开发阶段.md` 及其指向的唯一 Plan
- 同一任务内已读文档不重复读，除非任务边界或实现事实变化

## 共享基础设施触发

只有任务涉及现有 `@ai-game/*` package、通用 UI/AI/日志/测试配置，或准备创建无 RPG 业务语义的底层模块时，才读取：

- `.ai-game-foundation.json`
- `docs/共同规范/共同游戏设计原则.md`
- `docs/共同规范/共同游戏开发规范.md`
- `docs/共同规范/共享模块开发流程.md`
- `docs/共同规范/共享模块目录.json`
- `docs/共同规范/项目族定位与共享实践备忘.md`

未命中以上条件时，不加载共享模块流程。

## 文档维护

- 玩法事实变化：更新 `docs/策划文档/`
- 实现事实变化：更新 `docs/agent/` 和索引
- 共同规则或公共 package 变化：按共享模块流程处理

## 核心约束

- 分支放 `.worktrees/`，不用 `git checkout`
- 已合入主线的功能分支统一从本仓 `main` 执行 `npm run branch:finish -- <branch>` 收尾；该命令会先确认主工作区干净、分支已合入 `main`，再按 worktree 安全流程清理并执行安全分支删除。
- `../ai-game-foundation` 是受保护的 sibling Git 仓库，`.foundation` 是其 junction：禁止删除、移动、重建二者，尤其禁止递归删除 junction；异常时停止并按共享流程恢复/链接。
- **Windows worktree 清理**：只要 phase worktree 内存在 `.foundation` junction，禁止直接执行 `git worktree remove`（它可能沿 junction 递归到 `../ai-game-foundation`）。必须从本仓 main 运行 `node ../ai-game-foundation/scripts/cleanupConsumerWorktree.mjs --repository . --worktree-name <name>`；该工具会无递归解绑 junction、复核 foundation 完整，再调用 Git。工具报错时保留残留 worktree 并报告。
