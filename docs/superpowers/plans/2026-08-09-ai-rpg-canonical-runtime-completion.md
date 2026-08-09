# AI RPG 单一运行链与完整可玩闭环实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前并行的旧链/新链破坏性收敛为一个无版本后缀的生产运行时，并证明“两个 NPC 固定对话选择 + 一个自定义输入”能够连续改变结构化世界、推动至少 15 个回合并抵达不同结局。

**Architecture:** 保留 `WorldState + StoryState + TurnResolution + PendingNarrativeJob` 双状态回合模型，删除旧 `GameState` application/API 生产链和所有 V1/V2/V2.1 兼容入口。SceneSource 只提出结构化场景包，服务器审批并铸造 opaque token，把场景和 `ApprovedChoice` registry 同一次 CAS 写回；固定选择与自由文本只通过一个 `performTurn` 和一个 `/api/game/actions` 入口。UI 直接消费唯一 `GameSessionView`，不得构造业务 token、解析 actionKey 或通过版本适配器回退旧视图。

**Tech Stack:** TypeScript 5.8, Next.js 16, React 19, libsql/SQLite, Vitest

**Upstream:**

- `docs/superpowers/specs/2026-08-08-ai-rpg-v2-foundation-remediation-spec.md`
- `docs/superpowers/plans/2026-08-08-ai-rpg-v2-foundation-remediation.md`
- `.superpowers/sdd/2026-08-08-ai-rpg-v2-foundation-remediation/version-inventory.md`

## Global Constraints

- 只修改 `ai-rpg-game`；不修改、删除、移动或重建 `.foundation` 与 `../ai-game-foundation`。
- 允许破坏性重建本地游戏存档和 HTTP 契约；不提供旧路由、旧存档或旧类型兼容层。
- 最终生产源码的文件名、导出类型、函数、接口、路由和日志事件不得含 `V1`、`V2`、`V2.1`、`v1`、`v2`、`v2.1` 版本后缀。
- `schemaVersion`、`recordVersion`、provider `/v1` URL、第三方协议版本和历史 fixture/Spec/Plan 属于版本事实，不按接口版本化删除。
- `GameRecord.revision` 是唯一 CAS 屏障；一次玩家回合只允许一次规则 StateCommit，scene write-back 是独立的 narrative CAS。
- AI/fixture 只能生成 proposal；规则层独占 Action 校验、状态变化、任务、关系、知识、预算、候选事件激活和结局。
- 客户端只能提交服务端铸造的 opaque `choiceToken` 或 `free_text`；不得看到/构造 `actionKey`、Action、choice registry、候选事件内部 effect 或隐藏事实。
- 每个可交谈的焦点 NPC 场景必须显示两个语义不同的固定对话选择，并允许一个自定义输入入口。
- 每个成功固定选择和自定义输入都形成不同的 `actionId`、一个 `TurnResolution`、一个 `PendingNarrativeJob` 和一次规则 CAS；玩家原文不进入长期记忆或日志。
- 日常验收零网络、零计费；AI 失败必须走同一审批链的确定性 fallback。
- 删除旧代码后，`tsconfig.json` 必须覆盖所有剩余源码与测试，不允许以 exclusion 隔离生产类型错误。

---

## Target File Structure

```text
src/app/api/game/
  route.ts
  current/route.ts
  actions/route.ts
  narrative/ensure/route.ts
  prologue/ack/route.ts
  dev/current/route.ts

src/game/application/
  createGame.ts
  performTurn.ts
  generatePendingScene.ts
  gameSessionView.ts
  requestParser.ts
  sceneSource.ts
  approveAndWriteScene.ts
  buildChoiceMap.ts
  server/
    compositionRoot.ts
    persistence/gameRepository.ts
    persistence/sqliteGameRepository.ts
    ai/sourceFactory.ts
    ai/worldGenerationSource.ts
    ai/liveSceneSource.ts
    ai/liveExpansionSource.ts
    ai/liveIntentParserSource.ts
  testing/foundationJourney.*
  testing/storyDivergenceJourney.test.ts

src/components/
  CurrentGameScreen.tsx
  AdventureGameShell.tsx
  gameActionRequest.ts
```

There must be no `src/app/api/v2/`, `*V2*`, `index.v1.ts`, `viewAdapterV2.ts`, `performActionV2.ts`, `handleNpcDialogueV2.ts`, or `tsconfig.v1-legacy.json` at completion.

---

### Task 1: Close the scene proposal → ApprovedChoice → persisted token loop

**Files:**

- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/generatePendingSceneV2.ts`
- Modify: `src/game/application/buildChoiceMap.ts`
- Modify: `src/game/application/server/ai/v2SourceFactory.ts`
- Modify: `src/game/application/server/persistence/gameRepositoryV2.ts`
- Test: corresponding domain/application/source/persistence tests

**Interfaces:**

- Consumes: `ChoiceProposal`, `ApprovedChoice`, `SceneGenerationContext.legalActionCandidates`, current record revision.
- Produces: a ready `NarrativeSceneState` whose choices contain only `{ choiceToken, label, hint? }`, plus a persisted `choiceRegistry` valid for the post-writeback revision.

```ts
export type NarrativeChoiceState = {
  readonly choiceToken: string;
  readonly label: string;
  readonly hint?: string;
};

export type ScenePackageProposal = {
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly npcLine: NarrativeNpcLineState | null;
  readonly event: NarrativeEventState;
  readonly choiceProposals: readonly [ChoiceProposal, ChoiceProposal];
  readonly eventProposals: readonly EventProposal[];
  readonly source: "generated" | "fallback";
};

export type ApprovedSceneWriteBack = {
  readonly scene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly candidateEventPool: readonly EventCandidate[];
};
```

- [ ] **Step 1: Write failing token lifecycle tests**

Add tests proving a generated and fallback scene each has exactly two proposals; approval returns two distinct opaque tokens; scene JSON contains no `actionKey`; registry actions match the proposals; `basedOnRevision === loaded.revision + 1`; tampered, stale and repeated tokens cause zero writes.

```ts
expect(JSON.stringify(writeBack.scene)).not.toContain("actionKey");
expect(writeBack.choiceRegistry).toHaveLength(2);
expect(new Set(writeBack.choiceRegistry.map((x) => x.choiceToken)).size).toBe(2);
expect(writeBack.choiceRegistry.every((x) => x.basedOnRevision === 8)).toBe(true);
```

- [ ] **Step 2: Run the focused tests and confirm they fail for the current unregistered scene tokens**

Run:

```text
npm run test:game-domain -- src/game/domain/narrative.test.ts
npm run test:game-application -- src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingSceneV2.test.ts src/game/application/buildChoiceMap.test.ts
```

Expected: FAIL because source scenes still persist `actionKey` and `generatePendingSceneV2` never writes the approved registry.

- [ ] **Step 3: Make SceneSource return proposals, never ready state**

Deterministic dialogue fallback must propose two different `TalkAction`s for the focus NPC (for example `ask` and `support`/`challenge` selected by current relationship); non-dialogue fallback must choose two distinct actions from `legalActionCandidates`. Live AI output must select from server-provided candidate IDs and must not emit an arbitrary `actionKey` string.

- [ ] **Step 4: Approve and atomically write scene + registry + candidate pool**

`approveScenePackage` must rebuild the ready scene and every `ApprovedChoice` field-by-field. `generatePendingSceneV2` must use the approved fallback result when the generated proposal fails and pass this object to one `applySceneWriteBack` call.

- [ ] **Step 5: Rebuild the choice map only from current legal actions and current registry**

Always pass the current record revision to `buildChoiceMap`. Remove semantic scene-token parsing and ensure expired registry entries never resolve.

- [ ] **Step 6: Verify and commit**

Run:

```text
npm run test:game-domain
npm run test:game-gameplay -- src/game/gameplay/rpg/choices
npm run test:game-application -- src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingSceneV2.test.ts src/game/application/buildChoiceMap.test.ts
npm run typecheck
```

Commit: `fix(scene): persist approved opaque choices with each scene`

---

### Task 2: Unify fixed choices and NPC custom input on one action endpoint

**Files:**

- Modify: `src/components/AdventureGameShellV2.tsx`
- Modify: `src/components/gameActionRequestV2.ts`
- Modify: `src/app/api/v2/game/actions/route.ts`
- Modify: `src/game/application/server/compositionRootV2.ts`
- Modify: `src/game/application/performTurn.ts`
- Delete after callers move: `src/app/api/v2/game/npc/dialogue/route.ts`
- Delete after callers move: `src/game/application/handleNpcDialogueV2.ts`
- Test: action request, route, shell and `performTurn` tests

**Interfaces:**

- Consumes: `Interaction = fixed_choice | free_text` and browser UUID action IDs.
- Produces: one action response contract for both input kinds.

```ts
export type ActionRequest = {
  readonly actionId: string;
  readonly interaction:
    | { readonly kind: "fixed_choice"; readonly choiceToken: string }
    | { readonly kind: "free_text"; readonly text: string; readonly targetNpcId: string };
  readonly expectedRevision: number;
};
```

- [ ] **Step 1: Write failing repeated-custom-input tests**

Submit two different custom inputs to the same NPC on consecutive ready scenes. Assert different action IDs/turn IDs, two memory entries, two turn increments, two pending jobs and no duplicate suppression.

```ts
expect(history.map((x) => x.actionId)).toEqual(["uuid-1", "uuid-2"]);
expect(new Set(history.map((x) => x.actionId)).size).toBe(2);
```

- [ ] **Step 2: Write one-route browser/API tests**

Assert `NpcDialoguePanel` custom input calls the same `/api/v2/game/actions` request helper as fixed choices with `kind: "free_text"`; the standalone dialogue endpoint is never fetched. Validate UUID, text bounds, required target NPC, revision and unknown-field rejection.

- [ ] **Step 3: Remove the deterministic `input_${npcId}` action ID path**

The browser creates one UUID per submission. Composition root calls `performTurn` directly and returns the current view for either interaction. Remove `handleNpcDialogueV2` and its route instead of retaining an alias.

- [ ] **Step 4: Preserve the product interaction**

Each focused NPC panel renders exactly two fixed choice buttons from the current scene and one custom text input. A short greeting is still a real recorded turn; it may use deterministic fallback expression, but it cannot bypass CAS or return before the pending narrative job exists.

- [ ] **Step 5: Verify and commit**

Run:

```text
npm run test:game-application -- src/game/application/performTurn.test.ts
npm run test:components -- src/components/gameActionRequestV2.test.ts src/components/AdventureGameShellV2.test.tsx src/components/NpcDialoguePanel.test.tsx
npm run test:app
npm run typecheck
```

Commit: `refactor(input): route every player choice through performTurn`

---

### Task 3: Rename the retained runtime and replace the HTTP/storage contract destructively

**Files:**

- Rename retained `*V2*` application/server/persistence/AI files to the neutral target structure above
- Replace: `src/app/api/game/**` with the retained current six-route implementation
- Delete: `src/app/api/v2/**`
- Delete: `src/game/application/performActionV2.ts`
- Modify: `package.json`, imports, logs and adjacent tests

**Interfaces:**

- Consumes: Tasks 1–2 behavior-complete current pipeline.
- Produces: `GameRepository`, `GameRecord`, `createGame`, `generatePendingScene`, `GameSessionView`, `ServerGameEntryPoints`, `getServerGameEntryPoints`, and only `/api/game/**`.

```ts
export interface GameRepository {
  createInitialGame(input: CreateInitialGameInput): Promise<CreateInitialGameResult>;
  getCurrentGame(): Promise<GetCurrentGameResult>;
  applyState(input: ApplyStateInput): Promise<ApplyStateResult>;
  applySceneWriteBack(input: ApplySceneWriteBackInput): Promise<ApplyStateResult>;
  clearCurrentGame(): Promise<ClearCurrentGameResult>;
}
```

- [ ] **Step 1: Lock the neutral public contract with failing import/route tests**

Tests must import only neutral names and assert the final route set is exactly create/current/actions/ensure/prologue/dev-clear. No redirect or compatibility endpoint is accepted.

- [ ] **Step 2: Rename current ports, sources, world-generation gameplay directory and composition root**

Required moves include `scenarioV2 → worldGeneration`, `v2SourceFactory → sourceFactory`, current live source files to neutral names, current repository/SQLite adapter to neutral names and `compositionRootV2 → compositionRoot`. Delete `performActionV2`; callers invoke `performTurn`.

- [ ] **Step 3: Replace the route tree atomically**

Delete the former old `/api/game/**` handlers, then place the retained current routes at the six neutral paths. Delete `/api/v2/**`. Update browser fetch paths and request logging source to `rpg.http.*`.

- [ ] **Step 4: Reset storage table names without migration**

Use only `game_records` and `current_game`. Do not read/copy `game_records_v2`, old `games`, or old pointers. Keep a neutral `UNSUPPORTED_RECORD`/`VERSION_MISMATCH` corruption classification and current record schema validation. Development clear deletes only the neutral current slot/records.

- [ ] **Step 5: Rename journey commands**

Use `test:foundation-journey` and `journey:foundation`; rename the script and test files. Remove the versioned command names.

- [ ] **Step 6: Verify and commit**

Run:

```text
npm run test:app
npm run test:game-application
npm run test:boundaries
npm run typecheck
```

Commit: `refactor(runtime): collapse production onto one neutral contract`

---

### Task 4: Replace the version adapter with one complete server read model

**Files:**

- Replace: `src/game/application/gameSessionView.ts`
- Replace/rename: `src/components/CurrentGameScreen.tsx`
- Replace/rename: `src/components/AdventureGameShell.tsx`
- Replace/rename: `src/components/gameActionRequest.ts`
- Modify: retained map/location/dialogue/battle/detail components as required by the canonical view
- Delete: `src/components/viewAdapterV2.ts`
- Delete: `src/components/NewGameSetupFormV2.tsx`
- Modify: `src/components/NewGameSetupForm.tsx`
- Test: canonical projector and component tests

**Interfaces:**

- Consumes: `WorldState`, `StoryState`, current revision, approved opaque tokens.
- Produces: one `GameSessionView`; visual components do not import domain/gameplay.

```ts
export type PlayerChoiceView = {
  readonly choiceToken: string;
  readonly label: string;
  readonly hint?: string;
  readonly presentation: "dialogue" | "travel" | "explore" | "item" | "battle" | "rest";
};

export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly speechPages: readonly string[];
  readonly choices: readonly [PlayerChoiceView, PlayerChoiceView] | readonly [];
  readonly freeInputEnabled: boolean;
};
```

- [ ] **Step 1: Write failing complete-view tests**

Cover map travel tokens, current location actions, obtainable item, battle controls, focused NPC two choices + custom input, quest objectives, pending, reload and ending. Serialize and assert zero `actionKey`, registry, candidate effects, hidden facts and full states.

- [ ] **Step 2: Move projection into the canonical read model**

Do not cast `as unknown as GameSessionView`. The application projector must provide every field visual components consume. All actionable buttons submit a provided opaque token; no component builds `move:*`, `take_item:*`, `attack:*`, `explore` or any other semantic token.

- [ ] **Step 3: Collapse the new-game form contract**

Keep one callback and fixed `/api/game` endpoint. Remove `onCreatedV2`, `apiPath` and response branching by path.

- [ ] **Step 4: Add UI interaction tests**

Render a dialogue scene, click both fixed buttons in separate runs, submit one custom input, and assert exact opaque tokens/free-text request. Render travel/item/battle choices and assert those buttons also forward opaque server tokens.

- [ ] **Step 5: Verify and commit**

Run:

```text
npm run test:game-application -- src/game/application/gameSessionView.test.ts
npm run test:components
npm run typecheck
```

Commit: `refactor(ui): consume one canonical game session view`

---

### Task 5: Delete the legacy executable chain and remove typecheck quarantine

**Files:**

- Delete: `src/game/application/index.v1.ts`
- Delete: old application use cases/server AI/persistence/tests listed by the version inventory once import closure is empty
- Delete: old duplicate root UI/tests and town demo executable chain if no canonical consumer remains
- Delete: `tsconfig.v1-legacy.json`
- Simplify: `tsconfig.json`
- Rewrite: `src/game/application/index.ts`, `src/game/domain/index.ts`, `src/dependencyBoundaries.test.ts`, `vitest.config.ts`, `package.json`

**Interfaces:**

- Consumes: Tasks 3–4 neutral runtime.
- Produces: exactly one application facade, repository, composition root, API tree and UI root; all retained files are under normal typecheck/build/test discovery.

- [ ] **Step 1: Add failing one-chain architecture assertions**

Assert no second repository/root/route/request/view exists and no typecheck exclusion mentions application/API/component production files.

```ts
expect(findProductionMatches(/(?:V1|V2|v2\.1|\/api\/v[12]\//)).filter(notAllowlisted)).toEqual([]);
```

- [ ] **Step 2: Delete by import closure, not by directory age**

Remove old application/API/server/test files from the inventory only after `rg` proves no neutral runtime importer. Retain useful version-neutral domain types and visual components still consumed by the canonical runtime; delete only genuinely unused old `GameState`/scenario/town/narrative modules after the same closure proof.

- [ ] **Step 3: Remove exclusions and legacy commands**

`tsconfig.json` must return to a normal `node_modules`-only exclusion (plus generated/tooling necessities, never source debt). Remove retired phase10/phase11/story-eval/town commands only when their executable chain is deleted. Historical fixture data remains untouched.

- [ ] **Step 4: Rewrite boundary guards for one chain**

UI/API import application facade only; application imports gameplay facades; gameplay imports domain; only the one server composition root imports SQLite/AI/environment; only `sqliteClient.ts` imports libsql.

- [ ] **Step 5: Run closure scans and commit**

Run:

```text
rg -n 'index\.v1|performActionV2|handleNpcDialogueV2|viewAdapterV2|compositionRootV2|GameRepositoryV2|scenarioV2' src scripts package.json tsconfig*.json
rg -n 'V1|V2|v2\.1|/api/v[12]/' src scripts package.json tsconfig*.json
npm run typecheck
npm run test:boundaries
```

Expected: both scans have zero non-allowlisted results.

Commit: `refactor(architecture): delete legacy runtime and version quarantine`

---

### Task 6: Make new games structurally different and prove a real 15-turn multi-ending journey

**Files:**

- Modify: `src/game/domain/worldGenerationCandidate.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/gameplay/rpg/worldGeneration/**`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveEnding.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: deterministic/live world and scene sources
- Replace: `src/game/application/testing/foundationJourney.*`
- Replace: `src/game/application/testing/storyDivergenceJourney.test.ts`
- Test: world source, validator, compiler, rule engine, application journey

**Interfaces:**

- Consumes: player seed/game type/game length and structured dialogue outcomes.
- Produces: seed-dependent validated worlds, mutually distinguishable ending requirements and a journey that actually executes at least 15 successful turns and reaches an ending.

```ts
export type EndingRequirement =
  | { readonly kind: "quest_completed"; readonly questId: QuestId }
  | { readonly kind: "quest_failed"; readonly questId: QuestId }
  | { readonly kind: "fact_discovered"; readonly factId: FactId }
  | { readonly kind: "npc_affinity_at_least"; readonly npcId: NpcId; readonly value: number }
  | { readonly kind: "npc_affinity_at_most"; readonly npcId: NpcId; readonly value: number };
```

- [ ] **Step 1: Write failing seed-diversity tests**

For the same genre/length, two different seeds must produce different validated structural signatures (at least two of NPC identity, quest graph, facts, locations or ending predicates), while repeating the same seed produces byte-equivalent compiled state.

- [ ] **Step 2: Write a genuine 15-turn journey before implementation**

The journey must count 15 successful `performTurn` calls, advance/restore pending scenes, reload at least three times, consume server-issued tokens, include fixed NPC choices and custom input, unlock/move, obtain or investigate, activate a candidate event, battle or comparable climax, and finish with `ending_reached`. It must fail if it executes fewer than 15 turns or has `ending === null`.

```ts
expect(successfulTurns).toBeGreaterThanOrEqual(15);
expect(record.storyState.turnNumber).toBe(successfulTurns);
expect(record.worldState.ending).not.toBeNull();
expect(record.worldState.eventLedger.some((e) => e.type === "ending_reached")).toBe(true);
```

- [ ] **Step 3: Write A/B full-journey tests**

Use the same seed. Branch A repeatedly supports/reassures the key NPC; Branch B challenges/threatens/refuses. Both branches must remain completable, differ in relationship/memory plus at least one fact/thread/quest/candidate event, and end at different ending IDs. Run each branch twice and assert deterministic rule/event replay.

- [ ] **Step 4: Implement reachable branch predicates and fallback variety**

Extend candidate parsing/validation/compilation and ending resolution for closed relationship predicates. Ensure the default/fallback world has enough quest/location/item/enemy/fact structure for a real complete route and two non-overlapping endings. Seed must choose content variants without using global randomness.

- [ ] **Step 5: Verify and commit**

Run:

```text
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application -- src/game/application/testing/foundationJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
npm run test:foundation-journey
npm run journey:foundation
```

Commit: `test(story): prove fifteen-turn choice-driven multi-ending play`

---

### Task 7: Update current documentation and run complete acceptance

**Files:**

- Modify: `docs/Agent文档索引.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`
- Modify: relevant `docs/agent/*.md`
- Modify: `docs/游戏开发规范.md` only for actual final path/guard facts
- Modify: `docs/策划文档/` for player-visible two-choice + custom-input and branching-ending rules

- [ ] **Step 1: Replace current versioned implementation facts**

Current docs must describe one neutral production chain and one API tree. Dated Specs/Plans remain historical and may retain version terms; navigation must mark them superseded for implementation naming.

- [ ] **Step 2: Record destructive reset and capability limits**

State that existing local development saves are discarded. Do not claim unlimited long games; short/medium support and segmented-ledger gate remain explicit.

- [ ] **Step 3: Run all static, behavioral and build gates**

```text
npm run check:standards
npm run typecheck
npm run lint
npm run test:boundaries
npm run test:fast
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
npm test
npm run test:foundation-journey
npm run journey:foundation
npm run build
npm run phase:status
```

- [ ] **Step 4: Run final zero-version and zero-leak scans**

Allow only external provider protocol URLs, schema/record fields, dependency versions, immutable fixture/contract values and dated historical docs.

- [ ] **Step 5: Commit**

Commit: `docs: close canonical choice-driven RPG runtime`

---

## Self-Review

### Requirement coverage

- [x] Scene tokens become persisted ApprovedChoice entries and are executable.
- [x] Two NPC fixed choices and one custom input share one `performTurn`/API path.
- [x] Repeated custom input receives unique action/turn IDs and is not deduplicated incorrectly.
- [x] One neutral API, composition root, repository, read model and UI root replace all V1/V2/V2.1 surfaces.
- [x] Old executable chain and typecheck quarantine are deleted, not aliased.
- [x] UI never fabricates semantic tokens or parses actionKey.
- [x] Different seeds produce structurally different games; same seed remains replayable.
- [x] The journey actually has 15+ successful turns, candidate/event/world progression and an ending.
- [x] Same-seed player choices lead to different structured state and different ending IDs.

### Placeholder scan

- [x] No TBD/TODO/“similar to previous task” implementation placeholder.
- [x] Every task identifies exact current/target files, interfaces, failure tests, commands and commit checkpoint.
- [x] Historical/version allowlists are explicit; broad scan suppression is forbidden.

### Completion rule

The work is complete only when Tasks 1–7 and every final command pass on the neutral runtime. Passing the old 229-file suite before deletion is baseline evidence only; it is not acceptance because the old suite currently masks production gaps and excluded type debt.

### Post-review remediation (added after final independent review)

Before declaring the runtime fully usable, close these production gaps:

1. Make the deterministic fallback honor `short`/`medium` act budgets with a reachable ending for both lengths.
2. Bind custom NPC input to the authoritative focused NPC before intent classification; reject missing/non-focused targets.
3. Make the ending-screen “restart” create a fresh game/seed through the canonical API, including production behavior.
4. Make fallback world generation honor `gameType` and provide stronger seed-dependent compiled story variation, with deterministic replay tests.
