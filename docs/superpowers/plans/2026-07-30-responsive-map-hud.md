# Responsive Map HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将非战斗主界面改为没有页面滚动条的全视口地图，并把玩家信息、目标与功能入口组织为贴边 HUD。

**Architecture:** 保持 `GameSessionView`、地图节点状态、地点互动、对话、弹层和 API 请求协议不变。`AdventureGameShell` 继续作为非战斗协调器；`AdventureHud` 成为覆盖地图的布局层，`WorldMapScreen` 与 `LocationSceneScreen` 只负责视窗内容；RPG 专属 CSS 用固定全屏壳和安全视口单位实现响应式适配。

**Tech Stack:** Next.js 16、React 19、TypeScript、Vitest + Testing Library、现有本仓内联 SVG、RPG `src/app/globals.css`。

## Global Constraints

- 只修改 `ai-rpg-game`；不修改 `.foundation`、`../ai-game-foundation`、`@ai-game/ui` 或共享规范副本。
- 不修改 `GameState`、`GameSessionView`、ScenarioBlueprint、地图节点状态、任务/战斗规则、持久化、intent、API 或 `stateVersion`。
- HUD 只能读取传入的 `GameSessionView`；不得访问 domain、gameplay、server、SQLite 或环境变量。
- 所有图片均为本仓内联 SVG 占位；不发起 AI、图片或外部网络请求。
- 世界地图顶部中央不显示地点名；地点场景顶部中央显示 `locationScene.title`。当前目标位于左侧垂直中部；角色、背包、任务、日志和可用的开发工具位于右下角。
- 保持所有现有可访问名称、键盘操作、弹层 Escape/焦点恢复，以及现有地图/地点动作 payload。
- 非战斗冒险视窗不得引入页面级纵向滚动条；窄屏安全区、按钮换行和文本截断必须可用。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/components/AdventureGameShell.tsx` | 把当前地图/地点模式传给 HUD，保持协调逻辑不变。 |
| `src/components/AdventureGameShell.test.tsx` | 验证地图/地点模式的 HUD 标题切换及原有交互回归。 |
| `src/components/AdventureHud.tsx` | SVG 头像、玩家姓名/HP、条件性地点名、当前目标、右下信息入口。 |
| `src/components/AdventureHud.test.tsx` | 验证 HUD 四个位置语义、标题切换和开发工具入口。 |
| `src/components/WorldMapScreen.tsx` | 移除重复的地图目标卡，只保留地图底图与节点。 |
| `src/components/WorldMapScreen.test.tsx` | 保持节点行为，断言目标已移至 HUD。 |
| `src/components/LocationSceneScreen.tsx` | 保留可访问场景名称，移除重复的可见标题。 |
| `src/components/LocationSceneScreen.test.tsx` | 验证地点视窗无障碍名称和热点行为。 |
| `src/app/globals.css` | 实现全屏地图、HUD 指针分层与移动端安全区。 |
| `docs/agent/地图与地点冒险.md` | 记录全屏 HUD 的实现事实。 |
| `docs/Agent文档索引.md` | 同步地图/地点系统摘要。 |

### Task 1: Write the HUD regression contracts

**Files:**

- Modify: `src/components/AdventureHud.test.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/components/WorldMapScreen.test.tsx`
- Modify: `src/components/LocationSceneScreen.test.tsx`

**Interfaces:**

- `AdventureHudProps` gains `screen: "map" | "scene"`.
- `AdventureHud` exposes `aria-label="游戏 HUD"`; its decorative avatar SVG has `aria-hidden="true"`; the title only exists in scene mode.
- `WorldMapScreen` retains `data-testid="world-map-viewport"`, safe node projection and all node callbacks.
- `LocationSceneScreen` retains `aria-label={\`地点场景：${scene.title}\`}`.

- [ ] **Step 1: Write failing HUD tests**

```tsx
it("地图模式显示角色、当前目标和右下入口，但不显示中央地点名", () => {
  render(<AdventureHud view={buildSessionViewFixture()} screen="map" onOpen={vi.fn()} />);
  const hud = screen.getByLabelText("游戏 HUD");
  expect(hud.querySelector(".adventure-hud-player-card")).toHaveTextContent("沈青崖");
  expect(hud.querySelector(".adventure-hud-avatar svg")).toHaveAttribute("aria-hidden", "true");
  expect(hud.querySelector(".adventure-hud-objective")).toHaveTextContent("到访城外官道");
  expect(hud.querySelector(".adventure-hud-location-title")).toBeNull();
  expect(hud.querySelector(".adventure-hud-actions")).toHaveTextContent("角色背包任务日志");
});

it("地点模式在 HUD 顶部中央显示当前场景名", () => {
  render(<AdventureHud view={buildSessionViewFixture()} screen="scene" onOpen={vi.fn()} />);
  expect(screen.getByText("青石镇")).toHaveClass("adventure-hud-location-title");
});
```

- [ ] **Step 2: Write failing shell and map assertions**

```tsx
it("进入地点后显示 HUD 场景标题，返回地图后隐藏", async () => {
  renderShell(buildSessionViewFixture());
  expect(screen.queryByText("青石镇", { selector: ".adventure-hud-location-title" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "进入青石镇" }));
  expect(screen.getByText("青石镇", { selector: ".adventure-hud-location-title" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "地图" }));
  expect(screen.queryByText("青石镇", { selector: ".adventure-hud-location-title" })).toBeNull();
});

it("当前目标由 HUD 承担，地图视窗不再重复渲染", () => {
  render(<WorldMapScreen view={buildSessionViewFixture()} onEnterCurrent={vi.fn()} onMove={vi.fn()} busy={false} />);
  expect(screen.getByTestId("world-map-viewport")).not.toHaveTextContent("当前目标");
});
```

- [ ] **Step 3: Run the focused tests**

Run: `npx vitest run src/components/AdventureHud.test.tsx src/components/AdventureGameShell.test.tsx src/components/WorldMapScreen.test.tsx src/components/LocationSceneScreen.test.tsx`

Expected: FAIL because `screen` does not exist and the old viewport chrome is still rendered.

- [ ] **Step 4: Commit the test contract**

```bash
git add src/components/AdventureHud.test.tsx src/components/AdventureGameShell.test.tsx src/components/WorldMapScreen.test.tsx src/components/LocationSceneScreen.test.tsx
git commit -m "test: specify responsive map hud layout"
```

### Task 2: Compose the map HUD and remove duplicate chrome

**Files:**

- Modify: `src/components/AdventureHud.tsx`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/components/WorldMapScreen.tsx`
- Modify: `src/components/LocationSceneScreen.tsx`

**Interfaces:**

- `AdventureGameShell` passes its existing `screen` state to `AdventureHud` without changing action or overlay state.
- `AdventureHud` adds only a static decorative SVG; it adds no public type or network asset.
- `WorldMapScreen` no longer derives quest/objective data.
- `LocationSceneScreen` is still named by its section `aria-label`, but has no duplicate visible `h2`.

- [ ] **Step 1: Implement HUD markup**

```tsx
<div className="adventure-hud-layer" aria-label="游戏 HUD">
  <div className="adventure-hud-player-card">
    <span className="adventure-hud-avatar" aria-hidden="true">
      <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true"><circle cx="32" cy="32" r="30" /><circle cx="32" cy="25" r="11" /><path d="M12 56c4-13 12-19 20-19s16 6 20 19" /></svg>
    </span>
    <span><strong>{view.player.name}</strong><small>HP {view.player.stats.hp}</small></span>
  </div>
  {screen === "scene" ? <h1 className="adventure-hud-location-title">{view.locationScene.title}</h1> : null}
  <aside className="adventure-hud-objective"><span>当前目标</span><strong>{objectiveText}</strong></aside>
  <nav className="adventure-hud-actions" aria-label="信息入口">
    {(Object.keys(PANEL_LABELS) as DetailsPanel[]).map((panel) => <button key={panel} type="button" onClick={() => onOpen(panel)}>{PANEL_LABELS[panel]}</button>)}
    {developmentTools ? <button type="button" onClick={() => onOpenDevTools?.()}>开发工具</button> : null}
  </nav>
</div>
```

Retain the existing `PANEL_LABELS`, callbacks and conditional development-tool button verbatim inside the final navigation.

- [ ] **Step 2: Pass the local screen state and remove duplicates**

```tsx
<AdventureHud view={view} screen={screen} onOpen={openDetails} developmentTools={developmentTools} onOpenDevTools={() => {
  devToolsTriggerRef.current = document.activeElement as HTMLElement;
  setDevToolsOpen(true);
}} />
```

Delete `mainQuest`, `objective`, `objectiveText` and `<aside className="map-objective-card">` from `WorldMapScreen`. Delete only `<h2 className="location-scene-title">{scene.title}</h2>` from `LocationSceneScreen`.

- [ ] **Step 3: Run focused UI tests**

Run: `npx vitest run src/components/AdventureHud.test.tsx src/components/AdventureGameShell.test.tsx src/components/WorldMapScreen.test.tsx src/components/LocationSceneScreen.test.tsx`

Expected: PASS; existing movement, dialogue, overlay and hotspot payload tests remain green.

- [ ] **Step 4: Commit semantic composition**

```bash
git add src/components/AdventureHud.tsx src/components/AdventureGameShell.tsx src/components/WorldMapScreen.tsx src/components/LocationSceneScreen.tsx
git commit -m "feat: compose edge-aligned adventure map hud"
```

### Task 3: Build the responsive full-viewport map styling

**Files:**

- Modify: `src/app/globals.css`

**Interfaces:**

- `.adventure-game-shell` is fixed to the visual viewport with `overflow: hidden`.
- `.world-map-viewport` and `.location-viewport` fill the root at `100dvh`.
- `.adventure-hud-layer` spans the root with `pointer-events: none`; only HUD clusters re-enable pointer events.
- HUD clusters are anchored top-left, top-center, left-center and bottom-right. The narrow layout uses `env(safe-area-inset-*)` and retains reachable controls.

- [ ] **Step 1: Add full-screen layering CSS**

```css
.adventure-game-shell { position: fixed; inset: 0; z-index: 1; min-height: 100dvh; overflow: hidden; background: var(--game-surface-bg); }
.world-map-viewport, .location-viewport { position: absolute; inset: 0; min-height: 100dvh; }
.adventure-hud-layer { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.adventure-hud-player-card, .adventure-hud-location-title, .adventure-hud-objective, .adventure-hud-actions { position: absolute; pointer-events: auto; }
.adventure-hud-player-card { top: max(12px, env(safe-area-inset-top)); left: max(12px, env(safe-area-inset-left)); }
.adventure-hud-location-title { top: max(12px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); }
.adventure-hud-objective { top: 50%; left: max(12px, env(safe-area-inset-left)); transform: translateY(-50%); }
.adventure-hud-actions { right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); }
```

- [ ] **Step 2: Add visual and mobile rules**

```css
.adventure-hud-player-card { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--game-surface-border); border-radius: 10px; background: rgb(17 22 18 / 86%); box-shadow: 0 8px 24px rgb(0 0 0 / 30%); }
.adventure-hud-avatar { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 50%; overflow: hidden; background: var(--game-accent-soft); }
.adventure-hud-avatar svg { width: 100%; height: 100%; fill: none; stroke: var(--game-accent); stroke-width: 3; }
.adventure-hud-player-card small, .adventure-hud-objective span { display: block; color: var(--game-text-muted); font-size: .75rem; }
.adventure-hud-location-title { margin: 0; max-width: min(52vw, 32rem); overflow: hidden; color: var(--game-text-primary); font-size: clamp(1rem, 2.2vw, 1.5rem); text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.adventure-hud-objective { display: grid; gap: 3px; max-width: min(14rem, calc(100vw - 24px)); padding: 9px 12px; border: 1px solid var(--game-surface-border); border-radius: 8px; background: rgb(17 22 18 / 86%); }
.adventure-hud-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; max-width: min(34rem, calc(100vw - 24px)); }
@media (max-width: 700px) { .adventure-hud-player-card { padding: 6px 8px; } .adventure-hud-avatar { width: 40px; height: 40px; } .adventure-hud-location-title { top: calc(max(8px, env(safe-area-inset-top)) + 2px); max-width: 48vw; font-size: .95rem; } .adventure-hud-objective { top: auto; bottom: calc(max(76px, env(safe-area-inset-bottom)) + 10px); transform: none; max-width: 42vw; } .adventure-hud-actions { gap: 6px; } .adventure-hud-actions button { padding: 7px 9px; font-size: .82rem; } .map-node { width: min(38vw, 150px); } .scene-hotspot-layer .scene-hotspot { width: min(42vw, 155px); } }
```

Remove the old `.adventure-hud`, `.adventure-hud-info`, `.map-objective-card` and duplicate narrow-screen rules. Preserve the scene-action rail, map node and overlay stacking.

- [ ] **Step 3: Verify CSS and viewport contracts**

Run: `npx vitest run src/components/AdventureHud.test.tsx src/components/AdventureGameShell.test.tsx src/components/WorldMapScreen.test.tsx src/components/LocationSceneScreen.test.tsx && npm run lint && npm run typecheck`

Expected: all commands exit 0 with no real network request.

- [ ] **Step 4: Commit responsive layout**

```bash
git add src/app/globals.css
git commit -m "feat: make adventure map viewport responsive"
```

### Task 4: Document and fully verify the UI contract

**Files:**

- Modify: `src/components/CurrentGameScreen.test.tsx`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**

- The map/location implementation document records presentation changes only; phase status remains unchanged.
- Battle and ending roots continue to bypass the adventure HUD.

- [ ] **Step 1: Add a root route regression**

```tsx
it("非战斗 active 会话渲染地图 HUD", async () => {
  stubFetch(async () => jsonResponse(200, { status: "active", view: buildSessionViewFixture() }));
  render(<CurrentGameScreen />);
  expect(await screen.findByLabelText("游戏 HUD")).toBeInTheDocument();
  expect(document.querySelector(".adventure-game-shell")).toBeTruthy();
});
```

- [ ] **Step 2: Update implementation documentation after tests pass**

Record the full-screen map/HUD composition, four required player-facing positions, SVG avatar placeholder, safe-area behavior and unchanged no-AI/no-rules boundary in `docs/agent/地图与地点冒险.md`. Update the map/location row in `docs/Agent文档索引.md` to mention the responsive full-screen HUD refinement.

- [ ] **Step 3: Run complete offline acceptance**

```bash
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
```

Expected: every command exits 0 and makes no external AI or image request.

- [ ] **Step 4: Commit final regression and documentation**

```bash
git add src/components/CurrentGameScreen.test.tsx docs/agent/地图与地点冒险.md docs/Agent文档索引.md
git commit -m "docs: record responsive map hud"
```

## Final Review Checklist

- [ ] The gameplay shell fills the browser viewport without a page scrollbar on desktop and mobile.
- [ ] The world map remains the bottom full-screen layer; nodes retain safe state, labels and request behavior.
- [ ] Player SVG/name/HP are top-left; the location title is scene-only; the objective is mid-left; information entries are bottom-right.
- [ ] Details, developer tool, overlays, focus handling and server action payloads do not change.
- [ ] Battle/ending routes do not regress; no gameplay/read-model/persistence/shared-infrastructure changes occur.
