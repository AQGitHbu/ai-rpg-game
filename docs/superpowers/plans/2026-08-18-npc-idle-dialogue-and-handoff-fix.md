# NPC 对话交接与闲聊模式修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NPC 引导出下一剧情（交接）后，再次与其对话改为零回合、零 API 的本地闲聊/提醒展示；正式对话只能经当前权威 talk 目标入口（行动栏目标交谈或交接 NPC 的双选项）开启，闲聊永不推进新剧情。

**Architecture:**
1. **读模型收口 (`gameSessionView.ts`)**：行动栏与 `talkChoice` 只为当前权威 talk 目标 NPC 铸造 ask 入口；所有非焦点 NPC 一律投影 `choices: []`、`freeInputEnabled: false` 的闲聊对话（含预生成待机台词），删除 `fallbackTalkChoice`。
2. **UI 闲聊展示 (`LocationSceneScreen.tsx`)**：非焦点弹窗渲染台词 + “知道了”关闭按钮，不提交任何请求；删除 UI 侧自行合成可提交交谈入口的两条路径（对话合成与侧边栏合成）。
3. **台词预生成 (`npcSpeech.ts`)**：新增 `composeIdleNpcLine`，按“是否参与过剧情 + 当前权威目标”确定性生成提醒或中性闲聊变体；生成点在 read model（那里才有 `currentObjectiveLabel`），不在 `deterministicSceneSource.ts`。

**Tech Stack:** TypeScript, React, Next.js, Vitest, Testing Library.

## Global Constraints

- 单一架构：规则修改与状态投影保持纯函数确定性；同 seed 同状态投影结果不变（变体仅由结构化字段决定）。
- 零额外 API：非目标 NPC 闲聊完全消费 read model 预生成数据，点击不创建 `PendingNarrativeJob`、不调用 `postAction`。
- `composeDirectNpcGreeting()` 无参调用行为不变：`gameSessionView.ts` 旧存档通用问候清洗检测（`onlyLegacyGenericGreeting`）依赖它。
- 正式对白仍走单一路径：`/api/game/actions` → `performTurn`；本次不新增任何并行入口，只收窄入口的投影范围。
- NPC 知识边界：从未与玩家交互过的 NPC 闲聊台词不得引用当前主线目标内容（防泄露未参与的信息）。
- 遵守 `docs/游戏开发规范.md`：UI 只从 `@/game/application` 导入；最低验收 `npm run test:boundaries` + `npm run typecheck`；行为子集按 5.1 表入口运行。

---

### Task 1: `npcSpeech.ts` 新增确定性闲聊台词组合器

**Files:**
- Modify: `src/game/domain/npcSpeech.ts`
- Test: `src/game/domain/npcSpeech.test.ts`

**Interfaces:**
- Produces: `composeIdleNpcLine(input: { readonly currentObjectiveLabel: string | null; readonly hasInteractionHistory: boolean; readonly variantIndex: number }): string` — Task 2 的 read model 消费此签名。

- [ ] **Step 1: 编写失败测试**

在 `src/game/domain/npcSpeech.test.ts` 追加：

```typescript
import { composeIdleNpcLine } from "./npcSpeech";

describe("composeIdleNpcLine", () => {
  it("有交互历史的 NPC 生成承接当前权威目标的提醒台词", () => {
    const line = composeIdleNpcLine({
      currentObjectiveLabel: "调查酒楼后巷的车轮印",
      hasInteractionHistory: true,
      variantIndex: 0,
    });
    expect(line).toContain("调查酒楼后巷的车轮印");
    // 直接对白正文：无叙述包装、无引号残留
    expect(normalizeNpcSpeech(line)).toBe(line);
  });

  it("无交互历史的 NPC 使用不泄露主线内容的中性闲聊", () => {
    for (let variantIndex = 0; variantIndex < 6; variantIndex += 1) {
      const line = composeIdleNpcLine({
        currentObjectiveLabel: "调查酒楼后巷的车轮印",
        hasInteractionHistory: false,
        variantIndex,
      });
      expect(line).not.toContain("车轮印");
      expect(line).not.toContain("调查");
    }
  });

  it("同 variantIndex 稳定，变体索引覆盖全部模板", () => {
    const a = composeIdleNpcLine({ currentObjectiveLabel: null, hasInteractionHistory: true, variantIndex: 4 });
    const b = composeIdleNpcLine({ currentObjectiveLabel: null, hasInteractionHistory: true, variantIndex: 4 });
    expect(a).toBe(b);
    // objective 为 null 时即使有交互历史也落入中性闲聊（无目标可提醒）
    const seen = new Set(
      [0, 1, 2].map((i) => composeIdleNpcLine({ currentObjectiveLabel: null, hasInteractionHistory: false, variantIndex: i })),
    );
    expect(seen.size).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/domain/npcSpeech.test.ts`
预期：FAIL（`composeIdleNpcLine` 未导出）。

- [ ] **Step 3: 实现 `composeIdleNpcLine`**

在 `src/game/domain/npcSpeech.ts` 末尾追加（不改动 `composeDirectNpcGreeting` 等既有函数）：

```typescript
/** 已参与过剧情的 NPC 待机提醒变体：只引用权威当前目标，不制造未发生的地点、证物或人物。 */
const IDLE_REMINDER_VARIANTS: readonly string[] = [
  "先前说定的事别忘了。{objective}要紧，有了结果再来告诉我。",
  "我还在这儿守着。{objective}有了眉目，随时来寻我。",
  "别在我这里耽搁太久。{objective}查清楚了，我们再从头核对。",
];

/** 无交互历史 NPC 的中性闲聊变体：不泄露未参与的主线内容。 */
const IDLE_AMBIENT_VARIANTS: readonly string[] = [
  "今日没什么可说的。你忙你的正事，我先招呼着。",
  "我就在这里。亲眼见过的事，问了我才答。",
  "忙你的去吧。真有要紧事，我不会瞒你。",
];

/**
 * 组合非焦点 NPC 的零回合闲聊台词。
 * 有结构化交互历史且存在权威当前目标 → 提醒变体；否则 → 中性闲聊变体。
 * variantIndex 由调用方从结构化字段（回合数/幕次/交互条数）派生，保证确定性重放。
 */
export function composeIdleNpcLine(input: {
  readonly currentObjectiveLabel: string | null;
  readonly hasInteractionHistory: boolean;
  readonly variantIndex: number;
}): string {
  const isReminder = input.hasInteractionHistory && input.currentObjectiveLabel !== null;
  const variants = isReminder ? IDLE_REMINDER_VARIANTS : IDLE_AMBIENT_VARIANTS;
  const template = variants[Math.abs(input.variantIndex) % variants.length]!;
  return isReminder
    ? template.replaceAll("{objective}", input.currentObjectiveLabel!)
    : template;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/domain/npcSpeech.test.ts`
预期：PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/game/domain/npcSpeech.ts src/game/domain/npcSpeech.test.ts
git commit -m "feat(narrative): add deterministic idle npc line composer"
```

---

### Task 2: 读模型收口——非焦点 NPC 闲聊化、talk 入口只属权威目标

**Files:**
- Modify: `src/game/application/gameSessionView.ts`
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `composeIdleNpcLine`。
- Produces: `NpcDialogueView.choices` 对非焦点 NPC 恒为 `[]`；`GameSessionView["currentLocation"]["npcs"][number]["talkChoice"]` 类型改为 `PlayerChoiceView | null`（仅当前 talk 目标 NPC 非 null）——Task 3 的 UI 消费此契约。

- [ ] **Step 1: 编写/更新失败测试**

在 `src/game/application/gameSessionView.test.ts` 中：

(a) 新增用例（追加到 smallTalk 用例之后，装配方式与该文件既有内联构造一致）：

```typescript
it("交接后的非焦点 NPC 只提供零回合闲聊，不再投影可提交的 ask 选项", () => {
  const factTracks = {
    factId: asFactId("fact_tracks"),
    text: "车轮印",
    source: "generated" as const,
    discovered: false,
    locationId: loc1.id,
  };
  const wsHandoffIdle: WorldState = {
    ...ws,
    npcs: [{ ...npc1, met: true }],
    worldFacts: [factTracks],
    quests: [{
      id: asQuestId("quest_tracks"),
      name: "追查车轮印",
      description: "查明车轮印",
      objectives: [
        { kind: "talk_to_npc", npcId: npc1.id },
        { kind: "discover_fact", factId: factTracks.factId },
      ],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    }],
  };
  const ssHandoffIdle: StoryState = {
    ...ss,
    reveal: { questId: asQuestId("quest_tracks"), visibleObjectiveIndex: 1 },
    narrative: {
      ...ss.narrative,
      dialogueSession: { npcId: npc1.id, turnCount: 2, requiredTurns: 2, completed: true },
      currentScene: {
        sceneId: "scene-handoff-idle",
        turn: 5,
        narration: "老板说完了。",
        usedFactIds: [],
        npcLine: { npcId: npc1.id, text: "接下来去查明车轮印。", emotion: "neutral" as const, usedFactIds: [] },
        choices: [] as never,
        source: "fallback" as const,
        event: { kind: "observe" as const, locationId: loc1.id },
      },
    },
  };

  const view = projectGameSessionView(wsHandoffIdle, ssHandoffIdle, 0, "test-ending-session");
  const idle = view.narrative.npcDialogues.find((dialogue) => dialogue.npcId === String(npc1.id));
  expect(idle).toBeDefined();
  expect(idle?.choices).toEqual([]);
  expect(idle?.freeInputEnabled).toBe(false);
  expect(idle?.speechPages.length).toBeGreaterThan(0);
  // 老板参与过剧情且当前目标为调查 → 提醒台词承接权威目标
  //（discover_fact 的目标 label 由 fact 文本派生，故断言事实文本而非具体动词）
  expect(idle?.speechPages.join("")).toContain("车轮印");
  // 行动栏与 talkChoice 不再为非目标 NPC 提供交谈入口
  expect(view.currentLocation.actions.some((action) => action.presentation === "dialogue")).toBe(false);
  expect(view.currentLocation.npcs[0]?.talkChoice).toBeNull();
});
```

(b) 更新三个锁定旧“单选项 ask 入口”行为的用例（均在 `src/game/application/gameSessionView.test.ts`）：

1. 交接用例（约 L301-314，`oldNpc` 断言处）：

```typescript
    expect(oldNpc?.freeInputEnabled).toBe(false);
    // 旧断言：expect(oldNpc?.choices.map((entry) => entry.label)).toEqual(["与老板交谈"]);
    expect(oldNpc?.choices).toEqual([]);
    expect(oldNpc?.speechPages.length).toBeGreaterThan(0);
```

2. 过期对白用例（约 L398-404，objective 为 obtain_item、老板 supplied 台词场景）：

```typescript
    expect(dialogue?.freeInputEnabled).toBe(false);
    // 旧断言：expect(dialogue?.choices).toHaveLength(1); expect(dialogue?.choices[0]?.label).toBe("与老板交谈");
    expect(dialogue?.choices).toEqual([]);
```

3. observe 旁白用例（约 L690-695）与 smallTalk 用例（约 L963-969，韩征）：

```typescript
    // observe 用例
    expect(dialogue?.freeInputEnabled).toBe(false);
    expect(dialogue?.choices).toEqual([]);

    // smallTalk 用例（韩征）：无 ask 选项；动作旁白被清洗后回落闲聊台词
    expect(nonFocusNpc?.choices).toEqual([]);
    expect(nonFocusNpc?.freeInputEnabled).toBe(false);
    expect(nonFocusNpc).not.toHaveProperty("smallTalk");
    expect(nonFocusNpc?.speechPages.join("")).not.toContain("继续巡视");
    expect(nonFocusNpc?.speechPages.length).toBeGreaterThan(0);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/gameSessionView.test.ts`
预期：新用例 FAIL（`choices` 仍含 `fallbackTalkChoice`）；被更新的旧用例 FAIL。

- [ ] **Step 3: 修改 `gameSessionView.ts`**

四处修改：

(a) import 增加 `composeIdleNpcLine`（与既有 `composeDirectNpcGreeting` 同一 import 语句）。

(b) `locationActions` 的 talk 循环（现 L379-386，`for (const npc of presentNpcs)` 整段）替换为：

```typescript
    // 正式交谈入口只属于当前权威 talk 目标；其余在场 NPC 一律零回合闲聊展示，
    // 不再提供可提交的 ask 行动。
    if (
      currentObjective?.kind === "talk_to_npc"
      && presentNpcs.some((npc) => String(npc.id) === String(currentObjective.npcId))
    ) {
      const objectiveNpc = presentNpcs.find((npc) => String(npc.id) === String(currentObjective.npcId))!;
      locationActions.push(choice(
        { type: "talk", npcId: objectiveNpc.id, dialogueAct: "ask" },
        revision,
        `与${objectiveNpc.name}交谈`,
        "dialogue",
      ));
    }
```

（token 与 `currentObjectiveChoiceToken()` 对 talk 目标铸造的 action 相同，`deriveRuntimeChoiceToken(action, revision)` 确定性保证两处一致，UI 按 token 匹配 `currentObjectiveAction` 的逻辑不变。）

(c) `currentLocation.npcs` 投影（现 L625-634）与类型声明（`GameSessionView` 内 `npcs` 字段，`talkChoice: PlayerChoiceView` 改为 `talkChoice: PlayerChoiceView | null`）：

```typescript
      npcs: presentNpcs.map((npc) => ({
        name: npc.name,
        role: npc.role,
        // talkChoice 只在“该 NPC 就是当前权威 talk 目标”时下发
        talkChoice: currentObjectiveNpcId === String(npc.id)
          ? choice(
              { type: "talk", npcId: npc.id, dialogueAct: "ask" },
              revision,
              `与${npc.name}交谈`,
              "dialogue",
            )
          : null,
      })),
```

(d) `npcDialogues` 映射（现 L528-582）重写为：

```typescript
  const npcDialogues: readonly NpcDialogueView[] = presentNpcs.map((npc) => {
    const isFocus = focusNpcId === String(npc.id);
    const supplied = sceneDialogues.get(String(npc.id));
    const normalizedFocusLine = scene?.npcLine !== null
      && scene?.npcLine !== undefined
      && scene.npcLine.npcId === npc.id
      && scene.npcLine.text.trim() !== ""
      ? normalizeNpcSpeech(scene.npcLine.text, npc.name)
      : null;
    const focusLine = normalizedFocusLine === "" ? null : normalizedFocusLine;
    const suppliedSpeechPages = supplied?.speechPages
      .map((page) => normalizeNpcSpeech(page, npc.name))
      .filter((page) => page !== "") ?? [];
    // 旧场景“欢迎光临”类通用问候没有剧情上下文，读取时重建
    const onlyLegacyGenericGreeting = suppliedSpeechPages.length > 0
      && suppliedSpeechPages.every((page) => page === composeDirectNpcGreeting());
    const usableSupplied = suppliedSpeechPages.length > 0 && !onlyLegacyGenericGreeting
      ? suppliedSpeechPages
      : null;
    const interactionCount = npc.memory.interactionHistory.length;
    // 非焦点 NPC 的零回合闲聊台词：参与过剧情且有权威目标 → 提醒；否则中性闲聊
    const idleLine = composeIdleNpcLine({
      currentObjectiveLabel: currentObjectiveRef?.label ?? null,
      hasInteractionHistory: interactionCount > 0,
      variantIndex: storyState.turnNumber + storyState.currentAct + interactionCount,
    });
    const speechPages = usableSupplied !== null
      ? usableSupplied
      : paginateSpeechText(
          isFocus
            ? focusLine ?? composeDeterministicNpcLine(npc.name, npc.role)
            : focusLine ?? idleLine,
          NPC_SCENE_PAGE_CHAR_BUDGET,
        );
    return [{
      npcId: String(npc.id),
      name: npc.name,
      role: npc.role,
      speechPages,
      // 非焦点 NPC 是零回合闲聊：不提供任何可提交选项；正式对话只能经
      // 当前权威 talk 目标入口（交接双选项 / 行动栏目标交谈）开启。
      choices: isFocus ? dialogueChoices : [],
      freeInputEnabled: isFocus,
      giveChoices: isFocus
        ? worldState.inventory.map((itemId) => {
            const item = worldState.items.find((entry) => entry.id === itemId);
            const itemName = item?.name ?? "未知物品";
            return {
              itemName,
              choice: choice(
                { type: "give_item", itemId, npcId: npc.id },
                revision,
                `把${itemName}交给${npc.name}`,
                "item",
              ),
            };
          })
        : [],
    }];
  });
```

要点：删除原 L539 的 `if (!isFocus && supplied === undefined && focusLine === null) return [];`（read model 现在必须为所有在场 NPC 投影闲聊对话，Task 3 据此删除 UI 合成路径）；删除 `fallbackTalkChoice`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/gameSessionView.test.ts`
预期：PASS。若 `talk_to_npc` 为目标时 `talkChoice` 相关旧断言（约 L101 `view.currentLocation.npcs[0]?.talkChoice.choiceToken`）因可空类型报 TS 错误，改为：

```typescript
    expect(view.story.currentObjectiveChoiceToken).toBe(view.currentLocation.npcs[0]?.talkChoice?.choiceToken ?? null);
```

- [ ] **Step 5: 提交**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts
git commit -m "fix(narrative): project handed-off npcs as zero-turn idle dialogues"
```

---

### Task 3: UI 闲聊弹窗与行动栏收口

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- Consumes: Task 2 的视图契约（非焦点 `choices: []`；`talkChoice: PlayerChoiceView | null`）。
- Produces: 非焦点弹窗渲染 `speechPages` + “知道了”按钮（`onClick={onClose}`），不调用 `onSubmit`。

- [ ] **Step 1: 编写/更新失败测试**

(a) 在 `src/components/AdventureGameShell.test.tsx` 追加零回合闲聊用例（复用既有 `buildView` / `enterScene` / `vi.mock("./gameActionRequest")` 模式）：

```typescript
it("renders zero-turn idle dialogue for handed-off NPC with dismiss button and no submission", async () => {
  const user = userEvent.setup();
  const idleView: GameSessionView = {
    ...buildView(),
    currentLocation: {
      ...buildView().currentLocation,
      npcs: [{ name: "老周", role: "茶摊老板", talkChoice: null }],
    },
    narrative: {
      ...buildView().narrative,
      npcDialogues: [{
        npcId: "npc_lao_zhou",
        name: "老周",
        role: "茶摊老板",
        speechPages: ["先前说定的事别忘了。调查酒楼后巷的车轮印要紧，有了结果再来告诉我。"],
        choices: [],
        freeInputEnabled: false,
        giveChoices: [],
      }],
    },
  };
  renderShell(idleView);
  await enterScene(user);

  // 点击老周卡片打开闲聊弹窗（纯本地打开，不消费回合）
  await user.click(screen.getByRole("button", { name: "老周" }));

  expect(screen.getByText(/调查酒楼后巷的车轮印/)).toBeInTheDocument();
  // 不存在可提交的“与老周交谈”按钮，也不存在自由输入
  expect(screen.queryByRole("button", { name: "与老周交谈" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("自定义回应")).not.toBeInTheDocument();

  // “知道了”关闭弹窗；全程零提交
  await user.click(screen.getByRole("button", { name: "知道了" }));
  expect(screen.queryByRole("dialog", { name: "与老周对话" })).not.toBeInTheDocument();
  expect(vi.mocked(postAction)).not.toHaveBeenCalled();
});
```

(b) 更新 busy 用例（约 L223-242）：删除 `preparedDialogueTalkChoice` 后行动栏不再出现“与老板交谈”，两处按钮断言改为弹窗内选项：

```typescript
    // 旧：expect((screen.getByRole("button", { name: "与老板交谈" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "追问线索" }) as HTMLButtonElement).disabled).toBe(true);
    // 旧：expect((screen.getByRole("button", { name: "与老板交谈" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "追问线索" }) as HTMLButtonElement).disabled).toBe(false);
    });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx`
预期：新用例 FAIL（无“知道了”按钮）；busy 用例 FAIL（按钮名不存在）。

- [ ] **Step 3: 修改 `LocationSceneScreen.tsx`**

五处修改：

(a) `NpcDialogueModal` 非焦点分支（现 L333-352 的 `: (` 分支）改为：

```tsx
        ) : (
          /* 非焦点 NPC：零回合闲聊展示；有台词 + “知道了”关闭，不提交任何请求 */
          <>
            {dialogue.choices.length > 0 ? (
              <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
                {dialogue.choices.map((choice) => (
                  <button
                    key={choice.choiceToken}
                    type="button"
                    disabled={busy}
                    className="npc-dialogue-talk-cta"
                    onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken })}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="npc-dialogue-choices" role="group" aria-label="对话操作">
                <button
                  type="button"
                  className="npc-dialogue-dismiss-btn"
                  onClick={onClose}
                >
                  知道了
                </button>
              </div>
            )}
          </>
        )}
```

(b) 删除 `allDialoguesMap` 的 UI 合成循环（现 L478-492，`for (const npc of locationNpcs) { ... composeDirectNpcGreeting ... }` 整段）：read model 已为所有在场 NPC 投影闲聊对话。同时若文件内无其他使用，删除 import 中的 `composeDirectNpcGreeting`（现 L4）。

(c) 删除 `sidebarNpcs` 的合成循环（现 L627-639，引用 `npc.talkChoice.choiceToken` 构造 `fallbackId` 的整段）：同因已死代码，且可空类型下无法编译。

(d) `selectedNpcChoiceToken`（现 L403-405）改可空访问：

```tsx
  const selectedNpcChoiceToken = currentSceneNpcName === null
    ? null
    : locationNpcs[0]?.talkChoice?.choiceToken ?? null;
```

`handoffLeavesCurrentBuilding`（现 L422-425）改为按“建筑场景 NPC 是否就是权威 talk 目标”判定：

```tsx
  const sceneNpcIsObjectiveTalkTarget = selectedNpcChoiceToken !== null
    && selectedNpcChoiceToken === view.story.currentObjectiveChoiceToken;
  const handoffLeavesCurrentBuilding = hasBuildingSceneContext
    && view.story.currentObjectiveLabel !== null
    && !currentObjectiveIsSceneAction
    && !sceneNpcIsObjectiveTalkTarget;
```

(e) 删除 `preparedDialogueTalkChoice`（现 L428-432），`sceneActions`（现 L440-452）简化为：

```tsx
  const sceneActions = currentObjectiveRailAction !== null
    ? [currentObjectiveRailAction]
    : handoffLeavesCurrentBuilding || handoffLeavesCurrentLocation
      ? []
      : view.story.currentObjectiveChoiceToken !== null
        ? view.currentLocation.actions.filter((action) => action.choiceToken === view.story.currentObjectiveChoiceToken)
        : view.currentLocation.actions;
```

另将 `hasDialogueInteraction`（现 L467-469）改为 `activeDialogues.length > 0`（闲聊对话也构成可交互入口，避免纯闲聊场景误报“当前场景没有可执行行动”告警）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx`
预期：PASS。若有其他用例依赖行动栏“与老板交谈”快捷入口，按同一模式改为点击 NPC 卡片打开弹窗。

- [ ] **Step 5: 提交**

```bash
git add src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.test.tsx
git commit -m "feat(ui): add zero-turn idle dialogue with dismiss action"
```

---

### Task 4: 全量回归与受影响用例修正

**Files:**
- Test（按需修正）: `src/game/application/testing/*.test.ts`、`src/components/AdventureGameShell.test.tsx`

- [ ] **Step 1: 运行 application 子集（含 journey 回归）**

Run: `npm run test:game-application`
预期：PASS。journeys（`foundationJourney` / `storyDivergenceJourney` / `dynamicMaterializationJourney` / `narrativeGroundingJourney`）按目标推进，不依赖非目标 NPC 的 ask 入口；若个别 journey 显式点击非目标交谈入口，改为点击当前权威目标入口（与 HUD“下一步”一致的按钮），不改服务端断言。

- [ ] **Step 2: 运行其余子集与静态门禁**

Run: `npm run test:components`
Run: `npm run test:boundaries`
Run: `npm run typecheck`

预期：全部 PASS（`talkChoice` 可空化导致的类型错误只允许出现在本 plan 已列出的文件中）。

- [ ] **Step 3: 全量测试**

Run: `npm test`
预期：全部通过。

- [ ] **Step 4: 提交（如有修正）**

```bash
git add -A src
git commit -m "test: align journeys and components with idle npc dialogue contract"
```

---

### Task 5: 文档同步

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/闲聊功能实现说明.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: 更新 `docs/agent/NPC对话驱动叙事场景触发.md`**

- “玩家可见规则”中（现 L19）“同时保留自由回访角色的能力”一条替换为：交接/非目标 NPC 点击后是零回合闲聊弹窗（预生成提醒或中性台词 + “知道了”关闭），不提交回合、不创建 pending、不推进剧情；正式对话只能经当前权威 talk 目标入口开启。
- 现第 12 行“地点行动栏中的明确 talk 行动只打开该 NPC 已预生成的 dialogue scene”补一句：行动栏与 `talkChoice` 只为当前权威 talk 目标铸造。
- “修改注意事项”（现 L93）“不能为‘短问候’‘闲聊’增加零写入快捷路径；成功输入就是正式玩家回合”改写为：闲聊是只读展示、零写入、不创建回合；“成功输入就是正式玩家回合”仅约束可提交输入。
- 现第 98 行“非焦点 NPC 只显示真实的 `ask` 交谈入口”改为“非焦点 NPC 只显示零回合闲聊（`choices: []`），`ask` 入口仅由当前权威 talk 目标投影”。

- [ ] **Step 2: 更新 `docs/agent/闲聊功能实现说明.md`、`docs/agent/剧情连续性与结构化记忆.md`、`docs/agent/地图与地点冒险.md`、`docs/策划文档/AI生成RPG_MVP.md`**

- `闲聊功能实现说明.md`：记录新契约——闲聊预生成于 read model（`composeIdleNpcLine`，参与过剧情且有权威目标 → 提醒变体；否则中性变体；variantIndex = 回合数 + 幕次 + 交互条数），零 API、零回合。
- `剧情连续性与结构化记忆.md` 现第 29 行“读模型仍投影一次‘与其交谈’入口；提交后 NPC 才成为焦点……”替换为零回合闲聊描述。
- `地图与地点冒险.md`：行动栏“与 NPC 交谈”条目更新为“只为当前权威 talk 目标显示”。
- `策划文档/AI生成RPG_MVP.md`：现第 108 行“旧焦点 NPC 同时降为普通交谈入口”改为“旧焦点 NPC 降为零回合闲聊（预生成台词，‘知道了’关闭）”；现第 110 行“地点行动栏中的明确‘与 NPC 交谈’只打开生成任务时已经准备好的焦点对话”补充“且仅为当前主线目标人物提供”。

- [ ] **Step 3: 更新 `docs/Agent文档索引.md`**

- 第 24 行（NPC 对话驱动叙事场景触发）与第 22 行（地图与地点冒险）的行内描述追加“2026-08-18：非目标/交接 NPC 零回合闲聊化，talk 入口仅属权威目标”。

- [ ] **Step 4: 提交**

```bash
git add docs
git commit -m "docs: document zero-turn idle npc dialogue contract"
```
