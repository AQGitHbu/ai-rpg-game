# AI RPG Game

AI 驱动的单人叙事 RPG。当前已具备无需 AI 的确定性试玩版本：创建一局世界、探索/对话/调查/拾取/移动、推进任务、完成 boss 战并抵达成功或失败结局。

## 技术基线

- Next.js App Router + React
- TypeScript strict
- Zustand
- Vitest + Testing Library
- SQLite / libSQL（当前已用于单槽本地存档）
- `@ai-game/ui`（本地 Phase 0 通过 `.foundation` 消费）

## 开始开发

```powershell
npm run setup
npm run phase:status
npm run dev
```

执行当前 MVP 阶段前，在干净的 RPG `main` 运行 `npm run phase:start`。它会按 `docs/agent/current-phase.json` 创建目标 worktree/分支、执行 setup 和严格交接检查；通过后 Plan 才可交给新 Agent 编码。

`setup` 会尝试初始化 RPG 自己的 `.env.local`。它可以从本机 RPG 主工作区或 sibling SLG 复制三个 AI 键的初始值，但应用运行时永远不读取 SLG 文件；真实 AI 接入前用 `npm run env:check` 严格验收。

## 无 AI 试玩

运行 `npm run dev` 后填写开局资料即可试玩。所有当前互动只调用本地 `/api/game/*`，不调用 AI 或外部网络。

开发模式会显示“清除本地试玩存档”：确认后仅删除当前 RPG SQLite 槽位，回到新开局表单；不会删除数据库文件、schema 或其它项目的数据。生产构建不显示该按钮，直接请求其接口也会被拒绝。

## 常用命令

```text
npm run lint
npm run typecheck
npm test
npm run test:boundaries
npm run test:fast
npm run build
npm run phase:status
npm run phase:start -- --dry-run
npm run handoff:check
npm run env:check
```

## 文档入口

- [AI 生成 RPG MVP 玩家规则](docs/策划文档/AI生成RPG_MVP.md)
- [MVP 开发 Spec](docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md)
- [无 AI MVP 试玩验收 Plan](docs/superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md)
- [Shared UI Phase 0 Plan](docs/superpowers/plans/2026-07-26-shared-ui-phase-0.md)
- [项目准备方案](docs/设想/AI_RPG新项目启动准备方案.md)
- [游戏设计原则](docs/游戏设计原则.md)
- [游戏开发规范](docs/游戏开发规范.md)
- [Agent 文档索引](docs/Agent文档索引.md)

`docs/策划文档/AI生成RPG_MVP.md` 和对应开发 Spec 是当前基线；`docs/设想/` 保留原始思路与启动过程，仅用于追溯。
