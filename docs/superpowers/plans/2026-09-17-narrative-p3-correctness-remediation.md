# P3 正确性修复与完整验收 Implementation Plan

> **For agentic workers:** 按任务执行本计划，使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`；每个步骤用复选框记录，任务完成后独立审查，再进入依赖它的任务。

**Goal:** 修复错误目标绑定、历史证明缺项和审阅误重写，恢复有界 UI 派发，并让 P3 的结论真正由 C1–C8 的可追溯证据决定。

**Architecture:** 保留现有 A 提交实际行动、B 生成/审批/发布完整候选的架构。只提取必要的纯证据/合作检查函数，修正已有编译和错误分流；验收侧新增独立能力证据和 v2 协议，不增加新的生产状态机或审阅角色。

**Tech Stack:** Node >=24.15.0、npm >=10、TypeScript、Next.js/React、Vitest/Testing Library、Node test runner、现有 SQLite/CAS、现有 `.foundation` 共享依赖；不新增运行时依赖。

**Spec:** [P3 规则语义、审阅依据与完整验收修复 Spec](../specs/2026-09-17-narrative-p3-correctness-remediation-spec.md)。执行者先读该文件，再读当前任务，不从本计划代码片段反推或扩大产品范围。

**状态与基线：** v1.1，按本地 `codex/narrative-architecture` HEAD `b93c7542b0aafe2efe290e052d051b01d5c145b0` 复核修订，尚未实施。定位、现有测试失败及历史 UI 实际停点见 [复核报告](../reports/2026-09-17-narrative-p3-remediation-review.md)。代码片段是拟实现内容；历史 runtime 指纹不同，不是新版本 live 证据。修订新增 Task 6A，为 G2/G4/G5 必须依赖，不可跳过。

## Global Constraints

- 仅修改 `ai-rpg-game`；零 foundation 改动，不新增运行时依赖，不修改 `docs/共同规范/`。
- Node `>=24.15.0`、npm `>=10`；先恢复本仓库声明的 `.foundation` 链接及依赖，再执行工程验证。
- 保留一个整场作者角色、必要的隔离 NPC 私有判断和现有候选审阅角色；不新增常驻 Agent、额外审批角色或固定多轮生成 DAG。
- 保留 A 已提交行动与 B 候选发布的分离；B 失败、重审、重新派发不得重做 A。
- 保留正式事件、EntityStore、revision/job、CAS 和已批准续接权威。读地图、切 UI 面板和 GET 不增加 provider 工作。
- 内容版本最多 3 个；每 job/epoch 的叙事 HTTP 上限 24，记忆 HTTP 上限 8。二者不得因为合计 32 而互相借用或隐藏。
- 单路线最多 32 个行动、300 次 HTTP、7,200,000ms；两路线批次最多 600 次 HTTP、10,800,000ms。不得自动重试已耗尽的批次/epoch。
- 保留 P2 摘要协议 v1、50/10 阈值、24k/6k/64k 的现有预算语义；本次不以删历史或秘密泄露换取审阅通过。
- 不修改 `docs/agent/current-phase.json`；不 reset/checkout 丢弃已有工作区改动；不覆盖任何旧 run 的 artifacts。
- 本次不要求变更 EntityStore v4、WorldState v8、StoryState v13、NarrativeBundle v3。审阅投影和验收文件版本可独立变化，不等于存档 schema 升级。
- 完整批次采用 `private = next_ui`、`public = api`。至少一条实际 UI，不要求两条都用 UI；不得将 public API 的证据写成 UI。
- 不实现验收 runner 跨进程续跑；进程退出后新注册 runId，旧目录只读保留。游戏刷新恢复仍必须实现。
- 未经真实 API 执行许可，不运行 live；工程修复完成和 P3 验收完成分别报告。

---

## 0. 执行顺序与环境入口

三个可独立审查的工作组放在同一计划中，因为它们共同修复一个 P3 完成契约：

```
Task 1 → Task 2 → Task 3 → Task 4        编译与审阅（G1）
Task 1 → Task 5 → Task 6 → Task 6A → Task 7 → Task 8 → Task 9   规则与验收（G2）
Task 10 → Task 11                       UI（G3）
所有代码任务 → Task 12 → Task 13       工程回归、真实验收（G4/G5）
```

Task 5 可在 Task 1 后与历史目录工作并行；Task 10 可独立实施。Task 9 的生产采集依赖 Task 6–8 的接口，Task 11 的 UI 证据接入依赖 Task 8–10。合并到本工作分支时按依赖顺序，不同时修改同一大文件。

### 开始前的必要检查（并入 Task 1，不单独算一次功能交付）

- [ ] 阅读 `AGENTS.md`、`docs/Agent文档索引.md`、上游总 Spec、原 P3 Plan 的 C1–C8 和本 Spec。
- [ ] 执行以下命令，保存命令、返回码和工作区差异。ZIP 解压目录没有 Git 历史时只能做离线文档/代码试验，正式实现需进入用户现有工作区；不要 `git init` 伪造历史。

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
node --version
npm --version
npm run doctor
```

预期：分支符合约定；未提交改动已识别并保留；Node/npm/foundation 检查成功。失败就先修本地环境或报告阻塞，不能将共享包缺失记为功能回归失败。按 `.ai-game-foundation.json` 和现有 bootstrap/link 文档恢复已有依赖，不修改共享包源码或清理 junction。

### 文件布局与责任

下列 `新增` 都是本计划拟创建的文件，不是声称仓库已存在；未列出的框架文件不得顺手重构。

| 文件/文件组 | 状态 | 单一职责 |
|---|---|---|
| `scripts/extractNarrativeP3RegressionFixtures.mjs` | 新增 | 由指定原始 runtime 提取最小可校验回归输入，不联网、不写 live |
| `src/game/application/server/ai/fixtures/p3-live44-regression.json` | 新增 | 经审查的状态/作者/审阅切片及原文件 hash |
| `src/game/application/server/ai/p3RegressionFixture.testutil.ts` | 新增 | 用现有持久化解析器读取这些切片，不把 unknown 强转世界状态 |
| `src/game/application/server/ai/narrativeDraftProjection.ts` | 修改 | 取消隐式绑定，保留原槽编译 |
| `src/game/application/server/ai/narrativeHistoricalEvidence.ts` | 新增 | 已提交且可见历史的白名单投影 |
| `src/game/application/narrativeCandidateReview.ts`、`generatePendingNarrativeBundle.ts` | 修改 | 显式传入 A 已提交快照，历史权限不读取候选预览 |
| `src/game/application/server/ai/narrativeExecutionChecks.ts`、`narrativeReviewRules.ts`、`liveNarrativeCandidateReview.ts` | 修改 | 同源目录、时序/权限、响应协议错误分流 |
| `src/game/gameplay/rpg/narrativeBundle/deliveryEvidenceClosure.ts` | 新增 | 同一事实发现/分享/核验的完整链 |
| `src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.ts`、`index.ts` | 修改 | 在现有 resolver 内提取并导出合作准入函数，生产与只读验收共用，避免循环依赖 |
| `src/game/application/p3CapabilityCoverage.ts` | 新增 | 已请求 P3 的调查片段发布前结构覆盖检查，不产生绑定 |
| `src/game/gameplay/rpg/narrativeBundle/descriptors.ts`、`src/game/application/storyConsequenceContext.ts` | 修改 | 正式候选及可用互动采用同一合作准入 |
| `src/game/application/testing/narrativeP3Acceptance.ts` | 新增 | C2/C3/C4 与总体状态的纯判定及证据类型 |
| `src/game/application/testing/narrativeP3LiveJourney.ts` | 修改 | v2 协议、分层结果、预算与最终汇总 |
| `scripts/narrativeP3Evidence.mjs` | 新增 | 状态/请求/Action/事件到可校验能力证据的只读采集 |
| `scripts/narrativeP3Acceptance.mjs` | 新增 | 核对材料 hash、人工签核和严格回放后生成新最终汇总 |
| `scripts/narrativeP1Journey.mjs`、`narrativeP3Journey.mjs` | 修改 | 无侵入观察钩子、P3 策略顺序、真实采集 |
| `src/components/narrativeEnsureDispatch.ts` | 新增 | 每个 pending job 的有界连接派发记账；不处理业务重试 |
| `src/components/CurrentGameScreen.tsx` | 修改 | 接入连接控制、提示、旧回调取消 |
| `src/components/gameActionRequest.ts` | 修改 | ensure/current 请求及响应体的有界连接等待 |
| `scripts/narrativeP3UiJourney.mjs` | 修改 | UI 刷新检查点、验收层诊断、生命周期 |
| 所列模块对应 `.test.ts` / `.node-test.mjs` 与现有集成测试 | 新增/修改 | 非空真实切片、独立负例、集成和恢复回归 |

所有函数经已有所属模块 facade 导出；测试专用 helper 不导出到生产入口。新增纯投影不持久化、不调用 provider。

---

## Task 1：删除隐式目标绑定并固化源码回归输入

**Spec:** §4，P3R-01/11。**交付：** 同一作者输入不会因目标排序或编译次数而增加未声明的规则。

**Files:**
- Create: `scripts/extractNarrativeP3RegressionFixtures.mjs`
- Create: `src/game/application/server/ai/fixtures/p3-live44-regression.json`
- Create: `src/game/application/server/ai/p3RegressionFixture.testutil.ts`
- Modify: `src/game/application/server/ai/narrativeDraftProjection.ts`（`p3EvidenceGoalBinding`、`compileNarrativeDraft`）
- Modify/Test: `src/game/application/server/ai/narrativeDraftProjection.test.ts`

**Interfaces:**
- Consumes: 现有 `compileNarrativeDraft(raw: unknown, input: NarrativeDraftContext)`、`projectNarrativeDraft(input)`；两个原始 `.runtime.json`。
- Produces: `loadP3Record(key: string): {worldState: WorldState; storyState: StoryState; revision: number}`；`readP3Fixture(key: string): unknown`。仅测试使用。
- `compileNarrativeDraft` 的生产签名和候选 schema 不变。

- [ ] **Step 1：创建只读切片提取器。** 使用以下完整入口代码；它按 job/purpose 和候选版本定位，不靠易漂移的 calls 数组下标。状态不裁掉 ledger/EntityStore 的依赖闭包，避免造出不合法“最小世界”。请求只保留本项需要的原作者/审阅结果，不复制完整 system prompt 或模型配置。

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [privatePath, publicPath, outputPath] = process.argv.slice(2);
if (!privatePath || !publicPath || !outputPath) {
  throw new Error('usage: node scripts/extractNarrativeP3RegressionFixtures.mjs private.runtime.json public.runtime.json output.json');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const output = { schema: 'p3-regression-fixture/v1', sources: {}, entries: {} };
for (const [route, file] of [['private', privatePath], ['public', publicPath]]) {
  const bytes = readFileSync(file);
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.tape?.stream !== route || !Array.isArray(data.tape.states) || !Array.isArray(data.tape.calls)) {
    throw new Error(`INVALID_RUNTIME:${route}`);
  }
  output.sources[route] = { sha256: sha256(bytes), binding: data.tape.binding };
  for (const index of [3, 4, 5, 6, 7, 8, 10, 11, 14, 15]) {
    const state = data.tape.states.find(s => s.key === `before:${index}`);
    if (!state?.semantic?.ok || state.semantic.status !== 'active') {
      throw new Error(`MISSING_STATE:${route}:${index}`);
    }
    output.entries[`${route}.before${index}`] = state.semantic.record;
  }
  for (const action of [3, 6, 10, 14]) {
    for (const purpose of ['narrative_bundle_generation', 'narrative_candidate_review']) {
      const calls = data.tape.calls.filter(c =>
        c.request?.context?.jobId === `job_${route}-action-${action}` &&
        c.request.context.purpose === purpose && c.output?.ok === true);
      calls.forEach((call, index) => {
        output.entries[`${route}.${action}.${purpose}.${index}`] = JSON.parse(call.output.content);
      });
    }
  }
}
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
```

运行：`node scripts/extractNarrativeP3RegressionFixtures.mjs artifacts/narrative-p3/p3-live-44/private.runtime.json artifacts/narrative-p3/p3-live-44/public.runtime.json src/game/application/server/ai/fixtures/p3-live44-regression.json`。
原始文件不在该位置时，将用户提供的同名文件路径作为前两个参数；不下载、替换或猜测另一批文件。审查切片不含密钥后才提交。已有输出拒绝覆盖；需要重新提取时先另存并核对源 hash。

- [ ] **Step 2：创建经真实解析器校验的测试读取器。** 所有 helper 完整定义如下，后续任务只引用这些明确的接口。

```ts
import { readFileSync } from 'node:fs';
import { validatePersistableWorldState } from '../persistence/worldStatePersistenceValidation';
import { parsePersistableStoryState } from '../persistence/storyStatePersistenceValidation';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('fixture object expected');
  return value as Record<string, unknown>;
}
export function readP3Fixture(key: string): unknown {
  const file = new URL('./fixtures/p3-live44-regression.json', import.meta.url);
  const root = object(JSON.parse(readFileSync(file, 'utf8')));
  const entries = object(root.entries);
  if (!(key in entries)) throw new Error(`fixture missing: ${key}`);
  return structuredClone(entries[key]);
}
export function loadP3Record(key: string) {
  const record = object(readP3Fixture(key));
  const world = validatePersistableWorldState(record.worldState);
  if (!world.ok) throw new Error(`invalid fixture world: ${world.code}`);
  const story = parsePersistableStoryState(record.storyState, world.value.eventLedger, world.value.entityStore);
  if (!story.ok) throw new Error(`invalid fixture story: ${story.code}`);
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision)) throw new Error('invalid revision');
  return { worldState: world.value, storyState: story.value, revision: record.revision };
}
```

- [ ] **Step 3：在现有 projection 测试中加入失败测试。** 复用该文件已经定义的 `context()`、`scene()`，从真实已调查边界构造编译输入；这是编译单元回归，不冒称严格历史回放。

```ts
it('does not bind any unassigned P3 goal when the author omitted bindings', () => {
  const record = loadP3Record('private.before4');
  const base = context();
  const input: NarrativeDraftContext = {
    ...base, worldState: record.worldState, storyState: record.storyState,
    job: { ...base.job, actionId: 'regression-no-implicit-binding',
      actionSummary: { kind: 'talk', npcId: asNpcId('npc_0') } },
  };
  const raw = { worldDelta: null, sceneDrafts: projectNarrativeDraft(input).slots.map(slot => ({
    slotKey: slot.slotKey, scene: scene('回归测试正文。', slot.choiceCount),
  })) };
  const before = JSON.stringify(input);
  const result = compileNarrativeDraft(raw, input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  expect(result.value).not.toHaveProperty('consequenceBindings');
  expect(JSON.stringify(input)).toBe(before);
});
```

补齐同一文件的显式绑定保持测试：作者确实提供绑定时编译结果保留；连续编译两次深度一致；用 `updateWorldStateFixture` 调整真实 NPC goals 顺序后不出现新绑定，不能直接只改兼容投影而忽略 EntityStore。

- [ ] **Step 4：运行 RED。** `npx vitest run src/game/application/server/ai/narrativeDraftProjection.test.ts`。预期新增测试在旧编译追加逻辑上失败；不是因为 fixture 解析、导入或缺共享依赖失败。若未命中，打印该 fixture 的未绑定 active 目标定位原因，不改断言为宽松通过。
- [ ] **Step 5：删除 helper 和追加逻辑。** 保留 `raw.consequenceBindings` 原有解析及已有 `worldDelta.consequenceBindings` 路径；不要把缺少绑定改为另一种自动补写。

```ts
// compileNarrativeDraft：删除 automaticP3GoalBinding 和原合并表达式，
// 原 return 中的条件展开保持不变，绑定只能来自 raw。
const consequenceBindings = raw.consequenceBindings;
```

原返回对象继续使用 `...(consequenceBindings === undefined ? {} : { consequenceBindings })`。删除 `p3EvidenceGoalBinding` 函数，并清理其专用且不再使用的 import；不重构整个结果对象。

- [ ] **Step 6：运行 GREEN 与集成保护。** 执行 projection 测试及 `npx vitest run src/game/application/approveStoryConsequenceBindings.test.ts src/game/domain/npcGoalResolution.test.ts`。绑定幂等、未来生效和普通非 P3 编译必须不回归。
- [ ] **Step 7：独立审查并提交。** 审查者比较 raw 与 compiled 绑定，确认没有 fallback 挪到别处。

```bash
git add scripts/extractNarrativeP3RegressionFixtures.mjs src/game/application/server/ai/fixtures/p3-live44-regression.json src/game/application/server/ai/p3RegressionFixture.testutil.ts src/game/application/server/ai/narrativeDraftProjection.ts src/game/application/server/ai/narrativeDraftProjection.test.ts
git commit -m "fix(narrative): preserve only authored goal bindings"
```

---

## Task 2：建立白名单历史执行依据投影

**Spec:** §5，P3R-02。**依赖：** Task 1 的测试输入。**交付：** 从已提交、观察者可见事件生成完整且不越权的依据。

**Files:**
- Create: `src/game/application/server/ai/narrativeHistoricalEvidence.ts`
- Create/Test: `src/game/application/server/ai/narrativeHistoricalEvidence.test.ts`
- Modify: `src/game/application/narrativeCandidateReview.ts`、`src/game/application/generatePendingNarrativeBundle.ts`（明确已提交快照来源）
- Modify/Test: `src/game/application/generatePendingNarrativeBundle.test.ts`、所有构造 decision review input 的测试（显式注入 committedState，不回退到 preview）
- Read: `src/game/gameplay/rpg/narrativeMemory/projectObserverEvidence.ts`、`src/game/domain/events.ts`

**Interfaces（在新模块中定义并导出）：**

```ts
import type { EntityId } from '@/game/domain/entity';
import type { WorldState } from '@/game/domain/worldState';
import type { StoryState } from '@/game/domain/storyState';
import type { CandidateRuleImpact, NarrativeCandidateReviewInput } from '../../narrativeCandidateReview';

export type HistoricalExecutionBasis = Readonly<{
  key: string;
  kind: 'item' | 'action';
  impacts: readonly CandidateRuleImpact[];
  value: Readonly<{
    eventId: string; sequence: number; turnNumber: number; outcome: string;
    actorIds: readonly string[]; targetIds: readonly string[];
    locationId: string | null; factIds: readonly string[];
    payload: Readonly<Record<string, unknown>>;
  }>;
}>;
export function projectHistoricalExecutionEvidence(input: {
  worldState: WorldState; storyState: StoryState; observerId: EntityId;
}): readonly HistoricalExecutionBasis[];
export function buildNarrativeHistoricalEvidence(input: NarrativeCandidateReviewInput): readonly HistoricalExecutionBasis[];
```

上面为契约声明；实现文件中用下面函数体替代无函数体声明，不能把声明和同名实现重复导出。

- [ ] **Step 1：写真实核验事件存在的 RED 测试。**

```ts
import { describe, expect, it } from 'vitest';
import { PLAYER_ENTITY_ID } from '@/game/domain/worldEntity';
import { loadP3Record } from './p3RegressionFixture.testutil';
import { projectHistoricalExecutionEvidence } from './narrativeHistoricalEvidence';

it('includes the committed verification before private action 10', () => {
  const record = loadP3Record('private.before10');
  const result = projectHistoricalExecutionEvidence({ ...record, observerId: PLAYER_ENTITY_ID });
  const verified = result.find(entry => entry.value.payload.type === 'story_interaction_resolved'
    && entry.value.payload.operation === 'request_verification');
  expect(verified?.key).toBe('event:private-action-7:story_interaction_resolved:interaction:job_private-action-6:verify_watch_with_hejiu');
  expect(verified?.value.payload.factIds).toEqual(['fact_dyn_4']);
  expect(verified?.value.sequence).toBe(30);
});
```

- [ ] **Step 2：运行 RED。** `npx vitest run src/game/application/server/ai/narrativeHistoricalEvidence.test.ts`。先因新模块不存在失败；实现后必须再用 Task 3 的旧行为负例证明不是只测“函数存在”。
- [ ] **Step 3：实现纯投影与预览隔离。** 完整核心算法如下，复用既有观察者过滤。白名单事件若带不可见 `evidenceEventIds`，先拒绝纳入目录，不静默删掉依据后声称完整。

先在 `NarrativeCandidateReviewInput` 添加服务端字段，再在 `generatePendingNarrativeBundle` 调 reviewer 时明确传入预审批前 record。不可把该字段随 context/proposal 原样 JSON.stringify 发给模型。

```ts
// narrativeCandidateReview.ts 的输入类型字段；引入 domain WorldState/StoryState 类型。
readonly committedState?: Readonly<{ worldState: WorldState; storyState: StoryState }>;
// generatePendingNarrativeBundle：与 context/proposal 同级，读取已有 record。
committedState: { worldState: record.worldState, storyState: record.storyState },
```

decision 缺该字段是服务端不变量失败，Task 3 在 HTTP 前转为 UNCERTAIN；opening 不需要。`generationContract` 在 `previewNarrativeDisclosure` 后构造，不能用于历史权限判定。

```ts
import { PLAYER_ENTITY_ID } from '@/game/domain/worldEntity';
import { projectObserverEvidence } from '@/game/gameplay/rpg/narrativeMemory';

export function projectHistoricalExecutionEvidence(input: {
  worldState: WorldState; storyState: StoryState; observerId: EntityId;
}): readonly HistoricalExecutionBasis[] {
  const visible = projectObserverEvidence(input).events;
  const visibleIds = new Set(visible.map(event => String(event.eventId)));
  const result: HistoricalExecutionBasis[] = [];
  for (const event of visible) {
    const p = event.payload;
    const permitsNeutral = p.type === 'location_visited' || p.type === 'opening_history_established';
    if (event.outcome !== 'success' && !(permitsNeutral && event.outcome === 'neutral')) continue;
    let payload: Record<string, unknown>;
    switch (p.type) {
      case 'item_given':
        payload = { type: p.type, itemId: p.itemId, npcId: p.npcId }; break;
      case 'item_obtained':
        payload = { type: p.type, itemId: p.itemId }; break;
      case 'fact_discovered':
        payload = { type: p.type, factId: p.factId,
          ...(p.approachId === undefined ? {} : { approachId: p.approachId }),
          witnessNpcIds: p.witnessNpcIds ?? [] }; break;
      case 'story_interaction_resolved':
        if (!p.evidenceEventIds.every(id => visibleIds.has(String(id)))) continue;
        payload = { type: p.type, interactionId: p.interactionId, npcId: p.npcId,
          operation: p.operation, factIds: p.factIds, audienceIds: p.audienceIds,
          evidenceEventIds: p.evidenceEventIds }; break;
      case 'location_visited':
        payload = { type: p.type, locationId: p.locationId }; break;
      case 'opening_history_established':
        payload = { type: p.type, factIds: p.factIds }; break;
      default: continue;
    }
    const item = p.type === 'item_given' || p.type === 'item_obtained';
    result.push({ key: `event:${event.eventId}`, kind: item ? 'item' : 'action',
      impacts: item ? ['item_state', 'interaction_effect'] : ['fact_claim', 'interaction_effect', 'step_order'],
      value: { eventId: String(event.eventId), sequence: event.sequence,
        turnNumber: event.turnNumber, outcome: event.outcome,
        actorIds: event.actorIds.map(String), targetIds: event.targetIds.map(String),
        locationId: event.locationId == null ? null : String(event.locationId),
        factIds: event.factIds.map(String), payload } });
  }
  return result.sort((a, b) => a.value.sequence - b.value.sequence);
}

export function buildNarrativeHistoricalEvidence(input: NarrativeCandidateReviewInput) {
  if (input.context.kind !== 'decision') return [];
  const committed = input.committedState;
  if (committed === undefined) throw new Error('HISTORICAL_BASIS_MISSING');
  return projectHistoricalExecutionEvidence({ worldState: committed.worldState,
    storyState: committed.storyState, observerId: PLAYER_ENTITY_ID });
}
```

字段白名单来自当前 events.ts；不输出 evidenceQuality。上面 switch 之外须核验 payload 内引用：fact 只取 committedState 中 observer 已知事实，entity 只取 observer 投影 knownEntityIds，source event 只取可见事件；引用越界则该项不进入目录，不删引用后声称完整。不能用候选披露后的知识授权历史。用同一已提交事件、只改变 preview 知识的对照测试证明不会扩大目录。

- [ ] **Step 4：补齐同模块负例。** 用现有 world fixture 工具构造 secret fact/非观察者参与事件，断言不出现；`location_visited` 和 `opening_history_established` 的 neutral 保留；failure 核验不进入目录；给 `reviewWorldState` 加候选事件不能进入历史；相同输入结果有序且输入 JSON 不变。测试对 history/store 一致性保持合法，不直接删账本中间事件后称合法存档。
- [ ] **Step 5：运行 GREEN。** `npx vitest run src/game/application/server/ai/narrativeHistoricalEvidence.test.ts src/game/gameplay/rpg/narrativeMemory/projectObserverEvidence.test.ts`，并运行 `npm run typecheck`。
- [ ] **Step 6：提交。**

```bash
git add src/game/application/server/ai/narrativeHistoricalEvidence.ts src/game/application/server/ai/narrativeHistoricalEvidence.test.ts src/game/application/narrativeCandidateReview.ts src/game/application/generatePendingNarrativeBundle.ts src/game/application/generatePendingNarrativeBundle.test.ts
git commit -m "fix(narrative): project authorized historical execution evidence"
```

---

## Task 3：让审阅 catalog 与前提检查消费同一历史目录

**Spec:** §5.2–5.4，P3R-02。**依赖：** Task 2。**交付：** 正确历史既能被看到，也能以同一键被引用；条件未来仍隔离。

**Files:**
- Modify: `src/game/application/server/ai/narrativeExecutionChecks.ts`
- Modify: `src/game/application/server/ai/narrativeReviewRules.ts`
- Modify: `src/game/application/server/ai/liveNarrativeCandidateReview.ts`
- Modify/Test: `src/game/application/server/ai/narrativeExecutionChecks.test.ts`
- Modify/Test: `src/game/application/server/ai/liveNarrativeCandidateReview.test.ts`

**Interfaces:**
- Consumes: `buildNarrativeHistoricalEvidence(input)` → `readonly HistoricalExecutionBasis[]`。
- Produces: 现有 `buildNarrativeReviewRules(input)` 与 `buildNarrativeExecutionChecks(input)` 的返回结构不变，但同一历史 event 键和值完整对应。保留 `NarrativeRuleBasis.kind` 现有联合类型，历史非物品使用已有 `action`，不任意增加 `event` 枚举。

- [ ] **Step 1：在 execution tests 加 RED。** 复用该文件已有 `input(false)`，用已校验真实快照替换 world/story；不改旧历史内容来迎合目录。

```ts
it('offers the same historical verification basis to catalog and execution prerequisites', () => {
  const original = input(false);
  if (original.context.kind !== 'decision') throw new Error('decision required');
  const record = loadP3Record('private.before10');
  const value = { ...original, committedState: record, context: { ...original.context, ...record } };
  const key = 'event:private-action-7:story_interaction_resolved:interaction:job_private-action-6:verify_watch_with_hejiu';
  const catalog = buildNarrativeReviewRules(value);
  const checks = buildNarrativeExecutionChecks(value);
  expect(catalog.filter(entry => entry.key === key)).toHaveLength(1);
  expect(checks.find(check => check.path === 'currentScene.segments[0].text')?.prerequisiteBasisKeys).toContain(key);
});
```

这个测试只证明结构性目录完整；另用真实候选回顾原文与原非空 completedPrerequisites 验证可以绑定到该 key。不能使用全空 `fixtureNarrativeReviewPass` 代替历史前提断言。

- [ ] **Step 2：运行 RED。** `npx vitest run src/game/application/server/ai/narrativeExecutionChecks.test.ts`，预期旧代码找不到核验 event key。
- [ ] **Step 3：替换两处孤立历史筛选。**

```ts
// narrativeReviewRules.ts，复用现有 add，替换原只添加 item history 的循环。
for (const entry of buildNarrativeHistoricalEvidence(input)) {
  add(entry.key, entry.kind, entry.impacts, entry.value);
}

// narrativeExecutionChecks.ts，在构建 current 的 prerequisites 时合入同源键。
const historical = buildNarrativeHistoricalEvidence(input);
const prerequisiteBasisKeys = [...new Set([
  `action:${job.actionId}`,
  ...historical.map(entry => entry.key),
  ...worldState.worldFacts.filter(fact => fact.discovered).map(fact => `fact:${fact.factId}`),
])];
```

物品 `transfers` 也改为从 `historical` 的 item payload 投影，不再独立过滤另一份观察者事件；继续按 visibleItems 筛选持有物。current 的位置和未来 NPC/持有物仍由各槽 snapshot 预演，不能被历史位置覆盖。

- [ ] **Step 4：在审阅请求构建前加入本地目录不变量。** 此函数放在 reviewer 文件的私有 helper，不修改对外返回类型。

```ts
function historyKeysMatch(
  history: readonly { key: string; value: unknown }[],
  rules: readonly { key: string; value: unknown }[],
  checks: readonly { prerequisiteBasisKeys: readonly string[] }[],
): boolean {
  const allowed = new Set(history.map(entry => entry.key));
  return history.every(entry => {
    const matches = rules.filter(rule => rule.key === entry.key);
    return matches.length === 1 && JSON.stringify(matches[0]!.value) === JSON.stringify(entry.value);
  }) && checks.every(check => history.every(entry => check.prerequisiteBasisKeys.includes(entry.key))
    && check.prerequisiteBasisKeys.filter(key => key.startsWith('event:')).every(key => allowed.has(key)));
}
```

先在 reviewer 请求构建前检查 decision.committedState，缺失记录 `HISTORICAL_BASIS_MISSING`、直接 `resultFailure(input, 'UNCERTAIN')`，不能让异常落入通用 PROVIDER_FAILURE catch。构建 ruleBasis/executionChecks 后若不一致，记录 `HISTORICAL_BASIS_MISMATCH`，同样停止。目录只构建一次，发送与校验使用同一值。

- [ ] **Step 5：补正负测试并运行 GREEN。** 真实历史回顾合法；删除/隐藏依据的独立合法 fixture 不提供 key；current 不含 future step/ending；旧 itemGiven 正反例不变；同包新增实体不会被误判“不存在”。运行：

```bash
npx vitest run src/game/application/server/ai/narrativeExecutionChecks.test.ts src/game/application/server/ai/liveNarrativeCandidateReview.test.ts
npm run typecheck
```

- [ ] **Step 6：提交。**

```bash
git add src/game/application/server/ai/narrativeExecutionChecks.ts src/game/application/server/ai/narrativeReviewRules.ts src/game/application/server/ai/liveNarrativeCandidateReview.ts src/game/application/server/ai/narrativeExecutionChecks.test.ts src/game/application/server/ai/liveNarrativeCandidateReview.test.ts
git commit -m "fix(narrative): align history catalog with execution checks"
```

---

## Task 4：将审阅协议错误留在原候选重审

**Spec:** §6，P3R-03。**依赖：** Task 3。**交付：** `player_0` 类型误填不会导致作者重新抽样，真实越权仍被拒绝。

**Files:**
- Modify: `src/game/application/server/ai/narrativeExecutionChecks.ts`（校验与 `NARRATIVE_EXECUTION_CHECK_CONTRACT`）
- Modify: `src/game/application/server/ai/liveNarrativeCandidateReview.ts`（必要诊断，不另建重试循环）
- Modify/Test: `src/game/application/server/ai/narrativeExecutionChecks.test.ts`
- Modify/Test: `src/game/application/server/ai/liveNarrativeCandidateReview.test.ts`
- Modify/Test: `src/game/application/generatePendingNarrativeBundle.test.ts`

**Interfaces:** 保持 `validateNarrativeExecutionChecks(...): CandidateDefect[] | null`、`CandidateReviewResult` 和 `candidateReviewMatches` 现有定义。`null` 的 malformed pass 走最多两份 review response；非空 defects 才触发作者修订。

- [ ] **Step 1：加入可定位的 RED。** 以下片段复用 execution tests 现有 `input`、`response`、`validate`，不是未定义 helper。

```ts
it('classifies a player in npc participants as review protocol error', () => {
  const value = input(false);
  const verdict = response(value);
  const check = verdict.executionChecks![0]!;
  check.participants = [{ quote: check.quote, npcId: 'player_0', locationId: 'inner_hall' }];
  expect(validate(value, verdict)).toBeNull();
});
```

- [ ] **Step 2：运行 RED。** `npx vitest run src/game/application/server/ai/narrativeExecutionChecks.test.ts`。旧代码返回 `ACTION_MISMATCH[]`，不是 null。
- [ ] **Step 3：在字段结构验证后、NPC 位置查找前加入类型检查。**

```ts
if (String(participant.npcId) === String(PLAYER_ENTITY_ID)) return null;
```

提示词将“抽取参与人物”改为：“participants 仅抽取实际到场 NPC；玩家只能由 playerLocation 表达，不得填入 participants.npcId；提及 NPC 不等于 NPC 到场。”不删除已返回的条目后直接放行。

- [ ] **Step 4：增加真实 reviewer 循环测试。** 放在 `narrativeExecutionChecks.test.ts`，它已有 `input`、`response`、`RpgAiClient`、`createLiveNarrativeCandidateReview` 和 Vitest 导入。下列两组测试调用真实 parser 和同候选修复循环，不用直接返回 pass 的 reviewer。

```ts
it.each([false, true])('keeps one candidate when reviewer protocol remains invalid=%s', async remainsInvalid => {
  const value = input(false);
  const reviewBodies: Record<string, unknown>[] = [];
  const complete = vi.fn<RpgAiClient['complete']>(async (_role, messages) => {
    const user = messages.find(message => message.role === 'user');
    if (user === undefined) throw new Error('review request missing');
    reviewBodies.push(JSON.parse(user.content));
    const verdict = response(value);
    const first = verdict.executionChecks![0]!;
    if (remainsInvalid || reviewBodies.length === 1) {
      first.participants = [{ quote: first.quote, npcId: 'player_0', locationId: 'inner_hall' }];
    }
    return { ok: true, content: JSON.stringify(verdict) };
  });
  const aiClient: RpgAiClient = { complete, policy: () => ({
    thinking: 'off', timeoutMs: 45000, maxTokens: 2000, jsonMode: 'prompt_only', maxAttempts: 1,
  }) };
  const result = await createLiveNarrativeCandidateReview({ aiClient }).reviewNarrativeCandidate(value);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(reviewBodies.map(body => body.candidateHash)).toEqual([value.candidateHash, value.candidateHash]);
  expect(reviewBodies[1]!.proposal).toEqual(reviewBodies[0]!.proposal);
  if (remainsInvalid) expect(result).toMatchObject({ ok: false, failure: 'UNCERTAIN' });
  else expect(result.ok).toBe(true);
});
```

在 `generatePendingNarrativeBundle.test.ts` 的现有“real author, approval, reviewer and revision loop”测试组中增加以下完整集成用例，复用该文件已有 world/story/job/repository 工厂。

```ts
it('exhausts malformed review responses without regenerating the author or changing A', async () => {
  const npcId = asNpcId('npc_0');
  const worldState = updateWorldStateFixture(createMinimalWorldState(), {
    npcs: [{ id: npcId, name: '掌柜', role: '掌柜', description: '在场', locationId: LOC_0,
      isCompanion: false, met: true, tags: [], memory: { npcId, knownFactIds: [], hiddenFactIds: [],
        interactionHistory: [], relationship: { affinity: 0 }, emotion: 'neutral', goals: [] } }],
    endings: [
      { id: asEndingId('ending_trust'), name: '合作', description: '合作',
        requirements: [{ kind: 'npc_affinity_at_least', npcId, value: 10 }] },
      { id: asEndingId('ending_doubt'), name: '分歧', description: '分歧',
        requirements: [{ kind: 'npc_affinity_at_most', npcId, value: 9 }] },
    ],
  });
  const job = createPendingJob();
  const base = createMinimalStoryState({ status: 'provider_pending', mode: 'ai', job, lastPresentedScene: null });
  const { repo, getRecord } = createInMemoryRepo({ gameId: asGameId('protocol-only-repair'), worldState,
    storyState: { ...base, endingAllowed: true, currentAct: 3, storyProgress: 100, turnNumber: 1 },
    revision: 0, createdAt: '2026-01-01' });
  const beforeLedger = structuredClone(worldState.eventLedger);
  const scene = { segments: [{ beatId: 'atmosphere', text: '掌柜等着你表明立场。' }],
    npcLine: null, objectiveLink: null, choices: [] };
  const authorComplete = vi.fn<RpgAiClient['complete']>(async () => ({ ok: true, content: JSON.stringify({
    worldDelta: null, sceneDrafts: [{ slotKey: 'current', scene }],
    endingOutcomes: ['trust', 'doubt'].map(themeKey => ({ themeKey, choiceLabel: '当面表达立场', scene })),
  }) }));
  const reviewComplete = vi.fn<RpgAiClient['complete']>(async (_role, messages) => {
    const verdict = fixtureNarrativeReviewPass(messages);
    const first = verdict.executionChecks![0]!;
    first.participants = [{ quote: first.quote, npcId: String(PLAYER_ENTITY_ID), locationId: String(LOC_0) }];
    return { ok: true, content: JSON.stringify(verdict) };
  });
  const policy: RpgAiClient['policy'] = () => ({ thinking: 'off', timeoutMs: 45000,
    maxTokens: 8000, jsonMode: 'prompt_only', maxAttempts: 1 });
  const result = await generatePendingNarrativeBundle({ repository: repo,
    source: createNarrativeBundleSource({ aiClient: { complete: authorComplete, policy } }),
    reviewer: createLiveNarrativeCandidateReview({ aiClient: { complete: reviewComplete, policy } }),
    now: () => '2026-01-01T00:00:00.000Z' });
  expect(result.ok).toBe(false);
  expect(authorComplete).toHaveBeenCalledTimes(1);
  expect(reviewComplete).toHaveBeenCalledTimes(2);
  expect(getRecord()!.worldState.eventLedger).toEqual(beforeLedger);
  expect(getRecord()!.storyState.narrative.status).toBe('provider_failed');
});
```

给该测试文件的 `@/game/domain/worldEntity` 导入补上已有的 `asEndingId`。这项测试核对同一个 A 后状态与 B 失败，不声称浏览器/SQLite E2E 已通过。

- [ ] **Step 5：保留真实缺陷负例。** 远程 boatman 被写在 inner_hall、未执行核验却宣告凭记合看成功、talk 变物品转移都继续返回对应非空 defects；其作者修订次数受三版本限制，不能改成审阅重试或 quality observation。
- [ ] **Step 6：运行 GREEN。**

```bash
npx vitest run src/game/application/server/ai/narrativeExecutionChecks.test.ts src/game/application/server/ai/liveNarrativeCandidateReview.test.ts src/game/application/generatePendingNarrativeBundle.test.ts
```

- [ ] **Step 7：提交并完成 G1 中的审阅门。**

```bash
git add src/game/application/server/ai/narrativeExecutionChecks.ts src/game/application/server/ai/liveNarrativeCandidateReview.ts src/game/application/server/ai/narrativeExecutionChecks.test.ts src/game/application/server/ai/liveNarrativeCandidateReview.test.ts src/game/application/generatePendingNarrativeBundle.test.ts
git commit -m "fix(narrative): retry malformed reviews without rewriting candidates"
```

---

## Task 5：按同一调查链判断回访分享与核验完成

**Spec:** §7，P3R-04。**依赖：** Task 1。**交付：** 不再由“有一个 share 加另一个 verify”拼出闭环。

**Files:**
- Create: `src/game/gameplay/rpg/narrativeBundle/deliveryEvidenceClosure.ts`
- Create/Test: `src/game/gameplay/rpg/narrativeBundle/deliveryEvidenceClosure.test.ts`
- Modify: `src/game/gameplay/rpg/narrativeBundle/descriptors.ts`、`src/game/gameplay/rpg/narrativeBundle/index.ts`
- Modify/Test: `src/game/application/approveNarrativeBundle.test.ts`
- Read: `src/game/application/approveNarrativeBundle.ts` 中调用 closure 门禁的分支；若存在重复直接 ledger 查询，用同一 facade 替换

**Interfaces：**

```ts
import type { WorldState } from '@/game/domain/worldState';
import type { StoryState } from '@/game/domain/storyState';
import type { EventId } from '@/game/domain/events';
import type { FactId } from '@/game/domain/worldEntity';
export type DeliveryEvidenceClosure = Readonly<{
  factId: FactId; discoveryEventId: EventId;
  shareEventId: EventId; verificationEventId: EventId;
}>;
export function deliveryInvestigationFactIds(worldState: WorldState, storyState: StoryState): readonly FactId[];
export function findDeliveryEvidenceClosure(worldState: WorldState, storyState: StoryState): DeliveryEvidenceClosure | null;
```

`deliveryInvestigationFactIds` 取已批准主线 Quest（含游标已越过但保留的 objective）的 discover_fact 引用，与 giver 显式 completeWhen/合作引用、investigation Fact 取交集。不能以任意 goal/blockWhen/allowedFactIds 并集证明递送关联。v2 要求唯一候选，0 或多条由 Task 6A 在调查发布前拒绝；getter 不按数组首项猜测。

- [ ] **Step 1：写独立的跨 fact RED。** 下面代码放在已有 `src/game/application/approveNarrativeBundle.test.ts`，从 `./server/ai/p3RegressionFixture.testutil` 导入 `loadP3Record`，从 RPG narrativeBundle facade 导入新的链查询与已有门禁函数。新 gameplay 单测使用该层现有的 world/event 工厂，不向上导入 application 测试 helper。

```ts
it('does not close evidence when share and verification refer to different facts', () => {
  const record = loadP3Record('private.before8');
  const malformed = { ...record.worldState, eventLedger: record.worldState.eventLedger.map(event => {
    if (event.payload.type !== 'story_interaction_resolved' || event.payload.operation !== 'request_verification') return event;
    return { ...event, factIds: [asFactId('fact_2')], payload: { ...event.payload, factIds: [asFactId('fact_2')] } };
  }) };
  expect(findDeliveryEvidenceClosure(malformed, record.storyState)).toBeNull();
  expect(hasPendingDeliveryEvidenceClosure(malformed, record.storyState)).toBe(true);
});
```

该错配账本只作为谓词负例，不写入仓储，不声称这是合法业务过程生成的存档。新 getter 的正例读取原未改记录，完整返回 action3/action6/action7 的链。

- [ ] **Step 2：运行 RED。** `npx vitest run src/game/application/approveNarrativeBundle.test.ts`，在尚未导出新函数时先失败；再以原 `hasPendingDeliveryEvidenceClosure` 的独立 share/verify 存在性测试确认旧行为缺口。不能只把函数不存在当作整个缺陷复现。
- [ ] **Step 3：实现关联 fact 集与链搜索。** 下面给出关联集合与主搜索实现；均从现有实体组件投影，不新增关系表。

```ts
import { PLAYER_ENTITY_ID } from '@/game/domain/worldEntity';
import { entitiesOfKind } from '@/game/domain/entity';

export function deliveryInvestigationFactIds(world: WorldState, story: StoryState): readonly FactId[] {
  const giverId = story.delivery?.giverNpcId;
  if (giverId === undefined) return [];
  const giver = entitiesOfKind(world.entityStore, 'npc').find(npc => npc.core.id === giverId);
  if (giver === undefined) return [];
  const referenced = new Set<string>();
  for (const goal of giver.dynamicState.goals) {
    if (goal.resolution === undefined) continue;
    for (const condition of goal.resolution.completeWhen) {
      if (condition.kind === 'knows_fact' && condition.actorId === giverId) referenced.add(String(condition.factId));
      if (condition.kind === 'investigation_observed' && condition.npcId === giverId) referenced.add(String(condition.factId));
    }
  }
  for (const definition of giver.cooperationDefinitions ?? []) {
    for (const factId of definition.allowedFactIds) referenced.add(String(factId));
  }
  const mainFactIds = new Set(world.quests.filter(quest => quest.kind === 'main')
    .flatMap(quest => quest.objectives.flatMap(objective =>
      objective.kind === 'discover_fact' ? [String(objective.factId)] : [])));
  return entitiesOfKind(world.entityStore, 'fact')
    .filter(record => record.fact.discoveryMode === 'investigation'
      && mainFactIds.has(String(record.core.id)) && referenced.has(String(record.core.id)))
    .map(record => record.core.id).sort((a, b) => String(a).localeCompare(String(b)));
}

export function findDeliveryEvidenceClosure(world: WorldState, story: StoryState): DeliveryEvidenceClosure | null {
  const delivery = story.delivery;
  if (delivery === undefined) return null;
  const ids = new Set(deliveryInvestigationFactIds(world, story).map(String));
  if (ids.size !== 1) return null;
  const events = [...world.eventLedger].sort((a, b) => a.sequence - b.sequence);
  const giver = String(delivery.giverNpcId);
  const player = String(PLAYER_ENTITY_ID);
  const interactions = events.filter(event => event.outcome === 'success'
    && event.payload.type === 'story_interaction_resolved');
  for (const discovery of events) {
    const dp = discovery.payload;
    if (discovery.outcome !== 'success' || dp.type !== 'fact_discovered'
      || typeof dp.approachId !== 'string' || dp.approachId.trim() === ''
      || dp.evidenceQuality === undefined || !ids.has(String(dp.factId))
      || ![...discovery.actorIds, ...discovery.targetIds].some(id => String(id) === player)) continue;
    for (const share of interactions) {
      const sp = share.payload;
      if (sp.type !== 'story_interaction_resolved' || sp.operation !== 'share_known_fact'
        || String(sp.npcId) !== giver || !sp.factIds.includes(dp.factId)
        || !sp.evidenceEventIds.includes(discovery.eventId)
        || share.sequence <= discovery.sequence
        || sp.audienceIds.length !== 1 || String(sp.audienceIds[0]) !== giver
        || share.locationId == null
        || !share.actorIds.some(id => String(id) === player)
        || !share.targetIds.some(id => String(id) === giver)) continue;
      for (const verification of interactions) {
        const vp = verification.payload;
        if (vp.type !== 'story_interaction_resolved' || vp.operation !== 'request_verification'
          || String(vp.npcId) !== giver || !vp.factIds.includes(dp.factId)
          || !vp.evidenceEventIds.includes(discovery.eventId)
          || verification.sequence <= share.sequence
          || vp.audienceIds.length !== 1 || String(vp.audienceIds[0]) !== player
          || verification.locationId == null
          || !verification.actorIds.some(id => String(id) === player)
          || !verification.actorIds.some(id => String(id) === giver)
          || !verification.targetIds.some(id => String(id) === player)) continue;
        return { factId: dp.factId, discoveryEventId: discovery.eventId,
          shareEventId: share.eventId, verificationEventId: verification.eventId };
      }
    }
  }
  return null;
}
```

合法 share 是 player actor / giver target，合法 verification 是 player+giver actors / player target。先用原 `private.before8` 原样正例证明能返回完整链，再做错配负例。事件经原账本校验，live 证据还核对对应实际结算前态同场；不通过改写历史 actorIds 迎合本函数。

- [ ] **Step 4：接回原门禁。** 非 P3、没有 delivery、已合法完成递送、尚无真实 investigation 的原返回边界保持；已有调查而没有合格同源链则 pending。

```ts
if (!isP3EvidenceClosureContract(worldState)) return false;
if (storyState.delivery === undefined || isStoryDeliveryComplete(worldState, storyState)) return false;
const investigated = worldState.eventLedger.some(event => event.outcome === 'success'
  && event.payload.type === 'fact_discovered' && event.payload.evidenceQuality !== undefined);
return investigated && findDeliveryEvidenceClosure(worldState, storyState) === null;
```

所有消费者仍调用 facade，不重新实现 share/verify 检索。缺少显式关联条件由能力 preflight 报告，不回引 Task 1 的自动补绑定。

- [ ] **Step 5：补表驱动负例。** 同 fact 不同 discovery ID、verify 早于 share、错误 giver、混入 player 的 share 听众、缺实际参与者、失败事件、无关联支线事实均不关闭。合法 giver 后来移动不否定过去链；重复分享不产生第二次规则变更；普通非 P3 流程仍可行。
- [ ] **Step 6：运行 GREEN。**

```bash
npx vitest run src/game/gameplay/rpg/narrativeBundle/deliveryEvidenceClosure.test.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/server/ai/narrativeDraftProjection.test.ts
npm run typecheck
```

- [ ] **Step 7：提交。**

```bash
git add src/game/gameplay/rpg/narrativeBundle/deliveryEvidenceClosure.ts src/game/gameplay/rpg/narrativeBundle/deliveryEvidenceClosure.test.ts src/game/gameplay/rpg/narrativeBundle/descriptors.ts src/game/gameplay/rpg/narrativeBundle/index.ts src/game/application/approveNarrativeBundle.test.ts
git commit -m "fix(rpg): require a same-source delivery evidence chain"
```

---

## Task 6：提取真实合作准入，避免测试再造一套规则

**Spec:** §8.4，P3R-06。**依赖：** Task 5。**交付：** 生产执行和只读采集使用相同合作条件；legacy 不带定义的行为不被强制改为新模型。

**Files:**
- Modify: `src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.ts`
- Modify: `src/game/gameplay/rpg/storyInteraction/index.ts`
- Modify/Test: `src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.test.ts`
- Modify/Test: `src/game/gameplay/rpg/narrativeBundle/descriptors.ts`、`descriptors.test.ts`
- Modify/Test: `src/game/application/storyConsequenceContext.ts`、`storyConsequenceContext.test.ts`
- Modify/Test: `src/game/application/approveNarrativeBundle.test.ts`（choice/registry/read model/resolver 一致性）
- Modify/Test: `src/dependencyBoundaries.test.ts`（仅当新增 facade 导出检查实际需要时）

**Interfaces（放在现有 resolver 中，避免与 `evaluateStoryCondition` 循环依赖）：**

```ts
export type NpcCooperationProbe = Readonly<{
  npcId: NpcId;
  operation: 'request_introduction' | 'request_verification';
  factIds: readonly FactId[];
  audienceIds: readonly EntityId[];
  evidenceEventIds: readonly EventId[];
}>;
export type NpcCooperationEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly disposition: 'blocked' | 'rejected'; readonly reason:
      'NPC_UNAVAILABLE' | 'NOT_COLOCATED' | 'OPERATION_NOT_APPROVED' |
      'GOAL_CONDITIONS_UNMET' | 'SCOPE_NOT_APPROVED' | 'KNOWLEDGE_MISSING' |
      'DISCLOSURE_DENIED' | 'EVIDENCE_MISSING' };
export function checkNpcCooperation(worldState: WorldState, probe: NpcCooperationProbe): NpcCooperationEligibility;
```

`EventId` 从 domain/events 引入；既有 EntityId/NpcId/FactId 沿原文件。不要从 application/testing 回调生产模块。

- [ ] **Step 1：用现有 resolver tests 的 `world()`、`interaction()` 和常量写 RED。**

```ts
it('uses the same declared goal gate for read-only and real cooperation', () => {
  const definition: NpcCooperationDefinition = {
    operation: 'request_introduction',
    requirements: [{ kind: 'goal_status', npcId: MESSENGER, goalId: `${MESSENGER}_goal_1`, status: 'completed' }],
    allowedFactIds: [FACT], allowedAudienceIds: [PLAYER_ENTITY_ID, WITNESS],
  };
  const proposed = interaction();
  const current = world(proposed, { cooperationDefinitions: [definition] });
  const before = JSON.stringify(current);
  const probe = checkNpcCooperation(current, { npcId: MESSENGER,
    operation: 'request_introduction', factIds: proposed.factIds,
    audienceIds: proposed.audienceIds, evidenceEventIds: proposed.evidenceEventIds });
  expect(probe).toEqual({ allowed: false, disposition: 'blocked', reason: 'GOAL_CONDITIONS_UNMET' });
  expect(JSON.stringify(current)).toBe(before);
});
```

同一个 fixture 实际 `resolveStoryInteraction` 仍必须返回 blocked；复用该文件已有 ResolveDeps 构造，不通过 only `validateAction` 代替，因为合作条件在 resolver 内才执行。

- [ ] **Step 2：运行 RED。** `npx vitest run src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.test.ts`。
- [ ] **Step 3：提取而非改写条件。** 复用同文件的 `npcOf`、`cooperationDefinitionFor`、`evaluateStoryCondition`、`subsetOf`、`knownFacts`、`canDiscloseFactToAudience`、`evidenceExists`。核心如下：

```ts
export function checkNpcCooperation(worldState: WorldState, probe: NpcCooperationProbe): NpcCooperationEligibility {
  const npc = npcOf(worldState, probe.npcId);
  if (npc === undefined) return { allowed: false, disposition: 'rejected', reason: 'NPC_UNAVAILABLE' };
  if (npc.position.locationId !== worldState.currentLocationId) return { allowed: false, disposition: 'rejected', reason: 'NOT_COLOCATED' };
  const definition = cooperationDefinitionFor(npc, probe.operation);
  if (npc.cooperationDefinitions !== undefined) {
    if (definition === undefined) return { allowed: false, disposition: 'rejected', reason: 'OPERATION_NOT_APPROVED' };
    if (definition.requirements.some(condition => !evaluateStoryCondition(worldState, condition))) {
      return { allowed: false, disposition: 'blocked', reason: 'GOAL_CONDITIONS_UNMET' };
    }
    if (probe.factIds.length === 0 || probe.audienceIds.length === 0
      || !subsetOf(probe.factIds, definition.allowedFactIds)
      || !subsetOf(probe.audienceIds, definition.allowedAudienceIds)) {
      return { allowed: false, disposition: 'rejected', reason: 'SCOPE_NOT_APPROVED' };
    }
  }
  if (!knownFacts(worldState, probe.npcId, probe.factIds)) {
    return { allowed: false, disposition: 'rejected', reason: 'KNOWLEDGE_MISSING' };
  }
  if (!probe.factIds.every(factId => probe.audienceIds.every(audienceId =>
    canDiscloseFactToAudience(worldState, probe.npcId, factId, audienceId)))) {
    return { allowed: false, disposition: 'rejected', reason: 'DISCLOSURE_DENIED' };
  }
  if (probe.operation === 'request_verification' && !evidenceExists(worldState, probe.evidenceEventIds)) {
    return { allowed: false, disposition: 'rejected', reason: 'EVIDENCE_MISSING' };
  }
  return { allowed: true };
}
```

在真实 resolver 保留原 interaction 存在、condition、实体引用、受众和基础结构检查，合作两种 operation 将重复的 definition/knowledge/disclosure/evidence 分支委托该函数。`blocked` 继续使用原 `blockedResult`，`rejected` 对应现有反馈字符串，不把所有拒绝改成相同反馈；`share_known_fact` 和 `promise_confidentiality` 不改。

生产选项也必须接入：`preparedNpcContext` 的 interaction.condition 通过后，对两种合作 operation 调相同 guard；`storyConsequenceContext.activeInteractionIds` 同步。到达槽把 world.currentLocationId 设为服务端 descriptor 的预期到达 location，仅用于只读准入，不能改实体或提前授知。测试当前远程 NPC 被拒绝、合法到达槽仍有选项、未满足目标的当前 choice 无法批准、满足后正式 registry/UI 暴露并真实结算。不要对所有普通 talk 调合作 gate。

- [ ] **Step 4：回归允许/拒绝和 legacy。** 现有 active-goal 允许例、未声明 operation、保密/受众拒绝、目标完成后的允许、undefined 与空 definitions 的区别均通过；函数无写入无 provider。collector 不得将没有显式 definition 的 legacy allowed 当成 C3 证明。
- [ ] **Step 5：运行 GREEN。**

```bash
npx vitest run src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.test.ts src/game/domain/npcGoalResolution.test.ts
npm run test:boundaries
```

- [ ] **Step 6：提交。**

```bash
git add src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.ts src/game/gameplay/rpg/storyInteraction/index.ts src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.test.ts src/game/gameplay/rpg/narrativeBundle/descriptors.ts src/game/gameplay/rpg/narrativeBundle/descriptors.test.ts src/game/application/storyConsequenceContext.ts src/game/application/storyConsequenceContext.test.ts src/game/application/approveNarrativeBundle.test.ts
git commit -m "refactor(rpg): share authoritative cooperation eligibility"
```

---

## Task 6A：在调查发布前形成可执行的能力契约

**Spec:** §4、§7.2–7.3、§8.4，P3R-13。**依赖：** Task 1、5、6。**交付：** 删除自动补绑定后，正常作者能在有限修订内明确提出规则链；缺项在发布前定位，不到结局才发现死路。

**Files:**
- Create/Test: `src/game/application/p3CapabilityCoverage.ts`、`p3CapabilityCoverage.test.ts`
- Modify/Test: `src/game/application/approveNarrativeBundle.ts`、`approveNarrativeBundle.test.ts`
- Modify/Test: `src/game/application/server/ai/openingNarrativePrompt.ts`、`narrativeContext/narrativeBundleContext.ts`、`liveNarrativeBundleSource.test.ts`
- Modify/Test: `src/game/application/testing/narrativeP3Journey.testutil.ts`、`narrativeP3Journey.test.ts`
- Modify/Test: `scripts/narrativeP3Journey.mjs`、`narrativeP3Journey.node-test.mjs`

**Interfaces:** application 新函数只读预审批状态，不负责产生目标或选项。

```ts
type P3CoverageResult =
  | { ok: true; required: false }
  | { ok: true; required: true; factId: FactId; giverNpcId: NpcId;
      witnessNpcId: NpcId; witnessGoalId: string }
  | { ok: false; code: 'p3_capability_fact' | 'p3_capability_goal'
      | 'p3_capability_cooperation' | 'p3_capability_revisit'; path: string };
export function validateP3CapabilityCoverage(input: {
  worldState: WorldState; storyState: StoryState;
}): P3CoverageResult;
```

- [ ] **Step 1：用未绑定的真实 fork 写 RED，并增加完整离线正例。** 真实 live44 fork 两个 NPC 都没有 cooperationDefinitions，必须返回 cooperation/goal 缺项，不能由程序安装。正例让作者同包创建现场 NPC 的“完成本次见证”目标与绑定，两个 clean 方法仅见证不同；giver 的核验 definition 以本人 knows_fact 为前提，两路分享后都可满足。原 giver 长期目标保持未完成，不要求作者盲绑不可见目标。

```ts
const record = loadP3Record('private.before3');
expect(validateP3CapabilityCoverage(record).ok).toBe(false);
// 放在 application 测试；gameplay 层不导入此 fixture helper。
```

- [ ] **Step 2：在原开场/decision prompt 对齐生成时机。** 开场声明有限调查合作需求，不要求 town 提前生成 scene，也不预装空 cooperationDefinitions 占位（定义不可替换）。生成 investigation fact 的同包要求现场 NPC 新目标+resolution/cooperation，公开见证路先满足；给原 giver 安装以 knows_fact 为前提的核验 definition，两路真实分享后满足。不得要求 writer 凭 goalOrdinal 元数据猜旧私有目标含义；C2 默认绑定同包可见新目标。不给模型正式未来 eventId 或程序预制剧情，字段缺项走现有 repair detail。
- [ ] **Step 3：实施只读覆盖检查并接审批。** 在 P3 契约下、第一条主线 investigation 正要发布时及以后读取同一批准关系；非 P3 和尚未进入调查片段的开局返回 required=false。deliveryInvestigationFactIds 必须唯一，主线 objective、giver 核验 requirement/allowedFact、现场目标/合作均引用它；giver 调查前未知；两种方法经已有可行性规则且 witness 同场。错误 path 指向 binding/definition，用现有 world_delta_rejected/detail 修订。已有 unrelated giver goal 不强制绑定。

```ts
// approveNarrativeBundle：consequenceBindings 安装后，旧调查缺项检查旁。
const coverage = validateP3CapabilityCoverage({
  worldState: previewWorldState, storyState: previewStoryState,
});
if (!coverage.ok) return { ok: false, code: 'world_delta_rejected',
  detail: `${coverage.code}:${coverage.path}` };
```

“giver 调查前未知”只在首次绑定/调查前态检查，分享后的 B 不得因 giver 已知反而拒绝。已安装目标不因 status completed 被当作缺项；定义不允许替换。C3 是否真正分化继续由实际两路证明，结构 preflight 不冒称完成。
- [ ] **Step 4：让共享前缀在正确时点检查。** `prepareNarrativeP3SharedSnapshot` 检测到 investigation choices 后、保存 fork 前调用 coverage；返回明确缺项并保存原失败。不要在 town 初始化后立即要求未来 scene 能力，不要为补能力执行无授权 Action 或重抽开局。
- [ ] **Step 5：补发布与完整路径回归。** 无绑定、支线 fact、错 giver、空合作、所有方法无法开启均拒绝；同包显式链成功。共有核验被门槛锁死由正式 A/B 完整离线旅程检出。长期目标与条件语义不符由既有候选审阅及 C2 签核拒绝，不能声称纯结构检查理解任意中文。旧 fixture 的 installGoalResolution 只用于离线装配且须在调查前绑定，不作为 live 来源。
- [ ] **Step 6：运行定向测试、typecheck、boundaries，审查后提交本任务 Files 中实际修改项。**

```bash
npx vitest run src/game/application/p3CapabilityCoverage.test.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/testing/narrativeP3Journey.test.ts
node --test scripts/narrativeP3Journey.node-test.mjs
npm run typecheck
npm run test:boundaries
git add src/game/application/p3CapabilityCoverage.ts src/game/application/p3CapabilityCoverage.test.ts src/game/application/approveNarrativeBundle.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/server/ai/openingNarrativePrompt.ts src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/testing/narrativeP3Journey.testutil.ts src/game/application/testing/narrativeP3Journey.test.ts scripts/narrativeP3Journey.mjs scripts/narrativeP3Journey.node-test.mjs
git commit -m "fix(p3): validate authored investigation capability before publication"
```

---

## Task 7：建立完整 C1–C8 能力证据判定

**Spec:** §8，P3R-05/06/07/10/14。**依赖：** Task 6A。**交付：** 每项能力均有可重算判据，对错配目标、伪分化和反向策略链给出失败，缺资料为 not_run。

**Files:**
- Create: `src/game/application/testing/narrativeP3Acceptance.ts`
- Create/Test: `src/game/application/testing/narrativeP3Acceptance.test.ts`

**Interfaces（全部在该新模块定义）：**

```ts
export const P3_CAPABILITIES = ['C1','C2','C3','C4','C5','C6','C7','C8'] as const;
export type CapabilityId = typeof P3_CAPABILITIES[number];
export type CheckStatus = 'passed' | 'failed' | 'not_run';
export type EvidenceRef = Readonly<{ path: string; sha256: string; pointer: string }>;
export type CapabilityCheck = Readonly<{
  id: CapabilityId; status: CheckStatus; reason: string; evidence: readonly EvidenceRef[];
}>;
export type GoalProof = Readonly<{
  npcId: string; goalId: string; authoredBindingHash: string; approvedBindingHash: string;
  eventNpcId: string; eventGoalId: string; sourceEventIds: readonly string[];
  recordedSourceEventIds: readonly string[]; actualConditionSatisfied: boolean;
  semanticReview: null | { bindingHash: string; reviewer: string; approved: boolean; reason: string };
  evidence: readonly EvidenceRef[];
}>;
export type CooperationObservation = Readonly<{
  route: 'private' | 'public'; forkHash: string; checkpoint: string;
  npcId: string; operation: string; definitionHash: string; scopeHash: string;
  locationId: string; allowed: boolean; reason: string;
  offered: boolean; executedEventId: string | null;
  checkpointStep: number; executedStep: number | null;
  afterActions: readonly { actionId: string; step: number;
    retainedSourceEventIds: readonly string[]; consequencesVerified: boolean }[];
  causalEventIds: readonly string[]; evidence: readonly EvidenceRef[];
}>;
export type StrategyProof = Readonly<{
  inputStep: number; exposedAfterStep: number; selectedStep: number;
  inputActionId: string; responseActionId: string;
  inputEffectOperations: readonly string[];
  expectedKey: string; offeredKey: string; executedKey: string;
  offeredToken: string; selectedToken: string;
  selectedActionId: string; resultActionId: string;
  inputLastSequence: number; resultSequence: number;
  resultEventId: string; candidateHash: string; evidence: readonly EvidenceRef[];
}>;
export function evaluateGoalProof(proof: GoalProof | null): CapabilityCheck;
export function evaluateCooperationPair(pair: readonly CooperationObservation[]): CapabilityCheck;
export function evaluateStrategyProof(proof: StrategyProof | null): CapabilityCheck;
export function summarizeP3Acceptance(input: {
  routes: readonly { routeId: 'private' | 'public'; status: 'completed' | 'blocked' | 'not_run' }[];
  checks: readonly CapabilityCheck[];
  strictReplayPassed: boolean | null;
}): CheckStatus;
```

这些证明只能由 Task 9 从实际状态/请求/注册表生成；不是提供给模型自行填写的 JSON。Task 8/13 必须核对引用文件内容和签封 hash，不能只信这里的布尔字段。

- [ ] **Step 1：创建三个明确的 RED 测试。** 以下测试均完整定义其输入，不借用未定义“成功 fixture”。

```ts
import { describe, expect, it } from 'vitest';
import { evaluateGoalProof, evaluateCooperationPair, evaluateStrategyProof, summarizeP3Acceptance } from './narrativeP3Acceptance';

it('does not replace the intended goal with any related goal event', () => {
  const result = evaluateGoalProof({ npcId: 'giver', goalId: 'report-reviewed',
    authoredBindingHash: 'binding', approvedBindingHash: 'binding',
    eventNpcId: 'giver', eventGoalId: 'save-all-households',
    sourceEventIds: ['share:1'], recordedSourceEventIds: ['share:1'], actualConditionSatisfied: true,
    semanticReview: { bindingHash: 'binding', reviewer: 'tester', approved: true, reason: '收到报告' },
    evidence: [{ path: 'private.steps.json', sha256: 'source-hash', pointer: '/0' }] });
  expect(result.status).toBe('failed');
});
it('rejects investigation or verification before the strategy input', () => {
  expect(evaluateStrategyProof({ inputStep: 5, exposedAfterStep: 3, selectedStep: 3,
    inputActionId: 'input', responseActionId: 'input', inputEffectOperations: [],
    expectedKey: 'verify:giver:fact', offeredKey: 'verify:giver:fact', executedKey: 'verify:giver:fact',
    offeredToken: 'token', selectedToken: 'token', selectedActionId: 'click', resultActionId: 'click',
    inputLastSequence: 20, resultSequence: 10, resultEventId: 'verify:1', candidateHash: 'candidate',
    evidence: [{ path: 'private.steps.json', sha256: 'source-hash', pointer: '/1' }] }).status).toBe('failed');
});
it('does not promote two completed routes with missing capabilities', () => {
  expect(summarizeP3Acceptance({ routes: [{ routeId: 'private', status: 'completed' },
    { routeId: 'public', status: 'completed' }], checks: [], strictReplayPassed: true })).toBe('not_run');
  expect(evaluateCooperationPair([]).status).toBe('not_run');
});
```

- [ ] **Step 2：运行 RED。** `npx vitest run src/game/application/testing/narrativeP3Acceptance.test.ts`。
- [ ] **Step 3：实现纯判定。** 完整关键函数如下；不做自然语言目标等价推断。

```ts
const check = (id: CapabilityId, status: CheckStatus, reason: string,
  evidence: readonly EvidenceRef[] = []): CapabilityCheck => ({ id, status, reason, evidence });

export function evaluateGoalProof(p: GoalProof | null): CapabilityCheck {
  if (p === null) return check('C2', 'not_run', 'GOAL_PROOF_MISSING');
  if (p.evidence.length === 0 || p.semanticReview === null) return check('C2', 'not_run', 'GOAL_REVIEW_MISSING', p.evidence);
  const sources = new Set(p.recordedSourceEventIds);
  const valid = p.npcId === p.eventNpcId && p.goalId === p.eventGoalId
    && p.authoredBindingHash.length > 0 && p.authoredBindingHash === p.approvedBindingHash
    && p.sourceEventIds.length > 0 && p.sourceEventIds.every(id => sources.has(id))
    && p.actualConditionSatisfied && p.semanticReview.approved
    && p.semanticReview.bindingHash === p.approvedBindingHash
    && p.semanticReview.reviewer.trim().length > 0 && p.semanticReview.reason.trim().length > 0;
  return check('C2', valid ? 'passed' : 'failed', valid ? 'GOAL_CAUSALITY_CONFIRMED' : 'GOAL_CAUSALITY_MISMATCH', p.evidence);
}
export function evaluateCooperationPair(pair: readonly CooperationObservation[]): CapabilityCheck {
  if (pair.length !== 2) return check('C3', 'not_run', 'COOPERATION_PAIR_MISSING');
  const a = pair[0]!;
  const b = pair[1]!;
  const evidence = [...a.evidence, ...b.evidence];
  const same = a.route !== b.route && a.forkHash === b.forkHash && a.forkHash.length > 0
    && a.checkpoint === b.checkpoint && a.npcId === b.npcId && a.operation === b.operation
    && a.definitionHash === b.definitionHash && a.definitionHash.length > 0
    && a.scopeHash === b.scopeHash && a.locationId === b.locationId;
  if (!same) return check('C3', 'failed', 'COOPERATION_NOT_COMPARABLE', evidence);
  if (a.allowed === b.allowed) return check('C3', 'failed', 'NO_ACTION_ELIGIBILITY_DIVERGENCE', evidence);
  const yes = a.allowed ? a : b;
  const no = a.allowed ? b : a;
  const legitimateDenial = ['GOAL_CONDITIONS_UNMET', 'KNOWLEDGE_MISSING', 'DISCLOSURE_DENIED'].includes(no.reason);
  const retained = pair.every(p => p.causalEventIds.length > 0 && p.afterActions.length >= 2
    && (!p.allowed || p.executedStep !== null && p.executedStep >= p.checkpointStep)
    && new Set(p.afterActions.slice(0, 2).map(action => action.actionId)).size === 2
    && p.afterActions[0]!.step < p.afterActions[1]!.step
    && p.afterActions.slice(0, 2).every(action => action.step > (p.executedStep ?? p.checkpointStep)
      && action.consequencesVerified
      && p.causalEventIds.every(id => action.retainedSourceEventIds.includes(id))));
  const valid = legitimateDenial && yes.offered && yes.executedEventId !== null && !no.offered
    && retained && a.evidence.length > 0 && b.evidence.length > 0;
  return check('C3', valid ? 'passed' : 'failed', valid ? 'COOPERATION_DIVERGENCE_CONFIRMED' : 'COOPERATION_EFFECT_NOT_PROVEN', evidence);
}
export function evaluateStrategyProof(p: StrategyProof | null): CapabilityCheck {
  if (p === null) return check('C4', 'not_run', 'STRATEGY_PROOF_MISSING');
  const illegalInput = p.inputEffectOperations.some(operation =>
    ['investigate', 'request_verification', 'give_item'].includes(operation));
  const valid = !illegalInput && p.inputStep <= p.exposedAfterStep && p.exposedAfterStep < p.selectedStep
    && p.inputActionId === p.responseActionId && p.selectedActionId === p.resultActionId
    && p.expectedKey.length > 0 && p.expectedKey === p.offeredKey && p.offeredKey === p.executedKey
    && p.offeredToken.length > 0 && p.offeredToken === p.selectedToken
    && p.resultSequence > p.inputLastSequence && p.resultEventId.length > 0
    && p.candidateHash.length > 0 && p.evidence.length > 0;
  return check('C4', valid ? 'passed' : 'failed', valid ? 'STRATEGY_ORDER_CONFIRMED' : 'STRATEGY_ORDER_MISMATCH', p.evidence);
}
export function summarizeP3Acceptance(input: {
  routes: readonly { routeId: 'private' | 'public'; status: 'completed' | 'blocked' | 'not_run' }[];
  checks: readonly CapabilityCheck[]; strictReplayPassed: boolean | null;
}): CheckStatus {
  if (input.routes.some(route => route.status === 'blocked') || input.strictReplayPassed === false
    || input.checks.some(c => c.status === 'failed')) return 'failed';
  if (input.routes.length !== 2 || new Set(input.routes.map(route => route.routeId)).size !== 2
    || input.routes.some(route => route.status !== 'completed') || input.strictReplayPassed !== true) return 'not_run';
  for (const id of P3_CAPABILITIES) {
    const checks = input.checks.filter(c => c.id === id);
    if (checks.length !== 1 || checks[0]!.status !== 'passed' || checks[0]!.evidence.length === 0) return 'not_run';
  }
  return 'passed';
}
```

`exposedAfterStep` 是输入步骤 A 后 B ready 的逻辑边界，故允许等于 inputStep；selectedStep 必须严格更晚。由 record/事件重算内部 proof，不直接接受文件中的布尔值。C3 的 consequencesVerified 必须对照后续实际目标/知识状态及其来源；若状态变化，验证新事件解释了变化，不能只查旧事件仍存在。

其余 C 项须在同模块定义 `evaluateInvestigationEvidence`、`evaluateRevisitEvidence`、`evaluateRecoveryEvidence`、`evaluateUiEvidence`、`evaluateReuseEvidence`，输入为 Task 9 加载的经校验来源对象（WorldState/StoryState、steps、请求、UI events、工程记录），返回 CapabilityCheck。函数不接收预填 status；以下各行就是必须落地的判定和独立变异测试，缺任何一个函数 G2 不通过。

| 函数/能力 | 来源与通过条件 | 单因素失败测试 |
|---|---|---|
| investigation/C1 | fork fact 未知、实际 offered method、A 唯一成功 discovery；witness 与方法/在场匹配；未选方法零效果；automatic 离线回归 | 删除 discovery、加第二次发现、错 witness、方法未 offered |
| revisit/C5 | 同 giver 告知前未知/后已知且 source 为该 share；changed_revisit 源指向调查；实际 writer/reviewer 请求包含许可旧话；隐私回归 | 初始已知、source 错 action、只有 prompt 模板无实际请求 |
| recovery/C6 | 同代码工程报告内 SQLite A/B失败、retry、CAS、取消、战败回滚断言均运行通过；UI重派/持久化重开无重复 A | skip、不同代码、同 action 多次领域事件、只 mock success |
| ui/C7 | fork 相同、两路完成；真实 browser actions、同 generation/revision 的中途刷新/重开、后续 action、terminal 有序关联 | 首次导航、终局才刷新、无后续行动、reviewed 空文件 |
| reuse/C8 | 同代码预算不超、另一题材完整离线链、非 P3/P1/P2/边界回归通过 | 一个必需命令未运行、题材仅改名称未走流程、预算超限 |

为 C1/C5/C6/C7/C8 各创建一个完整正例，然后逐行只替换一个来源字段或移除必需材料；正例不是五个预填 passed 对象。类型来源复用仓库正式类型；工程记录结构在 Task 12 定义。

- [ ] **Step 4：补独立正例和变异负例。** 用完整已知正例验证 C2/C3/C4 passed，再每次只改一项：定义 hash、NPC、地点、事实 scope、没有实际 Action 成功事件、后续不足两步、输入本身执行核验、token 不对应、结果 actionId 不符、人工评审拒绝。每次输出明确 failed/not_run，避免一个测试因多个坏字段掩盖未实现检查。
- [ ] **Step 5：运行 GREEN。** `npx vitest run src/game/application/testing/narrativeP3Acceptance.test.ts` 与 `npm run typecheck`。
- [ ] **Step 6：提交。**

```bash
git add src/game/application/testing/narrativeP3Acceptance.ts src/game/application/testing/narrativeP3Acceptance.test.ts
git commit -m "test(p3): define independent capability acceptance checks"
```

---

## Task 8：冻结 v2 协议并分离通关、回放和最终验收

**Spec:** §8.1–8.2、§10，P3R-10/11。**依赖：** Task 7。**交付：** 旧 v1 不被重标通过，两个 completed 不再直接推出 P3 passed。

**Files:**
- Modify: `src/game/application/testing/narrativeP3LiveJourney.ts`
- Modify/Test: `src/game/application/testing/narrativeP3LiveJourney.test.ts`
- Modify: `scripts/narrativeP3Journey.mjs`
- Modify/Test: `scripts/narrativeP3Journey.node-test.mjs`
- Create: `scripts/narrativeP3Acceptance.mjs`
- Create/Test: `scripts/narrativeP3Acceptance.node-test.mjs`
- Modify: `package.json`（仅追加新验收器的开发脚本，零依赖变更）

**Interfaces：**

```ts
// narrativeP3LiveJourney.ts 的协议新增内容；原 budget/route/环境字段保留。
export const NARRATIVE_P3_PROTOCOL_VERSION = 'narrative-p3/v2' as const;
export type P3AcceptanceProtocol = Readonly<{
  schema: 'narrative-p3-acceptance/v1';
  required: readonly CapabilityId[];
  executors: Readonly<{ private: 'next_ui'; public: 'api' }>;
  strategy: Readonly<{ route: 'private'; checkpoint: 'after_share_before_verification';
    operation: 'request_verification'; text: string }>;
  requiresStrictReplay: true;
}>;
// 在 NarrativeP3Protocol 中添加 acceptance: P3AcceptanceProtocol。
// 在 NarrativeP3JourneyResult 中添加 acceptanceStatus: CheckStatus。
```

新 MJS 验收入口定义并导出：
`finalizeP3Acceptance({liveDirectory, replayDirectory, reviewPath, outputPath}): Promise<{status: CheckStatus; passed: boolean}>`。
CLI：`node scripts/narrativeP3Acceptance.mjs --live-directory DIR --replay-directory DIR --review FILE --output FILE`。此命令不导入 live source，不读取 API key，不调用 provider。

严格回放分支还必须以 `flag: 'wx'` 在独立 replay 输出目录写 `replay.json`（新产物，原代码没有该文件）。字段固定为：

```ts
type P3ReplayProof = Readonly<{
  schema: 'narrative-p3-replay/v1'; runId: string;
  protocolHash: string; inputHash: string; codeFingerprint: string; forkHash: string;
  status: 'passed' | 'failed' | 'not_run'; realHttpAttempts: number;
  sourceRuntimeHashes: Readonly<Record<'shared-three-act-opening-opening' | 'private' | 'public', string>>;
  sharedPrefix: { matched: boolean; replayedTransportAttempts: number; failureCode?: string };
  routes: readonly { routeId: 'private' | 'public'; matched: boolean;
    replayedTransportAttempts: number; failureCode?: string }[];
}>;
```

该对象由三条实际 runtime 的 finish/comparison 生成。共享前缀和两路都 matched、源 hash 与 audit 完整、realHttpAttempts=0 才通过。不可仅对两路签封而跳过 shared initialization/prefix。失败也写结果。`createP3ProductionRouteRunner` 必须保留 P1 返回的 replayedTransportAttempts，不能在包装 route result 时丢掉。

人工文件 `review.json` 的 schema 固定为 `narrative-p3-review/v1`，包含 `protocolHash`、`reviewer`、`reviewedAt`、`goalReviews` 和 C7 检查记录；goalReviews 每项含 `npcId`、`goalId`、`bindingHash`、`approved`、非空 `reason` 和来源 `EvidenceRef[]`。C7 记录含浏览器证据引用、真实中途 reload/后续 Action/terminal 的检查结论。只给 `.ui-reviewed` 空文件不能替代此记录。

- [ ] **Step 1：新增 v2 与缺项 RED 测试。**

```ts
it('freezes explicit capability requirements without borrowing memory HTTP budget', () => {
  const protocol = createNarrativeP3Protocol('p3-remediation-fixture', deps);
  expect(protocol.protocolVersion).toBe('narrative-p3/v2');
  expect(protocol.transport.narrativeHttpPerEpoch).toBe(24);
  expect(protocol.transport.memoryHttpPerEpoch).toBe(8);
  expect(protocol.acceptance.executors).toEqual({ private: 'next_ui', public: 'api' });
  expect(protocol.acceptance.required).toEqual(['C1','C2','C3','C4','C5','C6','C7','C8']);
});
```

在现有 Node runner 测试中让两个 routeRunner 都返回 completed，断言 raw live 结果的 `passed` 为 false、`acceptanceStatus` 为 not_run。保持原 route completed 和计数，不把正常业务通关改成没有发生。

- [ ] **Step 2：运行 RED。**

```bash
npx vitest run src/game/application/testing/narrativeP3LiveJourney.test.ts
node --test scripts/narrativeP3Journey.node-test.mjs
```

- [ ] **Step 3：冻结协议与结果类型。** 在 `createNarrativeP3Protocol` 的 hash body 中加入 acceptance，修正 transport 中被错误合并的预算字段；两份 protocol version 常量保持一致。

```ts
const acceptance: P3AcceptanceProtocol = {
  schema: 'narrative-p3-acceptance/v1', required: P3_CAPABILITIES,
  executors: { private: 'next_ui', public: 'api' },
  strategy: { route: 'private', checkpoint: 'after_share_before_verification',
    operation: 'request_verification', text: '请先对刚才取得的这份证据当面核验，再决定怎么交付。' },
  requiresStrictReplay: true,
};
```

v2 同时在 `NARRATIVE_P3_INPUT.storyOpening` 原文后追加以下能力要求，并把新 inputHash 纳入注册；不能在运行中才追加：

```ts
const remediationRequirements = '本次调查需由作者在同包现场NPC上明确声明有限目标，例如完成本次现场见证，不能以收到报告完成保护全部船户等长期目标。'
  + '须由作者显式绑定至少一项依赖实际见证或证据条件的有限合作定义，让两条调查路线在同一NPC、同一操作和范围产生后续实际准入差异；'
  + '原委托人的核验以本人获知该事实为前提，真实分享后两路均可核验，不要求绑定其不可见的旧目标。差异不能堵死共有回访、告知、核验和交付路径。所有绑定明确关联本次主线调查事实，不能依靠编译器自动填充。';
```

将该常量与原已登记开场字符串拼接后作为新的 `storyOpening`；不指定新 NPC 名字、目标 ordinal 或未生成 ID，也不直接把常量解析成生产绑定。它只约束作者的待审批提案，缺能力仍按本批失败处理。原中文契约开关所需措辞保持，未引入结构化能力迁移。

注册冻结的是角色和逻辑检查点，尚未生成的 fact/NPC ID 不伪造。实际共同初态生成后，只从该快照绑定一次，写 `fork-capabilities.json` 并 hash，两个分支使用同一份。

保留源码指纹和实际共享包 revision/版本、生效 provider 配置。注册零 HTTP。仅 live 校验实际 executor 必须 private=next_ui；replay 接受原 UI 协议，以冻结实际命令离线驱动同一生产规则链，C7 读取原 UI 证据。不能让该检查拒绝 Task 13 的合法 replay。协议默认既定参数须与实际 `loadAiConfig` 生效配置逐项比对，不只记录一个模型名。

同时更新两个 CLI 的退出语义：register 成功 exit0；live 两路业务完成可 exit0 并明确 acceptanceStatus=not_run；replay 只有 strict match exit0；最终汇总器仅综合 passed exit0。禁止继续使用所有模式统一 `result.passed ? 0 : 1`，否则本次设计会使正常 live 永远失败。

- [ ] **Step 4：新增最终汇总器，先校验来源再调用 Task 7。** 按如下完整文件引用验证 helper 使用 Node 内置 API，禁止传入 artifact 根外路径和 symlink 逃逸。

```js
import { readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export function verifyEvidenceRef(root, ref) {
  const base = realpathSync(root);
  const file = realpathSync(resolve(base, ref.path));
  const rel = relative(base, file);
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) {
    throw new Error('P3_EVIDENCE_PATH_OUTSIDE_RUN');
  }
  const bytes = readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== ref.sha256) throw new Error('P3_EVIDENCE_HASH_MISMATCH');
  let value = JSON.parse(bytes.toString('utf8'));
  if (ref.pointer !== '') {
    if (!ref.pointer.startsWith('/')) throw new Error('P3_EVIDENCE_POINTER_INVALID');
    for (const encoded of ref.pointer.slice(1).split('/')) {
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
        throw new Error('P3_EVIDENCE_POINTER_MISSING');
      }
      value = value[key];
    }
  }
  return { bytes, value };
}
```

汇总步骤固定：校验协议/来源身份，解析全部 EvidenceRef 的 value，按 Task 9 的纯派生函数从实际 record/request/event 重建 proof，然后逐项调用 Task 7。不能只验证 pointer 存在后信任 capabilities.json 的 allowed/status/actualConditionSatisfied；这些仅作显示缓存，若与重算不符为 failed。核对人工绑定签核、三流严格回放零网络，最后 `flag:'wx'` 写 acceptance.json，不覆盖旧文件。必须加“把能力 JSON 的 failed 改 passed，并重算该文件 hash，但底层记录不变，仍然失败”的测试。

缺少 review/replay/能力文件不是崩溃后无结果：写出 not_run 及缺项原因；已有文件 hash/协议错配、人工拒绝、能力负例则 failed；避免不匹配资料被误归成“还没做”。已有输出时拒绝覆盖，采用新的签封文件名。

- [ ] **Step 5：为文件校验器写实际 Node 测试。** 以下测试放入新 `.node-test.mjs`。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyEvidenceRef } from './narrativeP3Acceptance.mjs';

test('rejects a changed evidence file rather than reusing its recorded status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-evidence-'));
  try {
    const bytes = Buffer.from('{"value":1}\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(dir, 'proof.json'), bytes);
    const ref = { path: 'proof.json', sha256, pointer: '/value' };
    assert.doesNotThrow(() => verifyEvidenceRef(dir, ref));
    writeFileSync(join(dir, 'proof.json'), '{"value":2}\n');
    assert.throws(() => verifyEvidenceRef(dir, ref), /P3_EVIDENCE_HASH_MISMATCH/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

继续用 mkdtemp 的完整小型协议/证据集测试：少 C3 not_run；C3无差异 failed；两路一条 not_run；不同 runId/初态拒绝；漏一笔失败 HTTP 计数拒绝；人工 review hash 错拒绝；v1 只读不升级；合法完整集合通过。每个正例文件的 hash 实际算出，不写“任意 hash”。

- [ ] **Step 6：运行 GREEN，新增脚本。** 在 package.json 增加 `acceptance:narrative:p3` → `node scripts/narrativeP3Acceptance.mjs`，将新 Node test 加入现有 P3 script 测试命令。运行 Task 7/8 的 Vitest 与三份 P3 Node test。不要为了通过旧测试让 live/replay 的 `passed` 重新等于 routes.every。
- [ ] **Step 7：提交。**

```bash
git add src/game/application/testing/narrativeP3LiveJourney.ts src/game/application/testing/narrativeP3LiveJourney.test.ts scripts/narrativeP3Journey.mjs scripts/narrativeP3Journey.node-test.mjs scripts/narrativeP3Acceptance.mjs scripts/narrativeP3Acceptance.node-test.mjs package.json
git commit -m "test(p3): version complete acceptance separately from route completion"
```

---

## Task 9：采集真实能力并修正路线策略顺序

**Spec:** §8.3–8.7，P3R-05/06/07/14。**依赖：** Task 5、6、6A、7、8。**交付：** 从真实运行重建能力证明，采集器与最终汇总器复用同一派生函数。

**Files:**
- Create: `scripts/narrativeP3Evidence.mjs`
- Create/Test: `scripts/narrativeP3Evidence.node-test.mjs`
- Modify: `scripts/narrativeP1Journey.mjs`（只加可选观察钩子）
- Modify: `scripts/narrativeP3Journey.mjs`
- Modify/Test: `scripts/narrativeP1Journey.node-test.mjs`、`scripts/narrativeP3Journey.node-test.mjs`
- Modify: `src/game/application/testing/narrativeP3LiveJourney.ts`（输入能力要求文字/共同行为注册，不代写剧情）
- Modify/Test: `src/game/application/testing/narrativeP3LiveJourney.test.ts`
- Modify: `package.json`（将新采集器 test 纳入开发测试脚本）

**Interfaces（MJS 的 JSDoc 指明实际生产类型，不定义第二份 WorldState）：**

```ts
// MJS 以 JSDoc 实现该签名；下面导入列出实际类型来源。
import type { GameRecord } from '../src/game/application/server/persistence/gameRepository';
import type { GameSessionView } from '../src/game/application/gameSessionView';
import type { Action, Interaction } from '../src/game/domain/action';
import type { NarrativeP3Protocol } from '../src/game/application/testing/narrativeP3LiveJourney';
type Observation = {
  stage: 'ready' | 'after_action' | 'terminal';
  routeId: 'private' | 'public'; actionIndex: number;
  record: GameRecord; stateReference: string;
  view?: GameSessionView; command?: { actionId: string; expectedRevision: number; interaction: Interaction };
  action?: Action;
};
type ForkObservation = {
  record: GameRecord; stateReference: 'investigation-fork'; stream: 'shared-three-act-opening-opening';
};
function createP3EvidenceCollector(input: {
  artifactDirectory: string; protocol: NarrativeP3Protocol;
  buildChoiceMap: typeof buildChoiceMap; checkNpcCooperation: typeof checkNpcCooperation;
}): {
  observeFork(value: ForkObservation): void;
  observe(value: Observation): void;
  seal(input: { runtimePaths: readonly string[]; stepsPaths: readonly string[];
    engineeringPath?: string; uiPath?: string }): Promise<{ path: string; sha256: string }>;
};
```

这里的两个 `typeof` 指现有 application/buildChoiceMap 与 Task 6 facade 导出，不是新同名函数。collector 不接收“预期通关状态”以修改 world，不有 `performTurn` 或 provider 权限。

- [ ] **Step 1：为反向策略、同准入和错目标写 RED。** 在新 Node tests 中使用 Task 7 函数及采集器，状态来源用构建好的冻结小 fixture；另加入历史 runtime 对照作为不完整能力样本。要求：原“先调查、后策略”的顺序不能产生 C4 passed；把张力字段改成不同但相同 guard 时 C3 failed；无原作者绑定来源时 C2 not_run/failed。比较中保留原失败与未执行计数。

```js
test('does not treat an earlier investigation as execution of a later strategy', () => {
  const check = evaluateStrategyProof({ inputStep: 5, exposedAfterStep: 5, selectedStep: 3,
    inputActionId: 'private-action-5', responseActionId: 'private-action-5',
    inputEffectOperations: [], expectedKey: 'verify:giver:fact',
    offeredKey: 'verify:giver:fact', executedKey: 'investigate:fact',
    offeredToken: 'verify-token', selectedToken: 'investigation-token',
    selectedActionId: 'private-action-3', resultActionId: 'private-action-3',
    inputLastSequence: 25, resultSequence: 19, resultEventId: 'discovery', candidateHash: 'candidate',
    evidence: [{ path: 'private.steps.json', sha256: 'fixture', pointer: '/0' }] });
  assert.equal(check.status, 'failed');
});
```

该 Node 文件的具体加载头如下，沿已有 Node test 写法；不新增 ts-node/tsx 依赖。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { installTsHooks } from './narrativeP1Journey.mjs';
installTsHooks();
const { evaluateStrategyProof } = await import('../src/game/application/testing/narrativeP3Acceptance.ts');
```

- [ ] **Step 2：运行 RED。** `node --test scripts/narrativeP3Evidence.node-test.mjs scripts/narrativeP3Journey.node-test.mjs`。
- [ ] **Step 3：只添加 P1 观察钩子。** 在真实状态读取位置新增以下调用，现有 P1 policy 不提供该钩子时行为完全不变。

```js
// while 内 runtime.state(`before:${actionCount}`, state) 之后：
await policy.onObservation?.({ stage: 'ready', routeId: route.routeId,
  actionIndex: actionCount, record: state.record, view: current.view, stateReference: `before:${actionCount}` });

// A 来源不直接采用可能已包含后台 B 的 settled GET；见下方 CAS 观察契约。

// endingState 已读取、entry 关闭前：
await policy.onObservation?.({ stage: 'terminal', routeId: route.routeId,
  actionIndex: actionCount, record: endingState.record, stateReference: 'ending' });
```

此处使用已取得的 current.view。另在共享前缀保存 investigation-fork 时调用 onForkObservation，并在 `createProductionRouteRunner` 透传给 collector。不要只声明 fork 时点却没有调用点。

A 采集在 P1 runner 注入仓储时包裹原 repository.applyState：仍调用真实 SQLite/CAS，只有成功结果才保存**实际写入的参数状态和返回 revision**，按已知 command.actionId/turn 增量定位 A。B 的写入单独分类，不把下一候选状态混进 A；使用原 GameRepository 方法签名，不改生产用例接口、不额外写库。这些 A records 放独立来源文件并在 seal 时引用；严格 runtime 继续在原稳定 ready/ending 边界比较，不能随意加一个与 worker 租约竞争的 after:* GET 快照。加入“UI ensure 与 runner GET 交错，A proof 仍一致”的测试。

free_text 的 selectedAction 当前为 undefined；其 A 行动与禁执行证据必须从已提交 job.actionSummary/domainEventIds 和事件差集推导，不能把空 action 解释为“没有核验/交付”。

- [ ] **Step 4：实现 collector 的三个时点。**

| 时点 | 写出的权威数据 | 必须核对 |
|---|---|---|
| fork | 共同 record hash、调查 fact/method、目标/合作定义、对应 raw/approved 候选来源 | 定义明确存在；目标不是编译器补的；两路共用同一 fork |
| ready | 当前 view 暴露 token、buildChoiceMap 的 Action、注册表 revision、明确 checkpoint、合作 guard | 同 NPC/定义/范围/地点配对；不是同数字步数硬配 |
| after_action | A 实际事件差集、goal 状态、actionId、支持事件；策略输入有无违规执行 | 不从响应文案或 performed set 推断成功 |
| terminal/seal | 两次后续真实 Action、源事件仍保留、回访与交付链、实际 writer/reviewer 来源 | 不改 world；缺证据保留 not_run；原文件 hash 固定 |

每个观察保存实际 record 或 sealed runtime pointer。route 收尾、runtime.finish() 和 audit 写入完成后才调用 seal；公共 collector 在两路都结束（含失败/not_run）后统一签封一次，不能 private 结束就要求 public 文件存在。工程材料、UI 与人工签核缺失时允许 not_run，最终汇总再读取。

seal 必须加载三条 runtime 的实际 calls 和 approved ready 状态，按 jobId/candidateVersion/hash 找到真正发布候选；失败响应不能混入批准来源。同一纯函数导出给 Task 8 重算，collector.observe 不具备 provider/performTurn 权限。

原始绑定的 `@new.*` 与批准正式 ID 不能直接算 hash 比较。使用本次编译/审批实际符号表规范化引用，再比较 `npc/goal/condition`：`@current.location`、`@new.npc/fact/quest/item/location` 只解析本次真实创建对象；goalOrdinal 映射本次该 NPC 原始 goals 顺序。没有该映射就失败，禁止用中文名称、后续新实体或数组猜测。记录 raw pointer、符号表和规范化对象三份证据。

具体获取方式：seal 从该调用的已提交前态和原作者 raw 重走真实 draft compile/approval 的纯预览，复用 `approveNarrativeBundle.ts` 中 `sceneSymbolBindings` 的实际结果；将该 helper 作为 application 内部命名导出给测试/采集使用（不从客户端 facade 导出），或在 approval 返回值增加非持久化的 binding provenance。选前者以保持返回接口最小，Files/提交清单加入 approveNarrativeBundle.ts 与其测试。重建 proposal hash 和批准状态绑定必须与 runtime 对上才接受；不能凭 goalOrdinal 自行猜一个新实体 ID。

- [ ] **Step 5：C3 用真实 guard 和真实 Action，不只比较 token。** 绑定唯一可比较的共同 cooperationDefinition，将 probe 中 `evidenceEventIds` 绑定到各自路线同一 fact 的真实 discovery（两路 eventId 不同正常，不能复制另一条路的 ID）。拒绝原因只能来自 Task 6。允许路必须暴露实际 Action 并真正提交；拒绝路不得伪造 token做 mutation。观测之后两路各保留两次实际 Action 及源事件，未完成就 C3 not_run/failed。

为 selectChoice 增加优先级：调查结果 ready → 采集冻结 checkpoint → 若 guard allowed 则选同定义/scope 的真实合作 → 再走回访分享；guard denied 则保留拒绝原因并正常回访。删掉旧选择器“private 且调查前可自由输入就 return undefined”的分支，它与本计划 after_share 策略冲突，会造成无选择。C3 未执行前不能让旧 private revisit/public townReturn 优先带玩家离场。

如果 shared fork 没有显式有限目标或合作定义、条件不可能制造区别，记录能力覆盖不足并停止本次批次；不得现场补 definition 或自动抽另一个开局。可改已登记测试输入后启动**新批次**，全部旧失败计数保留。

- [ ] **Step 6：修 selectInteraction 的时点。** 从当前 ledger 查原委托人同 fact 的成功 share，尚无其后的 verify，当前 view 有该 NPC 的 freeInputEnabled；只有 private、尚未输入策略时触发。替换原“遇到第一个能输入的 NPC 就输入”的逻辑。

```js
selectInteraction: ({ route, view, state, performed }) => {
  if (p3RouteId(route) !== 'private' || performed.has('strategy_freeform_submitted')) return undefined;
  const giver = state.record.storyState.delivery?.giverNpcId;
  if (giver === undefined) return undefined;
  const events = state.record.worldState.eventLedger;
  // forkCapabilities 来自 observeFork 冻结并验证的当前共同快照。
  const factId = forkCapabilities.factId;
  const shared = events.find(event => event.outcome === 'success'
    && event.payload.type === 'story_interaction_resolved'
    && event.payload.operation === 'share_known_fact' && event.payload.npcId === giver
    && event.payload.factIds.includes(factId)
    && event.payload.evidenceEventIds.some(id => events.some(source => source.eventId === id
      && source.payload.type === 'fact_discovered' && source.payload.evidenceQuality !== undefined
      && event.payload.factIds.includes(source.payload.factId))));
  if (shared === undefined) return undefined;
  const verified = events.some(event => event.sequence > shared.sequence && event.outcome === 'success'
    && event.payload.type === 'story_interaction_resolved' && event.payload.operation === 'request_verification'
    && event.payload.npcId === giver && shared.payload.factIds.some(id => event.payload.factIds.includes(id)));
  if (verified) return undefined;
  const npc = view.narrative.npcDialogues.find(dialogue => dialogue.npcId === giver && dialogue.freeInputEnabled);
  if (npc === undefined) return undefined;
  return { kind: 'free_text', targetNpcId: npc.npcId, text: protocol.acceptance.strategy.text };
},
```

`createNarrativeP3RoutePolicy(protocol)` 内设 `let forkCapabilities`，由新 onForkObservation 使用 Task 6A 结果一次赋值；selectInteraction 前必须已初始化，缺失返回明确能力错误，不 fallback 任意 fact。所有调用/测试传冻结协议。C4 选择匹配 giver/fact/audience 的核验；无选项为能力失败，不能普通 talk 冒充。策略已输入但未核验时优先匹配选项，不转向另一 NPC 的核验。

- [ ] **Step 7：删掉宽松完成判据，保留业务完成事实。** 从原 `p3RouteSatisfied` 移除“任意 goalChanged”“nextIndex !== index”的伪能力判断。routeCompleted 使用真实 terminal ready、合法交付/登记允许退出及本路线必要业务结果；C2/C3/C4 交给独立证据判定，不以 prepared 文本或 performed marker 判成功。v2 默认两路交付；若要覆盖主动退出，必须新协议显式声明，不能事后把卡死路线改判退出成功。
- [ ] **Step 8：运行 GREEN 与 P1 隔离回归。**

```bash
node --test scripts/narrativeP1Journey.node-test.mjs scripts/narrativeP3Journey.node-test.mjs scripts/narrativeP3Evidence.node-test.mjs
npx vitest run src/game/application/testing/narrativeP3Acceptance.test.ts src/game/application/testing/narrativeP3LiveJourney.test.ts
```

P1 不提供新 hook 时调用/动作不变；新hook不能消耗HTTP；C3 fixture既有机制有区别仍通过，历史live44没有区别不能被“优化”成通过。
- [ ] **Step 9：提交并完成 G2。**

```bash
git add scripts/narrativeP3Evidence.mjs scripts/narrativeP3Evidence.node-test.mjs scripts/narrativeP1Journey.mjs scripts/narrativeP3Journey.mjs scripts/narrativeP1Journey.node-test.mjs scripts/narrativeP3Journey.node-test.mjs src/game/application/testing/narrativeP3LiveJourney.ts src/game/application/testing/narrativeP3LiveJourney.test.ts package.json
git commit -m "test(p3): collect causal capability evidence from real actions"
```

---

## Task 10：修复 UI 未确认派发后的无限等待

**Spec:** §9.1，P3R-08。**依赖：** 无，可独立实施。**交付：** transport 失败允许有限重派，成功确认后 GET-only，旧回调不会污染新 job。

**Files:**
- Create: `src/components/narrativeEnsureDispatch.ts`
- Create/Test: `src/components/narrativeEnsureDispatch.test.ts`
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify/Test: `src/components/CurrentGameScreen.test.tsx`
- Modify/Test: `src/components/gameActionRequest.ts`、`gameActionRequest.test.ts`（ensure/current 请求 15 秒有限等待）
- Test: `src/game/application/server/ai/_shared/ensureCoordinator.test.ts`、`src/game/application/server/providerTriggerBoundary.test.ts`

**Interfaces（新模块无网络/React 依赖）：**

```ts
export type DispatchTicket = Readonly<{ jobKey: string; serial: number }>;
export function createNarrativeEnsureDispatch(): {
  activate(jobKey: string | null): void;
  begin(now: number): DispatchTicket | null;
  finish(ticket: DispatchTicket, result: { ok: boolean; retryable: boolean }, now: number): void;
  restartConnection(): boolean;
  status(): 'idle' | 'waiting' | 'sending' | 'confirmed' | 'stopped' | 'exhausted';
};
```

confirmed 只来自 ok=true。stopped 表示明确业务拒绝后等待 GET 更新，不自动调用重置 epoch 的 retry；exhausted 才显示重连按钮。

- [ ] **Step 1：先用真实组件测试复现旧行为。** 追加到 `CurrentGameScreen.test.tsx`，复用其 `pendingPrologueView`、现有网络 mock 和 cleanup。

```ts
it('retries an unacknowledged ensure without invoking business retry', async () => {
  vi.useFakeTimers();
  vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: 'active', view: pendingPrologueView });
  vi.mocked(ensureNarrative)
    .mockResolvedValueOnce({ ok: false, code: 'INFRASTRUCTURE_FAILURE' })
    .mockResolvedValue({ ok: true, result: 'already_running' });
  render(<CurrentGameScreen />);
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
  expect(ensureNarrative).toHaveBeenCalledTimes(2);
  expect(retryNarrative).not.toHaveBeenCalled();
});
```

- [ ] **Step 2：运行 RED。** `npx vitest run src/components/CurrentGameScreen.test.tsx`。旧实现只调用一次 ensure，GET 再多也不能让此测试通过。
- [ ] **Step 3：实现独立记账控制器。**

```ts
export function createNarrativeEnsureDispatch() {
  let key: string | null = null;
  let serial = 0;
  let active: DispatchTicket | null = null;
  let attempts = 0;
  let confirmed = false;
  let stopped = false;
  let nextAt = 0;
  function reset() { active = null; attempts = 0; confirmed = false; stopped = false; nextAt = 0; }
  return {
    activate(jobKey: string | null) {
      if (jobKey !== key) { key = jobKey; reset(); }
    },
    begin(now: number): DispatchTicket | null {
      if (key === null || confirmed || stopped || active !== null || attempts >= 3 || now < nextAt) return null;
      attempts += 1;
      active = { jobKey: key, serial: ++serial };
      return active;
    },
    finish(ticket: DispatchTicket, result: { ok: boolean; retryable: boolean }, now: number) {
      if (active?.serial !== ticket.serial || key !== ticket.jobKey) return;
      active = null;
      if (result.ok) { confirmed = true; return; }
      if (!result.retryable) { stopped = true; return; }
      nextAt = now + (attempts === 1 ? 1_000 : 2_000);
    },
    restartConnection() {
      if (key === null || active !== null || confirmed || stopped || attempts < 3) return false;
      reset();
      return true;
    },
    status(): 'idle' | 'waiting' | 'sending' | 'confirmed' | 'stopped' | 'exhausted' {
      if (key === null) return 'idle';
      if (confirmed) return 'confirmed';
      if (stopped) return 'stopped';
      if (active !== null) return 'sending';
      return attempts >= 3 ? 'exhausted' : 'waiting';
    },
  };
}
```

延时是重派最早允许时间；实际请求仍由 UI poll 串行驱动，不承诺网络延迟。serial 不随同名 job 的新连接周期清零，防止迟到响应误匹配。

先为 gameActionRequest 的 ensure/current 增加每请求 15,000ms AbortController，计时器覆盖 fetch 与 response.json，finally 清理。公开 retry 参数和 API body 保持不变；timeout 沿原错误返回，不启动业务 retry。核心写法放在这两个既有函数内部，避免新增无业务公共网络框架：

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15_000);
// 原 try 中的 fetch 传入 signal: controller.signal；沿用原 catch 错误结果。
// 原 try/catch 后新增 finally { clearTimeout(timer); }
```

测试请求和 JSON body 永不完成、超时后收到迟到结果、三个超时耗尽、GET 超时后仍重试；mock fetch 要遵守 abort rejection。保留同 job 服务端单 worker 保证，不能把 abort 当作已取消生成。

- [ ] **Step 4：接回 React effect。** 删除过早赋值 `observedPendingJobKey`；useRef 保存 controller，useState 保存连接失败提示及用户新连接周期。执行下列调用顺序，特别是 controller.finish 在取消 UI 状态更新前完成，以免 StrictMode 清理旧 effect 后留下永不解除的 inFlight。

```ts
const dispatch = useRef(createNarrativeEnsureDispatch());
const [dispatchCycle, setDispatchCycle] = useState(0);
const [connectionExhausted, setConnectionExhausted] = useState(false);

useEffect(() => {
  dispatch.current.activate(pendingJobKey);
  if (pendingJobKey === null) { setConnectionExhausted(false); return; }
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readFailures = 0;
  async function poll() {
    const ticket = dispatch.current.begin(Date.now());
    if (ticket !== null) {
      let outcome: { ok: boolean; retryable: boolean };
      try {
        const response = await ensureNarrative();
        outcome = { ok: response.ok, retryable: !response.ok && response.code === 'INFRASTRUCTURE_FAILURE' };
      } catch { outcome = { ok: false, retryable: true }; }
      dispatch.current.finish(ticket, outcome, Date.now());
    }
    if (cancelled) return;
    setConnectionExhausted(dispatch.current.status() === 'exhausted');
    const response = await fetchCurrentGame();
    if (cancelled) return;
    if (response.status === 'error') {
      readFailures += 1; // 保留当前 active view，不能把连接抖动当成存档消失。
    } else {
      readFailures = 0;
      applyResponse(response);
    }
    timer = setTimeout(() => void poll(), readFailures === 0 ? 750 : Math.min(5_000, readFailures * 1_000));
  }
  void poll();
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
}, [pendingJobKey, applyResponse, dispatchCycle]);
```

确认 pending 消失时停止原循环；若当前响应显示 ready/failed/ending，可以在本次 poll 内直接不安排下一 timer，避免多一次无用 GET。GET 初次加载失败仍沿原页面 unreachable；这里只有已知 active pending 期间的暂时 read error 保留最后状态。

UI 的 active pending 展示分支插入下面可复用提示，包括序幕阅读中的 pending 展示；不只加在最终 shell 以致黑屏序幕看不到重连。

```tsx
{connectionExhausted ? <div role="alert">
  <p>生成请求尚未确认，请检查连接后重新连接。</p>
  <InlineButton onClick={() => {
    if (dispatch.current.restartConnection()) {
      setConnectionExhausted(false);
      setDispatchCycle(value => value + 1);
    }
  }}>重新连接生成请求</InlineButton>
</div> : null}
```

- [ ] **Step 5：写控制器边界测试及组件耗尽测试。** 控制器测试的代表代码如下；另覆盖0/999/1000ms、第二次2秒门槛、三次上限、manual reset、job变更及两请求并发。

```ts
it('ignores a late acknowledgement for a replaced job', () => {
  const d = createNarrativeEnsureDispatch();
  d.activate('old');
  const old = d.begin(0)!;
  d.activate('new');
  const current = d.begin(0)!;
  d.finish(old, { ok: true, retryable: false }, 1);
  expect(d.status()).toBe('sending');
  d.finish(current, { ok: false, retryable: true }, 1);
  expect(d.status()).toBe('waiting');
});
```

组件持续 INFRASTRUCTURE_FAILURE：8秒后 exactly3次 ensure，存在重连按钮，`retryNarrative` 零调用；点击按钮只再启动同 job 的连接轮。ok queued/already_running 后持续 pending 只 GET；切新 job、unmount、StrictMode 双 effect 不漏派、不重复 worker。真正业务 failed 状态仍使用原 retry 按钮，不自动重置 epoch。

- [ ] **Step 6：服务端保证复验。** `ensureCoordinator.test.ts` 验证同时/重复同 job ensure 只一个 work item；`providerTriggerBoundary.test.ts` 验证 GET 不发起生成、ensure 不重做 A。测试要保留原 action/event数量，不能只检查函数被调用。
- [ ] **Step 7：运行 GREEN。**

```bash
npx vitest run src/components/narrativeEnsureDispatch.test.ts src/components/CurrentGameScreen.test.tsx src/game/application/server/ai/_shared/ensureCoordinator.test.ts src/game/application/server/providerTriggerBoundary.test.ts
npm run typecheck
```

- [ ] **Step 8：提交。**

```bash
git add src/components/narrativeEnsureDispatch.ts src/components/narrativeEnsureDispatch.test.ts src/components/CurrentGameScreen.tsx src/components/CurrentGameScreen.test.tsx src/components/gameActionRequest.ts src/components/gameActionRequest.test.ts
git commit -m "fix(ui): retry unacknowledged narrative dispatch within bounds"
```

---

## Task 11：对齐实际 UI 检查点与验收诊断

**Spec:** §9.2–9.3、§10.2，P3R-09/15。**依赖：** Task 8–10。**交付：** private 从页面派发 B，经持久化重开和中途刷新继续；不暗示跨进程续跑。

**Files:**
- Modify: `scripts/narrativeP3UiJourney.mjs`
- Modify/Test: `scripts/narrativeP3UiJourney.node-test.mjs`
- Modify: `scripts/narrativeP3Evidence.mjs`（仅消费 UI 证明引用）
- Modify/Test: `scripts/narrativeP3Evidence.node-test.mjs`

**追加 Files:** `scripts/narrativeP1Journey.mjs`、`narrativeP1Journey.node-test.mjs`（UI 接管时的等待器与重开回调）。

**Interfaces:** 原 `createUiCommandGate` 的生产 API 返回 shape 不变。新增事件：

```ts
type UiAcceptanceEvent =
  | { kind: 'command_rejected'; layer: 'acceptance'; reason: 'UI_COMMAND_MISMATCH'; expectedRevision: number | null; receivedRevision: number }
  | { kind: 'refresh_after_action'; actionId: string; revision: number; refreshRevision: number }
  | { kind: 'lifecycle'; resumeMode: 'same_process_only'; protocolHash: string };
```

已存在 `ready`、`expected_command`、`browser_action`、`refresh_before`、`refresh_verified`、terminal 事件沿用；JSON Schema/解析器必须接受明确新增字段，不能任意松化。

- [ ] **Step 1：写 gate 负例 RED。** 新测试直接调用真实 `createUiCommandGate`，定义全部输入。

```js
test('labels a route mismatch as acceptance rejection without calling production', async () => {
  const events = [];
  let calls = 0;
  const gate = createUiCommandGate({
    getEntry: () => ({ performTurn: async () => { calls++; return { ok: true, revision: 2 }; } }),
    record: event => events.push(event),
  });
  const expected = { actionId: 'expected', expectedRevision: 1,
    interaction: { kind: 'fixed_choice', choiceToken: 'expected-token' } };
  const waiting = gate.wait(expected, 'trace');
  const rejectObserved = waiting.catch(error => error.message);
  try {
    const result = await gate.submit({ ...expected, interaction: { kind: 'fixed_choice', choiceToken: 'another-current-token' } });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.ok(events.some(e => e.kind === 'command_rejected' && e.layer === 'acceptance'));
  } finally { gate.close(); await rejectObserved; }
});
```

- [ ] **Step 2：运行 RED。** `node --test scripts/narrativeP3UiJourney.node-test.mjs`；旧逻辑没有分层 rejection 记录。
- [ ] **Step 3：增加诊断，不放松 exact command 校验。** 在 gate 的现有拒绝分支写事件，返回仍为原 INVALID_REQUEST。不能将用户点错路线的另一选项直接改绑为 expected token。

```js
record({ kind: 'command_rejected', layer: 'acceptance', reason: 'UI_COMMAND_MISMATCH',
  expectedRevision: expected?.command.expectedRevision ?? null,
  receivedRevision: command.expectedRevision });
```

production 自己的 stale/token/规则拒绝仍来自真正 performTurn 的结果，保存原 code，不标成 acceptance mismatch。

- [ ] **Step 4：固定中途刷新门。** 保留 `GET /` + `sec-fetch-mode=navigate`、曾成功 browser_action、ready、`ending===null` 的触发条件；验证 GET 后同 hash/revision，记录 refresh_verified。之后的第一笔成功 browser_action 写 `refresh_after_action`，最终 C7 必须同时具备这两项。

先消除后台代派发：P1 路线 while 使用 `uiDriver.waitUntilReady(traceId)`（只 GET、沿原 deadline/signal 等待）；无 driver 时用原 waitForNarrativeP1Generation。shared 初始化不受影响。UI wrapper 的 ensure 记录 jobKey、请求结果。页面未派发时 B 必须保持 pending，不能由 runner 推进。

openUiDriver 增加 `reopenEntry(): Promise<void>` 回调，P1 关闭旧 entry 再用原 createEntry 重开同 SQLite；只在无 action 提交、ready 的刷新节点调用。wrapper 经 getEntry 动态读取新 entry。记录 repository_reopened 的 generationId/revision/前后语义 hash，随后浏览器真实导航、GET、继续 action；不能只写事件而未实际重开。首次加载和 ending 后重开不计中途恢复。

```js
// 替换 openP3UiDriver 内原 record；evidence、path 是该函数已有局部变量。
let awaitingRefreshRevision;
const append = event => {
  evidence.push(event);
  writeFileSync(path, JSON.stringify({ executor: 'next_ui', evidence }, null, 2));
};
const record = event => {
  append(event);
  if (event.kind === 'refresh_verified') awaitingRefreshRevision = event.revision;
  if (event.kind === 'browser_action' && event.ok && awaitingRefreshRevision !== undefined) {
    append({ kind: 'refresh_after_action', actionId: event.command.actionId,
      revision: event.revision, refreshRevision: awaitingRefreshRevision });
    awaitingRefreshRevision = undefined;
  }
};
```

`createUiCommandGate` 只调用已注入的 `record`。新包装器把刷新后的行动绑定到确切 `refreshRevision`；汇总器从有序事件重算这个关联，至少一对有效中途刷新及后续行动才满足要求，不只检查两个 kind 分别存在。

- [ ] **Step 5：完善 finish 和启动提示。** 启动输出 private真实UI/publicAPI、登记 protocolHash、中途刷新窗口、旧目录拒绝及 same-process-only。finish 先记录业务终局，再等待人工审阅释放；是否完成由 refresh、following action、terminal和Task8签核共同判断，不因 `.ui-reviewed` 存在跳过机器证明。输出目录已有 private.ui.json 时仍拒绝覆盖，不实现伪 resume。
- [ ] **Step 6：增加完整顺序测试。** 首次打开不是reload；ready前无成功action不计；pending刷新不计；ending后刷新不替代中途；hash变了失败；有verified没有后续action不满足；两者都有才满足；重复导航不重复推进业务。publicAPI无UI文件是符合本协议的，不强迫该路 UI driver 启动。
- [ ] **Step 7：运行 GREEN。**

```bash
node --test scripts/narrativeP3UiJourney.node-test.mjs scripts/narrativeP3Evidence.node-test.mjs scripts/narrativeP3Acceptance.node-test.mjs
```

- [ ] **Step 8：提交并完成 G3。**

```bash
git add scripts/narrativeP3UiJourney.mjs scripts/narrativeP3UiJourney.node-test.mjs scripts/narrativeP3Evidence.mjs scripts/narrativeP3Evidence.node-test.mjs scripts/narrativeP1Journey.mjs scripts/narrativeP1Journey.node-test.mjs
git commit -m "test(p3-ui): require real midgame reload and continued play"
```

---

## Task 12：运行工程回归并原位更新系统事实

**Spec:** §10–11，P3R-11、G4。**依赖：** Task 1–11。**交付：** 工程变更可追溯，各系统文档描述实际已经实现的边界，不用旧报告成绩代替新运行。

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`、`docs/agent/NPC人格知识与关系图.md`、`docs/agent/探索与任务推进.md`
- Modify: `docs/agent/MVP核心闭环.md`、`docs/agent/日志与追踪.md`
- Modify: `docs/superpowers/README.md`（仅新 Spec/Plan/报告导航）
- Create: `docs/superpowers/reports/2026-09-17-narrative-p3-remediation-engineering.md`
- Test: 现有全量测试，不替换预期以回避 Task 1–11 的负例

**Interfaces:** 报告包含源码commit/差异hash、环境、每条命令/返回码/日志引用、G0–G4与C1–C8覆盖，live/UI状态明确尚未执行。不写 current-phase、不修改只读共同规范。

同时在工程 artifacts 写 `engineering.json`：`schema='narrative-p3-engineering/v1'`、testedCommit、codeFingerprint、逐命令 argv/exitCode/logPath/logSha256、Vitest 原 JSON reporter 的每个 case 名称/status（包括 skip）、C6/C8 必需 case 索引。只从实际进程退出码与 reporter 结果生成，不手填 passed。最终批次复制该报告和所引用原日志进入 run 的 engineering/ 子目录，保留 hash；Task 8 逐项核对。目录外 EvidenceRef 不放宽。

提交代码和系统事实后，最后一次 G4 在该提交上执行，生成 JSON/report；注册/live/replay 使用同一 HEAD。最终验收报告提交放到 Task 13 之后；若提前提交文档使 HEAD 指纹改变，重新登记工程证据的源码等价性（src/scripts/package/lock/tsconfig/foundation 实际内容逐项 hash 相同），不能把旧 fingerprint 改写成新值或谎称重跑。任何实现内容变化都重新跑受影响及必需 G4 检查。

- [ ] **Step 1：先运行原命令，记录真实失败。** 使用 PowerShell 的顺序命令并在每一步检查 `$LASTEXITCODE`；以下以 shell 形式展示命令内容，不能使用分号串后只保留最后一条状态。

```bash
git diff --check
npm run typecheck
npm run lint
npm run test
npm run test:boundaries
npm run test:narrative-p3-script
npm run build
npm run check:docs
npm run test:docs
```

预期全部0。共享模块、Node版本不满足应停在G0，不得改tsconfig忽略类型、跳过跨仓库依赖边界或用语法解析通过替换。Vitest中 skip/not_run必须记录，不能从报告删掉。

- [ ] **Step 2：针对 C6/C8 做实际离线集成核对。** 在现有 `src/game/application/testing/narrativeP3Journey.testutil.ts` 驱动和对应 P3 测试中，确认调查/合作/策略/revisit/A-B失败及恢复用正式规则和仓储走完；增加另一题材的同机制用例，不依赖“旧契/何九”字面。非 P3 ordinary talk、automatic observation、旧会话两轮规则不变。

基线已有 `liveNarrativeCandidateReview.test.ts` 的 `turns semantic candidate defects into actionable author repair constraints` 失败：stable/worldDelta=null 仍要求 beatSummary 提示。拆成 stable 要求 null、需要演化时保留摘要时序约束两例，不为通过测试在 stable 强加 beatSummary。该失败必须在本任务消除并记录，不能沿用交接的“全绿”。

```bash
npx vitest run src/game/application/server/narrativeReplay.integration.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/application/performTurn.test.ts src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/retryNarrativeGeneration.test.ts
```

若为覆盖新增了实际断言，将相应测试文件加入本 Task 的提交清单；不得把“现在无测试需要改动”写成“已新增”。

- [ ] **Step 3：更新系统文档的对应章节。** 写入明确事实：编译不自动挑目标；历史依据白名单与观察者权限；malformed reviewer同hash重审；同源closure；合作只读guard与生产同源；ensure连接重试和业务retry区别；P3三层结果。未实现的结构化能力契约/跨进程resume保留为非目标，不写成已有能力。
- [ ] **Step 4：写工程报告并校对旧交接结论。** 旧交接“全部 output.ok=true”需注明历史日志有一次恢复的network_error；“只剩UI”应引用本次明确修复与新C矩阵。只追加来源明确的勘误/新报告入口，不改旧runtime/steps/routes。
- [ ] **Step 5：重跑文档检查及受影响测试，完成审查。** 检查生成文件路径、Imports、JSON pointer、fixture来源hash、README链接、Plan每项复选框是否有日志依据。报告中“复现通过”和“修复后通过”必须分列。
- [ ] **Step 6：提交工程事实。**

```bash
git add docs/agent/运行时AI导演与场景表演.md docs/agent/NPC人格知识与关系图.md docs/agent/探索与任务推进.md docs/agent/MVP核心闭环.md docs/agent/日志与追踪.md docs/superpowers/README.md docs/superpowers/reports/2026-09-17-narrative-p3-remediation-engineering.md
git commit -m "docs(p3): record corrected contracts and engineering validation"
```

若G4通过但真实运行未被授权，交付工程修复并停在这里；不能承诺后台继续，也不能标记P3总体完成。

---

## Task 13：新冻结两路真实验收、严格回放与最终签核

**Spec:** §8–11，G5。**依赖：** G0–G4通过、用户许可真实API费用与运行。**交付：** 当前修复版本的完整证据，而非拼接旧批次。

**Files:**
- Create: 新 runId 下的 `artifacts/narrative-p3/<runId>/`（此处 `<runId>` 表示执行时本步骤生成的变量，下面命令给出完整生成方式）
- Create: 对应独立 replay 输出目录
- Create: `docs/superpowers/reports/2026-09-17-narrative-p3-remediation-acceptance.md`
- 不修改: `p3-live-44`、`p3-ui-live-01` 及任何旧 schema/hash/人工标记

**Interfaces:** 消费 Task 8 v2 注册、Task 9 collector、Task 11 UI、Task 8 `finalizeP3Acceptance`。只在最终`acceptance.json`状态为passed且来源检查通过时宣布P3完成。

- [ ] **Step 1：冻结当前代码与输入，生成唯一 runId。** 先确认工作区修复已提交、无临时调试代码。下面是 PowerShell 实际命令，不填写API密钥；密钥沿原 `.env.local`/环境机制读取。

```powershell
$runId = 'p3-remediation-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$runDir = "artifacts/narrative-p3/$runId"
$replayDir = "artifacts/narrative-p3/$runId-replay"
$protocol = "$runDir/protocol.json"
node scripts/narrativeP3Journey.mjs --mode register --run-id $runId --protocol $protocol --output $runDir
if ($LASTEXITCODE -ne 0) { throw 'P3_REGISTER_FAILED' }
```

预期：仅写冻结协议，真实HTTP为0。核对privateUI/publicAPI、预算24+8、策略checkpoint、新源码指纹和foundation实际版本，不将归档ZIP标识代替当前commit。

- [ ] **Step 2：运行完整 UI/API 批次。**

```powershell
$env:RUN_REAL_AI_JOURNEY = '1'
node scripts/narrativeP3UiJourney.mjs --mode live --run-id $runId --protocol $protocol --output $runDir
$liveExit = $LASTEXITCODE
```

运行器启动后，操作者在当前进程运行期间打开其实际输出的本地URL。该步骤需要真实浏览器操作，与runner终端同时进行；不能等待终端退出后才操作UI。缺浏览器执行能力时C7未执行，不能改用HTTP代点。

共享初始化与前缀必须真实生成并审批；能力 preflight 位于调查 fork，先用 Task 6A 的原候选修订预算处理批准前缺项，耗尽或已到 fork 仍缺能力时保留失败停止，不自动重抽。新尝试登记新 run，保留旧分母。将同源 engineering.json 和日志复制进本 run 后核对 hash，不能借用其他实现版本的绿灯。

- [ ] **Step 3：完成 private 的明确检查点。** 选择 private 方法，调查结果 B ready 后先采集现场 C3 准入；允许路先完成匹配合作，拒绝路保留规则原因。再返回原 giver 告知，在已分享未核验窗口输入策略，B 后实际选择匹配核验。中途 ready 完成 entry/SQLite 重开与真实浏览器 reload 后继续行动；C3 后续两步按各路线检查点/成功合作时序计数，最后使用当前 token/revision 完成交付和结局。public 同样遵守 C3 优先级，不能调查后直接离场跳过允许合作。

不按照历史action14序号硬点，也不把下一个token写进脚本。UI gate只承认本次expected command；被拒绝时先看acceptance/production层次，不自动换旧token。

在private达到terminal后，验收者实际阅读当前UI材料并释放现有review gate。PowerShell可在另一个终端运行：

```powershell
# 先实际检查 private.ui.json 中有 refresh_verified、refresh_after_action 和 terminal。
$activeRun = Read-Host '输入本次 runner 显示的完整 runId'
$releaseFile = "artifacts/narrative-p3/$activeRun/private.ui-reviewed"
New-Item -ItemType File -Path $releaseFile -ErrorAction Stop
```

该文件只是释放当前进程，不是C7通过证书。public随后由API runner按同一fork继续，不能重新createGame，也不用伪造public.ui.json。

- [ ] **Step 4：保存并审查自动结果。** 预期两路业务completed；raw live passed仍不能当作总体通过。检查capabilities、fork、goal、strategy、合作对照、事件后果、HTTP失败计数与预算。任一失败保留failed/not_run；不为制造准入差异增加无策略意义的动作。
- [ ] **Step 5：严格回放，零新增真实HTTP。**

```powershell
Remove-Item Env:RUN_REAL_AI_JOURNEY -ErrorAction SilentlyContinue
node scripts/narrativeP3Journey.mjs --mode replay --run-id $runId --protocol $protocol --output $replayDir --replay-source $runDir
$replayExit = $LASTEXITCODE
```

预期：与本次v2所有成功/失败/未执行路径一致，源记录的失败调用也应重放，真实网络尝试为0。若UI运行的随机时间/额外读取造成strict不一致，定位并修复回放契约；不得将“业务结局一样”冒称严格一致。使用新版本后不得接着修改旧协议hash蒙混通过。

- [ ] **Step 6：做真实语义与UI人工签核。** 验收者根据实际批准目标与条件填 `review.json`；长期“保住旧泊权”被“知道报告”完成必须拒绝。对于C3，确认同NPC/同定义/同范围/同地点、真实guard区别、允许路实际成功和两步后果。检查C4输入没有代执行、之后曝光/点击/结果完整。签核引用实际path/hash/pointer，由Task8校验器读取，不直接手写最终passed。

- [ ] **Step 7：运行离线汇总器。**

```powershell
node scripts/narrativeP3Acceptance.mjs --live-directory $runDir --replay-directory $replayDir --review "$runDir/review.json" --output "$runDir/acceptance.json"
if ($LASTEXITCODE -ne 0) { throw 'P3_ACCEPTANCE_NOT_PASSED' }
```

预期：只有C1–C8齐全通过才exit0；缺资料以独立非0状态报告not_run；错配/缺陷以failed报告。该命令不联网，不改变此前live/replay文件。

- [ ] **Step 8：写最终报告，不改阶段指针。** 明确G0–G5、C1–C8、两路状态、实际UI范围、strictreplay、真实网络次数与失败分母。未过就写具体失败层和缺项；只有新签封证据成立才宣称P3完成。报告链接到新批次，不引用旧run冒充当前成功。
- [ ] **Step 9：提交报告及必要的脱敏导航。** 大型artifacts按仓库既有保存策略保留，不把.env、密钥或完整私人日志推到公开仓库。

```bash
git add docs/superpowers/reports/2026-09-17-narrative-p3-remediation-acceptance.md docs/superpowers/README.md
git commit -m "docs(p3): record source-bound live and UI acceptance"
```

---

## 14. Spec 覆盖、审阅门与交付清单

| Spec 要求 | 实施 Task | 必须看到的检查 |
|---|---|---|
| P3R-01 显式目标 | 1、9 | raw/compiled不新增；目标顺序与编译次数不影响 |
| P3R-02 历史目录 | 2、3 | action7核验可被回顾；隐藏/未来依据不可引用 |
| P3R-03 错误分流 | 4 | 同hash重审；作者一次；真越权仍拒绝 |
| P3R-04 同源闭环 | 5 | 同fact/discovery/giver/受众/顺序；跨fact负例 |
| P3R-05 目标含义 | 7、9、13 | 指定目标、真实条件来源、人工签核 |
| P3R-06 合作分化 | 6、7、9、13 | 共用生产guard、同定义差异、真实Action、两步后果 |
| P3R-07 策略时序 | 7、9、13 | 输入不代执行；之后实际曝光/点击/结果 |
| P3R-08 UI派发 | 10 | 未确认重派、最多3次、确认后GET、旧回调失效 |
| P3R-09 UI证据 | 11、13 | 中途ready刷新后再行动；publicAPI不冒充UI；不伪resume |
| P3R-10 完成判定 | 7、8、9、13 | 缺项not_run、错配failed、v1只读、新v2全矩阵 |
| P3R-11 兼容/工程 | 1、8、12、13 | 旧产物保留、依赖有效、A/B/CAS/P1/P2不回归 |
| P3R-12 actor/target 与生产选项 | 5、6 | 原始合法分享正例；当前/未来槽、choice/registry/resolver 一致 |
| P3R-13 能力产出与路线可达 | 6A、8、9、13 | 原候选预算修订；调查 fork 冻结；合作先于离场；两路完整链 |
| P3R-14 来源与完整矩阵 | 2、7、8、9、12 | committedState；fork/CAS/封存采集；八项重算；not_run 不混成 failed |
| P3R-15 UI 与回放真实性 | 8、10、11、13 | UI 独立派发、请求超时、SQLite 重开、三流 replay |

### 执行者交付前自检

- [ ] 每个勾选任务有对应真实命令/日志/commit；没有把未运行项填成通过。
- [ ] 新函数只在其定义任务及明确消费者使用；导出经所属facade；无测试helper流入生产。
- [ ] 每个自动化判定都有独立正例和单因素负例；没有全空review fixture掩盖非空响应问题。
- [ ] raw绑定与批准绑定按真实符号表规范化；不拿随机hash或人工布尔值代替源文件验证。
- [ ] 文档不宣称修好了历史 action14 的唯一原因；本地证据只证明 ready/revision23 的合法命令等待提交，缺少后续执行记录。
- [ ] 基线源码/环境差异、复现通过、修复后工程通过、live/UI通过四类事实明确分开；覆盖 Task 6A，未把计划文本当生产能力。
- [ ] 没有自动重抽、增加候选预算、降低验收门槛、导入固定生产剧情或修改shared/foundation。
- [ ] 最终报告是工程完成或P3完整完成中的哪一种，取决于G4/G5证据，不取决于计划复选框数量。

### 编写依据

文档结构沿本仓库架构 Spec 与原 P3 Plan，任务拆分和验证采用当前环境的 `superpowers:writing-plans` 技能；技能不覆盖用户授权、仓库约束与阶段边界。实际执行按会话已有授权判断，不因为此 Plan 重复索取已给出的许可。
