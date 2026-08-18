# 中篇 RPG 真机测试与界面修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Chrome 真机中从新建中篇游戏开始，覆盖完整可达结局、所有主要动作与模块，记录剧情和界面问题，修复确认的问题，并提交一份可复核的中篇流程与修复记录。

**Architecture:** 测试以玩家可见的 Chrome 页面为主证据，以现有 `GameSessionView`、DOM 快照、截图和浏览器控制台日志辅助定位；规则事实只通过现有 application/API 链产生。发现问题后在本分支修复对应 domain/gameplay/application/component/CSS，并用同一浏览器流程与自动化测试回归，避免从 UI 文案推断或绕过 opaque action token。

**Tech Stack:** Chrome extension browser control、Next.js App Router、React 19、TypeScript、CSS、Vitest、SQLite 本地开发存档。

## Global Constraints

- 使用 `codex/real-browser-playtest` 分支及 `.worktrees/real-browser-playtest`；不在主工作区执行 `git checkout`。
- 测试必须从新建中篇游戏开始，完整走到结构化 ending；覆盖地图/城镇/建筑场景、对白双选项、自定义闲聊、探索、调查、拾取、背包、移动、战斗、失败/撤退可达路径、回合提交、reload 和结局。
- 浏览器只提交页面下发的 opaque token 或焦点 NPC 自定义输入；不调用隐藏 API、篡改存档或从客户端推导规则结果。
- 每个可复现问题记录“玩家看到的现象、复现步骤、影响、所属子系统、截图/DOM证据、修复结果”；P0/P1 阻断问题优先修复并立即回归。
- 战斗验收必须明确呈现己方在左、敌方在右、回合制状态、速度/行动顺序、攻击移动、受击反馈、头顶伤害/治疗数字、技能/防御/撤退反馈和胜负结算；视觉动效不能改变规则结果。
- UI 修复遵循 RPG 主题和 playfield 保护原则：减少表单/后台面板感，保留清晰行动层级，桌面和窄屏均检查，尊重 `prefers-reduced-motion`。
- 共享 package、foundation junction 和 `docs/共同规范/` 不修改；若仅为 RPG 业务 UI/玩法修复，留在本仓。
- 完成后运行与改动相关的 focused tests、`npm run typecheck`、`npm run lint`、`npm run test:components`、`npm run test:game-application`、`npm run test:game-gameplay`，并按比例运行 `npm test`、`npm run build` 和阶段门禁。

---

### Task 1: 建立基线、启动隔离环境并准备测试记录

**Files:**
- Create: `docs/真机测试/2026-08-13-中篇完整流程记录.md`
- Read/verify: `docs/agent/当前开发阶段.md`, `docs/agent/地图与地点冒险.md`, `docs/agent/探索与任务推进.md`, `docs/agent/物品与任务奖励.md`, `docs/agent/战斗与结局.md`, `docs/agent/NPC对话驱动叙事场景触发.md`, `docs/agent/闲聊功能实现说明.md`
- Test: `npm run check:standards`, `npm run typecheck`, `npm run lint`

**Interfaces:**
- Produces a clean baseline report, a running local app URL, and a test log schema with sections `环境`, `剧情流程`, `模块覆盖`, `问题与证据`, `修复记录`, `回归结果`.
- Consumes only the canonical six game routes and the current medium-game configuration.

- [ ] **Step 1: Record the baseline state**

Run from `F:\AI2\ai-rpg-game\.worktrees\real-browser-playtest`:

```text
npm run check:standards
npm run typecheck
npm run lint
git status --short --branch
```

Write the results and the exact browser URL into the test record. If a command fails, record the first actionable failure before changing code.

- [ ] **Step 2: Start the local app**

Start `npm run dev -- --hostname 127.0.0.1 --port 3000` from the worktree, confirm `http://127.0.0.1:3000` responds, and keep the process alive only for the browser pass. Confirm the worktree has `.foundation`, `.env.local`, and installed dependencies without exposing secret values.

- [ ] **Step 3: Create the coverage matrix**

Add a checklist table to the record with these required rows: new game/medium length, prologue, map, town, building scene, NPC profile, fixed dialogue choice A, fixed dialogue choice B, custom dialogue, casual chat, exploration, investigation, item pickup, inventory categories/detail, travel, battle attack, skill, defend, retreat or defeat consequence, reload, quest progression, act handoff, ending, responsive narrow viewport, and reduced-motion behavior.

- [ ] **Step 4: Commit the empty record and plan**

```text
git add docs/superpowers/plans/2026-08-13-real-browser-playtest-and-ui-remediation.md docs/真机测试/2026-08-13-中篇完整流程记录.md
git commit -m "test: plan medium RPG browser playtest"
```

---

### Task 2: Run the first Chrome pass and capture the opening slice

**Files:**
- Modify: `docs/真机测试/2026-08-13-中篇完整流程记录.md`
- Evidence: `artifacts/playtest/2026-08-13/` screenshots and notes
- Browser: Chrome tab at `http://127.0.0.1:3000`

**Interfaces:**
- Produces the first real game ID/session, selected medium length, opening world, prologue, initial objective, and opening UI screenshots.

- [ ] **Step 1: Open Chrome and inspect the first actionable screen**

Use the Chrome browser skill to open the local app, read the DOM snapshot, and capture a screenshot. Record whether the first screen is a game setup surface rather than a dashboard, whether the primary action is obvious, and whether any error/overlay blocks play.

- [ ] **Step 2: Create a new medium game**

Fill only visible setup fields, choose the medium story length, select a coherent player/world setup, and submit. Confirm the loading state resolves to the prologue/map without manually calling `ensure` or refreshing away a pending state. Record the generated world name, player identity, central conflict, opening location/NPC/quest and initial objective exactly as shown.

- [ ] **Step 3: Review opening presentation**

Check that the prologue is readable, the map remains the navigation entry, the objective is visible, no future NPC/location names leak, and no large form/dashboard panel obscures the playfield. Log any copy, hierarchy, overlay, or responsive defect with screenshot evidence.

- [ ] **Step 4: Exercise both opening dialogue choices**

On the first focus NPC scene, submit one fixed choice in the main journey and record the exact NPC reply, relationship/quest consequence visible to the player, pending-to-ready transition, and whether the old dialogue closes cleanly. In a fresh replay of the same medium setup, submit the other fixed choice to verify it is semantically different and leaves an observable structural consequence.

---

### Task 3: Complete the medium journey while logging every action and story beat

**Files:**
- Modify: `docs/真机测试/2026-08-13-中篇完整流程记录.md`
- Evidence: `artifacts/playtest/2026-08-13/` representative screenshots for map, town, scene, inventory, battle, and ending
- Inspect if needed: `src/components/AdventureGameShell.tsx`, `src/components/CurrentGameScreen.tsx`, `src/components/TownLayerScreen.tsx`, `src/components/LocationSceneScreen.tsx`, `src/components/AdventureHud.tsx`, `src/components/AdventureOverlay.tsx`

**Interfaces:**
- Produces a chronological trace in the form `开幕 → 与 NPC 交谈 → 获得信息/物品 → 移动/调查 → 触发战斗 → 战斗结算 → 幕交接 → 结局`.
- Produces one row per successful turn with visible action label, current location, current objective, resulting scene text, NPC response, item/task/battle facts, and whether a reload occurred.

- [ ] **Step 1: Follow the authoritative objective**

At every ready scene, use the current objective and legal UI action as the next step. Record when the story materializes a new NPC, location, item, enemy, quest objective, or ending direction, and verify the next scene uses the approved name without introducing unexplained facts.

- [ ] **Step 2: Cover map, town, and building navigation**

Move from map to the current town, inspect town building labels/highlights, enter a bound story building, open the NPC conversation, return to town, and return to the world map. Confirm navigation-only clicks do not consume turns and that a scene-scale location still supports direct map-to-scene navigation.

- [ ] **Step 3: Cover dialogue and casual chat**

Use the second fixed choice in the main journey when available; use the focus NPC custom input with a natural question; test the visible casual-chat entry and observe whether it is a real supported action, a read-only conversation, or an unavailable affordance. Record if a non-focus NPC incorrectly receives the free-input control or if dialogue text is not a direct reply.

- [ ] **Step 4: Cover exploration and investigation**

Use `探索` where the location has actionable content, then use each visible `调查现场线索` entry one at a time. Verify exploration does not silently pick up items or start combat, investigation reveals a concrete fact, and empty locations do not show fake actions.

- [ ] **Step 5: Cover items and inventory**

Pick up every visible obtainable item needed by the current objective, verify it disappears from the location, open each inventory category and item detail view, reload, and verify the item remains in the backpack without any unsupported use/trade/equip button.

- [ ] **Step 6: Cover movement and act handoffs**

Travel only through visible adjacent travel choices, record why each move is narratively motivated, verify the old location does not remain selected after arrival, and verify a completed objective hands off to the next objective with a clear “下一步” prompt rather than an auto-opened unrelated NPC.

- [ ] **Step 7: Cover the complete medium path**

Continue until `currentAct` reaches the medium target and a structured ending is displayed. Record the causal chain and flag any dialogue option that is unreasonable, any abrupt NPC identity/setting change, any objective that cannot be understood from the UI, and any dead-end requiring a hidden action.

---

### Task 4: Inspect, repair, and verify battle presentation and game-like interaction

**Files:**
- Inspect/modify: `src/components/AdventureGameShell.tsx`, `src/components/AdventureOverlay.tsx`, `src/components/AdventureHud.tsx`, `src/components/adventureVisuals.tsx`, `src/app/globals.css`
- Inspect/modify if rule/view facts are missing: `src/game/application/combatView.ts`, `src/game/application/gameSessionView.ts`, `src/game/gameplay/rpg/ruleEngine/advanceBattle.ts`
- Test: `src/components/AdventureGameShell.test.tsx`, `src/game/application/combatView.test.ts`, focused battle/gameplay tests in `src/game/gameplay/rpg/ruleEngine/`
- Evidence: battle screenshots and a short action-by-action battle log in `docs/真机测试/2026-08-13-中篇完整流程记录.md`

**Interfaces:**
- Produces a battle surface where player units render on the left and enemy units on the right, with an explicit turn/active-unit indicator and controls bound to server tokens.
- Produces readable visual feedback for attack movement, hit/defeat, floating damage/heal/status numbers, skill energy, defend state, retreat, victory, and defeat without changing the rule resolver.

- [ ] **Step 1: Reproduce and document the current battle surface**

Start or continue a battle, capture the first active state, one player attack, one skill, one defend action, one enemy response, and the resolved state. Record whether the action target is clear, whether the current actor is clear, and whether any animation or text is missing/overlapping.

- [ ] **Step 2: Add explicit battle layout and state hierarchy**

Keep the battlefield center readable; place the player formation in the left combat zone and enemies in the right combat zone. Give each unit a compact name/HP/energy/status strip, highlight the active actor and selected target, and show the turn queue or “轮到谁” label without exposing internal IDs.

- [ ] **Step 3: Add rule-result-driven feedback layers**

Render the existing `lastAdvance.sequence` as transient events: attacker moves toward the target and returns, target flashes or shakes on hit, damage/heal/status text rises from the affected unit’s head, defeated units leave the formation, and the result banner names victory/retreat/defeat. Use CSS classes/data attributes driven by the read model, not HP-difference inference in the component.

- [ ] **Step 4: Make all combat controls feel like game actions**

Present attack, skill, defend, and retreat as a contextual combat command bar with costs/disabled reasons; remove form-like submit affordances; keep the active-turn state obvious; prevent duplicate clicks while a request is pending; and preserve reduced-motion behavior with instant but readable result states.

- [ ] **Step 5: Add focused tests and run them**

Assert the left/right unit ordering, active-unit marker, control labels, target binding, reduced-motion class/behavior, and sequence-to-feedback mapping. Run the component and combat application tests before continuing the browser journey.

- [ ] **Step 6: Re-run the exact battle in Chrome**

Use the new UI to complete a battle, capture before/during/after screenshots, verify the numbers and winner match the visible rule outcome, and continue the medium story from the post-battle objective.

---

### Task 5: Repair form-like UI, dialogue quality, and responsive interaction defects

**Files:**
- Inspect/modify: `src/components/NewGameSetupForm.tsx`, `src/components/CurrentGameScreen.tsx`, `src/components/LocationSceneScreen.tsx`, `src/components/TownLayerScreen.tsx`, `src/components/AdventureDetailsPanel.tsx`, `src/components/GenerationStatusModal.tsx`, `src/app/globals.css`
- Test: adjacent component tests under `src/components/`
- Evidence: desktop and narrow viewport screenshots in `artifacts/playtest/2026-08-13/`

**Interfaces:**
- Produces game-native setup, dialogue, inventory, map, and generation feedback surfaces with clear primary actions, no fake buttons, no accidental modal interruption, and no obstruction of the playable scene.

- [ ] **Step 1: Classify each UI finding**

For every finding in the record, mark it as `阻断`, `高`, `中`, or `低`, identify whether it belongs to copy, state synchronization, layout, accessibility, motion, or game presentation, and keep a before screenshot.

- [ ] **Step 2: Replace the highest-impact form pattern**

Convert the first user-visible form-like surface that does not belong in a game into a themed card/choice/scene treatment while preserving labeled inputs, keyboard access, validation, and the existing application request contract. Do not add a second route or duplicate state model.

- [ ] **Step 3: Fix dialogue and choice coherence**

Ensure every focus NPC scene has exactly two distinct fixed options plus the custom input affordance; direct NPC speech answers the current player utterance; non-focus NPCs stay read-only; old dialogue closes on submission; and the next objective is visible without auto-opening the new NPC.

- [ ] **Step 4: Fix responsive and reduced-motion behavior**

Check the same states at the normal Chrome viewport and a narrow mobile-like viewport. Fix clipped controls, bottom HUD obstruction, unreadable text, horizontal overflow, and overlay stacking. Add/adjust `prefers-reduced-motion` rules so state changes remain understandable without movement.

- [ ] **Step 5: Add or update component tests**

Cover primary action labels, no-op/unavailable states, focus management/labels, exact choice count, custom input behavior, inventory details, modal retry behavior, narrow layout class contracts, and reduced-motion-safe markup.

- [ ] **Step 6: Re-run the relevant browser checkpoints**

Restart at a fresh medium game when a state-dependent fix changes the opening; otherwise resume from the current save. Verify each fixed issue in Chrome and attach after screenshots to the record.

---

### Task 6: Finish the medium ending, reload checkpoints, and write the final report

**Files:**
- Modify: `docs/真机测试/2026-08-13-中篇完整流程记录.md`
- Modify when facts changed: `docs/策划文档/AI生成RPG_MVP.md`, `docs/agent/地图与地点冒险.md`, `docs/agent/战斗与结局.md`, `docs/agent/NPC对话驱动叙事场景触发.md`, `docs/agent/当前开发阶段.md`, `docs/Agent文档索引.md`
- Test: `npm run test:components`, `npm run test:game-application`, `npm run test:game-gameplay`, `npm test`, `npm run build`, `npm run phase:status`

**Interfaces:**
- Produces a completed medium-game record with a causal story trace, module coverage matrix, severity-ranked findings, implemented fixes, residual recommendations, screenshots, and final acceptance results.

- [ ] **Step 1: Verify reload persistence**

Reload after the opening, after an NPC choice, after item pickup, after a battle, and before the ending. Confirm the authoritative objective, inventory, location, relationship-visible feedback, battle/ending state, and pending generation recovery remain coherent.

- [ ] **Step 2: Complete and inspect the ending**

Reach the structured ending through the tested medium route. Record the ending name/description, the accumulated relationship/quest/battle causes visible to the player, whether the ending feels earned, and whether post-ending actions are correctly disabled or rejected without UI pretending to continue.

- [ ] **Step 3: Update player-facing and implementation docs**

Write the full causal flow in Chinese prose, not just action IDs. Add concrete repair suggestions for any non-blocking residual issue. Update only docs whose gameplay or implementation facts changed, and keep the test record as the single chronological evidence document.

- [ ] **Step 4: Run the final gates**

Run the commands listed in this task, record pass/fail and any environment-only exceptions, then verify `git diff --check`, `git status --short`, and that no secret/env file is staged.

- [ ] **Step 5: Commit the completed work**

```text
git add docs src
git diff --cached --check
git commit -m "fix: complete medium RPG browser playtest remediation"
```

---

## Self-Review

### Requirement coverage

- [x] New medium game and complete ending are first-class steps.
- [x] Browser issues are fixed in place and the flow resumes with Chrome regression checkpoints.
- [x] Dialogue, choices, custom input/casual chat, items, inventory, exploration, investigation, travel, battle, reload, act handoff, and ending are explicitly covered.
- [x] Battle layout and missing attack/hit/floating-number/turn feedback are concrete implementation requirements.
- [x] Form-like UI, game-native hierarchy, responsiveness, reduced motion, and playfield protection are covered.
- [x] The causal Chinese story record and residual repair recommendations are required deliverables.

### Placeholder scan

- [x] Every task names concrete files, concrete commands, and observable evidence; no `TBD`, `TODO`, or “implement later” steps are used.

### Type and workflow consistency

- [x] Browser action tokens remain opaque and all rule changes stay behind application/API.
- [x] Battle visuals consume `BattleView`/`lastAdvance.sequence`; UI does not infer outcomes from HP deltas.
- [x] Documentation updates are limited to gameplay/implementation facts that the test actually proves.

