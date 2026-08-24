# Task 1 Report

## 改动文件

- `src/dependencyBoundaries.test.ts`
- `src/game/application/approveAndWriteScene.test.ts`
- `src/game/application/createGame.ts`
- `src/game/application/createGame.test.ts`
- `src/game/application/deterministicSceneSource.test.ts`
- `src/game/application/focusNpcContext.test.ts`
- `src/game/application/generatePendingScene.test.ts`
- `src/game/application/markNarrativeGenerationFailed.test.ts`
- `src/game/application/performTurn.ts`
- `src/game/application/performTurn.test.ts`
- `src/game/application/retryNarrativeGeneration.test.ts`
- `src/game/application/sceneGenerationContext.test.ts`
- `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.test.ts`
- `src/game/application/server/ai/sourceFactory.test.ts`
- `src/game/application/server/battleScenePrewarm.ts`
- `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- `src/game/application/stateCommit.test.ts`
- `src/game/domain/narrative.test.ts`
- `src/game/domain/pendingNarrativeJob.ts`
- `src/game/domain/pendingNarrativeJob.test.ts`
- `src/game/gameplay/rpg/narrativeExecution/index.ts`
- `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.ts`
- `src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts`

## TDD Red / Green

### Red

Command:

```bash
npm run typecheck
```

Output:

```text
src/game/application/approveAndWriteScene.test.ts ... missing generationKind, sceneRequestKind
src/game/application/deterministicSceneSource.test.ts ... missing generationKind, sceneRequestKind
src/game/application/focusNpcContext.test.ts ... missing generationKind, sceneRequestKind
src/game/application/generatePendingScene.test.ts ... missing generationKind, sceneRequestKind
src/game/application/markNarrativeGenerationFailed.test.ts ... missing generationKind, sceneRequestKind
src/game/application/performTurn.test.ts ... missing generationKind, sceneRequestKind
src/game/application/retryNarrativeGeneration.test.ts ... missing generationKind, sceneRequestKind
src/game/application/sceneGenerationContext.test.ts ... missing generationKind, sceneRequestKind
src/game/application/server/ai/liveScenePerformanceSource.test.ts ... missing generationKind, sceneRequestKind
src/game/application/server/ai/narrativeContext/sceneNarrativeContext.test.ts ... missing generationKind, sceneRequestKind
src/game/application/server/ai/sourceFactory.test.ts ... missing generationKind, sceneRequestKind
src/game/application/server/battleScenePrewarm.ts ... missing generationKind, sceneRequestKind
src/game/application/server/persistence/sqliteGameRepository.test.ts ... missing generationKind, sceneRequestKind
src/game/application/stateCommit.test.ts ... missing generationKind, sceneRequestKind
src/game/domain/narrative.test.ts ... missing generationKind, sceneRequestKind
```

### Green

Command:

```bash
npm run typecheck
```

Output:

```text
tsc --noEmit
PASS
```

Command:

```bash
npm run test:boundaries
```

Output:

```text
PASS src/game/logging/dependencyBoundaries.test.ts (3 tests)
PASS src/dependencyBoundaries.test.ts (92 tests)
Test Files 2 passed
Tests 95 passed
```

Command:

```bash
npx vitest run src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts src/game/domain/pendingNarrativeJob.test.ts src/game/application/performTurn.test.ts src/game/application/createGame.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
```

Output:

```text
PASS src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts (15 tests)
PASS src/game/domain/pendingNarrativeJob.test.ts (33 tests)
PASS src/game/application/performTurn.test.ts (33 tests)
PASS src/game/application/createGame.test.ts (14 tests)
PASS src/game/application/server/persistence/sqliteGameRepository.test.ts (20 tests)
Test Files 5 passed
Tests 115 passed
```

## Commit

- `10ddb67d2ad16883d07a2ef47700b1faf73ee7af`
- `refactor(narrative): define provider trigger whitelist`

## 剩余 Concerns

- `parsePendingNarrativeJob()` 已实现并有 domain 单测，但持久化恢复链当前仍在 `sqliteGameRepository.ts` 里把 `story_state_json` 直接强转成 `StoryState`；如果后续要让非法持久化 job 在读取时就变成 corrupt，需要单独把 parser 接进 repository 解析流程。
- `battleScenePrewarm.ts` 和若干非对话 pending-job fixture 当前使用合法的 `npc_fixed_choice` / `npc_response` 组合来满足 Task 1 的新契约；更彻底的“prepared continuation 与 provider trigger 脱钩”仍需要后续任务继续收口。

---

## Fix Round 1 (Review Follow-up)

### Red

Mandated command:

```bash
npx vitest run src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts
```

Observed output:

```text
PASS src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts (16 tests)
```

Honest note:

```text
这个命令在本轮没有复现 red。原因有二：
1. facade 文件在上一轮部分实现中已经存在；
2. Vitest/esbuild 不执行 TypeScript type-only export 校验，因此新增的 facade type re-export 断言不会在这个命令里单独变红。
```

Mandated command:

```bash
npm run test:boundaries
```

Observed output:

```text
PASS src/game/logging/dependencyBoundaries.test.ts (3 tests)
PASS src/dependencyBoundaries.test.ts (92 tests)
```

Honest note:

```text
这个命令同样没有复现 red，因为 `narrativeExecution` facade 与 boundary pinning 已在上一轮部分实现中落地。
```

Actual red evidence used for this fix round:

```bash
npx vitest run src/game/domain/pendingNarrativeJob.test.ts src/game/application/performTurn.test.ts
```

Output:

```text
FAIL src/game/domain/pendingNarrativeJob.test.ts
- 非 provider pending job 接受 null/null metadata
- parsePendingNarrativeJob 接受 null/null metadata

FAIL src/game/application/performTurn.test.ts
- 未知地点修复 + 重演算成功 → expected generationKind null, received "npc_fixed_choice"
- 我的等级升到100 → expected generationKind null, received "npc_free_text"
```

### Green

Command:

```bash
npx vitest run src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts
```

Output:

```text
PASS src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts (16 tests)
```

Command:

```bash
npx vitest run src/game/domain/pendingNarrativeJob.test.ts src/game/application/performTurn.test.ts
```

Output:

```text
PASS src/game/domain/pendingNarrativeJob.test.ts (36 tests)
PASS src/game/application/performTurn.test.ts (33 tests)
Test Files 2 passed
Tests 69 passed
```

Command:

```bash
npm run typecheck
```

Output:

```text
tsc --noEmit
PASS
```

Command:

```bash
npm run test:boundaries
```

Output:

```text
PASS src/game/logging/dependencyBoundaries.test.ts (3 tests)
PASS src/dependencyBoundaries.test.ts (92 tests)
Test Files 2 passed
Tests 95 passed
```

Command:

```bash
npx vitest run src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts src/game/domain/pendingNarrativeJob.test.ts src/game/application/performTurn.test.ts src/game/application/createGame.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
```

Output:

```text
PASS src/game/application/server/persistence/sqliteGameRepository.test.ts (20 tests)
PASS src/game/gameplay/rpg/narrativeExecution/narrativeExecutionPolicy.test.ts (16 tests)
PASS src/game/domain/pendingNarrativeJob.test.ts (36 tests)
PASS src/game/application/performTurn.test.ts (33 tests)
PASS src/game/application/createGame.test.ts (14 tests)
Test Files 5 passed
Tests 119 passed
```

### Fix Commit

- `dd1672ed66411ff20f62adc67939706a87a1e138`
- `fix(narrative): enforce provider trigger policy`

### Fix-round Concerns

- 为了在不提前做 Task 2+ prepared-continuation 重构的前提下消除“非 provider 动作伪装成 provider trigger”的问题，本轮让 `performTurn` 对非 provider pending job 持久化 `generationKind=null` / `sceneRequestKind=null`。当前 scene generation 链并不消费这两个字段，因此 focused tests 通过；后续若有代码开始消费它们，需要继续把 null 视为合法的非 provider continuation 元数据。
- `parsePendingNarrativeJob()` 仍未接入 `sqliteGameRepository.ts` 的读取路径，这个旧 concern 本轮未处理。
