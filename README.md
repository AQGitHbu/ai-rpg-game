# AI RPG Game

AI 驱动的单人叙事 RPG。当前仓库处于脚手架阶段：工程边界、文档、测试与共享规范已建立，尚未实现 RPG 玩法。

## 技术基线

- Next.js App Router + React
- TypeScript strict
- Zustand
- Vitest + Testing Library
- SQLite / libSQL（在真实存档需求出现时接入）

## 开始开发

```powershell
npm install
npm run sync:standards
npm run doctor
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

- [项目准备方案](docs/设想/AI_RPG新项目启动准备方案.md)
- [游戏设计原则](docs/游戏设计原则.md)
- [游戏开发规范](docs/游戏开发规范.md)
- [Agent 文档索引](docs/Agent文档索引.md)

现有 `docs/设想/` 材料用于收敛正式 MVP Scope，不是直接实现基线。
