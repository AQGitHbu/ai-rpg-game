# Investigation Approach Overlap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让世界演化提案中的调查方式可以正常引用事实关键词，同时继续拒绝把完整事实正文泄漏到调查标签或提示中。

**Architecture:** 保留 live world source 的 JSON、字段、引用和完整正文泄漏校验；把当前过度严格的“任意两个连续字符重合即失败”改为不阻断正常关键词复用，并用回归测试覆盖真实存档中的“赵四爷/破庙/令牌”案例。提示契约同步说明调查方式应围绕事实设计，但不得复制完整事实正文。

**Tech Stack:** TypeScript, Vitest, existing RPG live world evolution source.

**Spec:** `docs/agent/世界动态具象化.md` and `docs/agent/运行时AI导演与场景表演.md`

## Global Constraints

- 只修改 `ai-rpg-game`，不修改共享 foundation sibling。
- 保持 live source 失败分类、一次 content repair 和零非法演化写入语义。
- 不恢复生产 deterministic fallback。
- 完整事实正文仍不得出现在调查方式 `label` 或 `hint` 中。

---

### Task 1: Lock the parser contract with regression tests

**Files:**
- Modify: `src/game/application/server/ai/worldEvolutionSource.test.ts`

**Interfaces:**
- Consume `parseFactInvestigationApproaches` and `parseWorldDeltaProposal`.
- Produce tests proving grounded keyword reuse is valid and complete fact-text leakage remains invalid.

- [x] Add a test where an approach label/hint shares ordinary fact keywords such as `赵四爷` or `破庙` and remains accepted.
- [x] Add a test where a label or hint contains the complete fact text and the approach list is rejected.
- [x] Run the focused source test and confirm the new keyword-reuse test fails before implementation.

### Task 2: Align parsing and prompt rules

**Files:**
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts:101-160`
- Modify: `src/game/application/server/ai/narrativeContext/worldNarrativeContext.ts:85-87`

**Interfaces:**
- Preserve `parseFactInvestigationApproaches(raw, factText)` and `parseWorldDeltaProposal(raw, gameType)` signatures.
- Preserve `WorldEvolutionSourceResult` failure mapping and content-repair behavior.

- [x] Remove the fatal two-character soft-overlap rejection; retain exact full-fact-text rejection and all structural/enum/range/duplicate checks.
- [x] Update the world output contract to explicitly allow grounded labels while forbidding copying the complete fact text.
- [x] Keep the parser’s return shape and all existing callers unchanged.

### Task 3: Verify the production failure path is closed

**Files:**
- No additional production files unless tests expose a contract mismatch.

**Interfaces:**
- Exercise the existing live world source parser and application suite.

- [x] Run `npx vitest run src/game/application/server/ai/worldEvolutionSource.test.ts`.
- [x] Run `npm run typecheck` and `npm run test:boundaries`.
- [x] Review `git diff --check` and the final diff; confirm no unrelated files changed.
