# DeepSeek New API Thinking Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RPG and SLG send the DeepSeek/new-api-compatible `thinking.type` switch so default-off requests actually disable official DeepSeek reasoning while preserving explicit role/module opt-in.

**Architecture:** Keep the shared `@ai-game/ai-transport` package provider-agnostic. Change the RPG provider-options builder and SLG transport adapter to emit top-level request-body `thinking: { type: "disabled" | "enabled" }` through `extraBody`; remove the incompatible `chat_template_kwargs.enable_thinking` convention from these two DeepSeek/new-api consumers. Keep role/module policy decisions in each product layer and verify the exact body shape with unit tests plus one real RPG scene/world provider probe.

**Tech Stack:** TypeScript, Vitest, OpenAI-compatible Chat Completions, DeepSeek official API semantics, QuantumNous new-api relay semantics.

## Global Constraints

- The shared transport must not gain RPG/SLG/DeepSeek product semantics; it only merges generic `extraBody` into the outgoing JSON body.
- Default thinking remains disabled for all production RPG roles and all production SLG modules unless explicitly opted in.
- Do not send both `thinking` and `chat_template_kwargs.enable_thinking`; the current provider path is new-api → official DeepSeek.
- Never log API keys, authorization headers, prompts, raw response bodies, or raw `reasoning_content`.
- Real provider validation uses RPG prompts only; no SLG prompt is sent to the provider.

---

### Task 1: Update RPG DeepSeek request construction

**Files:**
- Modify: `src/game/application/server/ai/providerRequestOptions.ts`
- Test: `src/game/application/server/ai/providerRequestOptions.test.ts`
- Modify: `src/game/application/server/ai/rpgAiClient.test.ts`
- Modify: `docs/agent/AI环境.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`

**Interfaces:**
- `createProviderRequestOptions(timeoutMs, maxTokens?, jsonMode?, thinking?)` keeps its existing signature.
- `thinking: "off"` produces `extraBody.thinking = { type: "disabled" }`.
- `thinking: "on"` produces `extraBody.thinking = { type: "enabled" }`.

- [x] **Step 1: Change tests to assert the DeepSeek/new-api request body.**
- [x] **Step 2: Run the focused RPG provider-option/client tests and confirm the old nested field fails.**
- [x] **Step 3: Replace `chat_template_kwargs.enable_thinking` with `thinking.type` in the RPG option builder.**
- [x] **Step 4: Update RPG AI environment/runtime documentation with the official DeepSeek/new-api parameter and the role-level switch.**
- [x] **Step 5: Run the focused tests and typecheck.**

### Task 2: Update SLG non-streaming and streaming adapter

**Files:**
- Modify: `src/game/core/ai/aiTransport.ts`
- Modify: `src/game/core/ai/aiTransport.test.ts`
- Modify: `docs/agent/NPC 战略意图系统.md`

**Interfaces:**
- `AiRequestOptions.thinking?: boolean` remains the local SLG policy control.
- `withThinkingControl` removes the local control field and writes `extraBody.thinking.type` as `disabled` or `enabled` for both `requestAiCompletion` and `requestAiCompletionStream`.

- [x] **Step 1: Change the adapter tests to assert `thinking: { type: "disabled" | "enabled" }` for both request paths.**
- [x] **Step 2: Run the focused SLG core AI tests and confirm the old nested field fails.**
- [x] **Step 3: Change the shared adapter call-site normalization to DeepSeek/new-api `thinking.type`.**
- [x] **Step 4: Document the provider path and explicit opt-in behavior.**
- [x] **Step 5: Run focused tests, typecheck, and lint.**

### Task 3: Validate the real RPG provider path

**Files:**
- Create temporary validation input only inside the RPG worktree and remove it after the run; do not commit it.

**Interfaces:**
- Send the existing RPG scene and world prompts once each through the fixed `RpgAiClient`.
- Capture only request switch, role, token budget, response shape, content length, finish reason, reasoning-token count, and final parse/source status.

- [x] **Step 1: Intercept the outgoing RPG request body and assert `thinking.type="disabled"` with no `chat_template_kwargs`.**
- [x] **Step 2: Run one real scene request and one real world request through the new-api endpoint.**
- [x] **Step 3: Confirm the final channel is present and no identical retry occurs.**
- [x] **Step 4: Remove the temporary validation input and record only redacted results.**

> 真实验证结果：scene/world 各 1 次；请求均为 `thinking.type=disabled`、无旧字段，均 `finish_reason=stop`，scene 返回 `generated`，world 返回 `proposal`，两次均没有 reasoning token。

### Task 4: Consumer/package verification

- [x] **Step 1: Run the shared `ai-transport` package tests without changing its generic contract.**
- [x] **Step 2: Run RPG provider tests, application tests/typecheck, and SLG focused tests/typecheck/lint.**
- [ ] **Step 3: Run SLG full tests with one worker to avoid Windows worker-exit noise.**
- [x] **Step 4: Inspect `git diff --check` and all three worktree statuses without touching unrelated changes.**
- [ ] **Step 5: Attempt family readiness only when dependency state is healthy; report Windows file-lock failures separately from code failures.**

> SLG 全量回归补跑结果：旧 thinking 开关相关测试已通过；全量仍有与本次协议修改无关的 Windows `EPERM/ENOENT` 文件锁错误，主要集中在 `.tmp-*`、`.test-db` 测试目录的并发写入/清理。定向 AI 回归、类型检查和 lint 均通过。

## Self-review

- Official DeepSeek docs, new-api adapter source, and the observed request path all agree on `thinking: { type: "disabled" }`.
- The plan changes only product-layer provider options and keeps foundation transport generic.
- Both non-streaming and streaming SLG paths are covered, and RPG role-level opt-in remains independently testable.
