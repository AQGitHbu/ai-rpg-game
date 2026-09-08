# Agent 工作入口

## 按任务读取

先用 [文档索引](docs/Agent文档索引.md) 定位目标；只读本次任务需要的章节和系统。已读内容在任务内不重复加载，除非事实或任务边界变化。

| 任务 | 必要阅读 | 条件追加 |
|---|---|---|
| 设计玩法 | [设计原则](docs/游戏设计原则.md)、对应策划章节 | 调整现有能力时读对应系统实现 |
| 编写代码 | [开发规范](docs/游戏开发规范.md)、对应系统文档 | 只追加受影响系统；跨系统任务先读核心闭环 |
| 执行已规划阶段 | [当前阶段入口](docs/agent/当前开发阶段.md)、唯一 Plan 的全局约束和当前 Task | 按当前 Task 读取 Spec 章节与关联系统 |
| 配置、运行、排障 | 对应 operations 手册或 AI 环境文档 | 涉及实现时追加系统文档 |
| 维护文档 | 本页维护规则、目标文档及其事实来源 | 改检查脚本时读开发规范与项目脚手架 |

## 共享能力的条件入口

涉及 `@ai-game/*`、通用 UI/AI/日志/测试配置，或无 RPG 语义的基础模块时，先读 [共享流程](docs/共同规范/共享模块开发流程.md)、[模块目录](docs/共同规范/共享模块目录.json) 和 [.ai-game-foundation.json](.ai-game-foundation.json)。仅消费已有 API 时按公开契约使用；修改共同规则或公共 package 时再读对应共同设计/开发规范；需要比较产品职责时读项目族备忘。未命中触发条件不加载共享资料。

`docs/共同规范/` 是 foundation 同步副本，禁止在本仓直接修改。RPG 的 AI 剧情失败策略以本仓设计原则为准：生产失败显式重试，不以确定性剧情代替。

## 文档维护

- 当前文档原位替换失效事实，保持章节连贯；不追加日期补充、修复批次、上一阶段摘要或测试成绩。过程证据放报告，退役资料放 archive；不为无事实变化的任务制造维护记录。
- 玩家规则归策划文档；系统契约、入口与限制归对应 agent 文档；跨系统工程约束归开发规范；配置与排障归 operations。同一事实只有一个详细维护位置，其他文档用短摘要和链接引用。
- 索引只在新增、迁移、删除文档或职责/阅读依赖变化时修改，不记录实现进度。新系统按 [模板](docs/agent/template.md) 编写并登记入口。
- 阶段状态只维护 `docs/agent/current-phase.json`；阶段 Markdown 负责导航，Plan 记录待执行任务与验收证据。计划不代表已实现。
- 文档链接使用相对 Markdown 链接；源码入口可用仓库根相对路径。提交前运行 `npm run check:docs`；修改检查器还需 `npm run test:docs`。人工复核事实归属、失效说明清除和跨文档冲突，不能把机械检查当事实认证。

## 操作硬约束

- 分支 worktree 放 `.worktrees/`，不用 `git checkout`。从本仓 main 使用 `npm run branch:merge -- <branch>` 合并并安全收尾；已合入分支使用 `npm run branch:finish -- <branch>`。
- `../ai-game-foundation` 是受保护 sibling 仓库，`.foundation` 是其链接；禁止删除、移动、重建二者，尤其禁止递归删除 junction。异常时停止，按共享流程恢复链接。
- Windows worktree 内存在 `.foundation` junction 时，禁止直接 `git worktree remove`。必须从本仓 main 运行 `node ../ai-game-foundation/scripts/cleanupConsumerWorktree.mjs --repository . --worktree-name <name>`；工具失败时保留残留并报告。完整操作见 [项目脚手架](docs/agent/项目脚手架.md)。
