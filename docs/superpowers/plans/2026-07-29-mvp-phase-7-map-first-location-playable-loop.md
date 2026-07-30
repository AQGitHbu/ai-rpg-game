# 地图优先地点冒险主循环 Implementation Plan

> 状态：待执行
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有确定性 RPG 规则重组为“地图 → 地点场景 → 点击互动 → 任务推进 → 返回地图”的离线可玩主循环。

**Architecture:** 保持 `domain → gameplay → application → API/UI` 单向依赖。新增 `dialogue_choice` 作为唯一可写的 NPC 对话意图；地图、地点、对话和交互热点全部由 application 安全 read model 投影，UI 只提交其白名单 ID。视觉采用 RPG 仓内的内联 SVG 档案和响应式 CSS，不修改 foundation，不调用 AI 或外部图片服务。

**Tech Stack:** Next.js 16.2、React 19、TypeScript 5.8 strict、Vitest/jsdom、现有 SQLite CAS、`@ai-game/ui@0.1.0`（仅 package 根入口）。

## Global Constraints

- Node `>=20.9.0`、npm `>=10.0.0`；代码保持 TypeScript strict，禁用 `any`。
- 修改仓库仅 `ai-rpg-game`；`sharedInfrastructureChangeAllowed: false`。不得修改 `../ai-game-foundation`、`.foundation` 或 `@ai-game/ui`，也不得新增共享 package。
- UI/API 只经 `@/game/application` 门面使用玩法；不得读取蓝图、`GameState`、seed、SQLite 或 gameplay 内部模块。
- 所有地图、场景、NPC、线索、物品、敌人与状态视觉必须是本仓可审查的内联 SVG；不得读 AI 环境变量、调用 AI 生图、外部图片/语音服务或依赖 `.env.local`。
- 地图显示范围固定为：全部 `unlockedLocationIds` 加当前 active `visit_location` 指向但未解锁的目标；其余未解锁地点不得投影。
- 地图状态固定为 `current | travelable | known | locked`：仅 `travelable` 发送 `move`；`current` 只进入地点；`known` 显示真实名与“需从相邻地点前往”；`locked` 只显示“探寻未知之地 / 尚未解锁”。
- `dialogue_choice` 只允许 `greet` 与 `ask_main_quest` 两种写状态选择；`review_clue` 是本地 read model 展示，零 fetch、零写入。既有 `talk` 保留 API/回归兼容，新 UI 不提交它。
- 不新增 `GameState` 或蓝图持久化字段，不 bump `stateVersion`；旧存档零迁移可投影。
- 本阶段不重制战斗，且不实现自由输入、AI 对话/叙事、同伴、交易、使用物品、随机遭遇、技能、经验或多存档。

---

## 目标文件结构

| 路径 | 职责 |
|---|---|
| `src/game/gameplay/rpg/actions/dialogueChoices.ts` | 纯对话 choice ID、可用性与 intent 校验；不依赖 application/UI。 |
| `src/game/gameplay/rpg/actions/{intents,validateIntent,resolveAction,index}.ts` | 将 `dialogue_choice` 接入封闭 intent、规则校验、事件与 facade。 |
| `src/game/application/locationAdventureView.ts` | 从蓝图、状态和已有可用行动投影封闭地图、地点交互与安全对话 read model。 |
| `src/game/application/gameSessionView.ts` | 把 `worldMap`、`locationScene`、`dialogues` 并入 `GameSessionView`。 |
| `src/components/adventureVisuals.tsx` | 七题材 × 八类 SVG 视觉选择和可访问的内联 SVG 占位实现。 |
| `src/components/{AdventureGameShell,WorldMapScreen,LocationSceneScreen,NpcDialoguePanel,AdventureDetailsPanel}.tsx` | RPG 专属游戏壳、地图、地点热点、固定对话和次级信息抽屉。 |
| `src/components/gameActionRequest.ts`、`src/app/api/game/actions/actionHandler.ts` | 对 `dialogue_choice` 的客户端 payload 与服务端严格白名单。 |
| `src/app/globals.css` | 地图与地点场景的 RPG 主题、键盘焦点、窄屏纵向布局；不修改 foundation CSS。 |
| `docs/agent/地图与地点冒险.md` | 新系统的实现边界、入口、测试与维护事实。 |

## Task 1: 阶段交接文档与玩家规则基线

**Files:**
- Create: `docs/agent/地图与地点冒险.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`
- Modify: `docs/agent/MVP核心闭环.md`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-29-map-first-location-playable-loop-design.md`
- Produces: 单仓阶段 `mvp-phase-7-map-first-location-playable-loop` 的机器可读交接入口；后续任务只以本计划为唯一执行 Plan。

- [ ] **Step 1: 写出先失败的交接检查目标**

将 `current-phase.json` 设为下面的精确形态（保留既有 `schemaVersion` 和验收命令），然后预期当前检查在 Plan 尚未写入前失败：

```json
{
  "phase": "mvp-phase-7-map-first-location-playable-loop",
  "status": "planned",
  "implementationStatus": "not_started",
  "targetBranch": "codex/phase7-map-scene-playable-loop",
  "worktreeName": "phase7-map-scene-playable-loop",
  "repositories": ["ai-rpg-game"],
  "plan": "docs/superpowers/plans/2026-07-29-mvp-phase-7-map-first-location-playable-loop.md",
  "sharedInfrastructureChangeAllowed": false,
  "startCommand": "npm run phase:start"
}
```

- [ ] **Step 2: 运行交接检查，确认失败原因只与缺失 Plan/入口有关**

Run: `npm run handoff:check:docs`

Expected: FAIL，输出指出新 Plan 或新入口文档尚未就绪；不得通过修改 `scripts/checkHandoff.mjs` 绕过。

- [ ] **Step 3: 完成文档与规则事实**

1. 将上方 JSON 补齐 `entryDocs`（游戏设计/开发规范、索引、当前阶段、MVP 核心、`地图与地点冒险.md`、本 Spec、本 Plan）和既有六条离线验收命令。
2. `当前开发阶段.md` 只保留 Phase 7 的目标、范围、目标分支、唯一 Plan、Spec 和验收命令；写明 SVG 占位和零 AI 图片调用。
3. 从 `agent/template.md` 创建 `地图与地点冒险.md`，列出地图状态四元组、`dialogue_choice` 三种 choice kind 的边界、read model 入口和本计划要求的测试。
4. 在玩家规则文档第 5、6、7 节补充地图旅行层、地点点击互动、固定对话和“自由输入/AI/图片服务不在本阶段”的玩家可见边界。
5. 在索引登记新 agent 文档、Spec 与 Phase 7 Plan；在 `MVP核心闭环.md` 增加“Phase 7 计划中”的一行，不得把未实现功能写成完成。

- [ ] **Step 4: 运行交接检查，确认文档交接通过**

Run: `npm run handoff:check:docs && npm run phase:status`

Expected: PASS；状态显示 `planned / not_started`，仓库只列 `ai-rpg-game`。

- [ ] **Step 5: Commit**

```powershell
git add docs/agent docs/Agent文档索引.md docs/策划文档/AI生成RPG_MVP.md
git commit -m "docs: start map-first playable loop phase"
```

## Task 2: 封闭的 NPC 对话选择规则

**Files:**
- Create: `src/game/gameplay/rpg/actions/dialogueChoices.ts`
- Create: `src/game/gameplay/rpg/actions/dialogueChoices.test.ts`
- Modify: `src/game/gameplay/rpg/actions/intents.ts`
- Modify: `src/game/gameplay/rpg/actions/validateIntent.ts`
- Modify: `src/game/gameplay/rpg/actions/resolveAction.ts`
- Modify: `src/game/gameplay/rpg/actions/index.ts`
- Modify: `src/game/application/performAction.test.ts`

**Interfaces:**
- Consumes: compiled `ScenarioBlueprint`、`GameState`、`isQuestObjectiveSatisfied`、既有 `NpcMetEvent`。
- Produces:

```ts
export const DIALOGUE_CHOICE_KINDS = ["greet", "ask_main_quest"] as const;
export type DialogueChoiceKind = (typeof DIALOGUE_CHOICE_KINDS)[number];
export type DialogueChoiceIntent = {
  readonly type: "dialogue_choice";
  readonly npcId: NpcId;
  readonly choiceId: string;
};
export type DialogueChoice = {
  readonly kind: DialogueChoiceKind;
  readonly choiceId: string;
  readonly label: string;
};
export function makeDialogueChoiceId(npcId: NpcId, kind: DialogueChoiceKind): string;
export function projectDialogueChoices(
  blueprint: ScenarioBlueprint, state: GameState, npcId: NpcId
): readonly DialogueChoice[];
```

- [ ] **Step 1: 写失败测试，钉住 choice 的封闭语义**

在 `dialogueChoices.test.ts` 使用既有合法 fixture pipeline 覆盖：

```ts
expect(projectDialogueChoices(blueprint, state, asNpcId("npc_1"))).toEqual([
  { kind: "greet", choiceId: "npc_1:greet", label: "与村长初次交谈" }
]);
expect(projectDialogueChoices(blueprint, activeTalkTargetState, asNpcId("npc_3"))).toEqual([
  { kind: "ask_main_quest", choiceId: "npc_3:ask_main_quest", label: "询问当前线索" }
]);
expect(projectDialogueChoices(blueprint, metState, asNpcId("npc_1"))).toEqual([]);
```

再覆盖伪造 `choiceId`、NPC 不在场、已结识 NPC、非当前任务目标的 `ask_main_quest` 均返回稳定拒绝且 state/event ledger 不变。

- [ ] **Step 2: 运行定向测试，确认失败**

Run: `npx vitest run src/game/gameplay/rpg/actions/dialogueChoices.test.ts`

Expected: FAIL，原因是 `dialogueChoices.ts` 或导出尚不存在。

- [ ] **Step 3: 实现纯 choice 投影与 resolver 接线**

1. `makeDialogueChoiceId` 只返回 `${npcId}:${kind}`；解析时要求完全等于该值，禁止接受额外分隔符或任意 kind。
2. `greet` 只在 NPC 位于当前地点且 `met === false`、同时不存在该 NPC 的未完成 active `talk_to_npc` objective 时投影。
3. `ask_main_quest` 只在该 NPC 位于当前地点、未结识，且 active main quest 存在未满足的 `talk_to_npc` objective 时投影；它替代本次交谈的文案，但仍只产生已有 `npc_met` 事件。
4. 将 `DialogueChoiceIntent` 加入 `PlayerIntent`。`validateIntent` 增加 `INVALID_DIALOGUE_CHOICE` 与 `DIALOGUE_CHOICE_UNAVAILABLE` 两个稳定码，并复用当前地点/NPC 存在性校验。
5. `resolveAction` 的 `dialogue_choice` 成功分支必须与既有 `talk` 一样：仅把对应 `state.npcs` 条目的 `met` 置为 `true`、追加一个 `npc_met` 事件、返回确定性反馈；不得新增 GameState 字段或事件类型。
6. `performAction` 仍走普通 resolver + `reconcileQuests`，从而由既有 fixed point 满足 `talk_to_npc` objective；不要在对话 resolver 内直接改 quest。

- [ ] **Step 4: 运行动作与 application 回归，确认通过**

Run: `npx vitest run src/game/gameplay/rpg/actions/actions.test.ts src/game/gameplay/rpg/actions/dialogueChoices.test.ts src/game/application/performAction.test.ts`

Expected: PASS；断言一次成功对话只有一次 CAS、一次 `npc_met`，伪造/过期 choice 零 CAS。

- [ ] **Step 5: Commit**

```powershell
git add src/game/gameplay/rpg/actions src/game/application/performAction.test.ts
git commit -m "feat: add deterministic dialogue choices"
```

## Task 3: 地图、地点与安全对话 read model

**Files:**
- Create: `src/game/application/locationAdventureView.ts`
- Create: `src/game/application/locationAdventureView.test.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/game/application/index.ts`
- Modify: `src/game/application/phase4ExplorationRegression.test.ts`

**Interfaces:**
- Consumes: `ScenarioBlueprint`、`GameState`、`AvailableAction[]`、Task 2 的 `projectDialogueChoices`。
- Produces:

```ts
export type WorldMapNodeView =
  | { readonly state: "current"; readonly locationId: string; readonly name: string; readonly visual: "map_node" }
  | { readonly state: "travelable"; readonly locationId: string; readonly name: string; readonly visual: "map_node" }
  | { readonly state: "known"; readonly locationId: string; readonly name: string; readonly hint: "需从相邻地点前往"; readonly visual: "map_node" }
  | { readonly state: "locked"; readonly name: "探寻未知之地"; readonly hint: "尚未解锁"; readonly visual: "map_node_locked" };
export type LocationSceneView = {
  readonly title: string;
  readonly description: string;
  readonly backdrop: "location_backdrop";
  readonly interactions: readonly SceneInteractionView[];
};
export type SceneInteractionView =
  | { readonly kind: "observe"; readonly locationId: string; readonly label: string; readonly slot: "left" | "center" | "right" | "foreground" }
  | { readonly kind: "investigate"; readonly factId: string; readonly label: string; readonly slot: "left" | "center" | "right" | "foreground" }
  | { readonly kind: "take_item"; readonly itemId: string; readonly label: string; readonly slot: "left" | "center" | "right" | "foreground" }
  | { readonly kind: "start_battle"; readonly enemyId: string; readonly label: string; readonly slot: "left" | "center" | "right" | "foreground" };
export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly slot: "left" | "center" | "right" | "foreground";
  readonly choices: readonly DialogueChoiceView[];
  readonly reviewClues: readonly string[];
};
export type DialogueChoiceView =
  | { readonly kind: "greet" | "ask_main_quest"; readonly choiceId: string; readonly label: string; readonly mutatesState: true }
  | { readonly kind: "review_clue"; readonly label: "回顾已知线索"; readonly mutatesState: false };
```

- [ ] **Step 1: 写失败测试，先钉住封闭可见范围和零泄漏**

在 `locationAdventureView.test.ts` 构造三类 state：当前地点、相邻可移动地点、已解锁但不相邻地点，以及 active `visit_location` 指向但未解锁地点。断言：

```ts
expect(view.worldMap.nodes.map((node) => node.state)).toEqual([
  "current", "travelable", "known", "locked"
]);
expect(view.worldMap.nodes.at(-1)).toEqual({
  state: "locked", name: "探寻未知之地", hint: "尚未解锁", visual: "map_node_locked"
});
expect(JSON.stringify(view)).not.toContain("hidden-location-real-name");
```

再断言地点场景只投影当前地点的 NPC、当前可用 `observe` / `investigate` / `take_item` / `start_battle` 互动；NPC slot 对同一 ID 在两次投影中相同；`reviewClues` 只等于已发现事实文本。

- [ ] **Step 2: 运行定向测试，确认失败**

Run: `npx vitest run src/game/application/locationAdventureView.test.ts src/game/application/gameSessionView.test.ts`

Expected: FAIL，原因是新投影模块及 `GameSessionView.worldMap`/`locationScene`/`dialogues` 字段不存在。

- [ ] **Step 3: 实现纯投影并接入会话视图**

1. 在 `locationAdventureView.ts` 使用 `state.unlockedLocationIds`、当前地点出边和 active quest objective 计算四类地图节点；locked 节点不带 `locationId`，并按稳定排序输出 current、travelable、known、locked。
2. 以稳定 ID 的字符码累计后对 `['left','center','right','foreground']` 取模分配场景槽位；禁止 `Math.random`、时间或 AI。
3. 场景互动只由 `projectAvailableActions` 的当前可用 action 和当前地点运行时 NPC 投影；NPC 可见性只来自 `state.npcs` 当前位置，已结识 NPC 仍可投影为对话对象。
4. 将 Task 2 的写状态 choices 映射为 `{ kind, choiceId, label, mutatesState: true }`；将已发现 facts 映射为 `{ kind: 'review_clue', label: '回顾已知线索', mutatesState: false }` 的本地 choice，不为未发现事实生成文本。
5. `gameSessionView.ts` 把投影结果作为 `worldMap`、`locationScene`、`dialogues` 加入返回对象；结局或 active battle 时仍投影只读地图/地点资料，但 interactions 为空、对话 choice 不可写。
6. 导出只读 view 类型自 `@/game/application`，同时更新所有手写 `GameSessionView` fixture。

- [ ] **Step 4: 运行投影和探索回归，确认通过**

Run: `npx vitest run src/game/application/locationAdventureView.test.ts src/game/application/gameSessionView.test.ts src/game/application/phase4ExplorationRegression.test.ts`

Expected: PASS；三类现有探索路径保持可完成，read model 不含隐藏地点真实信息、seed 或完整蓝图。

- [ ] **Step 5: Commit**

```powershell
git add src/game/application/locationAdventureView.ts src/game/application/locationAdventureView.test.ts src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts src/game/application/index.ts src/game/application/phase4ExplorationRegression.test.ts
git commit -m "feat: project map and location adventure views"
```

## Task 4: 本地 SVG 视觉档案

**Files:**
- Create: `src/components/adventureVisuals.tsx`
- Create: `src/components/adventureVisuals.test.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `GameTypeId` 和 read model 的固定 visual keys `map_base | map_node | map_node_locked | location_backdrop | npc | fact | item | enemy`。
- Produces:

```tsx
export const ADVENTURE_VISUAL_KINDS = [
  "map_base", "map_node", "map_node_locked", "location_backdrop",
  "npc", "fact", "item", "enemy"
] as const;
export function AdventureVisual(props: {
  readonly gameType: GameTypeId;
  readonly kind: (typeof ADVENTURE_VISUAL_KINDS)[number];
  readonly label: string;
  readonly decorative?: boolean;
}): JSX.Element;
export function resolveAdventureVisualVariant(gameType: unknown, kind: unknown): "wuxia" | "xianxia" | "fantasy" | "science_fiction" | "urban" | "alternate_history" | "apocalypse" | "generic";
```

- [ ] **Step 1: 写失败测试，覆盖全部题材组合与 SVG 降级**

```tsx
const ALL_GAME_TYPES: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "apocalypse"
];
for (const gameType of ALL_GAME_TYPES) {
  for (const kind of ADVENTURE_VISUAL_KINDS) {
    render(<AdventureVisual gameType={gameType} kind={kind} label={`${gameType}-${kind}`} />);
    expect(screen.getByRole("img", { name: `${gameType}-${kind}` })).toBeInTheDocument();
  }
}
expect(resolveAdventureVisualVariant("unknown", "npc")).toBe("generic");
```

测试不得 mock fetch；额外断言 `adventureVisuals.tsx` 不含 `http`、`fetch`、`AI_` 或 `image_gen` 字符串。

- [ ] **Step 2: 运行定向测试，确认失败**

Run: `npx vitest run src/components/adventureVisuals.test.tsx`

Expected: FAIL，原因是视觉组件和固定档案导出尚不存在。

- [ ] **Step 3: 实现内联 SVG 档案与主题 CSS**

1. 用通用几何形状实现八类 SVG，按七种 `gameType` 映射固定 palette、线条和小装饰；允许复用基础 path，禁止引入图片 URL、`<img>`、网络字体或图片生成调用。
2. 每个非装饰 SVG 包含 `<title>` 并以 `role="img" aria-label={label}` 暴露；纯背景 SVG 使用 `aria-hidden="true"`，同时由相邻文本提供地点名。
3. `resolveAdventureVisualVariant` 对非法运行时字符串返回 `generic`，不抛错、不拼接路径。
4. 在 `globals.css` 新增 `.adventure-map`、`.location-scene`、`.scene-hotspot`、`.scene-slot-*` 和 `.adventure-details` 的 RPG 主题；所有 focusable hotspot 有 `:focus-visible`；窄屏将场景槽位改为单列列表。

- [ ] **Step 4: 运行视觉与共享 UI 合同测试，确认通过**

Run: `npx vitest run src/components/adventureVisuals.test.tsx src/components/sharedUiContract.test.tsx && npm run lint`

Expected: PASS；不修改 `@ai-game/ui`，无 deep import。

- [ ] **Step 5: Commit**

```powershell
git add src/components/adventureVisuals.tsx src/components/adventureVisuals.test.tsx src/app/globals.css
git commit -m "feat: add local adventure svg visuals"
```

## Task 5: 世界地图与游戏壳交互

**Files:**
- Create: `src/components/WorldMapScreen.tsx`
- Create: `src/components/WorldMapScreen.test.tsx`
- Create: `src/components/AdventureGameShell.tsx`
- Create: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/components/gameActionRequest.ts`
- Modify: `src/components/sessionViewFixture.testutil.ts`

**Interfaces:**
- Consumes: `GameSessionView.worldMap`、`AdventureVisual`、`postGameAction`。
- Produces:

```tsx
export function AdventureGameShell(props: {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onViewChange: (view: GameSessionView) => void;
  readonly onStaleRevision: () => void;
}): JSX.Element;
```

- [ ] **Step 1: 写失败 UI 测试，先锁住旅行层行为**

```tsx
render(<WorldMapScreen view={buildSessionViewFixture()} onEnterCurrent={enter} onMove={move} busy={false} />);
await user.click(screen.getByRole("button", { name: "进入青石镇" }));
expect(enter).toHaveBeenCalledOnce();
expect(fetch).not.toHaveBeenCalled();
await user.click(screen.getByRole("button", { name: "前往城外官道" }));
expect(move).toHaveBeenCalledWith("loc_guandao");
expect(screen.getByRole("button", { name: "探寻未知之地：尚未解锁" })).toBeDisabled();
```

`AdventureGameShell.test.tsx` 断言初始为地图、当前地点只切换本地 `map → scene`、成功 `move` 后接收最新 view 并自动切换 scene、stale 回调只触发 reload。

- [ ] **Step 2: 运行定向测试，确认失败**

Run: `npx vitest run src/components/WorldMapScreen.test.tsx src/components/AdventureGameShell.test.tsx`

Expected: FAIL，原因是地图和壳组件尚不存在，fixture 没有 Phase 7 read model。

- [ ] **Step 3: 实现地图、统一 action payload 与壳状态机**

1. 在 `gameActionRequest.ts` 加入：

```ts
| { readonly intent: { readonly type: "dialogue_choice"; readonly npcId: string; readonly choiceId: string }; readonly revision: number }
```

2. `AdventureGameShell` 只维护本地 `screen: 'map' | 'scene'`、次级面板开关和共享 busy；首次 active view 显示 `map`。
3. `WorldMapScreen` 只对 `current` 调用 `onEnterCurrent`，只对 `travelable` 调用 `onMove(locationId)`，`known`/`locked` 是禁用 button 并具有完整 aria label。
4. 壳中 `onMove` 调用 `postGameAction({ intent: { type: 'move', locationId }, revision })`；success 使用新 view、切换到 scene；rejected 留在地图并显示反馈；stale 交给 `onStaleRevision`；error 不伪造移动成功。
5. 所有可点击节点使用 `<button>`，不使用 `div onClick`；当前节点进入地点不发请求、不递增 revision。

- [ ] **Step 4: 运行地图 UI 测试，确认通过**

Run: `npx vitest run src/components/WorldMapScreen.test.tsx src/components/AdventureGameShell.test.tsx src/components/TravelPanel.test.tsx`

Expected: PASS；旧 TravelPanel 兼容测试仍通过，新壳不再把它作为主要旅行入口。

- [ ] **Step 5: Commit**

```powershell
git add src/components/WorldMapScreen.tsx src/components/WorldMapScreen.test.tsx src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx src/components/gameActionRequest.ts src/components/sessionViewFixture.testutil.ts
git commit -m "feat: add map-first adventure shell"
```

## Task 6: 地点热点、固定 NPC 对话与次级信息面板

**Files:**
- Create: `src/components/LocationSceneScreen.tsx`
- Create: `src/components/LocationSceneScreen.test.tsx`
- Create: `src/components/NpcDialoguePanel.tsx`
- Create: `src/components/NpcDialoguePanel.test.tsx`
- Create: `src/components/AdventureDetailsPanel.tsx`
- Create: `src/components/AdventureDetailsPanel.test.tsx`
- Modify: `src/components/AdventureGameShell.tsx`

**Interfaces:**
- Consumes: Task 3 的 `locationScene`/`dialogues`、Task 4 的 `AdventureVisual`、Task 5 的成功/拒绝/stale action protocol。
- Produces: 地点场景只通过显式回调请求白名单 action；`review_clue` 永远在本地展开。

- [ ] **Step 1: 写失败测试，覆盖点击热点与对话状态边界**

```tsx
render(<LocationSceneScreen view={fixture} onAction={onAction} onOpenDialogue={open} onReturnMap={back} busy={false} />);
await user.click(screen.getByRole("button", { name: "观察环境" }));
expect(onAction).toHaveBeenCalledWith({ type: "observe", locationId: "loc_qingshi" });
await user.click(screen.getByRole("button", { name: "陆掌柜，客栈掌柜" }));
expect(open).toHaveBeenCalledWith("npc_lu");
```

在 `NpcDialoguePanel.test.tsx` 断言 `review_clue` 点击只显示 `reviewClues` 文本且 `fetch` 调用数为 0；`greet` 和 `ask_main_quest` 分别提交精确的 `dialogue_choice` payload；关闭对话和返回地图都不发送请求。断言 `role="dialog"`、关闭按钮和按键可达。

- [ ] **Step 2: 运行定向测试，确认失败**

Run: `npx vitest run src/components/LocationSceneScreen.test.tsx src/components/NpcDialoguePanel.test.tsx src/components/AdventureDetailsPanel.test.tsx`

Expected: FAIL，原因是地点、对话和次级面板组件尚不存在。

- [ ] **Step 3: 实现地点场景与对话提交**

1. `LocationSceneScreen` 用 `locationScene.interactions` 渲染观察、线索、物品、敌人 hotspot；每个热点显示名称和动作，调用 `onAction`，不从 UI 推导 ID。
2. NPC hotspot 只打开 `NpcDialoguePanel`。面板渲染本地 `review_clue` 和写状态 choices；写状态 choice 由 shell 以：

```ts
postGameAction({
  intent: { type: "dialogue_choice", npcId, choiceId },
  revision: view.revision
});
```

提交。success 替换整份 view；rejected 留在当前对话并显示 server feedback；stale 关闭对话并触发 reload；error 保留对话和可重试选项。
3. `AdventureDetailsPanel` 使用本地按钮切换角色、背包、任务、日志四个只读子视图；只消费 `player`、`inventoryItems`、`activeQuests`、`storyEvents`，不复制旧 `ItemPanel` 的拾取按钮或旧 `QuestTracker` 的任务判定。
4. `AdventureGameShell` 仅在非战斗、非结局时渲染地图/地点；battle 非 null 时继续使用 `BattlePanel`，ending 非 null 时继续使用 `EndingPanel`，从而不改变 Phase 6 行为。

- [ ] **Step 4: 运行地点 UI 与旧组件回归，确认通过**

Run: `npx vitest run src/components/LocationSceneScreen.test.tsx src/components/NpcDialoguePanel.test.tsx src/components/AdventureDetailsPanel.test.tsx src/components/ItemPanel.test.tsx src/components/QuestTracker.test.tsx src/components/BattlePanel.test.tsx src/components/EndingPanel.test.tsx`

Expected: PASS；本地线索回顾零 fetch，写状态选择只发送白名单 payload。

- [ ] **Step 5: Commit**

```powershell
git add src/components/LocationSceneScreen.tsx src/components/LocationSceneScreen.test.tsx src/components/NpcDialoguePanel.tsx src/components/NpcDialoguePanel.test.tsx src/components/AdventureDetailsPanel.tsx src/components/AdventureDetailsPanel.test.tsx src/components/AdventureGameShell.tsx
git commit -m "feat: add location interactions and npc dialogue"
```

## Task 7: API 白名单、根界面替换与端到端回归

**Files:**
- Modify: `src/app/api/game/actions/actionHandler.ts`
- Modify: `src/app/api/game/actions/actionHandler.test.ts`
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/components/CurrentGameScreen.test.tsx`
- Modify: `src/game/application/performActionSqlite.test.ts`
- Create: `src/game/application/phase7MapLocationRegression.test.ts`

**Interfaces:**
- Consumes: Task 2 `PlayerIntent`、Task 3 `GameSessionView`、Task 5/6 game shell。
- Produces: `POST /api/game/actions` 唯一允许 `dialogue_choice { npcId, choiceId }`；根界面以新壳代替旧的 Scene/Travel/Item/Quest 主面板组合。

- [ ] **Step 1: 写失败 API 与完整流程测试**

在 adapter 测试添加：

```ts
expect(await handlePerformActionRequest(
  makeRequest({ intent: { type: "dialogue_choice", npcId: "npc_1", choiceId: "npc_1:greet" }, revision: 0 }),
  entryPoints
)).toMatchObject({ status: 200 });
```

并参数化拒绝：缺 `choiceId`、附带 `locationId`、`choiceId: 'npc_1:admin'`、非字符串 ID 均为 `400 INVALID_INTENT`。在 `CurrentGameScreen.test.tsx` 断言 active game 显示地图壳而不是旧“行动面板/移动/物品/任务”四面板主布局，点击当前地点进入 scene，完成一次 NPC 对话后更新目标并可返回地图。

`phase7MapLocationRegression.test.ts` 使用真实临时 SQLite 的武侠、科幻、都市 fixture：创建 → 地图进入当前地点 → observe / dialogue_choice / investigate（若可用）→ move → take_item（若可用）→ 返回地图 → reload；每一步断言 revision、事件和安全 view，且测试文件不读 `.env.local`、不 mock/调用 fetch。

- [ ] **Step 2: 运行定向测试，确认失败**

Run: `npx vitest run src/app/api/game/actions/actionHandler.test.ts src/components/CurrentGameScreen.test.tsx src/game/application/phase7MapLocationRegression.test.ts`

Expected: FAIL，原因是 HTTP 白名单、根集成或 Phase 7 回归尚未实现。

- [ ] **Step 3: 实现 adapter 与根集成**

1. `actionHandler.ts` 将 `choiceId` 加入允许字段，`dialogue_choice` 加入 `VALID_INTENT_TYPES`，并在 `INTENT_TARGET_FIELD` 使用显式双字段规则：只接受 `type`、`npcId`、`choiceId` 三键，拒绝任意额外 key。
2. `parseIntent` 对 `dialogue_choice` 同时检查两个非空字符串，返回 `{ type: 'dialogue_choice', npcId: asNpcId(npcId), choiceId }`；更新错误帮助文本列出新 intent。
3. `CurrentGameScreen` active 分支以 `AdventureGameShell` 取代 `SceneActionPanel`、`TravelPanel`、`ItemPanel`、`QuestTracker`、`AdventureLogPanel` 的主布局；沿用原有 `actionBusy`、success view 替换、stale reload、fallback 提示和 development clear 控制。不要删除旧组件或它们的兼容测试。
4. battle/ending 分支仍渲染既有面板；结局后不渲染地图或地点的可写热点。

- [ ] **Step 4: 运行端到端定向回归，确认通过**

Run: `npx vitest run src/app/api/game/actions/actionHandler.test.ts src/components/CurrentGameScreen.test.tsx src/game/application/performActionSqlite.test.ts src/game/application/phase7MapLocationRegression.test.ts`

Expected: PASS；伪造 choice 400 或规则拒绝且零半写入，三题材完整旅行流程刷新后一致。

- [ ] **Step 5: Commit**

```powershell
git add src/app/api/game/actions/actionHandler.ts src/app/api/game/actions/actionHandler.test.ts src/components/CurrentGameScreen.tsx src/components/CurrentGameScreen.test.tsx src/game/application/performActionSqlite.test.ts src/game/application/phase7MapLocationRegression.test.ts
git commit -m "feat: integrate map-first location gameplay"
```

## Task 8: 全量验收、试玩与完成态文档

**Files:**
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`
- Modify: `docs/agent/MVP核心闭环.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Consumes: Tasks 1–7 的已验证实现和验收结果。
- Produces: Phase 7 `completed / implemented` 的准确实现事实；不把下一阶段能力写入完成态。

- [ ] **Step 1: 运行完整离线验收**

Run:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
npm run phase:status
```

Expected: 全部 PASS。不得运行 `npm run smoke:ai:phase4b`，不得设置 `RUN_REAL_AI_SMOKE`，不得改写 `.env.local`。

- [ ] **Step 2: 执行本地人工试玩**

Run: `npm run dev`

Expected: 在 development 模式清除当前试玩存档后，验证：新局先进入地图；当前节点进入地点零请求；相邻节点成功移动后自动进入地点；锁定节点无法点击；NPC 的本地线索回顾零请求；`greet`/`ask_main_quest` 推进既有任务；刷新保留地点、任务和冒险记录；战斗与成功/失败结局保持可用。手动停止开发服务器后再继续。

- [ ] **Step 3: 写回完成态文档**

1. `current-phase.json` 改为 `status: "completed"`、`implementationStatus: "implemented"`，保留实际目标分支、Plan、Spec、单仓和验收命令。
2. `当前开发阶段.md`、`地图与地点冒险.md`、`MVP核心闭环.md`、索引只记录实际落地的地图状态、dialogue choice、SVG、UI 入口与测试数量；明确 AI、生图和战斗重制未实现。
3. 在玩家规则文档将“计划中”改为已实现规则，但不得修改内容预算或 AI 边界。

- [ ] **Step 4: 复跑文档交接与关键 UI 回归**

Run: `npm run handoff:check:docs && npx vitest run src/components/CurrentGameScreen.test.tsx src/game/application/phase7MapLocationRegression.test.ts`

Expected: PASS；完成态 `phase:status` 正确显示 Phase 7，关键地图—地点回归全绿。

- [ ] **Step 5: Commit**

```powershell
git add docs/agent docs/Agent文档索引.md docs/策划文档/AI生成RPG_MVP.md
git commit -m "docs: complete map-first playable loop phase"
```

## 明确边界

- 不修改 `@ai-game/ui` 或任何 foundation/SLG 文件；地图、地点、HUD、对话和 SVG 都是 RPG 业务实现。
- 不调用真实 AI、AI 生图、外部图片、语音或 streaming；所有测试与试玩都使用本地 SVG、fixture 或确定性 fallback。
- 不改变既有 `talk` API 的语义；新界面只使用 `dialogue_choice`，旧组件与历史回归继续覆盖 `talk`。
- 不新增持久化字段、迁移或数据重写；不处理多存档和存档导入导出。
- 不做完整战斗 UI、同伴、装备效果、物品使用、交易、自由输入、关系/记忆、随机数或无限世界扩展。
