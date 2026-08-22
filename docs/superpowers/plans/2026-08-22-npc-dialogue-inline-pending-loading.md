# NPC 对话内联等待与失败重试模态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 玩家提交 NPC 固定选项或自定义输入后，保留原 NPC 对话模态，在已选回应后显示内联 loading 并锁定所有游戏操作；只有 API/后台叙事生成真正失败时才显示失败重试模态。

**Architecture:** 保留现有 /api/game/actions、/api/game/narrative/ensure、规则 CAS、后台 pending job 和失败后复用同一 job 的服务端链路，不新增 route 或领域状态。客户端为 NPC 对话增加短暂的 optimistic presentation state：记录当前玩家回应、提交来源和等待阶段；AdventureGameShell 根据提交来源隐藏 NPC 对话路径上的全屏 progress modal，但仍为非 NPC 行动保留既有等待反馈。AI 失败继续区分“规则尚未提交、重试原行动”和“规则已提交、重试同一 narrative job”两种语义。

**Tech Stack:** React, TypeScript, Next.js, Vitest, Testing Library, RPG theme CSS

**Spec:** docs/agent/NPC对话驱动叙事场景触发.md、docs/agent/地图与地点冒险.md、docs/游戏设计原则.md

## Global Constraints

- 不新增 API route、并行 dialogue use case、兼容 facade 或领域 fallback；固定选择与自定义输入仍统一经 /api/game/actions。
- UI 只能消费 GameSessionView 下发的 opaque choiceToken，不能解析 token、构造 Action 或从 NPC 文案反推规则事实。
- NPC 正式提交仍只产生一次 actionId、一次规则 CAS 和一个 PendingNarrativeJob；叙事失败重试不得再次执行规则回合。
- 固定选项和自定义输入的玩家回应只可作为当前页面的临时展示；自定义输入原文不得写入 read model、长期记忆、事件账本或普通日志。
- NPC 等待期间对话关闭、返回地图、HUD 信息入口、NPC 卡片、场景行动和输入控件均不可操作；失败模态只开放对应的重试按钮。
- 非 NPC 行动、开局生成、战斗等待和非对话 pending 保持现有行为；“正在编排下一幕”只从 NPC 对话提交路径移除。
- 失败重试文案必须明确规则状态：行动提交失败时提示“本次选择尚未生效”，场景生成失败时提示“你的选择已生效，规则状态已保留”。
- 实现时使用 codex/ 分支和 .worktrees/，不得通过 git checkout 改写当前工作区，也不得覆盖已有未提交改动。

## 现状核对结论

- src/components/AdventureGameShell.tsx 当前把 isSubmitting、narrativeGeneration.pending 和 narrativeGeneration.failed 合并为 busy，pending 时渲染 GenerationStatusModal。
- src/components/LocationSceneScreen.tsx 当前在 pending 时将 activeDialogues 置为空，因此玩家提交后 NPC 对话框消失；NpcDialogueModal 已有 waiting 阶段，但只显示“正在等待 NPC 回应”，没有保留玩家已选回应和内联 spinner。
- src/components/CurrentGameScreen.tsx 已负责轮询 pending 和调用 retryNarrative()；这个服务端恢复语义应保持不变。
- postAction() 已将 AI_CALL_FAILED / AI_RESPONSE_INVALID 映射为带原 interaction 的 ai-failure，可用于“重试当前选择”；narrativeGeneration.status === "failed" 则代表规则已提交后的场景生成失败，应使用 retryNarrative()，不能再次调用 postAction()。
- AdventureHud 的信息入口目前没有 disabled 属性；NPC 对话遮罩可以拦截鼠标，但不应只依赖 z-index，等待态必须在 DOM 层明确锁住可操作入口。

## 文件职责映射

- src/components/LocationSceneScreen.tsx：NPC 对话临时状态、玩家回应展示、内联 loading、对话内控件禁用和 NPC 来源标记。
- src/components/AdventureGameShell.tsx：提交来源、全局 progress modal 的显示条件、两类失败重试模态和 HUD busy 状态传递。
- src/components/AdventureHud.tsx：接收 disabled 并锁住角色、背包、任务、日志和开发工具入口。
- src/components/GenerationStatusModal.tsx：保留非 NPC progress modal，增加“原行动重试”和“叙事回应重试”的明确失败文案。
- src/app/globals.css：NPC 选中回应、内联 spinner、等待态和 disabled 视觉。
- src/components/AdventureGameShell.test.tsx、src/components/LocationSceneScreen.test.tsx、src/components/GenerationStatusModal.test.tsx：覆盖正常等待、成功写回、两类失败和全局操作锁。
- docs/agent/NPC对话驱动叙事场景触发.md、docs/agent/地图与地点冒险.md、docs/Agent文档索引.md：同步实现事实。

---

### Task 1: 建立两类失败重试模态的客户端契约

**Files:**
- Modify: src/components/GenerationStatusModal.tsx
- Modify: src/components/AdventureGameShell.tsx
- Test: src/components/GenerationStatusModal.test.tsx
- Test: src/components/AdventureGameShell.test.tsx

**Interfaces:**
- `src/components/AdventureGameShell.tsx:25-31` 的 `ActionFeedback` 扩展 retryable 分支（`src/game/application` 的 `AiFailureKind`）：

~~~ts
import type { AiFailureKind } from "@/game/application";

type InteractionOrigin = "npc-dialogue" | "other";

type ActionFeedback =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "success"; readonly message: string }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "retryable"; readonly message: string; readonly interaction: PlayerInteraction; readonly failureKind: AiFailureKind; readonly origin: InteractionOrigin }
  | { readonly phase: "error"; readonly message: string };
~~~

- `submitInteraction` 使用内部来源签名，`origin` 仅用于客户端 UI 分流，不进入 HTTP body（`src/components/gameActionRequest.ts:postAction` 的 `ActionRequest` 不变）：

~~~ts
function submitInteraction(
  interaction: PlayerInteraction,
  origin: InteractionOrigin = "other",
): void;
~~~

- `src/components/GenerationStatusModal.tsx:6-17` 增加 `kind: "action-failure"` 分支；它表示行动尚未成功提交（`postAction` 返回 `ai-failure`），按钮文案为“重试当前选择”。现有 `narrative-failure` 保留，按钮文案改为“重试生成回应”。两个失败分支共用稳定 `AiFailureKind`，不把 provider 原始错误、prompt 或 job 细节投影给客户端。

~~~ts
type GenerationStatusModalProps =
  | { readonly kind: "creation" | "narrative" | "action"; readonly onRetry?: () => void | Promise<void>; readonly battleVisible?: boolean }
  | { readonly kind: "action-failure"; readonly failureKind: AiFailureKind; readonly onRetry: () => void | Promise<void>; readonly battleVisible?: boolean }
  | { readonly kind: "narrative-failure"; readonly failureKind: AiFailureKind; readonly onRetry: () => void | Promise<void>; readonly battleVisible?: boolean };
~~~

- [ ] **Step 1: 写失败测试**

在 GenerationStatusModal.test.tsx 增加：

~~~tsx
it("distinguishes action retry from narrative retry", () => {
  const onRetry = vi.fn();
  const { rerender } = render(
    <GenerationStatusModal
      kind="action-failure"
      failureKind="AI_CALL_FAILED"
      onRetry={onRetry}
    />,
  );

  expect(screen.getByRole("heading")).toHaveTextContent("本次选择提交失败");
  expect(screen.getByText("这次选择尚未生效")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试当前选择" }));
  expect(onRetry).toHaveBeenCalledOnce();

  rerender(
    <GenerationStatusModal
      kind="narrative-failure"
      failureKind="AI_RESPONSE_INVALID"
      onRetry={onRetry}
    />,
  );
  expect(screen.getByRole("heading")).toHaveTextContent("NPC回应生成失败");
  expect(screen.getByText("你的选择已经生效")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试生成回应" })).toBeInTheDocument();
});
~~~

在 AdventureGameShell.test.tsx 增加行动 API 返回 ai-failure 的测试：点击一次 NPC 选项后出现失败模态，点击“重试当前选择”使 postAction 第二次收到同一个 interaction；测试不得断言相同 action ID，因为每次提交必须继续由现有请求模块生成新 UUID。

- [ ] **Step 2: 运行测试确认旧契约失败**

Run:

~~~bash
npx vitest run src/components/GenerationStatusModal.test.tsx src/components/AdventureGameShell.test.tsx
~~~

Expected: FAIL，因为当前 GenerationStatusModal 没有 action-failure 分支，ActionFeedback 也没有保存失败分类和提交来源。

- [ ] **Step 3: 实现最小失败模态与反馈字段**

在 GenerationStatusModal.tsx 将失败文案拆成两个上下文：

~~~ts
const FAILURE_COPY = {
  action: {
    AI_CALL_FAILED: { title: "本次选择提交失败", description: "这次选择尚未生效，AI 调用失败。" },
    AI_RESPONSE_INVALID: { title: "本次选择提交失败", description: "这次选择尚未生效，AI 返回格式不符合要求。" },
  },
  narrative: {
    AI_CALL_FAILED: { title: "NPC回应生成失败", description: "你的选择已经生效，但 AI 调用失败。" },
    AI_RESPONSE_INVALID: { title: "NPC回应生成失败", description: "你的选择已经生效，但 AI 返回格式不符合要求。" },
  },
} as const;
~~~

AdventureGameShell.applyOutcome() 在 ai-failure 分支保存 failureKind 和当前提交来源；retryAction() 使用保存的 origin 再调用 submitInteraction()。行动失败模态调用 retryAction()，叙事失败模态继续调用传入的 onRetryNarrative，不能混用两个回调。移除当前 retryable 状态下独立的“重试” InlineButton 和重复的通用失败入口，确保 action-failure 模态是唯一的行动失败重试入口。

- [ ] **Step 4: 运行测试确认通过**

Run:

~~~bash
npx vitest run src/components/GenerationStatusModal.test.tsx src/components/AdventureGameShell.test.tsx
~~~

Expected: 新增失败模态测试和既有行动反馈测试 PASS；此时 pending 全屏模态仍可暂时存在，下一任务再收口其显示条件。

- [ ] **Step 5: 提交**

~~~bash
git add src/components/GenerationStatusModal.tsx src/components/GenerationStatusModal.test.tsx src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx
git commit -m "feat(ui): distinguish action and narrative retry states"
~~~

### Task 2: 保留 NPC 对话并加入玩家回应与内联 loading

**Files:**
- Modify: src/components/LocationSceneScreen.tsx
- Modify: src/components/AdventureGameShell.tsx
- Test: src/components/AdventureGameShell.test.tsx
- Test: src/components/LocationSceneScreen.test.tsx

**Interfaces:**
- `src/components/LocationSceneScreen.tsx:10-23` 的 `LocationSceneScreenProps.onSubmit` 接受可选的 NPC 来源标记（与 Task 1 的 `InteractionOrigin` 同源）；普通场景行动继续只传一个参数：

~~~ts
readonly onSubmit: (
  interaction: PlayerInteraction,
  origin?: "npc-dialogue",
) => void;
~~~

- `NpcDialogueModal` 的展示状态由父组件 `LocationSceneScreen` 注入，不在模态内自建来源；父组件在提交前写入临时展示字段：

~~~ts
type DialogueUiState = {
  readonly npcId: string | null;
  readonly revision: number;
  readonly pendingPlayerResponse: string | null;       // 仅本页面展示，固定选项为选中 label，自定义输入为 trim 后文本
  readonly pendingChoiceToken: string | null;          // 仅本页面展示，不进入 PlayerInteraction 以外的请求 payload
};
type DialoguePhase = "choice" | "waiting";
~~~

- 增加 `pendingPlayerResponse`、`pendingChoiceToken` 两个 props，并将已有交接场景的 `handoffPlayerResponse` 与本次提交的临时回应分开命名，避免固定选项被重复渲染为 NPC 对话段落。`NpcDialogueModal` 的提交回调统一为 `onSubmit(interaction, playerResponse)`，其中 `playerResponse` 只用于当前页面展示。

  `NpcDialogueModal` 的相关 props 契约固定为：`pendingPlayerResponse: string | null`、`pendingChoiceToken: string | null`、`onSubmit: (interaction: PlayerInteraction, playerResponse: string) => void`、`handoffPlayerResponse?: string | null`；固定选项和自定义输入都必须传入规范化后的展示文本。

- `waiting` 时保留同一个 `NpcDialogueModal`，展示旧 NPC 台词、玩家回应、内联 spinner 和等待文案。`NpcDialogueModal` 只负责展示和提交，不读取 action key、解析 token 或判断任务是否完成。
- **Spinner 挂载点（本次修复重点）**：固定选项的菊花为所选按钮内部的 inline 元素；自定义输入的菊花为玩家回应段落末尾的 inline 元素。两者共用同一个 `data-testid="npc-dialogue-spinner"`，`aria-hidden="true"`，不作为独立状态行：

~~~tsx
// 固定选项（本 Task Interfaces 的精确实现）
<button
  key={choice.choiceToken}
  type="button"
  disabled={busy}
  aria-current={choice.choiceToken === pendingChoiceToken}
  className={choice.choiceToken === pendingChoiceToken ? "npc-dialogue-choice--selected" : undefined}
  onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken }, choice.label)}
>
  {choice.label}
  {choice.choiceToken === pendingChoiceToken && phase === "waiting" ? <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" /> : null}
</button>

// 自定义输入（本 Task Interfaces 的精确实现）
{pendingPlayerResponse !== null && pendingChoiceToken === null ? (
  <p className="npc-dialogue-speech-text npc-dialogue-speech-text--player">
    {normalizeDisplayText(pendingPlayerResponse)}
    {phase === "waiting" ? <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" /> : null}
  </p>
) : null}
~~~

- [ ] **Step 1: 写失败测试**

在 AdventureGameShell.test.tsx 增加固定选项等待测试（精确校验 spinner 挂在选中按钮内）：

~~~tsx
it("keeps the NPC modal and shows the selected fixed choice while waiting", async () => {
  let resolveRequest!: (outcome: ActionOutcome) => void;
  vi.mocked(postAction).mockImplementationOnce(
    () => new Promise<ActionOutcome>((resolve) => { resolveRequest = resolve; }),
  );

  const user = userEvent.setup();
  renderShell();
  await enterScene(user);
  await user.click(screen.getByRole("button", { name: "追问线索" }));

  const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
  expect(dialogue).toBeInTheDocument();
  // 选中项的 label 仍可见，且 spinner 在该按钮内部
  const selectedBtn = screen.getByRole("button", { name: "追问线索" });
  expect(selectedBtn).toBeDisabled();
  expect(selectedBtn).toHaveAttribute("aria-current", "true");
  expect(selectedBtn).toHaveClass("npc-dialogue-choice--selected");
  expect(within(selectedBtn).getByTestId("npc-dialogue-spinner")).toBeInTheDocument();
  expect(within(selectedBtn).getByTestId("npc-dialogue-spinner")).toHaveAttribute("aria-hidden", "true");
  expect(dialogue).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status")).toHaveTextContent("正在等待老板回应");
  expect(screen.getByRole("button", { name: "关闭对话" })).toBeDisabled();
  // 另一选项仍可见但 disabled，无 spinner
  expect(screen.getByRole("button", { name: "表示理解" })).toBeDisabled();
  expect(within(screen.getByRole("button", { name: "表示理解" })).queryByTestId("npc-dialogue-spinner")).not.toBeInTheDocument();

  resolveRequest({ kind: "rejected", message: "stop" });
});
~~~

增加自定义输入测试：发送“我有一个主意”后，输入内容以 `npc-dialogue-speech-text--player` 段落显示，段落末尾带 `data-testid="npc-dialogue-spinner"`，`role="textbox"` 不再可编辑，`dialog` 同样 `aria-busy="true"` 且 `role=status` 文案为“正在等待老板回应”。

把现有 `src/components/AdventureGameShell.test.tsx:872` 的“hides NPC dialogue panels while narrative generation is pending”测试改为断言：当已有 NPC 对话焦点（`openDialogueNpcId !== null`）时 `view.narrativeGeneration.status === "pending"` 不清空对话；只有在没有本地打开对话时，才不自动打开 NPC 模态。对应 `src/components/LocationSceneScreen.test.tsx` 亦补充同一用例。

- [ ] **Step 2: 运行测试确认当前行为失败**

Run:

~~~bash
npx vitest run src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx
~~~

Expected: FAIL，因为当前 pending 会把 activeDialogues 置为空，选项提交没有玩家回应展示，也没有 npc-dialogue-spinner。

- [ ] **Step 3: 实现对话临时状态与等待视图**

在 LocationSceneScreen.tsx 执行以下行为（对应 `src/components/LocationSceneScreen.tsx:222-374` 的 `NpcDialogueModal` 与 `src/components/LocationSceneScreen.tsx:376-840` 的 `LocationSceneScreen`）：

1. 删除 `src/components/LocationSceneScreen.tsx:391-395` 的 `pending ? [] : ...` 对话清空逻辑；改为 `const activeDialogues = (view.narrative.npcDialogues ?? []).filter(...)`，保留当前 `activeDialogues`，由 `dialoguePhase` 决定对话框是选项态还是等待态。同步保留 `src/components/LocationSceneScreen.tsx:523-531` 的 `initialOpenDialogueNpcId` 逻辑，测试环境下仍默认打开第一个活跃对话。
2. 固定选项、给予道具选项和非焦点正式 CTA 将其 `label` 作为 `playerResponse` 传给 `NpcDialogueModal`；自定义输入将 `trim` 后的临时文本作为 `playerResponse`，仍只通过原 `free_text` `PlayerInteraction` 提交，不写入 `GameSessionView`。
3. 提交前先写入 `DialogueUiState.pendingPlayerResponse` 与 `pendingChoiceToken`，再设置 `dialoguePhase("waiting")`，最后调用外层 `onSubmit(interaction, "npc-dialogue")`。`onSubmit` 的 `origin` 必须与 Task 1 的 `InteractionOrigin` 同值，`LocationSceneScreen` 的场景行动、物品热点、地图入口不传 `origin`（默认为 `other`）。
4. waiting 期间保留两个固定选项的可见性但全部 `disabled`；已选项增加 `npc-dialogue-choice--selected` 与 `aria-current="true"`，并在其内部渲染 `data-testid="npc-dialogue-spinner"`（见本 Task Interfaces 的精确 JSX）。自定义输入区域改为不可编辑的等待行：隐藏 `form.npc-dialogue-input`，以 `p.npc-dialogue-speech-text--player` 展示 `playerResponse` 并在其末尾内联 spinner，避免玩家误以为文本丢失。
5. 对话关闭按钮（aria-label="关闭对话"）在 busy || phase === "waiting" 时 disabled；非焦点 NPC 的“知道了”按钮也必须遵守 busy。aria-busy="true" 放在根 div.npc-dialogue-backdrop（role="dialog"）上，等待说明 p.npc-dialogue-status 保持 role="status" aria-live="polite"，测试与 Task 4 使用同一个 dialog 节点。
6. busy 从 true 恢复为 false 且 view.revision 已变化时，允许 ready 快照中的新 NPC 台词和新选项直接替换旧选项；spinner 消失，选项恢复可用，不增加“继续对话”按钮。ready 或普通 rejected/error 后清空 pendingPlayerResponse 与 pendingChoiceToken，避免旧选项在新一轮显示为残留选中态；失败重试期间保留这两个字段。
7. action 被普通 rejected/error 拒绝时清掉临时 waiting 状态并恢复输入（setDialoguePhase("choice") 并清空 pendingPlayerResponse/pendingChoiceToken）；AI 失败（retryable）进入失败模态时保留临时回应和 waiting 状态，直到重试成功或用户重新获得可操作状态。同步删除或替换现有 `SubmittedDialogue`、`previousBusyRef` 及其旧的 busy 恢复 effect，不能让旧的“先隐藏对话、再恢复选项”逻辑与新临时状态并存；等待态的清理只能由当前 `busy`、`view.revision` 和失败状态共同决定。

waiting 分支不能继续使用当前 phase === "waiting" 后直接只渲染 status 的早返回；它必须渲染 disabled 的选项组，并只把自由输入表单替换为等待行。固定选项使用 pendingChoiceToken 负责选中高亮，固定选项不再额外渲染 pendingPlayerResponse 段落；自定义输入才在玩家回应段落末尾渲染 spinner。

NpcDialogueModal 只负责展示和提交，不读取 action key、解析 token 或判断任务是否完成。

- [ ] **Step 4: 运行测试确认通过**

Run:

~~~bash
npx vitest run src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx
~~~

Expected: 固定选项、自定义输入、旧对话焦点保留、ready 后恢复新选项和普通拒绝恢复测试 PASS。

- [ ] **Step 5: 提交**

~~~bash
git add src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx
git commit -m "feat(ui): keep NPC dialogue open during response generation"
~~~

### Task 3: 只对 NPC 对话移除全屏等待模态并锁住全局入口

**Files:**
- Modify: src/components/AdventureGameShell.tsx
- Modify: src/components/AdventureHud.tsx
- Modify: src/components/LocationSceneScreen.tsx
- Test: src/components/AdventureGameShell.test.tsx

**Interfaces:**
- `src/components/AdventureGameShell.tsx:63-68` 的 `busy` 拆分为来源感知的两路，并在 `src/components/AdventureGameShell.tsx:40-68` 顶部定义 `InteractionOrigin`（与 Task 1 同源）：

~~~ts
type InteractionOrigin = "npc-dialogue" | "other";

const [lastInteractionOrigin, setLastInteractionOrigin] = useState<InteractionOrigin>("other");
const pending = view.narrativeGeneration.status === "pending";
const narrativeFailed = view.narrativeGeneration.status === "failed";
const isSubmitting = feedback.phase === "submitting";
const actionFailed = feedback.phase === "retryable";
const dialogueSubmissionBusy =
  lastInteractionOrigin === "npc-dialogue"
  && (isSubmitting || pending);
const ordinaryProgressBusy = !dialogueSubmissionBusy && (isSubmitting || pending);
const controlsBusy = isSubmitting || pending || narrativeFailed || actionFailed;
// 传给子组件的精确值：
 // AdventureHud / 返回按钮 / 场景热点： disabled={controlsBusy}
 // LocationSceneScreen busy={controlsBusy}
 // WorldMapScreen/TownLayerScreen busy={controlsBusy}
~~~

- `src/components/AdventureHud.tsx:14-22` 的 `AdventureHudProps` 增加 `disabled?: boolean`，实现为角色卡、四个信息入口（角色/背包/任务/日志）和开发工具按钮统一 `disabled={disabled}`，并在 `aria-disabled` 同步状态，避免仅靠 `z-index` 遮挡：

~~~ts
type AdventureHudProps = {
  readonly view: GameSessionView;
  readonly screen: "map" | "town" | "scene";
  readonly sceneLocationName?: string | null;
  readonly onOpen: (panel: DetailsPanel) => void;
  readonly developmentTools: boolean;
  readonly onOpenDevTools: () => void;
  readonly disabled?: boolean;
};
~~~

- `src/components/GenerationStatusModal.tsx:42-49` 的显示优先级固定为：`narrative-failure` → `action-failure` → 非 NPC 的 `action`/`narrative` progress；`dialogueSubmissionBusy === true` 时不渲染 `GenerationStatusModal(kind="narrative"|"action")`。`narrativeFailed` 和 `actionFailed` 永远优先于等待态，即使 `lastInteractionOrigin === "npc-dialogue"` 也要弹出失败模态（此时 NPC 对话仍保留在失败模态下方）。
- 浏览器刷新导致本地 `lastInteractionOrigin` 丢失时，回退为 `ordinaryProgressBusy` 的恢复型 `narrative` progress 模态；不为恢复 UI 暴露 `PendingNarrativeJob` 或自由输入原文。

- [ ] **Step 1: 写失败测试**

在 AdventureGameShell.test.tsx 增加以下断言（覆盖 `src/components/AdventureGameShell.tsx:275-290` 的 gating）：

1. NPC `fixed_choice` 的 `postAction` 尚未返回（`isSubmitting===true`）时，不存在名为“正在处理……”或“正在编排下一幕……”的全屏 `dialog`；`getByRole("dialog",{name:"与老板对话"})`、`within(selectedBtn).getByTestId("npc-dialogue-spinner")` 和 `getByRole("status",{name:"正在等待老板回应"})` 仍存在。
2. `postAction` 返回 `view.narrativeGeneration.status === "pending"` 后，仍不存在“正在编排下一幕……”，但 NPC 对话保持 `aria-busy="true"` 且所有选项 `disabled`。
3. NPC 等待期间角色卡、信息入口“角色/背包/任务/日志”、开发工具、“返回地图/返回小镇”、`scene-npc-card`、`scene-interactive-hotspot`、`scene-action-rail` 按钮均 `disabled`；对 HUD 中实际渲染的所有按钮逐一断言 `toBeDisabled()`，不要用“5 个入口”这类会漏掉角色卡或重复角色入口的固定数量。
4. `view.narrativeGeneration.status === "failed"` 时，NPC 对话仍在失败模态下方保留（`getByRole("dialog",{name:"与老板对话"})` 仍存在），只有“重试生成回应”可用；点击它只调用 `onRetryNarrative`，不调用 `postAction`。
5. `action-failure`（`feedback.phase==="retryable" && origin==="npc-dialogue"`）点击“重试当前选择”后，失败模态关闭、NPC 对话重新显示 `spinner`（`within(selectedBtn).getByTestId("npc-dialogue-spinner")`），并再次以同一个 `PlayerInteraction` 调用 `postAction`；重试期间不创建第二个可点击选项，且 WorldMapScreen、TownLayerScreen、AdventureHud 和 LocationSceneScreen 都继续接收同一个 controlsBusy 锁定值。
6. 普通非 NPC 地图行动（如“前往街道”`TOKENS.travel`）仍能显示既有全屏 `GenerationStatusModal(kind="action")` 和 `kind="narrative"`，作为回归断言。

- [ ] **Step 2: 运行测试确认当前全屏模态回归失败**

Run:

~~~bash
npx vitest run src/components/AdventureGameShell.test.tsx
~~~

Expected: FAIL，因为当前所有 pending 都渲染 progress modal，HUD 没有 disabled contract，narrative failure 的 UI 流程也没有和 NPC 临时提交态完整连通。

- [ ] **Step 3: 实现来源感知的 modal gating 和全局锁**

在 AdventureGameShell.tsx（`src/components/AdventureGameShell.tsx:108-138` 与 `src/components/AdventureGameShell.tsx:175-217`）：

1. `submitInteraction(interaction, origin)` 记录 `setLastInteractionOrigin(origin)`；`applyOutcome()` 在 rejected、error 或 stale 后重置为 `"other"`，在 success 后仅当返回 view 不再 pending 时重置为 `"other"`，在 ai-failure 中把 `origin` 与 `failureKind` 一并写入 `retryable` 的 `feedback`，供重试时恢复来源。
2. `retryAction()` 从 `feedback` 取回 `origin` 与 `interaction`，再调用 `submitInteraction(interaction, origin)`，确保 NPC `action failure` 重试仍走 `dialogueSubmissionBusy` 的 inline waiting，而地图/探索 `action failure` 仍使用原有 `GenerationStatusModal(kind="action-failure")` 的全屏语义。
3. 将渲染条件拆成 `narrativeFailed`、`actionFailed`、`dialogueSubmissionBusy` 和 `ordinaryProgressBusy`，避免一个 `busy` 布尔值再次把“等待”“失败”“重试”混成同一个界面。伪代码：

~~~tsx
{narrativeFailed ? (
  <GenerationStatusModal kind="narrative-failure" failureKind={view.narrativeGeneration.failureKind ?? "AI_CALL_FAILED"} onRetry={onRetryNarrative} />
) : feedback.phase === "retryable" ? (
  <GenerationStatusModal kind="action-failure" failureKind={feedback.failureKind} onRetry={retryAction} />
) : dialogueSubmissionBusy ? null // NPC 等待：不渲染任何全屏 progress modal，改为对话内 inline spinner
: ordinaryProgressBusy ? (
  <GenerationStatusModal kind={pending ? "narrative" : "action"} onRetry={pending ? onRetryNarrative : undefined} />
) : null}
~~~

4. `narrative-failure` 永远优先于等待态；`dialogueSubmissionBusy` 时不渲染 `GenerationStatusModal(kind="narrative" | "action")`。
5. AdventureHud 接收 disabled={controlsBusy}；LocationSceneScreen 的 scene-return-map-btn、scene-npc-card、scene-interactive-hotspot、scene-action-rail 亦接收并使用 controlsBusy，保证 DOM 层 disabled，不能通过键盘或测试工具绕过等待锁。

保留 `src/components/CurrentGameScreen.tsx` 的 `pending` 轮询和 `retryNarrative()` 实现，不修改其 API 请求语义。浏览器刷新导致本地 `origin` 丢失时，仍可显示非 NPC 的恢复型 `progress modal`；不为恢复 UI 暴露 `PendingNarrativeJob` 或自由输入原文。

- [ ] **Step 4: 运行测试确认通过**

Run:

~~~bash
npx vitest run src/components/AdventureGameShell.test.tsx src/components/GenerationStatusModal.test.tsx
~~~

Expected: NPC 路径不再出现两个全屏等待模态；非 NPC progress、AI action failure、narrative failure 和 HUD 锁定测试 PASS。

- [ ] **Step 5: 提交**

~~~bash
git add src/components/AdventureGameShell.tsx src/components/AdventureHud.tsx src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.test.tsx
git commit -m "feat(ui): lock game controls without NPC progress modal"
~~~

### Task 4: 完成内联 loading 的视觉和可访问性表现

**Files:**
- Modify: src/app/globals.css
- Modify: src/components/LocationSceneScreen.tsx
- Test: src/components/AdventureGameShell.test.tsx

**Interfaces:**
- `src/components/LocationSceneScreen.tsx:253-254` 的 `NpcDialogueModal` 根 `div.npc-dialogue-backdrop` 直接承担 `role="dialog" aria-modal="true" aria-busy={phase === "waiting"}`；不要把 `aria-busy` 放到内层 `section.npc-dialogue-panel`，Task 2 和本 Task 的测试都定位同一个对话根节点。等待说明 `p.npc-dialogue-status` 为 `role="status" aria-live="polite"`，文案为 `正在等待${dialogue.name}回应……`。
- spinner 使用 `data-testid="npc-dialogue-spinner"` 仅供组件测试定位，设置 `aria-hidden="true"`，不把动画字符当成屏幕阅读器文案；挂载点严格为选中按钮内或玩家回应段落末尾的 inline 元素（见 Task 2 Interfaces），不作为独立全宽状态行。
- 选中回应使用独立 class `npc-dialogue-choice--selected` 且 `aria-current="true"`；`disabled` 选项保留可读对比度，不用 `opacity` 让文字无法辨识，需在 `src/app/globals.css` 中为 `button:disabled.npc-dialogue-choice--selected` 保留 `color` 与 `border-color`。

- [ ] **Step 1: 写失败测试**

在 `src/components/AdventureGameShell.test.tsx`（或 `src/components/LocationSceneScreen.test.tsx`）中断言 spinner 的精确挂载点与可访问性：

~~~tsx
const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
expect(dialogue).toHaveAttribute("aria-busy", "true");
expect(screen.getByRole("status")).toHaveTextContent("正在等待老板回应");
const selectedBtn = screen.getByRole("button", { name: "追问线索" });
expect(selectedBtn).toHaveClass("npc-dialogue-choice--selected");
expect(selectedBtn).toHaveAttribute("aria-current", "true");
expect(within(selectedBtn).getByTestId("npc-dialogue-spinner")).toHaveAttribute("aria-hidden", "true");
expect(within(selectedBtn).getByTestId("npc-dialogue-spinner")).toHaveClass("npc-dialogue-inline-spinner");
~~~

- [ ] **Step 2: 运行测试确认 class/ARIA 尚不存在**

Run:

~~~bash
npx vitest run src/components/AdventureGameShell.test.tsx
~~~

Expected: FAIL，因为当前 NPC dialog 没有 aria-busy、spinner test id 和 selected choice class。

- [ ] **Step 3: 实现样式与 reduced-motion 降级**

在 globals.css 增加：

~~~css
.npc-dialogue-inline-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-left: 8px;
  border: 2px solid var(--game-surface-border);
  border-top-color: var(--game-accent);
  border-radius: 50%;
  animation: npc-dialogue-spin 0.8s linear infinite;
}

@keyframes npc-dialogue-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .npc-dialogue-inline-spinner { animation: none; }
}
~~~

在 NpcDialogueModal 将 spinner 放在选中按钮内部（固定选项）或玩家回应段落末尾（自定义输入），视觉上明确“正在等 NPC 回应”，而不是表示页面正在重新加载。两者均使用 `src/app/globals.css` 中的 `.npc-dialogue-inline-spinner`（14px、margin-left 8px、border-top-color 为 `var(--game-accent)`），不复用 `GenerationStatusModal` 的大尺寸全屏 spinner。通过 `within(selectedBtn).getByTestId` 可校验挂载点，避免实现时把 spinner 放到独立状态行。

选中回应的 disabled 样式必须覆盖现有通用 disabled 降低透明度，避免等待中的选项变得不可读：

~~~css
.npc-dialogue-choices button:disabled.npc-dialogue-choice--selected {
  opacity: 1;
  color: var(--game-text-primary);
  border-color: var(--game-accent);
  cursor: wait;
}
~~~

- [ ] **Step 4: 运行组件测试与类型检查**

Run:

~~~bash
npx vitest run src/components/AdventureGameShell.test.tsx src/components/LocationSceneScreen.test.tsx
npm run typecheck
~~~

Expected: PASS；没有新增 TypeScript 错误，spinner 和 selected choice 的可访问性断言通过。

- [ ] **Step 5: 提交**

~~~bash
git add src/app/globals.css src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.test.tsx
git commit -m "style(ui): add inline NPC response loading state"
~~~

### Task 5: 同步实现事实并完成验收

**Files:**
- Modify: docs/agent/NPC对话驱动叙事场景触发.md
- Modify: docs/agent/地图与地点冒险.md
- Modify: docs/Agent文档索引.md

**Interfaces:**
- 文档事实必须与最终 UI 一致：NPC 正式提交后保留同一对话模态；玩家已选回应旁显示小型 loading；对话及全局入口锁定；ready 直接显示新 NPC 回应和新选项；failed 才显示重试模态。
- 文档必须保留两类失败边界：行动 API 失败重试原 interaction；pending 场景失败使用同一 job 的 retry: true，不重复规则回合。
- 不把前端临时 player response 写成 GameSessionView、PendingNarrativeJob 或长期记忆字段；不修改服务端 API 契约描述。

- [ ] **Step 1: 更新 NPC 对话实现事实**

在 docs/agent/NPC对话驱动叙事场景触发.md 中将 pending 期间“暂时隐去旧台词/由全屏模态负责等待”的描述改为：

~~~text
正式对白提交后保留原 NPC 对话模态；选中的固定回应或自定义回应的本地临时展示保留在当前模态中，并在其后显示等待 NPC 回应的内联 loading。自定义输入只保留在当前页面临时状态，不写入对话记录。对话选项、输入、关闭和其它游戏入口全部锁定。ready 写回后直接显示同一 NPC 的新台词和下一组选项，不增加继续按钮。场景生成 failed 时只弹出失败重试模态；行动尚未提交的 AI 失败重试原 interaction，规则已提交的场景失败复用同一 narrative job。
~~~

- [ ] **Step 2: 更新地图/场景实现事实和索引**

在 docs/agent/地图与地点冒险.md 的 pending 说明中保留非 NPC 行动的全屏等待行为，但明确 NPC 对话提交走对话内联等待；在 docs/Agent文档索引.md 的 NPC 对话和地图系统行中同步同一句实现摘要。

- [ ] **Step 3: 运行文档与静态门禁**

Run:

~~~bash
npm run check:standards
npm run typecheck
npm run test:boundaries
npm run test:components
npm run test:app
npm test
~~~

Expected: 所有命令 PASS；组件测试覆盖 NPC 固定选项、自定义输入、pending 保留、ready 恢复、action failure retry、narrative failure retry、HUD/返回入口锁定和非 NPC progress 回归。

- [ ] **Step 4: 做最终行为审查**

逐项确认：

- 点击固定选项后，玩家仍看见同一个 NPC 对话框、选中选项和 spinner。
- 发送自定义输入后，输入不会无解释地消失；等待期间不能再次发送。
- pending 期间不存在“正在编排下一幕”全屏模态。
- ready 后不需要“继续对话”，新台词和新选项直接出现。
- action failure 不重复规则提交；narrative failure 不重新提交玩家 action。
- 非 NPC 的地图、调查、拾取、战斗和开局等待仍保持既有反馈。
- 页面刷新不会泄漏 pending job、自由输入原文或 provider 错误。

- [ ] **Step 5: 提交文档和最终变更**

~~~bash
git add docs/agent/NPC对话驱动叙事场景触发.md docs/agent/地图与地点冒险.md docs/Agent文档索引.md
git commit -m "docs: record inline NPC dialogue waiting behavior"
~~~

## Self-Review

- 需求覆盖：保留 NPC 对话、选项后 spinner、锁定所有按钮、移除 NPC 路径全屏 pending modal、ready 直接显示下一轮、failed 显示 retry modal、区分两类 retry，均在 Task 1–5 有对应实现或测试。
- API 边界：没有新增 route，没有把 retry 当成第二次规则行动，没有把临时玩家文字加入 read model。
- 回归边界：仅 NPC 对话隐藏全屏 progress modal；普通非 NPC pending、开局、战斗和地图行为继续由既有 GenerationStatusModal 负责。
- 类型一致性：InteractionOrigin、ActionFeedback.retryable.failureKind/origin、GenerationStatusModal 两类 failure props、LocationSceneScreen.onSubmit 的可选 origin 在各任务中保持同一命名。
- 可访问性：waiting 使用 aria-busy 和 role=status，spinner aria-hidden，按钮在 DOM 层 disabled，并提供 reduced-motion 降级。
- 未修改服务端规则、AI source、持久化 schema、API route、CurrentGameScreen 的轮询和同 job retry 语义。
