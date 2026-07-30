# Phase 10 Dual-Mode Full Journey Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task when that skill is available.

**Goal:** Build an extensible full-story certification runner that reaches a successful ending within budgets, covers narrative choices/NPC/location/item/battle, records real parsed AI outputs, and replays them offline through the same approvals and rules.

**Architecture:** A framework-agnostic application journey runner drives existing use cases through a small harness port and produces a strict `JourneyReport`. Three recording/replay source decorators sit at the runtime AI port boundary. A Node CLI assembles either live-record or offline-replay dependencies; both modes reuse one coverage policy and validator. Golden fixtures are immutable by default and remain untrusted inputs to the existing approval chain.

**Tech Stack:** TypeScript 5.8, Vitest 3, Node.js 20+, existing `@ai-game/ai-transport`, libSQL/SQLite, JSON/JSONL fixtures.

**Global Constraints:**

- AI never mutates attributes, rewards, combat, quests, inventory, map access, blueprint entities, or endings.
- “New” entities in Phase 10 mean existing blueprint entities making their first runtime appearance.
- Replay must perform zero fetches and may not bypass director/writer/NPC approval.
- Live mode requires explicit opt-in and writes only to `artifacts/` by default.
- Logs and fixtures exclude prompt text, raw model output, secrets, URLs, hidden world state, and `actionKey` exposed to clients.
- Do not add the real AI command to `npm test`, `test:fast`, `build`, or CI.

---

### Task 1: Freeze journey contracts and coverage policy

**Files:**

- Create: `src/game/application/testing/runtimeNarrativeJourney.ts`
- Test: `src/game/application/testing/runtimeNarrativeJourney.test.ts`
- Modify: `src/game/application/index.ts`

**Step 1: Write failing contract tests**

Cover:

- report validation rejects missing successful ending, dialogue, first appearances, item, battle, reload consistency, and budget compliance one at a time;
- coverage policy only returns action keys present in current `AvailableAction[]`;
- runner fails with stable codes on `maxTurns` or `maxAiCalls`;
- serialized public report contains no action keys, prompt content, hidden facts, or source error text.

**Step 2: Run the focused test and confirm failure**

Run: `npx vitest run src/game/application/testing/runtimeNarrativeJourney.test.ts`

Expected: FAIL because the module does not exist.

**Step 3: Implement minimal contracts**

Add:

- `JourneyMode = "record" | "replay"`;
- versioned `JourneyCoverage`, `JourneyBudgets`, `JourneyReport`;
- `JourneyHarness` port for create/load/choose/perform-rule-action/audit;
- deterministic coverage queue: dialogue → location first visit → NPC first appearance → item → battle → successful ending;
- `validateJourneyReport()` returning stable issue codes only;
- a runner loop with explicit turn and AI-call counters.

The coverage queue can request only currently legal actions. It cannot decide combat results or write state.

**Step 4: Run focused tests**

Run: `npx vitest run src/game/application/testing/runtimeNarrativeJourney.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/game/application/testing src/game/application/index.ts
git commit -m "test: define runtime narrative journey contract"
```

### Task 2: Add safe request fingerprints and recording envelopes

**Files:**

- Create: `src/game/application/server/ai/runtimeNarrativeRecording.ts`
- Test: `src/game/application/server/ai/runtimeNarrativeRecording.test.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts`

**Step 1: Write failing recorder tests**

Assert:

- director/writer/NPC calls receive monotonic sequence and role-local attempt numbers;
- fingerprint is stable across object key order and changes when allowed context changes;
- recorded proposal is the parsed typed value, not raw provider text;
- fixture serialization has a strict field allowlist;
- API key, base URL, prompts, raw response, hidden facts outside the role projection, and exception messages never appear;
- recording is disabled unless an explicit artifact directory is supplied.

**Step 2: Run and confirm failure**

Run: `npx vitest run src/game/application/server/ai/runtimeNarrativeRecording.test.ts`

Expected: FAIL because recording adapters are absent.

**Step 3: Implement recorder**

Implement:

- canonical JSON projection and SHA-256 fingerprint;
- `RuntimeNarrativeRecordedCallV1`;
- decorators for the three existing source ports;
- an injected append-only sink;
- an in-memory sink for tests and JSONL artifact sink for the CLI;
- source factory option that wraps live sources only when record mode is explicitly assembled.

Do not write to `data/fixtures/` from production assembly.

**Step 4: Run focused tests**

Run: `npx vitest run src/game/application/server/ai/runtimeNarrativeRecording.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/game/application/server/ai
git commit -m "test: record safe runtime narrative calls"
```

### Task 3: Implement strict replay sources

**Files:**

- Create: `src/game/application/server/ai/runtimeNarrativeReplaySource.ts`
- Test: `src/game/application/server/ai/runtimeNarrativeReplaySource.test.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts`

**Step 1: Write failing replay tests**

Cover:

- one source instance serves director/writer/NPC entries in global sequence;
- role, attempt, contract version, and fingerprint must match;
- missing/extra/out-of-order calls fail with stable fixture errors;
- replay performs zero fetch calls;
- malformed proposals reach the normal approval layer and are rejected;
- replay completion asserts every fixture call was consumed exactly once.

**Step 2: Run and confirm failure**

Run: `npx vitest run src/game/application/server/ai/runtimeNarrativeReplaySource.test.ts`

Expected: FAIL because replay source is absent.

**Step 3: Implement replay**

Parse JSONL into validated envelopes, implement the existing three source interfaces, expose `assertComplete()`, and keep fixture errors separate from recoverable provider failures so the orchestrator cannot silently hide fixture drift behind scene fallback.

**Step 4: Run focused tests**

Run: `npx vitest run src/game/application/server/ai/runtimeNarrativeReplaySource.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/game/application/server/ai
git commit -m "test: replay recorded narrative calls offline"
```

### Task 4: Make coverage guidance explicit and rule-bounded

**Files:**

- Modify: `src/game/application/ports/runtimeNarrative.ts`
- Modify: `src/game/application/buildNarrativeContexts.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeLiveSources.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`
- Test: `src/game/application/server/ai/runtimeNarrativeLiveSources.test.ts`

**Step 1: Write failing tests**

Assert:

- optional `coverageTargetActionKey` is accepted only if it is among the current legal candidate keys;
- director prompt receives the target as a non-authoritative preference and is still required to output exactly two legal keys;
- production calls with no target are byte-for-byte behavior-compatible;
- an invalid target is discarded before any source call;
- director approval rejects invented or currently illegal target actions.

**Step 2: Run and confirm failure**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/runtimeNarrativeLiveSources.test.ts`

Expected: FAIL on missing coverage guidance.

**Step 3: Implement minimal guidance**

Thread the optional target through the server-only orchestration request and director minimal context. Do not expose it in safe views or persist it as game state. Describe it to the model as a preferred choice candidate, never as permission to alter rules or results.

**Step 4: Run focused tests**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/runtimeNarrativeLiveSources.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/game/application
git commit -m "test: guide live journey through legal coverage targets"
```

### Task 5: Build the pinned full journey and first golden fixture

**Files:**

- Create: `src/game/application/testing/phase10JourneyHarness.ts`
- Create: `src/game/application/testing/phase10FullJourney.test.ts`
- Create: `data/fixtures/phase10-journey/v1/manifest.json`
- Create: `data/fixtures/phase10-journey/v1/calls.jsonl`
- Create: `data/fixtures/phase10-journey/v1/expected-summary.json`

**Step 1: Write the failing offline journey**

Use one pinned Phase 1 blueprint with known legal paths. The test must:

- create a game using the pinned blueprint;
- generate the opening scene through replay sources;
- choose only returned `choiceToken` values for narrative progression;
- reload after each accepted choice;
- cover first visit of an initially unvisited location;
- cover first interaction with an initially unused NPC and require a non-empty approved NPC line;
- obtain or consume an item through existing rule actions;
- start and resolve a battle through existing battle rules;
- complete the main quest and reach the success ending;
- assert calls are exhausted and `fetch` count is zero;
- finish within declared content, turn, and AI-call budgets.

**Step 2: Run and confirm failure**

Run: `npx vitest run src/game/application/testing/phase10FullJourney.test.ts`

Expected: FAIL until the fixture exactly matches the real context fingerprints and journey transitions.

**Step 3: Add the minimal golden fixture**

Seed a versioned fixture with approved typed proposals. Mark its origin honestly as `curated` until a successful real run is explicitly promoted. Never claim curated data came from AI.

**Step 4: Run offline journey**

Run: `npx vitest run src/game/application/testing/phase10FullJourney.test.ts`

Expected: PASS with zero network calls and a successful ending.

**Step 5: Commit**

```bash
git add src/game/application/testing data/fixtures/phase10-journey
git commit -m "test: replay complete phase10 narrative journey"
```

### Task 6: Add the opt-in live record CLI

**Files:**

- Create: `scripts/phase10Journey.mjs`
- Create: `scripts/phase10Journey.node-test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Step 1: Write failing CLI gate tests**

Assert:

- no `RUN_REAL_AI_JOURNEY=1` means non-zero exit, zero env check, zero fetch;
- env check runs before source assembly;
- live output directory must resolve inside `artifacts/phase10-journey/`;
- no fixture under `data/fixtures/` can be overwritten;
- stdout contains only allowlisted counts, stable codes, duration and optional token totals;
- local/provider errors never print messages or configuration values;
- successful live certification rejects fallback for mandatory director/writer stages and requires at least one generated NPC line.

**Step 2: Run and confirm failure**

Run: `node --test scripts/phase10Journey.node-test.mjs`

Expected: FAIL because the CLI is absent.

**Step 3: Implement CLI and package commands**

Add:

```json
"test:phase10-journey": "vitest run src/game/application/testing/phase10FullJourney.test.ts",
"test:phase10-journey-script": "node --test scripts/phase10Journey.node-test.mjs",
"smoke:ai:phase10-journey": "node scripts/phase10Journey.mjs"
```

The live command assembles production-equivalent sources with the recorder, a temporary SQLite database, the same journey runner, and an artifact manifest. It may use the existing 120-second per-attempt timeout and bounded per-role retries.

**Step 4: Run offline gates**

Run: `npm run test:phase10-journey-script`

Expected: PASS without network.

Run: `npm run test:phase10-journey`

Expected: PASS without network.

**Step 5: Commit**

```bash
git add scripts package.json .gitignore
git commit -m "test: add opt-in live narrative journey recorder"
```

### Task 7: Run one real certification and promote only after replay

**Files:**

- Candidate artifact: `artifacts/phase10-journey/<run-id>/`
- Modify after review: `data/fixtures/phase10-journey/v1/*`

**Step 1: Run the real journey**

PowerShell:

```powershell
$env:RUN_REAL_AI_JOURNEY='1'
npm run smoke:ai:phase10-journey
```

Expected: a successful-ending report with dialogue/location/NPC/item/battle coverage and no mandatory fallback. Provider variability may require rerunning, but every run remains within the configured turn and AI-call budgets.

**Step 2: Inspect only the safe artifact**

Validate manifest hashes, call count, role sequence, proposal schemas, and the absence of forbidden fields. Do not inspect or copy secrets from environment files.

**Step 3: Promote the candidate**

Use an explicit promotion command or reviewed `apply_patch` update. Set `origin` to `recorded`; retain the previous golden fixture until the new candidate passes replay.

**Step 4: Replay the promoted fixture**

Run: `npm run test:phase10-journey`

Expected: PASS with zero fetch calls and the exact expected summary.

**Step 5: Commit**

```bash
git add data/fixtures/phase10-journey
git commit -m "test: record verified phase10 AI journey fixture"
```

### Task 8: Update phase facts and run full acceptance

**Files:**

- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/Agent文档索引.md`

**Step 1: Update implementation facts**

Document:

- record/replay source boundary;
- fixture trust model and schemas;
- full journey coverage and commands;
- current entity-expansion boundary;
- live test latency/retry expectations;
- distinction between deterministic offline regression and opt-in live certification.

**Step 2: Run full offline acceptance**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
npm run phase:status
```

Expected: all commands pass; none accesses the network.

**Step 3: Self-review**

Verify:

- every requirement in the design spec has a test;
- no placeholder comments or stub implementations remain;
- replay and record use the same port types;
- all fixture fields are typed and versioned;
- normal production assembly is unchanged when journey options are absent;
- only replay tests are part of normal automation;
- real smoke remains opt-in.

**Step 4: Commit**

```bash
git add docs
git commit -m "docs: document full narrative journey certification"
```

