# AI RPG Game

AI 驱动的单人叙事 RPG。当前已具备完整可玩闭环：创建一局世界（可选真实 AI 动态开局）、地图 → 小镇 → 场景三层导航、探索/对话/调查/拾取/移动、运行时 AI 导演的剧情场景（director / writer / NPC 三请求最小权限链路）、剧情连续性结构化记忆、确定性 boss 战与成功/失败双结局。

数值、战斗、任务与存档始终由程序规则裁决；AI 只负责叙事表达，任何 AI 失败都有确定性 fallback。日常测试与验收全部使用离线 fixture 回放，零网络调用。

## 技术基线

- Next.js App Router + React
- TypeScript strict
- Zustand
- Vitest + Testing Library
- SQLite / libSQL（单槽本地存档，事件账本 + CAS 写入）
- `@ai-game/ui`、`@ai-game/ai-transport`（通过 `.foundation` junction 消费本地 foundation 仓库）

## 开始开发

```powershell
npm run setup
npm run phase:status
npm run dev
```

执行当前 MVP 阶段前，在干净的 RPG `main` 运行 `npm run phase:start`。它会按 `docs/agent/current-phase.json` 创建目标 worktree/分支、执行 setup 和严格交接检查；通过后 Plan 才可交给新 Agent 编码。

`setup` 会尝试初始化 RPG 自己的 `.env.local`。它可以从本机 RPG 主工作区或 sibling SLG 复制三个 AI 键的初始值，但应用运行时永远不读取 SLG 文件；真实 AI 接入前用 `npm run env:check` 严格验收。

## 试玩

运行 `npm run dev` 后填写开局资料即可试玩，互动只调用本地 `/api/game/*`。

- **未配置 AI**：使用确定性 fallback 开局与模板叙事，完整闭环照常可玩。
- **配置了 AI**（`.env.local` 中 `AI_API_BASE_URL` / `AI_MODEL` / `AI_API_KEY`）：开局与进入地点后的剧情场景由真实 AI 生成；剧情选项由服务端批准，AI 不能改写数值或规则。
- 开发环境还可用 Phase 10 固定离线旅程基线开局（offline 模式，零 AI 调用）。

开发模式会显示“清除本地试玩存档”：确认后仅删除当前 RPG SQLite 槽位，回到新开局表单；不会删除数据库文件、schema 或其它项目的数据。生产构建不显示该按钮，直接请求其接口也会被拒绝。

## 双模式 AI 旅程

完整旅程测试固定为离线 replay；真实 AI 认证需在 shell 中显式 opt-in（会产生计费调用）：

```text
npm run journey:phase10          # 零网络回放
npm run journey:phase11          # 零网络回放（剧情连续性）
npm run journey:town             # 零网络回放（小镇层）
$env:RUN_REAL_AI_JOURNEY='1'; npm run smoke:ai:phase11-journey   # 真实录制
```

## 常用命令

```text
npm run lint
npm run typecheck
npm test
npm run test:boundaries
npm run test:fast
npm run build
npm run accept
npm run phase:status
npm run phase:start -- --dry-run
npm run branch:finish -- codex/<worktree-name>
npm run handoff:check
npm run env:check
```

`npm run accept` 是统一验收入口（lint + typecheck + test + test:fast + build + phase:status）。

功能分支合入 `main` 后，从主工作区运行 `npm run branch:finish -- <branch>` 完成合并确认、worktree 安全清理和分支删除。脚本要求 `main` 干净且目标分支已合入；Windows 上运行前先退出该 worktree 的开发服务器和测试 watcher。

## 文档入口

- [AI 生成 RPG MVP 玩家规则](docs/策划文档/AI生成RPG_MVP.md)
- [MVP 开发 Spec](docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md)
- [当前开发阶段](docs/agent/当前开发阶段.md)（Phase 11 已实现：剧情连续性与结构化记忆）
- [Agent 文档索引](docs/Agent文档索引.md)（各系统实现现状的入口）
- [游戏设计原则](docs/游戏设计原则.md)
- [游戏开发规范](docs/游戏开发规范.md)

`docs/策划文档/AI生成RPG_MVP.md` 和对应开发 Spec 是当前基线；`docs/agent/` 记录实现事实；`docs/设想/` 保留原始思路与启动过程，仅用于追溯。
