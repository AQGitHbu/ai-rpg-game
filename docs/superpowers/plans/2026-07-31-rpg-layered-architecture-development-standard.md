# RPG Layered Architecture Development Standard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an evidence-based RPG development standard that preserves the existing domain/gameplay/application boundaries and states clear adoption rules for core, UI, storage, AI, and logging.

**Architecture:** Keep the product-specific `domain → gameplay → application` flow already enforced by `src/dependencyBoundaries.test.ts`. Define `core` as an optional, game-agnostic mechanism layer that is introduced only with a concrete reusable mechanism, rather than moving RPG concepts into it. Treat UI, APIs, stores, SQLite, AI providers, and logs as adapters around the application boundary.

**Tech Stack:** Next.js 16, TypeScript, Vitest, Zustand, SQLite via `@libsql/client`, `@ai-game/ui`, `@ai-game/ai-transport`.

## Global Constraints

- Modify only RPG-owned documentation; do not edit the synchronized `docs/共同规范/` copies.
- Do not claim an empty `src/game/core/` or `src/game/logging/` placeholder is an implemented subsystem.
- Preserve the existing application facade, server composition root, SQLite adapter, and shared-package import boundaries.
- Any later source-level boundary change must update `src/dependencyBoundaries.test.ts` and run `npm run test:boundaries`.

---

### Task 1: Record the layered architecture contract and current maturity

**Files:**
- Create: `docs/superpowers/plans/2026-07-31-rpg-layered-architecture-development-standard.md`
- Modify: `docs/游戏开发规范.md`
- Test: `src/dependencyBoundaries.test.ts`

**Interfaces:**
- Consumes: the enforced import restrictions in `src/dependencyBoundaries.test.ts`, the server composition root at `src/game/application/server/compositionRoot.ts`, and the shared package contract in `docs/共同规范/共享模块目录.json`.
- Produces: a project-specific development standard covering dependency direction, public facades, UI, persistence, AI, logging, and tests.

- [x] **Step 1: Compare the RPG implementation with the SLG reference architecture**

Inspect the current source roots and boundary guards:

```powershell
Get-ChildItem src/game -Directory | Select-Object -ExpandProperty Name
npm run test:boundaries
```

Expected: `domain`, `gameplay`, and `application` exist; `core` is absent or empty; the existing boundary suite passes.

- [x] **Step 2: Replace the skeletal RPG development standard with executable layer rules**

Document these concrete rules in `docs/游戏开发规范.md`:

```text
UI / store / app route -> application facade -> gameplay facade -> domain
server composition root -> application/server adapters -> provider / SQLite
core -> game-agnostic mechanisms only; no RPG concepts or product imports
```

State the actual maturity explicitly: the first three layers and UI/SQLite/AI boundaries are implemented; core and a logging facade are not yet implemented.

- [x] **Step 3: Validate the documentation against the guarded implementation**

Run:

```powershell
npm run test:boundaries
npm run typecheck
```

Expected: both commands exit with status `0`; the documentation does not require an unimplemented source migration.

- [ ] **Step 4: Commit**

```powershell
git add docs/游戏开发规范.md docs/superpowers/plans/2026-07-31-rpg-layered-architecture-development-standard.md
git commit -m "docs: clarify RPG layered architecture"
```
