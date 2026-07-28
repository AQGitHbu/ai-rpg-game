# AI 契约模拟与动态开局设计

> 日期：2026-07-28
> 状态：设计已确认，待用户评审
> 关联基线：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`

## 1. 决策与目标

下一阶段不直接让真实模型阻塞日常开发。它拆为两个连续工作包：

- **Phase 4A：AI 契约模拟与生成体验。** 用版本化 fixture 和可注入的假适配器驱动完整生成链路、错误分支和 UI；不发起网络 AI 请求。
- **Phase 4B：真实动态开局。** 在 4A 的契约、验证器、降级和 UI 已证明可用后，抽取并接入真实 transport，以同一输出契约替换假适配器。

这保留既有确定性 fallback 和全量回归测试套件（2026-07 时点约 704 项）作为可用基线。目标是先证明系统能安全消费 AI *候选*，再验证模型能稳定产生这些候选；两者不能互相替代。

## 2. 范围与非目标

### Phase 4A 包含

- 固化 `ScenarioBlueprintCandidate` 的输入、输出、诊断、重试与 fallback 契约。
- 建立代表性成功 fixture，以及越权、格式、预算、引用、任务图、类型边界和服务故障 fixture。
- 用可控延迟、阶段事件和失败模式的 fake adapter 覆盖生成页的 loading、retry、fallback 与错误表达。
- 保持 `createGame` 的原子初始化：只有通过既有 validate/compile 的候选才能保存；其余路径继续使用确定性 fallback。
- 为测试和开发诊断记录真实发生的生成阶段，而不是用定时器伪造成功进度；玩家 UI 在请求飞行中只显示诚实的等待态（见 §4）。
- 在测试和开发工具中记录 fixture ID、契约版本和结果；普通玩家路径不暴露 fixture 选择器。

### Phase 4B 包含

- 在首次真实调用前，按共享流程评估并抽取 `@ai-game/ai-transport`：只包含 OpenAI-compatible transport、超时、取消、并发、流式与稳定错误类型。
- RPG server-only orchestration 读取本项目 AI 环境，组装 prompt，调用 transport，将输出转换为 4A 的同一候选契约。
- 对真实响应执行一次确定性修复、一次重试，之后回退到既有 fallback；写入脱敏的 trace、耗时、token/成本估算和失败类别。
- 建立非阻塞的真实 AI smoke suite：不进入普通单测、不依赖固定文本，只验证三类输入能被安全处理或降级。

### 本阶段不包含

- 自由输入意图识别、NPC 动态对白、场景叙事、记忆摘要、图片或语音生成；这些属于后续 Phase 5/6。
- 技能、装备、同伴、经济、地图扩张或图示中的复杂业务界面。
- 将 RPG prompt、蓝图 schema、任务规则或环境变量搬入共享 package。
- 为模拟数据增加生产后门、开发者可选的剧情内容或绕过校验的开关。

## 3. 契约与数据设计

`ScenarioBlueprintCandidate` 保持为唯一的 AI 世界生成候选格式；候选永远不能直接写入存档。4A 新增一个 project-local、server-only 的 `ScenarioCandidateSource` 门面：

```ts
type ScenarioGenerationRequest = {
  input: ValidatedNewGameInput;
  seed: string;
  traceId: string;
};

type ScenarioGenerationStage =
  | "requested"
  | "candidate_received"
  | "validating"
  | "repairing"
  | "retrying"
  | "falling_back"
  | "completed"   // 终态：携带 outcome "generated" | "fallback"
  | "failed";     // 终态：携带稳定失败类别（如事务失败）

type ScenarioCandidateFailureCategory =
  | "invalid_json"
  | "schema_violation"
  | "budget_exceeded"
  | "reference_broken"
  | "unreachable_ending"
  | "cross_type_content"
  | "illegal_entity"
  | "timeout"
  | "rate_limited"
  | "service_error"
  | "empty_response";

type ScenarioCandidateAttempt = {
  readonly contractVersion: string;
  readonly origin: "fixture" | "live";
  readonly outcome:
    | { readonly ok: true; readonly candidate: ScenarioBlueprintCandidate }
    | { readonly ok: false; readonly category: ScenarioCandidateFailureCategory };
  /** 非敏感诊断摘要：不含 prompt、完整玩家输入或原始响应。 */
  readonly diagnostics: readonly string[];
};

type ScenarioCandidateSource = {
  generate(request: ScenarioGenerationRequest): Promise<ScenarioCandidateAttempt>;
};
```

阶段机的终态集合在 4A 固定为 `completed` / `failed`；4B 引入取消时追加 `cancelled` 并升级契约版本。失败类别以上述枚举为初始集合；新增类别必须同步升级契约版本并补齐对应 fixture 与 manifest。应用层只消费 attempt 结果，通过现有 validate/compile 和 transactional repository 完成创建。AI source 不获得 repository 或状态写权限。

fixture 以 JSON 保存于 `data/fixtures/phase4/`，每份附带 manifest：输入类型、seed、候选/故障模式、预期阶段序列、预期诊断码和是否必须 fallback。至少覆盖：武侠、科幻、都市的合法候选；无效 JSON；未知枚举；重复 ID；悬空引用；内容超预算；不可达结局；跨类型内容；非法属性/物品；超时；429；5xx；空响应。

真实模型返回的脱敏样本只能经人工确认后转为 fixture；fixture 不保存 API key、完整玩家输入、完整 prompt 或未审查的生产响应。

## 4. 生成流程与错误处理

```text
NewGameInput
→ validate input
→ ScenarioCandidateSource
→ candidate parse/schema validation
→ existing blueprint validate/compile
→ transactional save
→ opening read model
```

候选失败时流程是：确定性修复一次 → 同一 source 重试一次 → `createFallbackBlueprint(input, seed, { profiles })` → validate/compile/save。确定性修复住在 `createGame` 编排层（source 之外），fixture source 与 4B live source 共享同一实现：只做机械、无内容创造的修复（剔除未知字段、trim 文本、裁剪超预算列表尾部），绝不新增或改写剧情内容，修复后必须重新通过完整 validate。fixture 至少各提供一份“可修复”与“不可修复”样本覆盖两分支。每个分支均产生结构化阶段与诊断；任何失败都不能留下半存档。

阶段记录仅供 source/orchestration contract test、结构化日志和受控开发诊断使用；它不随玩家 API 返回，也不含 prompt、原始响应或玩家原文。`createGame` 保持单次 `POST /api/game`：请求飞行中 UI 只显示诚实的“正在生成世界”等待态，不引入轮询端点或流式响应；4B 若需飞行中实时进度，作为独立决策另行评估。

4A 的 fake source 可以按 fixture 产生上述阶段、延迟与错误，但不应在 UI 内硬编码网络延迟。延迟只用于验证等待态、按钮禁用与错误恢复；阶段序列不驱动飞行中的玩家 UI。取消只在 4B transport 已支持且未写入存档时开放。

## 5. UI 与边界

新游戏创建页提交后进入生成状态视图。它需要：可访问的当前状态文本、等待说明、确定性 fallback 已启用的提示、稳定的失败说明与重试动作。成功后仍进入当前开场 read model。`CreateGameResult.source` 扩展为 `"generated" | "fallback"` 二元值；`POST /api/game` 成功响应明确返回同名的安全字段，`CurrentGameScreen` 仅在本次创建后用它显示降级提示。刷新恢复仍只返回持久化的 read model，故不承诺保留这条瞬时提示。`fixture` / `live` 的区分只存在于 attempt 诊断与开发工具，UI 不知道 fixture、provider、prompt、seed 或原始蓝图，4A→4B 切换时 UI 零改动。

UI/API/store 仍然只导入 `@/game/application` facade。fixture source、live source、环境变量、日志和 provider 都留在 `src/game/application/server/`；领域、玩法、客户端 bundle 和 SQLite adapter 均不依赖 AI provider。Phase 4A 的模拟能力先保留在 RPG 内，因为它目前只有这一个产品消费者。

Phase 4B 触发共享流程：先在 foundation、SLG 与 RPG 的同名 worktree 比较现有 SLG transport，再决定 public API。共享 package 只接收调用方传入的配置；RPG 保留自己的 prompt、schema、校验与业务降级。

## 6. 测试与验收

Phase 4A 的测试优先级：

1. 每份 fixture 的候选、诊断与阶段序列 contract test。
2. 从 fixture source 到 SQLite 的集成测试：合法候选保存；所有非法/服务失败路径走 fallback；事务失败没有半存档。
3. UI 测试：loading、校验、fallback、错误、重试与键盘/读屏状态；不依赖真实时间或网络。
4. 边界测试：客户端和应用门面不能导入 server-only source；候选 source 不能导入 repository。
5. 三类型固定 seed 回归：候选路径与 fallback 路径都保持内容预算和双结局可达性。

Phase 4B 的额外验收：

- `npm run env:check` 必须通过，且日志不泄露密钥。
- 真实 AI smoke 使用独立命令和显式 opt-in；普通 CI 单测只跑 fixture。
- 三种类型的真实响应要么通过候选校验并可创建存档，要么给出可观测诊断并完成 fallback。
- 恶意或越权模型输出绝不进入 GameState、存档或玩家 read model。

## 7. 实施顺序与完成条件

### Phase 4A

1. 定义 source/result/stage 的 project-local 契约与测试；保持 fallback 为默认生产实现。
2. 添加 fixture manifest、fixture source、失败/延迟模拟和契约测试。
3. 将 `createGame` 编排改为依赖 source，并将经过验证的阶段投影给创建 UI。
4. 实现生成状态/降级/重试 UI 与边界、SQLite 集成测试。
5. 更新 `docs/agent/AI环境.md`、`MVP核心闭环.md`、索引和当前阶段；通过 lint、typecheck、全测、boundary test、build。

**门槛：** 不调用外网的情况下，所有代表性 fixture 都能复现成功或安全 fallback，玩家可从生成状态进入并完成一局，测试不依赖模型延迟。

### Phase 4B

1. 依共享流程建立 transport API spec、同名 worktree 和两个消费者契约；完成 foundation 家族验收。
2. 实现 server-only live source、prompt adapter、解析/修复/重试、脱敏日志和 opt-in smoke command。
3. 将 production composition root 切换为 live source，同时保留 fallback 和可测试的 fixture injection。
4. 用三种类型和越权输出完成真实 smoke；更新 agent 文档、运维说明和成本/错误观察字段。

**门槛：** 真实服务慢、限流、失败或返回非法内容时，日常开发、自动化测试与玩家通关均不被阻断。

## 8. 取舍

本方案比“先接真实 AI”多了一层契约和 fixture 工作，但将模型延迟、供应商波动和成本从主开发循环中移除；它也比“所有系统完成后才接 AI”更早暴露 prompt、schema 与 provider 的真实风险。Phase 4A 结束就可以稳定完善生成体验与 UI，Phase 4B 则以小范围 smoke 逐步替换模拟来源。
