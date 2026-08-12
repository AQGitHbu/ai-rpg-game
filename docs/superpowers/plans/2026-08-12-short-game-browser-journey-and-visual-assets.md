# 短篇浏览器完整旅程与视觉资产 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在真实 Chrome 中从新建短篇游戏持续游玩到结构化结局，修复所有阻断流程和明显破坏 RPG 体验的界面问题，为小镇建筑接入仓库已有图片，并建立后续 AI 生图的完整制作参考。

**Architecture:** 保持 UI → `@/game/application` → gameplay/domain 的既有单链路；浏览器旅程只消费服务端投影的 opaque token。小镇视觉改动只在组件与主题 CSS 中消费静态资产，不改变确定性地图几何、城镇状态或规则；生图资料作为设计/开发参考文档，不在本任务中新增运行时生图调用。

**Tech Stack:** Next.js 16、React 19、TypeScript、Vitest、Testing Library、SVG/静态图片、Chrome 真机控制。

## Global Constraints

- 正式产品时长仅短篇/中篇，本次选择短篇。
- 六个 `/api/game/**` route、一次规则 CAS 与独立 scene CAS 保持不变。
- UI 只消费 `GameSessionView` 与 opaque token，不推导玩法事实。
- 小镇几何继续由 seed 确定性重建；不得新增 town API、AI 生图或权威几何存储。
- 不修改受保护的 `.foundation` junction 或 sibling foundation 仓库。
- 浏览器中发现问题后先留存可复现证据，再补回归测试、最小修复并继续同一旅程。

---

### Task 1: 建立 Chrome 短篇旅程基线

**Files:**
- Inspect: `src/components/CurrentGameScreen.tsx`
- Inspect: `src/components/AdventureGameShell.tsx`
- Inspect: `src/components/NewGameSetupForm.tsx`
- Test: Chrome 中的本地开发页面

**Interfaces:**
- Consumes: 新游戏表单、`GameSessionView`、六个既有 API route。
- Produces: 可复现问题清单；覆盖创建、序幕、地图、小镇、建筑场景、固定/自由对话、探索、物品、战斗和结局的浏览器证据。

- [ ] **Step 1: 启动开发服务器并确认健康**

Run: `npm run dev`

Expected: Next.js 本地地址可访问，首页返回 200；若已有存档，仅使用开发界面的清档能力清除 current slot。

- [ ] **Step 2: 在 Chrome 创建短篇游戏**

填写完整角色/世界输入，选择“短篇”，提交后确认序幕、生成反馈和首个可交互界面都可见。

- [ ] **Step 3: 逐回合记录旅程状态**

每回合记录当前层级、主目标、可用按钮、行动结果、revision/pending 的可见反馈；至少覆盖一次固定对话、一次自由输入、一次地图返回/重进、一次拾取、一次战斗动作。

- [ ] **Step 4: 对每个缺陷建立最小回归断言**

Run: `npm run test:components -- --reporter=dot`

Expected: 新断言在修复前能准确失败，既有组件用例仍能运行。

### Task 2: 修复流程阻断与界面不合理性

**Files:**
- Modify: `src/components/CurrentGameScreen.tsx`（仅当创建、轮询、错误反馈或恢复流程有问题）
- Modify: `src/components/AdventureGameShell.tsx`（仅当导航、行动或状态呈现有问题）
- Modify: `src/components/TownLayerScreen.tsx`（仅当城镇选择/进入流程有问题）
- Modify: `src/app/globals.css`（布局、层级、响应式和 RPG 主题修复）
- Test: 与每个实际缺陷对应的 `src/components/*.test.tsx`

**Interfaces:**
- Consumes: `GameSessionView`、`TownView`、`gameActionRequest`。
- Produces: 不改变玩法规则的稳定 UI 行为和明确的 pending/error/disabled 状态。

- [ ] **Step 1: 为首个浏览器缺陷写失败测试**

断言应面向玩家可见行为，例如按钮可达、状态反馈存在、界面层级可返回、行动不会重复提交；不得断言内部实现细节。

- [ ] **Step 2: 运行定向测试并确认失败原因**

Run: `npm run test:related -- <实际修改的组件文件路径>`

Expected: 仅新回归用例因复现缺陷失败。

- [ ] **Step 3: 实现最小修复并运行定向测试**

Run: `npm run test:related -- <实际修改的组件文件路径>`

Expected: PASS。

- [ ] **Step 4: 回到 Chrome 原存档继续旅程**

刷新或热更新后从当前存档继续；若缺陷需要新局验证，使用开发清档并按相同短篇输入重开。

- [ ] **Step 5: 对后续问题重复步骤 1–4 直至结局**

完成条件：结构化结局名称、描述与 outcome 可见，普通行动消失，刷新后结局仍恢复。

### Task 3: 小镇建筑使用已有图片

**Files:**
- Modify: `src/components/town/TownMapSvg.tsx`
- Modify: `src/components/TownLayerScreen.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/components/town/TownMapSvg.test.tsx`
- Modify: `src/components/TownLayerScreen.test.tsx`
- Reuse/Move if needed: 仓库中已存在的预设图片到 `public/assets/town/`

**Interfaces:**
- Consumes: `TownRenderSnapshot.buildings[].buildingType/displayName/footprint` 和 `TownView.interactiveBuildings`。
- Produces: `buildingType -> static asset URL` 的纯展示映射；未探索剧情建筑继续隐藏真实名称，点击/键盘和 aria 行为不变。

- [ ] **Step 1: 识别并视觉核对已有预设图片**

只复用仓库现有图片；记录其主题、构图和适用建筑类型，不生成新图。

- [ ] **Step 2: 写图片渲染与信息隐藏测试**

断言已知建筑出现稳定图片引用/纹理，未探索剧情建筑仍显示“未探索”且不泄漏名称，键盘 Enter/Space 选择保持可用。

- [ ] **Step 3: 实现静态图片映射与 SVG pattern/建筑卡片呈现**

图片层设置为非交互装饰，保留现有建筑 hit target、选中描边和剧情高亮；缺少精确类型素材时使用明确的通用 fallback。

- [ ] **Step 4: 运行城镇组件与 1000 seed 回归**

Run: `npm run test:components -- src/components/town/TownMapSvg.test.tsx src/components/TownLayerScreen.test.tsx`

Run: `npm run test:game-gameplay -- src/game/gameplay/rpg/town/townGenerationBatch.test.ts`

Expected: PASS；视觉改动不改变任何生成器快照。

### Task 4: 建立 AI 生图制作参考

**Files:**
- Create: `docs/AI生图资产制作参考.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/agent/地图与地点冒险.md`

**Interfaces:**
- Consumes: 当前已实现界面、玩法状态和资产目录。
- Produces: 资产分类、触发时机、画幅/透明度/尺寸、风格一致性、Prompt 模板、负面约束、命名/版本/缓存规则以及后处理规范。

- [ ] **Step 1: 盘点全部玩家可见图片位**

至少包含题材封面、大世界地图、地点卡、城镇底图/建筑、建筑外观、场景内景、角色头像/半身/全身立绘、敌人、道具/装备/技能/任务图标、战斗背景、角色与敌人战斗序列帧、特效、结局 CG、加载占位和 UI 装饰。

- [ ] **Step 2: 为每类资产写生产规格与 Prompt 建议**

每类明确输入上下文白名单、推荐分辨率/画幅、透明背景要求、构图安全区、禁止文本/水印、角色一致性锚点和可复现 seed/reference 策略。

- [ ] **Step 3: 写序列帧和图集规则**

明确每个动作建议帧数、单帧尺寸、等距网格、固定相机/角色尺度/光照、sheet 排列、切割坐标、去底/边缘处理、对齐锚点、预览 GIF/WebP 与运行时 atlas metadata 规则。

- [ ] **Step 4: 文档索引与实现事实同步**

在 Agent 索引中添加视觉资产参考入口；地图文档注明小镇静态图复用边界与未来运行时生图仍未实现。

### Task 5: 全面回归与最终 Chrome 复验

**Files:**
- Verify: 所有本任务修改文件

**Interfaces:**
- Consumes: 完成后的 UI、静态资产和文档。
- Produces: 可重复的通过证据与已知非阻断限制。

- [ ] **Step 1: 运行相关分层测试**

Run: `npm run test:components`

Run: `npm run test:app`

Run: `npm run typecheck`

Run: `npm run test:boundaries`

Expected: 全部 PASS。

- [ ] **Step 2: 运行变更感知与构建门禁**

Run: `npm run test:changed`

Run: `npm run build`

Expected: 全部 PASS。

- [ ] **Step 3: 在 Chrome 从新建短篇到结局复验**

确认创建、序幕、场景生成、地图/小镇/建筑图片、NPC 对话、物品、战斗、结局和刷新恢复完整可用；桌面视口无关键操作被裁切。

- [ ] **Step 4: 自检计划覆盖与占位符**

逐项核对用户五条要求都有浏览器证据、代码/测试或文档产物；搜索计划和新参考文档，不留下未完成占位语或未定义的接口。
