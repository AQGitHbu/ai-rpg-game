# Spec：AI source 基础设施去重 + demo 脚手架清理

> 日期：2026-07-31 ｜ 状态：待实现 ｜ 分支：`refactor/ai-source-shared-infra`

## 1. 背景

架构审核发现：`application/server/ai` 下三条 AI 管线
（`scenario` / `townPlan` / `runtimeNarrative`）各自从头实现了一套**几乎相同**的
录制/回放/去重基础设施，且部分演示脚手架（`townDemo` / `townAssets`）与生产主循环
并列摆放，导致"新增 AI 模块要复制 6 个文件""读代码分不清真实路径"两类扩展摩擦。

本 spec 只做**去重**与**边界澄清**，不引入任何前瞻抽象、不改变任何对外契约与运行时行为。

### 1.1 现状证据

三条管线逐字/近乎逐字重复的部分：

| 能力 | scenario | townPlan | runtimeNarrative | 现状 |
|------|----------|----------|------------------|------|
| `canonicalJson` + volatile key 处理 | ✔ | ✔ | ✔ | 逐字复制 |
| `fingerprint*`（canonical JSON + sha256） | – | ✔ | ✔ | 近乎相同 |
| recording source 包装器 | ✔ | ✔ | ✔ | 结构相同 |
| replay source + `*FixtureDriftError` + `assertComplete` | ✔ | ✔ | ✔ | 结构相同 |
| `*TaskCoordinator`（后台 ensure 去重） | – | ✔ | ✔ | 90% 相同 |

- `canonicalJson`：`townPlanRecording.ts` 与 `runtimeNarrativeRecording.ts` 中逐行一致，
  仅 volatile key 集合不同（townPlan=`{traceId}`，narrative=`{sceneId,choiceToken}`）。
- `*TaskCoordinator`：`townPlanTaskCoordinator.ts` 与 `runtimeNarrativeTaskCoordinator.ts`
  仅"pending 判定谓词 + 日志 key + 结果 union 名"不同，其余（`running` Map 去重、
  `Promise.resolve().then().catch().finally()` 调度、返回码集合）完全一致。

- 演示脚手架：`townDemo.ts` + `/town-demo` 页面只服务实验页；`townAssets.ts` 是一个恒返回
  `unavailable` 的"预留生图 port"，从 `application/index.ts` 门面导出却**零生产消费者**
  （仅自身单测引用）。二者与真实小镇主循环 `townRuntimeView` / `projectTownLayerView` 并列。

## 2. 目标

1. 抽取 `application/server/ai/_shared/`：把上表中三份一致的基础设施收成一份，
   三条管线改为薄适配调用。
2. 清理演示脚手架：移除零消费者的 `townAssets` 预留 port；明确 `townDemo` 的 demo 边界。
3. 全程行为不变：对外契约（`*_CONTRACT_VERSION`、`*_FAILURE_CATEGORIES`、`*Attempt`、
   `*CandidateSource` 形状）与 fixture 文件格式一字不改；离线 journey 回放逐字通过。

## 3. 非目标

- **不**统一三条管线的 `Attempt` / `Source` 契约类型（形状相似但语义域不同：
  scenario 候选是 `ScenarioBlueprintCandidate`、townPlan 是 `unknown`、narrative 有三个角色）。
  强行合并会引入过度抽象，违背"不过度设计"原则。仅抽取**实现**层的纯工具与调度。
- **不**统一三套 `*_FAILURE_CATEGORIES`（它们与各自 validator 的拒绝原因一一对应）。
- **不**改 fixture JSON 结构、契约版本号、录制条目 schema（回放必须逐字兼容）。
- **不**重构 application 层目录布局（扁平 45 文件的分子目录化是独立的低优先级项，本 spec 不动）。
- **不**改边界测试的规则内容（去重后新增 `_shared` 目录仍受既有 `application/server` 规则覆盖）。

## 4. 核心设计决策

### 4.1 `_shared/canonicalJson.ts`（第一步）

新文件导出纯函数，无副作用、无 I/O：

```ts
/** 稳定序列化：对象 key 排序；命中 volatileKeys 的字段值替换为 "<volatile>" 占位。 */
export function canonicalJson(value: unknown, volatileKeys: ReadonlySet<string>): string;

/** canonical JSON + sha256 十六进制指纹。 */
export function fingerprint(value: unknown, volatileKeys: ReadonlySet<string>): string;
```

- volatile key 集合从"模块内硬编码常量"改为"由调用方传入的参数"，从而容纳两种 volatile 策略。
- `canonicalJson` 内部递归对 volatile 判定沿用现有语义：**仅按 parentKey 命中即整值占位**
  （不递归进入被占位的子树），与现有 `runtimeNarrativeRecording`/`townPlanRecording` 逐字等价。
- `runtimeNarrativeRecording.ts`：`fingerprintNarrativeContext(context)` 改为
  `fingerprint(context, NARRATIVE_VOLATILE_KEYS)`，其中 `NARRATIVE_VOLATILE_KEYS =
  new Set(["sceneId","choiceToken"])` 保留在本文件（语义归属本模块）。导出名不变。
- `townPlanRecording.ts`：`fingerprintTownPlanRequest(request)` 改为
  `fingerprint(request, TOWN_PLAN_VOLATILE_KEYS)`，`TOWN_PLAN_VOLATILE_KEYS = new Set(["traceId"])`。
  导出名不变。
- scenario 侧当前无独立 fingerprint（其录制在 phase10 journey 工具链，另行核对），
  第一步不动 scenario；若其内联有同款 `canonicalJson` 也一并替换（实现细节在编码时核对）。

验收：三处 `canonicalJson` 局部定义删除；`fingerprint*` 导出名与返回值逐字节不变
（用现有单测 + journey 回放证明）。

### 4.2 `_shared/recording.ts`（第三步）

抽取泛型录制/回放骨架，保留各管线的类型化外壳：

```ts
export type RecordSink<Call> = { append(call: Call): void | Promise<void> };

export class FixtureDriftError extends Error {
  readonly code: string;           // 各管线传入自己的 code 字符串
  constructor(code: string, message: string);
}

/** 顺序游标消费 + drift 断言的通用回放核；各管线用它构造自己的 typed source。 */
export function createReplayCursor<Call extends { sequence: number }>(
  calls: readonly Call[],
  matches: (call: Call, cursor: number) => boolean,
  onDrift: () => never,
): { consume(): Call; assertComplete(): void };
```

- `runtimeNarrativeRecording` / `townPlanRecording` 的 replay source 改为在其上薄封装：
  drift 判定谓词（sequence/契约版本/fixtureVersion/requestFingerprint）作为 `matches` 传入，
  成功/失败分支的 typed 返回保留在各自文件（因返回体形状不同）。
- `*FixtureDriftError` 保留为各管线的具体子类或改由通用类携带各自 `code`——
  以"错误 code 字符串不变"为约束（现有断言若匹配 `code` 必须继续通过）。
- recording source 包装器（`createRecording*Source`）保留在各文件（因 narrative 是三端口、
  townPlan 是单端口，包装形状不同），仅复用 `fingerprint` 与 sink 追加逻辑。

### 4.3 `_shared/ensureCoordinator.ts`（第三步）

抽取后台 ensure 去重调度：

```ts
export type EnsureResult = "queued" | "already_running" | "not_pending" | "unavailable";

/** 进程内按 key 去重的后台任务调度器。pending 判定与执行体由调用方注入。 */
export class BackgroundEnsureCoordinator {
  constructor(config: {
    loadPending(): Promise<{ ok: true; key: string } | { ok: false; result: EnsureResult }>;
    run(): Promise<void>;
    logKey: string;
    logger?: GameLogger;
  });
  ensure(): Promise<EnsureResult>;
}
```

- `RuntimeNarrativeTaskCoordinator` / `TownPlanTaskCoordinator` 改为**薄封装**：
  各自实现 `loadPending`（narrative 的多条件谓词 vs townPlan 的 `townGeneration.status === "pending"`）
  与 `run`（调用各自的 `generatePending*`），`logKey` 分别为 `runtime_narrative_task` / `town_plan_task`。
- 两个类的公开名（`RuntimeNarrativeTaskCoordinator`、`TownPlanTaskCoordinator`）与
  返回类型别名（`NarrativeEnsureResult`、`TownEnsureResult`）保留，`compositionRoot` 接线不变。
- `running` Map、`Promise.resolve().then/catch/finally` 调度、日志级别收敛进通用类。
- 保留"不用 TS parameter property（Node strip-types 兼容）"的既有约束。

### 4.4 演示脚手架清理（第四步 / 第二步项）

- **`townAssets.ts`**：零生产消费者的预留生图 port。移除文件、其单测、以及
  `application/index.ts` 的 `createUnavailableTownIllustrationSource` / `TownIllustrationSource` /
  `TownAssetKind` / `TownAssetRequest` / `TownAssetResult` / `TownAssetStatus` /
  `TOWN_ASSET_CONTRACT_VERSION` 导出。若 `townDemo.ts` 依赖它，则同步解耦（见下）。
  > 依据：MVP 明确排除 AI 生图；真正做生图时按当时接口新增，成本低于维持空 port 的认知负担。
- **`townDemo.ts` + `/town-demo`**：保留但明确标注"仅 demo，非主循环"。
  在 `townDemo.ts` 顶部与 `application/index.ts` 对应导出处加边界注释；
  若其 import 了 `townAssets`，改为内联最小占位（不再依赖被删的 port）。
  > 不删除：demo 页对手动验证小镇生成仍有价值；仅澄清边界避免误读为主路径。

## 5. 兼容性与安全

- 对外契约零变化：门面 `application/index.ts` 除删除 `townAssets` 相关导出外不动其余导出。
- fixture / 录制条目格式零变化：`fingerprint` 输出逐字节等价 → 现有 journey `replay` 模式逐字通过。
- 依赖边界零新增违规：`_shared/` 位于 `application/server/ai/` 内，受既有
  `game/application/server` 规则覆盖（不导入 persistence/sqlite/libsql、不反向进 UI）。
  去重后 `_shared/recording.ts` 同样受"live source + prompt + audit + factory 不导入
  persistence/sqlite/libsql"同族约束——编码时确保 `_shared` 只依赖 domain 类型与 node 内置。
- `townAssets` 删除属"移除零消费者代码"：删前用全局引用扫描确认无生产调用点。

## 6. 验收标准（按步骤）

**第一步（canonicalJson/fingerprint）**
1. `_shared/canonicalJson.ts` 建立；两处（townPlan、narrative）局部 `canonicalJson` 删除，
   改调共享函数。
2. `fingerprintNarrativeContext` / `fingerprintTownPlanRequest` 导出名与签名不变，返回值逐字节等价。
3. `vitest run src/game/application/server/ai` 全绿；`tsc --noEmit`、`eslint .` 通过。

**第三步（recording + coordinator）**
4. `_shared/recording.ts`、`_shared/ensureCoordinator.ts` 建立；三条管线 replay 骨架与
   两个 coordinator 改为薄封装；公开名与返回类型别名不变。
5. `RuntimeNarrativeTaskCoordinator` / `TownPlanTaskCoordinator` 行为不变
   （queued/already_running/not_pending/unavailable 语义逐一保持）；`compositionRoot` 不改。
6. 三条 fixture drift 检测仍生效（错误 code 字符串不变）。
7. 离线 journey 回放（`journey:phase10` / `journey:phase11` / `journey:town` 的 replay 模式）逐字通过。

**第四步（demo 脚手架）**
8. `townAssets.ts` 及其单测删除；门面对应导出移除；全局无悬空引用；`tsc` / `eslint` / `vitest` 通过。
9. `townDemo` / `/town-demo` 边界注释就位；`/town-demo` 页仍可生成（demo 行为不变）。

**总验收**
10. 全量 `vitest run`、`tsc --noEmit`、`eslint .`、`dependencyBoundaries.test.ts` 全绿，无新违规。
11. `git diff` 中不存在对任何契约版本号、fixture JSON、录制 schema 的改动。
