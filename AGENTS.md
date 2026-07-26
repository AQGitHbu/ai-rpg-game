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
