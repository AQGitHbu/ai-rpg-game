# AI RPG Game

AI 驱动的单人叙事 RPG，支持短篇与中篇。玩家通过地图、小镇、场景、NPC 对话与规则战斗推进任务和结局。规则决定状态变化，AI 生成经过审批的世界与剧情内容。

生产游戏需要配置 AI；生成失败显示失败状态并允许重试。离线 fixture 用于独立的规则与旅程验收，不作为生产 AI 的替代内容。

## 开始开发

需要 Node.js ≥20.9、npm ≥10，以及同级 `ai-game-foundation` 仓库提供的本地公共依赖。

```sh
npm run setup
npm run env:check
npm run dev
```

AI 配置、独立存档与真实调用检查见 [AI 环境](docs/agent/AI环境.md)。技术栈为 Next.js、React、TypeScript、Zustand、Vitest 与 SQLite/libSQL，实际版本见 [package.json](package.json)。

## 验证与协作

- `npm run check:docs`：检查当前文档导航与引用。
- `npm run test:fast`：公共规范、脚本、类型与边界快速门禁。
- `npm run accept`：lint、类型、完整测试、快速门禁、构建和阶段状态展示。
- `npm run phase:status`：查看当前阶段；阶段执行要求见 [当前阶段入口](docs/agent/当前开发阶段.md)。

按改动选择测试、合并和 worktree 收尾方式见 [开发规范](docs/游戏开发规范.md) 与 [项目脚手架](docs/agent/项目脚手架.md)。

## 文档入口

- Agent 从 [AGENTS.md](AGENTS.md) 按任务读取。
- 玩家规则从 [策划目录](docs/策划文档/README.md) 读取。
- 实现事实从 [系统索引](docs/Agent文档索引.md) 定位。
- 配置与排障从 [运维入口](docs/operations/README.md) 定位。
- [过程资料](docs/superpowers/README.md)、[归档](docs/archive/README.md) 与 [原始设想](docs/设想/README.md) 用于规划或追溯，不定义生产能力。
