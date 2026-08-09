# Task 7 report — canonical choice-driven RPG runtime

Date: 2026-08-09

## Documentation closure

Updated current implementation/design facts to state:

- one neutral production chain: `/api/game/**` → `compositionRoot` → `performTurn` / `generatePendingScene` → `GameRepository`;
- exactly six production game routes and no redirect/compatibility endpoint;
- two fixed NPC dialogue choices plus one focus-NPC custom input through the same `/api/game/actions` and `performTurn` path;
- SceneSource proposal → server approval → opaque token → scene/registry/candidate-pool narrative CAS;
- seed-dependent structural generation, deterministic same-seed replay, and same-seed choice-driven structured divergence/multiple endings;
- destructive development reset: predecessor routes/storage/runtime chains and local saves are not migrated;
- formal product support is short/medium only; long/open requires a segmented-ledger Spec/Plan and cannot be described as unlimited memory or play time.

Current routing docs now point to `docs/superpowers/plans/2026-08-09-ai-rpg-canonical-runtime-completion.md`. The dated upstream architecture Spec remains historical and does not define current production names.

## Acceptance results

All commands ran from `.worktrees/v2-foundation-remediation`.

| Command | Result |
| --- | --- |
| `npm run check:standards` | PASS — `@ai-game/standards@0.5.0` synchronized |
| `npm run typecheck` | PASS — 0 TypeScript errors |
| `npm run lint` | PASS — 0 errors, 33 warnings |
| `npm run test:boundaries` | PASS — 2 files, 89 tests |
| `npm run test:fast` | PASS — standards, foundation locator (5), AI env (2), handoff checks (13), shared boundary check, typecheck and 89 boundary tests |
| `npm run test:game-domain` | PASS — 18 files, 184 tests |
| `npm run test:game-gameplay` | PASS — 24 files, 210 tests |
| `npm run test:game-application` | PASS — 27 files, 245 tests |
| `npm run test:components` | PASS — 4 files, 18 tests |
| `npm run test:app` | PASS — 2 files, 11 tests |
| `npm test` | PASS — 80 files, 765 tests |
| `npm run test:foundation-journey` | PASS — 1 file, 3 tests |
| `npm run journey:foundation` | PASS — replay mode, 1 file, 3 tests |
| `npm run build` | PASS — Next.js production compile/typecheck/static generation; route output contains only the six `/api/game` routes |
| `npm run phase:status` | PASS — `canonical-choice-driven-runtime`, `completed / implemented` |

The build tool suggested `.next/types` include entries and wrote them to `tsconfig.json`; this generated change was restored and is not part of Task 7.

## Final zero-version / zero-leak scans

Scans were run against production source/scripts/config, excluding test/fixture values where appropriate.

- Versioned production filenames (`V1`, `V2`, `V2.1`, lowercase equivalents): no matches.
- Versioned production symbols/routes (`/api/v*`, versioned composition root/use-case/record/view names): no matches.
- Client/API leakage (`actionKey`, `choiceRegistry`, `candidateEventPool`, hidden fact IDs, internal effects): no production matches.
- Current docs referring to retired routes/symbols as production facts: no matches.
- Production route enumeration returned exactly:
  - `src/app/api/game/route.ts`
  - `src/app/api/game/current/route.ts`
  - `src/app/api/game/actions/route.ts`
  - `src/app/api/game/narrative/ensure/route.ts`
  - `src/app/api/game/prologue/ack/route.ts`
  - `src/app/api/game/dev/current/route.ts`

A broader version-value scan found only allowed facts: provider `/v1` URLs in environment tests, UUID v4 terminology, FNV-1a algorithm naming, persisted template/schema values, one fixture source contract value, and an unsupported predecessor-record comment. None is a production interface/file/route version suffix.

## Notes

- No foundation files or packages were modified.
- `.foundation` remains an untracked protected junction and was not staged.
- Lint warnings are pre-existing unused-symbol/no-unused-expression warnings; the configured lint gate succeeds with zero errors.
