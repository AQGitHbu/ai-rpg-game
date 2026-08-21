# 无 AI 试玩验收

## 范围

本工作包只为已经完成的确定性规则闭环补齐试玩表达与开发环境重开局能力。它不是原始 MVP Spec 的新增 Phase，也不接入 AI、自由输入或共享 package。

## 已有闭环

当前显式 offline fixture 已支持：创建确定性 fixture 世界、观察/交谈/调查、地点移动、物品取得、任务解锁、确定性 boss 战，以及成功/失败两个可恢复结局。所有状态仍由 application facade → gameplay 规则 → SQLite CAS 保存。本文件不描述生产 AI 不可用时的用户体验；生产链会显示稳定 AI 失败并等待手动重试。

## 本次实现约束

- 玩家可见属性、冒险记录和行动反馈只能来自 `GameSessionView` 的安全投影；组件不能读取 domain state、blueprint、seed 或持久化层。
- 冒险文本是对已有 event ledger 的确定性模板化表达，不增加 AI 生成或改变规则裁决。
- 开发环境清档只处理当前 RPG 槽位。客户端只在开发构建显示；服务端必须再次检查 `NODE_ENV === "development"`。不删除 DB 文件、schema、其它表、worktree、`.foundation` 或 sibling 仓库。
- UI/API 仍只能从 `@/game/application` 导入游戏业务；SQLite 只留在 `application/server/persistence`。

## 手工试玩路线

1. 在 RPG 主工作区运行 `npm run dev`，浏览器打开本地地址；若已有旧局，在开发工具中确认“清除本地试玩存档”。
2. 填写角色名字、身份、世界观背景、故事开端，任选预设类型与叙事风格，确认开局。
3. 确认开场可见：世界与地点、基础 HP/攻击/防御、在场 NPC、初始物品、任务和开场叙事。
4. 依次按行动/任务面板完成交谈、调查、移动、拾取与后续移动；每一步确认冒险记录增加模板叙事，刷新页面后地点、物品、任务与记录仍在。
5. 到 boss 地点开始战斗，持续攻击到成功结局；刷新后结局仍在，且普通行动按钮不再出现。
6. 清档后重新开局，按同一路线在 boss 战选择撤退，确认失败结局和刷新恢复。

## 自动验收

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
```

完整 UI 测试需要 foundation 本地依赖可用：在 `../ai-game-foundation` 运行一次 `npm ci`（只安装其 lockfile 锁定的忽略依赖，不修改 package/source）。这是 `file:` 本地包在 Vitest 真实路径解析 React peer dependency 的运行时前置条件。

## 最近维护

- 2026-08-04：开发环境「使用已有数据开始」扩展为 7 题材下拉；按 caseId 复用 data/story-eval/cases/v2.json 输入 + 派生 seed 创建 offline 存档（显式 deterministic fixture + `runtimeNarrativeMode:"offline"`，零 AI）。新增 `src/game/application/server/offlineBaselines.ts`（题材→caseId 白名单 + seed 派生）与 7 题材零 AI 规则通关回归 `src/game/application/testing/offlineGenreJourney.test.ts`。
