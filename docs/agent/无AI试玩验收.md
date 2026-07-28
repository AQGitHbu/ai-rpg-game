# 无 AI 试玩验收

## 范围

本工作包只为已经完成的确定性规则闭环补齐试玩表达与开发环境重开局能力。它不是原始 MVP Spec 的新增 Phase，也不接入 AI、自由输入或共享 package。

## 已有闭环

当前规则已支持：创建 fallback 世界、观察/交谈/调查、地点移动、物品取得、任务解锁、确定性 boss 战，以及成功/失败两个可恢复结局。所有状态仍由 application facade → gameplay 规则 → SQLite CAS 保存。

## 本次实现约束

- 玩家可见属性、冒险记录和行动反馈只能来自 `GameSessionView` 的安全投影；组件不能读取 domain state、blueprint、seed 或持久化层。
- 冒险文本是对已有 event ledger 的确定性模板化表达，不增加 AI 生成或改变规则裁决。
- 开发环境清档只处理当前 RPG 槽位。客户端只在开发构建显示；服务端必须再次检查 `NODE_ENV === "development"`。不删除 DB 文件、schema、其它表、worktree、`.foundation` 或 sibling 仓库。
- UI/API 仍只能从 `@/game/application` 导入游戏业务；SQLite 只留在 `application/server/persistence`。

## 验收入口

实现完成后，按 `docs/superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md` 的自动与手工路线执行。手工步骤、成功路线和失败路线将在本文件完成时补全。
