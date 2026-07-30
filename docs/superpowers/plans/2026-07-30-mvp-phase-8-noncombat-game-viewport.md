# Phase 8 非战斗游戏视窗与交互层 Implementation Plan

> 状态：待执行
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将已有 Phase 7 非战斗确定性循环呈现为 HUD、地图/地点视窗、热点、行动栏和可关闭信息弹层组成的 RPG 游戏界面。

**Architecture:** application read model 只增加不泄漏的地图视觉位置；components 层以业务组件组合非战斗游戏壳。写状态请求继续复用 postGameAction 与既有 action intent；视觉、布局、弹层状态是客户端临时状态，不写入 GameState。

**Tech Stack:** Next.js 16、React 19、TypeScript、Vitest + Testing Library、@ai-game/ui public exports、AdventureVisual SVG、globals.css。

## Global Constraints

- 只修改 ai-rpg-game；不得修改 .foundation、../ai-game-foundation、@ai-game/ui 或共享文档副本。
- 不增加 GameState、蓝图字段、事件、intent、stateVersion、AI 调用或外部图片请求。
- UI 仅经 @/game/application facade 使用 read model；不得 import domain、gameplay、server 或 SQLite。
- locked 节点不得新增真实 locationId、名称、描述或可推断其身份的数据。
- battle / ending 继续由 CurrentGameScreen 的 BattlePanel / EndingPanel 呈现。
- 新组件必须有同目录测试；保持键盘、focus、Escape、aria-live 与窄屏验收。
- 最终验收全离线，不调用真实 AI 或图片服务。

## 明确边界

- 不改 BattlePanel、EndingPanel、战斗规则、敌人、技能或数值；battle active 时仍由既有根路由接管。
- 不新增交易、偷窃、赠与、同伴、装备使用、自由输入或任何对应的展示按钮。
- 不为 HUD、地图、地点或对话抽取共享组件；这些都是 RPG 业务组合。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| src/game/application/locationAdventureView.ts | 安全世界地图节点的纯、稳定、无泄漏展示位置 |
| src/components/AdventureHud.tsx | 常驻世界/角色/主线摘要和四个信息入口 |
| src/components/AdventureOverlay.tsx | RPG 专用可访问弹层壳与焦点恢复 |
| src/components/AdventureDetailsPanel.tsx | 四种详情内容，作为弹层内容而非行内 tab |
| src/components/WorldMapScreen.tsx | SVG 地图背景、叠加节点和安全目标卡 |
| src/components/LocationSceneScreen.tsx | 场景背景、热点与真实行动的右侧行动栏 |
| src/components/SceneActionMenu.tsx | 仅将已有 scene interaction 分类为可选入口 |
| src/components/NpcDialoguePanel.tsx | SVG 肖像和固定 choice 的对话内容 |
| src/components/AdventureGameShell.tsx | 视图、弹层、焦点、toast 与既有请求编排 |
| src/components/CurrentGameScreen.tsx | 非战斗 active 分支只挂载游戏壳 |
| src/app/globals.css | viewport、HUD、hotspot、action rail、toast、overlay、响应式样式 |

### Task 1: 安全地图布局 read model

**Files:**
- Modify: src/game/application/locationAdventureView.ts
- Modify: src/game/application/locationAdventureView.test.ts
- Modify: src/game/application/gameSessionView.test.ts

**Interfaces:**
- Produces MapNodePosition = north_west | north_east | south_west | south_east | center.
- Adds position: MapNodePosition to every WorldMapNodeView variant; locked variants remain without locationId.
- WorldMapScreen uses node.position only for CSS positioning.

- [ ] **Step 1: Write the failing test**

~~~ts
it("为同一安全节点集投影稳定位置，locked 仍无真实标识", () => {
  const first = project(bp, state).worldMap.nodes;
  expect(project(bp, state).worldMap.nodes).toEqual(first);
  expect(first.every((node) => "position" in node)).toBe(true);
  const locked = first.find((node) => node.state === "locked");
  expect(locked).toMatchObject({ state: "locked", position: expect.any(String) });
  expect(locked).not.toHaveProperty("locationId");
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/locationAdventureView.test.ts -t "稳定位置"

Expected: FAIL because position is absent.

- [ ] **Step 3: Write minimal implementation**

~~~ts
export const MAP_NODE_POSITIONS = ["north_west", "north_east", "south_west", "south_east", "center"] as const;
export type MapNodePosition = (typeof MAP_NODE_POSITIONS)[number];

function positionForLocation(blueprint: ScenarioBlueprint, locationId: string): MapNodePosition {
  const index = blueprint.locations.findIndex((entry) => String(entry.id) === locationId);
  return MAP_NODE_POSITIONS[Math.max(index, 0) % MAP_NODE_POSITIONS.length];
}
// Current/travelable/known nodes use positionForLocation, so a known location
// keeps its map position after the player moves. A locked node uses only its
// visible ordinal; do not pass targetId into its view or placement helper.
~~~

- [ ] **Step 4: Run test to verify it passes**

Run: npx vitest run src/game/application/locationAdventureView.test.ts src/game/application/gameSessionView.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/game/application/locationAdventureView.ts src/game/application/locationAdventureView.test.ts src/game/application/gameSessionView.test.ts
git commit -m "feat: project stable map node positions"
~~~

### Task 2: HUD、RPG 弹层和详情内容

**Files:**
- Create: src/components/AdventureHud.tsx
- Create: src/components/AdventureHud.test.tsx
- Create: src/components/AdventureOverlay.tsx
- Create: src/components/AdventureOverlay.test.tsx
- Modify: src/components/AdventureDetailsPanel.tsx
- Modify: src/components/AdventureDetailsPanel.test.tsx

**Interfaces:**
- AdventureHud accepts view and onOpen(panel), where panel is character | inventory | quests | journal.
- AdventureOverlay accepts title, children, onClose, returnFocusRef; it owns dialog focus and Escape.
- AdventureDetailsPanel accepts view and one panel value; it renders exactly one section.

- [ ] **Step 1: Write the failing test**

~~~tsx
it("HUD 只显示安全主线摘要，并把四个入口交给 shell", async () => {
  const onOpen = vi.fn();
  render(<AdventureHud view={viewWithActiveQuest} onOpen={onOpen} />);
  await userEvent.click(screen.getByRole("button", { name: "背包" }));
  expect(onOpen).toHaveBeenCalledWith("inventory");
  expect(screen.getByText(viewWithActiveQuest.activeQuests[0].name)).toBeVisible();
});

it("弹层获得焦点、Escape 关闭并恢复触发焦点", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "打开" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "打开" })).toHaveFocus();
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/components/AdventureHud.test.tsx src/components/AdventureOverlay.test.tsx

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Write minimal implementation**

~~~tsx
const mainQuest = view.activeQuests.find((quest) => quest.kind === "main");
const objective = mainQuest?.objectives.find((entry) => !entry.completed);

<section role="dialog" aria-modal="true" aria-labelledby={titleId} className="adventure-overlay">
  <button ref={closeButtonRef} type="button" onClick={onClose} aria-label={"关闭" + title}>×</button>
  <h2 id={titleId}>{title}</h2>{children}
</section>
~~~

Use useEffect to focus closeButtonRef on mount; on close, restore returnFocusRef.current if connected.

- [ ] **Step 4: Convert details to one explicit panel and test it**

~~~tsx
export function AdventureDetailsPanel({ view, panel }: { view: GameSessionView; panel: DetailsPanel }) {
  if (panel === "journal") return <JournalSection openingNarration={view.openingNarration} events={view.storyEvents} />;
  if (panel === "inventory") return <InventorySection items={view.inventoryItems} />;
  if (panel === "quests") return <QuestSection quests={view.activeQuests} />;
  return <CharacterSection player={view.player} />;
}
~~~

Run: npx vitest run src/components/AdventureHud.test.tsx src/components/AdventureOverlay.test.tsx src/components/AdventureDetailsPanel.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/components/AdventureHud.tsx src/components/AdventureHud.test.tsx src/components/AdventureOverlay.tsx src/components/AdventureOverlay.test.tsx src/components/AdventureDetailsPanel.tsx src/components/AdventureDetailsPanel.test.tsx
git commit -m "feat: add adventure hud and detail overlays"
~~~

### Task 3: 地图视窗替代节点列表

**Files:**
- Modify: src/components/WorldMapScreen.tsx
- Modify: src/components/WorldMapScreen.test.tsx
- Modify: src/components/adventureVisuals.tsx only if map backdrop needs a local composition prop
- Modify: src/components/adventureVisuals.test.tsx only if that prop changes

**Interfaces:**
- Keeps WorldMapScreen props unchanged.
- Emits data-map-position=node.position on every node.
- Renders one decorative AdventureVisual with kind=map_base.

- [ ] **Step 1: Write the failing test**

~~~tsx
it("用装饰性地图底图覆盖安全节点，并只让真实节点操作", () => {
  render(<WorldMapScreen view={view} onEnterCurrent={enter} onMove={move} busy={false} />);
  expect(screen.getByTestId("world-map-viewport")).toHaveTextContent("当前目标");
  expect(screen.getByTestId("world-map-backdrop")).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button", { name: /前往/ })).toHaveAttribute("data-map-position");
  expect(screen.getByRole("button", { name: /探寻未知之地/ })).toBeDisabled();
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/components/WorldMapScreen.test.tsx

Expected: FAIL because the viewport, backdrop and placement attribute are absent.

- [ ] **Step 3: Write minimal implementation**

~~~tsx
<section data-testid="world-map-viewport" className="world-map-viewport" aria-label="世界地图">
  <div data-testid="world-map-backdrop" className="world-map-backdrop">
    <AdventureVisual gameType={gameType} kind="map_base" label="" decorative />
  </div>
  <aside className="map-objective-card"><span>当前目标</span><strong>{objectiveText}</strong></aside>
  {view.worldMap.nodes.map((node, index) => <MapNode key={nodeKey(node, index)} node={node} />)}
</section>
~~~

- [ ] **Step 4: Run tests to verify it passes**

Run: npx vitest run src/components/WorldMapScreen.test.tsx src/components/adventureVisuals.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/components/WorldMapScreen.tsx src/components/WorldMapScreen.test.tsx src/components/adventureVisuals.tsx src/components/adventureVisuals.test.tsx
git commit -m "feat: render world map as adventure viewport"
~~~

### Task 4: 地点视窗、热点和真实行动栏

**Files:**
- Create: src/components/SceneActionMenu.tsx
- Create: src/components/SceneActionMenu.test.tsx
- Modify: src/components/LocationSceneScreen.tsx
- Modify: src/components/LocationSceneScreen.test.tsx

**Interfaces:**
- SceneActionMenu consumes projected interactions/dialogues and callbacks only.
- Categories are people | observe | investigate | items | map; no future ability categories.
- LocationSceneScreen callback signatures remain unchanged.

- [ ] **Step 1: Write the failing test**

~~~tsx
it("行动栏只显示当前真正可执行的类别，不显示未实现玩法", () => {
  render(<SceneActionMenu interactions={[observe]} dialogues={[]} onAction={vi.fn()} onOpenDialogue={vi.fn()} onReturnMap={vi.fn()} busy={false} />);
  expect(screen.getByRole("button", { name: "观察" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "交易" })).toBeNull();
  expect(screen.queryByRole("button", { name: "偷窃" })).toBeNull();
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/components/SceneActionMenu.test.tsx src/components/LocationSceneScreen.test.tsx

Expected: FAIL because SceneActionMenu does not exist.

- [ ] **Step 3: Write minimal implementation**

~~~tsx
<section className="location-viewport" aria-label={"地点场景：" + scene.title}>
  <AdventureVisual gameType={gameType} kind={scene.backdrop} label="" decorative />
  <p className="location-scene-caption">{scene.description}</p>
  <div className="scene-hotspot-layer">{scene.interactions.map(renderInteractionHotspot)}{view.dialogues.map(renderNpcHotspot)}</div>
  <SceneActionMenu interactions={scene.interactions} dialogues={view.dialogues} onAction={onAction} onOpenDialogue={onOpenDialogue} onReturnMap={onReturnMap} busy={busy} />
</section>
~~~

Each action rail button must either call the exact existing action callback or focus/open an existing visible hotspot; map calls onReturnMap.

- [ ] **Step 4: Run tests to verify it passes**

Run: npx vitest run src/components/SceneActionMenu.test.tsx src/components/LocationSceneScreen.test.tsx

Expected: PASS; observe, investigate, take_item, start_battle and NPC callbacks remain exact.

- [ ] **Step 5: Commit**

~~~bash
git add src/components/LocationSceneScreen.tsx src/components/LocationSceneScreen.test.tsx src/components/SceneActionMenu.tsx src/components/SceneActionMenu.test.tsx
git commit -m "feat: add location action rail and scene viewport"
~~~

### Task 5: 场景化 NPC 对话与游戏壳编排

**Files:**
- Modify: src/components/NpcDialoguePanel.tsx
- Modify: src/components/NpcDialoguePanel.test.tsx
- Modify: src/components/AdventureGameShell.tsx
- Modify: src/components/AdventureGameShell.test.tsx
- Modify: src/components/CurrentGameScreen.tsx
- Modify: src/components/CurrentGameScreen.test.tsx

**Interfaces:**
- AdventureGameShell owns screen, optional details panel, optional NPC id and trigger focus ref.
- handleMove, handleSceneAction and handleDialogueChoice remain the only write paths.
- NpcDialoguePanel renders AdventureVisual kind=npc and a static non-factual greeting; it has no gameplay/server import and no longer owns role=dialog, Escape, or focus handling because AdventureOverlay owns them.

- [ ] **Step 1: Write the failing integration test**

~~~tsx
it("HUD 打开背包弹层，关闭后回到触发按钮；成功行动用 toast", async () => {
  render(<AdventureGameShell {...props} />);
  const inventory = screen.getByRole("button", { name: "背包" });
  await userEvent.click(inventory);
  expect(screen.getByRole("dialog", { name: "背包" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(inventory).toHaveFocus();
});

it("active 页面不重复开场资料卡，battle 和 ending 路由不变", () => {
  render(<CurrentGameScreen />);
  expect(screen.queryByText("故事从这里开始")).toBeNull();
  expect(screen.getByLabelText("世界地图")).toBeVisible();
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/components/NpcDialoguePanel.test.tsx src/components/AdventureGameShell.test.tsx src/components/CurrentGameScreen.test.tsx

Expected: FAIL because HUD overlays and the new active layout are absent.

- [ ] **Step 3: Write minimal implementation**

~~~tsx
// Shell render order: HUD, map/scene viewport, optional overlay, optional toast.
<AdventureHud view={view} onOpen={openDetails} />
{detailsPanel ? <AdventureOverlay title={DETAIL_TITLE[detailsPanel]} onClose={closeOverlay} returnFocusRef={triggerRef}>
  <AdventureDetailsPanel view={view} panel={detailsPanel} />
</AdventureOverlay> : null}
{feedback.phase === "success" ? <p className="adventure-toast" role="status" aria-live="polite">{feedback.message}</p> : null}
~~~

Remove OpeningGameView from CurrentGameScreen active branch only. Keep the existing ending ? EndingPanel : battle ? BattlePanel : AdventureGameShell switch.

- [ ] **Step 4: Run tests to verify it passes**

Run: npx vitest run src/components/NpcDialoguePanel.test.tsx src/components/AdventureGameShell.test.tsx src/components/CurrentGameScreen.test.tsx

Expected: PASS; existing dialogue payload, stale revision and battle/ending tests remain green.

- [ ] **Step 5: Commit**

~~~bash
git add src/components/NpcDialoguePanel.tsx src/components/NpcDialoguePanel.test.tsx src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx src/components/CurrentGameScreen.tsx src/components/CurrentGameScreen.test.tsx
git commit -m "feat: compose noncombat adventure game shell"
~~~

### Task 6: RPG viewport styling、回归与文档收尾

**Files:**
- Modify: src/app/globals.css
- Modify: src/game/application/phase7MapLocationRegression.test.ts
- Modify: docs/agent/地图与地点冒险.md
- Modify: docs/agent/MVP核心闭环.md
- Modify: docs/Agent文档索引.md
- Modify: docs/agent/current-phase.json
- Modify: docs/agent/当前开发阶段.md

**Interfaces:**
- CSS contracts: adventure-hud, world-map-viewport, location-viewport, scene-action-rail, adventure-overlay, adventure-toast.
- current-phase.json becomes completed / implemented only after every acceptance command passes and implementation merges to main.

- [ ] **Step 1: Write the failing regression**

~~~ts
it("create → observe → dialogue_choice → move → reload：地图位置稳定且 view 安全", async () => {
  // Extend the existing three-fixture Phase 7 journey immediately after create.
  const beforeMove = created.view.worldMap.nodes
    .filter((node) => node.state !== "locked")
    .map((node) => [node.locationId, node.position]);
  expect(beforeMove.every(([, position]) => typeof position === "string")).toBe(true);
  // After the existing move, compare the same visible location IDs, then retain
  // the existing hidden-name, seed, inputDigest and reload assertions.
  const afterMove = moved.view.worldMap.nodes.filter((node) => node.state !== "locked");
  for (const [locationId, position] of beforeMove) {
    const after = afterMove.find((node) => node.locationId === locationId);
    if (after !== undefined) expect(after.position).toBe(position);
  }
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: npx vitest run src/game/application/phase7MapLocationRegression.test.ts

Expected: FAIL until the projection contract and journey assertion exist.

- [ ] **Step 3: Add responsive CSS without modifying shared primitives**

~~~css
.world-map-viewport, .location-viewport { position: relative; min-height: min(68vh, 720px); overflow: hidden; }
.map-node { position: absolute; }
.scene-action-rail { position: absolute; inset: 1rem 1rem auto auto; display: grid; }
.adventure-overlay { position: fixed; inset: 0; display: grid; place-items: center; }
@media (max-width: 700px) { .scene-action-rail { inset: auto .75rem .75rem; grid-auto-flow: column; overflow-x: auto; } }
~~~

- [ ] **Step 4: Update implementation facts only after code passes**

Update agent docs and index with the completed Phase 8 interface, test count and no combat/AI/shared module changes. Do not claim completion before this step.

- [ ] **Step 5: Run full offline acceptance**

Run:

~~~bash
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
npm run phase:status
~~~

Expected: every command exits 0; no real AI/image request is made.

- [ ] **Step 6: Commit**

~~~bash
git add src/app/globals.css src/game/application/phase7MapLocationRegression.test.ts docs/agent/地图与地点冒险.md docs/agent/MVP核心闭环.md docs/Agent文档索引.md docs/agent/current-phase.json docs/agent/当前开发阶段.md
git commit -m "docs: complete noncombat adventure viewport phase"
~~~

## Final Review Checklist

- [ ] Reference comparison maps to Task 1 (map), Task 2/5 (HUD and panels), Task 4 (scene/action rail), and Task 5 (NPC).
- [ ] No task introduces rules beyond existing noncombat intents or violates locked-map zero leakage.
- [ ] Later task types and names are defined by earlier task interfaces.
- [ ] There are no unspecified implementation or test placeholders.
