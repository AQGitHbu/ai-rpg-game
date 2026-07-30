# Phase 9 场景化战斗与敌人遭遇 Implementation Plan

> 状态：待执行
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将既有确定性 boss 战呈现为带战场、敌我状态、行动栏和反馈日志的 RPG 战斗主视窗。

**Architecture:** 保持 application 的 BattleView、performAction 与 CurrentGameScreen 路由不变；components 层新增无副作用的 BattleArena 与 BattleActionRail，BattlePanel 仍是唯一提交 battle_action 的协调器。视觉全部由 AdventureVisual 与 RPG CSS 提供，任何 HP/回合/胜负均只消费服务端最新 GameSessionView。

**Tech Stack:** Next.js 16、React 19、TypeScript、Vitest + Testing Library、现有 @ai-game/ui public exports、AdventureVisual SVG、globals.css。

## Global Constraints

- 只修改 ai-rpg-game；不改 .foundation、../ai-game-foundation、@ai-game/ui 或共享文档副本。
- 不修改 GameState、ScenarioBlueprint、battle gameplay、quest reconciliation、ending、intent、API 白名单或 stateVersion。
- UI 只从 @/game/application facade 读取 GameSessionView；不得 import domain、gameplay、server 或 SQLite。
- 不读取 .env.local，不发 AI、图片或外部网络请求；只使用本仓 SVG。
- active battle 只显示 battle_action；battle/ending 根路由语义不变。
- 不新增普通敌人、技能、物品使用、随机数、经验、掉落、自由输入或对应按钮。
- 新组件必须有同目录测试；最终验收在 worktree 中运行 npm run build（webpack）。

## 明确边界

- 这是表现与交互阶段，不调整攻击、防御、撤退、伤害、HP、任务或结局规则。
- Enemy HP 仅以 BattleView.enemyHp 原值显示；不得读取敌人隐藏 stats 或前端计算胜负/比例。
- BattleArena 和 BattleActionRail 属于 RPG 业务组合，不抽取共享 UI。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| src/components/BattleArena.tsx | 纯呈现的战场背景、敌我肖像、HP 与回合 |
| src/components/BattleActionRail.tsx | 只渲染已有 battle_action 的固定行动入口 |
| src/components/BattlePanel.tsx | 请求协调、busy/feedback 状态与新 UI 组合 |
| src/components/BattlePanel.test.tsx | 请求 payload、路由安全与新的可访问界面覆盖 |
| src/components/BattleArena.test.tsx | BattleView 数据只读投影与装饰 SVG 契约 |
| src/components/BattleActionRail.test.tsx | 仅有真实 action 的行动栏、禁用与回调 |
| src/components/CurrentGameScreen.test.tsx | battle/ending/nonbattle 根路由不回归 |
| src/app/globals.css | battle viewport、arena、action rail、日志与移动端样式 |

### Task 1: 战斗纯呈现组件

**Files:**
- Create: src/components/BattleArena.tsx
- Create: src/components/BattleArena.test.tsx

**Interfaces:**
- BattleArena props are gameType, playerName, playerHp, enemyName, enemyHp, round, children.
- BattleArena has no fetch, useState, action callback, gameplay import or value calculation.
- BattlePanel consumes BattleArena in Task 3.

- [ ] **Step 1: Write the failing component tests**

~~~tsx
it("只显示传入的敌我 HP、回合和装饰性 SVG", () => {
  render(<BattleArena gameType="wuxia" playerName="沈青崖" playerHp={28} enemyName="暗影刺客" enemyHp={15} round={2}><span>行动</span></BattleArena>);
  expect(screen.getByRole("region", { name: "战斗" })).toHaveTextContent("沈青崖");
  expect(screen.getByRole("region", { name: "战斗" })).toHaveTextContent("28");
  expect(screen.getByRole("region", { name: "战斗" })).toHaveTextContent("暗影刺客");
  expect(screen.getByRole("region", { name: "战斗" })).toHaveTextContent("15");
  expect(screen.getByText("回合 2")).toBeVisible();
  expect(screen.getAllByTestId("battle-combatant-visual")).toHaveLength(2);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npx vitest run src/components/BattleArena.test.tsx

Expected: FAIL because BattleArena does not exist.

- [ ] **Step 3: Implement BattleArena without rule logic**

~~~tsx
export function BattleArena({ gameType, playerName, playerHp, enemyName, enemyHp, round, children }: BattleArenaProps) {
  return <section className="battle-viewport" role="region" aria-label="战斗">
    <div className="battle-arena-backdrop"><AdventureVisual gameType={gameType} kind="location_backdrop" label="" decorative /></div>
    <header className="battle-hud"><span>战斗中</span><strong>{enemyName}</strong><span>回合 {round}</span></header>
    <section className="battle-combatant battle-combatant--player"><div data-testid="battle-combatant-visual"><AdventureVisual gameType={gameType} kind="npc" label="" decorative /></div><h3>{playerName}</h3><p>生命 {playerHp}</p></section>
    <section className="battle-combatant battle-combatant--enemy"><div data-testid="battle-combatant-visual"><AdventureVisual gameType={gameType} kind="enemy" label="" decorative /></div><h3>{enemyName}</h3><p>生命 {enemyHp}</p></section>
    {children}
  </section>;
}
~~~

- [ ] **Step 4: Run the focused test**

Run: npx vitest run src/components/BattleArena.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/components/BattleArena.tsx src/components/BattleArena.test.tsx
git commit -m "feat: add battle arena presentation"
~~~

### Task 2: 固定战斗行动栏

**Files:**
- Create: src/components/BattleActionRail.tsx
- Create: src/components/BattleActionRail.test.tsx

**Interfaces:**
- BattleActionRail props are actions, busy, onSelect.
- actions has type Extract<SessionActionView, { type: "battle_action" }>.
- onSelect receives the original battle action entry, so BattlePanel never reconstructs an action payload.

- [ ] **Step 1: Write the failing action rail tests**

~~~tsx
it("只渲染服务端给出的 battle_action，并转发精确 action", async () => {
  const onSelect = vi.fn();
  render(<BattleActionRail actions={[attack, guard, withdraw]} busy={false} onSelect={onSelect} />);
  await userEvent.click(screen.getByRole("button", { name: "攻击" }));
  expect(onSelect).toHaveBeenCalledWith(attack);
  expect(screen.queryByRole("button", { name: "技能" })).toBeNull();
  expect(screen.queryByRole("button", { name: "物品" })).toBeNull();
});

it("busy 时禁用所有已有战斗行动", () => {
  render(<BattleActionRail actions={[attack, guard]} busy onSelect={vi.fn()} />);
  for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npx vitest run src/components/BattleActionRail.test.tsx

Expected: FAIL because BattleActionRail does not exist.

- [ ] **Step 3: Implement action rail**

~~~tsx
const ACTION_ICON = { attack: "⚔", guard: "◈", withdraw: "↩" } as const;
export function BattleActionRail({ actions, busy, onSelect }: BattleActionRailProps) {
  return <div className="battle-action-rail" role="group" aria-label="战斗行动">
    {actions.map((entry) => <button key={entry.action} type="button" disabled={busy} onClick={() => onSelect(entry)}>
      <span aria-hidden="true">{ACTION_ICON[entry.action]}</span>{entry.label}
    </button>)}
  </div>;
}
~~~

- [ ] **Step 4: Run the focused test**

Run: npx vitest run src/components/BattleActionRail.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/components/BattleActionRail.tsx src/components/BattleActionRail.test.tsx
git commit -m "feat: add battle action rail"
~~~

### Task 3: 用战斗视窗重组 BattlePanel

**Files:**
- Modify: src/components/BattlePanel.tsx
- Modify: src/components/BattlePanel.test.tsx

**Interfaces:**
- BattlePanel keeps its existing public props and remains the only component that calls postGameAction.
- It filters SessionActionView into BattleActionView, passes view.world.gameType, view.player.name and BattleView values to BattleArena, and passes battle actions to BattleActionRail.
- Feedback remains API-derived and aria-live; no local HP, round or outcome state is introduced.

- [ ] **Step 1: Write failing integration tests**

~~~tsx
it("战斗主视窗使用服务端 BattleView，并把 rail 选择提交为原 payload", async () => {
  render(<BattlePanel view={view} onActionSuccess={onSuccess} onStaleRevision={vi.fn()} />);
  expect(screen.getByRole("region", { name: "战斗" })).toHaveTextContent("回合 2");
  expect(screen.getByRole("button", { name: "攻击" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "攻击" }));
  await waitFor(() => expect(JSON.parse(String(request.body))).toEqual({
    intent: { type: "battle_action", action: "attack" }, revision: 3
  }));
});

it("成功反馈只在 API 返回后作为战斗日志显示", async () => {
  render(<BattlePanel view={view} onActionSuccess={vi.fn()} onStaleRevision={vi.fn()} />);
  expect(screen.queryByLabelText("战斗日志")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "防御" }));
  await screen.findByLabelText("战斗日志");
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npx vitest run src/components/BattlePanel.test.tsx

Expected: FAIL because BattlePanel still uses the card layout.

- [ ] **Step 3: Replace only the presentation composition**

~~~tsx
return <BattleArena gameType={view.world.gameType} playerName={view.player.name} playerHp={battle.playerHp} enemyName={battle.enemyName} enemyHp={battle.enemyHp} round={battle.round}>
  <BattleActionRail actions={battleActions} busy={disabled} onSelect={(action) => void handleBattleAction(action)} />
  {feedback.phase === "submitting" ? <p role="status">正在裁决本回合…</p> : null}
  {feedback.phase === "success" || feedback.phase === "rejected" || feedback.phase === "error" ? <p role="status" aria-live="polite" aria-label="战斗日志">{feedback.message}</p> : null}
</BattleArena>;
~~~

Keep handleBattleAction, stale handling, postGameAction request and external busy behavior unchanged.

- [ ] **Step 4: Run focused UI tests**

Run: npx vitest run src/components/BattleArena.test.tsx src/components/BattleActionRail.test.tsx src/components/BattlePanel.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/components/BattlePanel.tsx src/components/BattlePanel.test.tsx
git commit -m "feat: render deterministic battle viewport"
~~~

### Task 4: 样式、根路由回归与文档收尾

**Files:**
- Modify: src/app/globals.css
- Modify: src/components/CurrentGameScreen.test.tsx
- Modify: docs/agent/战斗与结局.md
- Modify: docs/agent/MVP核心闭环.md
- Modify: docs/Agent文档索引.md
- Modify: docs/agent/current-phase.json
- Modify: docs/agent/当前开发阶段.md

**Interfaces:**
- CSS classes: battle-viewport, battle-arena-backdrop, battle-hud, battle-combatant, battle-action-rail, battle-log.
- CurrentGameScreen continues the existing ending ? EndingPanel : battle ? BattlePanel : AdventureGameShell routing.
- current-phase.json changes to completed / implemented only after all acceptance commands pass and the branch merges to main.

- [ ] **Step 1: Write failing root-route assertions**

~~~ts
it("active battle 显示战斗主视窗，且不渲染地图壳", async () => {
  stubFetch(async () => jsonResponse(200, { status: "active", view: buildBattleSessionViewFixture() }));
  render(<CurrentGameScreen />);
  expect(await screen.findByRole("region", { name: "战斗" })).toHaveClass("battle-viewport");
  expect(screen.queryByRole("button", { name: "进入青石镇" })).toBeNull();
});
~~~

Keep the existing three-fixture `phase6BattleEndingRegression.test.ts` unchanged and execute it in this task: it is the authoritative regression that verifies all three game types can win or withdraw and reload without UI leaking extra battle fields.

- [ ] **Step 2: Run focused tests and verify failure**

Run: npx vitest run src/components/CurrentGameScreen.test.tsx src/game/application/phase6BattleEndingRegression.test.ts

Expected: FAIL until the battle viewport contract assertions exist.

- [ ] **Step 3: Add RPG-only battle CSS**

~~~css
.battle-viewport { position: relative; min-height: min(72vh, 760px); overflow: hidden; display: grid; grid-template-columns: 1fr 1fr; align-items: end; }
.battle-arena-backdrop { position: absolute; inset: 0; opacity: .34; }
.battle-hud { position: absolute; inset: 1rem 1rem auto; z-index: 2; display: flex; justify-content: space-between; }
.battle-combatant { position: relative; z-index: 1; padding: clamp(1rem, 3vw, 2rem); }
.battle-combatant--enemy { text-align: right; }
.battle-action-rail { position: absolute; right: 1rem; bottom: 1rem; z-index: 2; display: grid; gap: .5rem; }
@media (max-width: 700px) { .battle-viewport { grid-template-columns: 1fr; min-height: 72dvh; } .battle-action-rail { inset: auto .75rem .75rem; grid-auto-flow: column; overflow-x: auto; } }
~~~

- [ ] **Step 4: Update implementation documents after code passes**

Record the final Phase 9 UI contract, test count, webpack build compatibility and the fact that battle rules, AI and shared UI did not change. Do not claim completion before all commands pass.

- [ ] **Step 5: Run full offline acceptance**

~~~bash
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
npm run phase:status
~~~

Expected: all commands exit 0 from the Phase 9 worktree, with no real AI/image request.

- [ ] **Step 6: Commit**

~~~bash
git add src/app/globals.css src/components/CurrentGameScreen.test.tsx docs/agent/战斗与结局.md docs/agent/MVP核心闭环.md docs/Agent文档索引.md docs/agent/current-phase.json docs/agent/当前开发阶段.md
git commit -m "docs: complete battle viewport phase"
~~~

## Final Review Checklist

- [ ] The Spec's battle scene, action rail, API-only feedback, root routing, responsive and zero-AI requirements map to Tasks 1 through 4.
- [ ] No task changes gameplay rules, read model disclosure or persistence.
- [ ] BattleArena, BattleActionRail and BattlePanel props are defined before use.
- [ ] There are no unspecified implementation or test placeholders.
