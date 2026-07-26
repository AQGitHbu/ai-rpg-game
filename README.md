# AI RPG Game

AI 驱动的单人叙事 RPG。工程边界、共享规范和正式 MVP 开发基线已建立，尚未实现 RPG 玩法。

## 技术基线

- Next.js App Router + React
- TypeScript strict
- Zustand
- Vitest + Testing Library
- SQLite / libSQL（在真实存档需求出现时接入）
- `@ai-game/ui`（本地 Phase 0 通过 `.foundation` 消费）

## 开始开发

```powershell
npm run setup
npm run dev
```

## 常用命令

```text
npm run lint
npm run typecheck
npm test
npm run test:boundaries
npm run test:fast
npm run build
```

## 文档入口

- [AI 生成 RPG MVP 玩家规则](docs/策划文档/AI生成RPG_MVP.md)
- [MVP 开发 Spec](docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md)
- [Shared UI Phase 0 Plan](docs/superpowers/plans/2026-07-26-shared-ui-phase-0.md)
- [项目准备方案](docs/设想/AI_RPG新项目启动准备方案.md)
- [游戏设计原则](docs/游戏设计原则.md)
- [游戏开发规范](docs/游戏开发规范.md)
- [Agent 文档索引](docs/Agent文档索引.md)

`docs/策划文档/AI生成RPG_MVP.md` 和对应开发 Spec 是当前基线；`docs/设想/` 保留原始思路与启动过程，仅用于追溯。
