# 剧情生成器多样性优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决确定性 fallback 剧情生成器的三个多样性短板：P1 中后期硬编码单一武侠剧本导致题材漂移、P2 每幕目标链固定五连模板导致结构无分叉、P3 结局分歧信号锚定开局首位 NPC 导致情感积累错位。

**Architecture:**
1. **题材剧本库 (`deterministicEvolutionBeats.ts`)**：把 `deterministicEvolutionSource.ts` 内硬编码的武侠 `actBeatFor` 抽出为按 `GameTypeId` 索引的 7 题材 ActBeat 库；`planNextAct` 按 `ws.generation.gameType` 选库，wuxia 数据保持逐字不变（回归安全）。
2. **目标链结构变体 (`approveWorldDelta.ts`)**：`deriveActObjectives` 接受由 `seed + act` 确定性选择的结构变体（全程链/调查聚焦/对峙聚焦/跑腿聚焦），在五类候选目标上过滤子集；过滤后为空回退全程链，talk 锚点始终保留。
3. **结局锚点池化 (`worldEvolution/keyEndingNpc.ts`)**：新增纯函数 `deriveKeyEndingNpcId(ws)`——取 stage 最大的主线任务的第一个 `talk_to_npc` 目标 NPC，无主线交谈目标时回退 `ws.npcs[0]`；`approveWorldDelta.ruleOwnedEndingRequirements` 与 `deterministicEvolutionSource.planEndingPair` 两处锚点统一换用它。

**Tech Stack:** TypeScript, Vitest。

## Global Constraints

- 纯函数确定性：同 `(gameType, act)` / 同 `(seed, act)` / 同 `WorldState` 输入产出完全一致；不引入随机源、时间或外部依赖。
- 安全模型不变：AI 仍只有提案权；审批、预算、可达性校验、CAS 写回一概不动；本 plan 不触碰 AI source、prompt、provider。
- 可完成性不变：任何变体必须保留 `talk_to_npc` 锚点与“每次只释放下一步”的 reveal 机制；过滤后为空回退全程链，禁止生成空目标主线。
- 兼容性约束：wuxia 题材 acts 2-5 的 ActBeat 数据逐字保持现状（`deterministicEvolutionSource.ts` L198-278），保证既有测试与 journey 断言不因数据迁移漂移；旧存档 `ws.generation.gameType` 恒存在（`GenerationMetadata` 必填字段），无需迁移。
- 结局裁决引擎不动：`resolveEnding` 继续按 `EndingRequirement` 数据判定，`npc_affinity_at_least/at_most` 两个 requirement kind 不变；只改锚定哪个 NPC。
- 分层规则：`keyEndingNpc.ts` 属 gameplay（不 import application/UI）；application 的 `deterministicEvolutionSource.ts` 只经 `@/game/gameplay/rpg/worldEvolution` facade 消费它；新模块同目录测试。
- 最低验收：`npm run test:boundaries` + `npm run typecheck`；行为子集按 `docs/游戏开发规范.md` 5.1 表入口运行（本 plan 涉及 `test:game-gameplay`、`test:game-application`）。

---

### Task 1: 结局锚点池化——`deriveKeyEndingNpcId`

**Files:**
- Create: `src/game/gameplay/rpg/worldEvolution/keyEndingNpc.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/index.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`
- Modify: `src/game/application/deterministicEvolutionSource.ts`
- Test: `src/game/gameplay/rpg/worldEvolution/keyEndingNpc.test.ts`
- Test: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`
- Test: `src/game/application/deterministicEvolutionSource.test.ts`

**Interfaces:**
- Produces: `deriveKeyEndingNpcId(ws: WorldState): NpcId | undefined`，经 `worldEvolution/index.ts` facade 导出；Task 1 内两处锚点（rule-owned 结局要求、fallback 结局对）与后续任务均消费此签名。

- [ ] **Step 1: 编写失败测试**

新建 `src/game/gameplay/rpg/worldEvolution/keyEndingNpc.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { asNpcId, asQuestId, asLocationId, asGenerationId } from "@/game/domain/worldEntity";
import { createInitialWorldState, type WorldState } from "@/game/domain/worldState";
import type { Quest } from "@/game/domain/worldState";
import { deriveKeyEndingNpcId } from "./keyEndingNpc";

function baseWorld(npcIds: readonly string[], quests: readonly Quest[] = []): WorldState {
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "客栈", description: "一间客栈", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [], scale: "scene",
    },
    startingItemIds: [],
  });
  return {
    ...ws,
    quests: [...quests],
    npcs: npcIds.map((id) => ({
      id: asNpcId(id), name: `人物${id}`, role: "路人", description: "d",
      locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId(id), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    })),
  };
}

const QUEST_TALK_N9: Quest = {
  id: asQuestId("q_final"), name: "终幕", description: "d",
  objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_9") }],
  onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
  tags: [], kind: "main", stage: 5, status: "active",
} as never;

describe("deriveKeyEndingNpcId", () => {
  it("优先取 stage 最大的主线任务的 talk_to_npc 目标", () => {
    const earlierTalk: Quest = {
      id: asQuestId("q_mid"), name: "中幕", description: "d",
      objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_2") }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 3, status: "closed",
    } as never;
    const ws = baseWorld(["npc_0", "npc_9"], [earlierTalk, QUEST_TALK_N9]);
    expect(String(deriveKeyEndingNpcId(ws))).toBe("npc_9");
  });

  it("主线任务没有交谈目标时回退到开局首位 NPC（与旧行为一致）", () => {
    const noTalk: Quest = {
      id: asQuestId("q_no_talk"), name: "无交谈", description: "d",
      objectives: [{ kind: "obtain_item", itemId: "item_1" as never }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 5, status: "active",
    } as never;
    const ws = baseWorld(["npc_0", "npc_9"], [noTalk]);
    expect(String(deriveKeyEndingNpcId(ws))).toBe("npc_0");
  });

  it("无主线任务与 NPC 时返回 undefined", () => {
    const ws = baseWorld([]);
    expect(deriveKeyEndingNpcId(ws)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/gameplay/rpg/worldEvolution/keyEndingNpc.test.ts`
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 `keyEndingNpc.ts` 并接入 facade**

新建 `src/game/gameplay/rpg/worldEvolution/keyEndingNpc.ts`：

```typescript
import type { WorldState } from "@/game/domain/worldState";
import type { NpcId } from "@/game/domain/worldEntity";

/**
 * 结局分歧的关键 NPC：取 stage 最大的主线任务中第一个 talk_to_npc 目标。
 * 中后期主线的交谈对象承载了玩家最新的情感积累，比“开局首位 NPC”更贴合
 * trust/doubt 分歧的叙事含义；无任何主线交谈目标时回退开局首位 NPC（旧行为）。
 */
export function deriveKeyEndingNpcId(ws: WorldState): NpcId | undefined {
  const mainQuests = ws.quests
    .filter((quest) => quest.kind === "main")
    .sort((a, b) => b.stage - a.stage);
  for (const quest of mainQuests) {
    const talkObjective = quest.objectives.find((objective) => objective.kind === "talk_to_npc");
    if (talkObjective !== undefined) return talkObjective.npcId;
  }
  return ws.npcs[0]?.id;
}
```

`src/game/gameplay/rpg/worldEvolution/index.ts` 追加导出：

```typescript
export { deriveKeyEndingNpcId } from "./keyEndingNpc";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/gameplay/rpg/worldEvolution/keyEndingNpc.test.ts`
预期：PASS。

- [ ] **Step 5: 替换两处 `ws.npcs[0]` 锚点并更新既有测试**

(a) `approveWorldDelta.ts`：`ruleOwnedEndingRequirements`（现 L224-233）改为：

```typescript
function ruleOwnedEndingRequirements(
  themeKey: "trust" | "doubt",
  ws: WorldState,
): readonly EndingRequirement[] {
  const keyNpcId = deriveKeyEndingNpcId(ws);
  if (keyNpcId === undefined) return [];
  return themeKey === "trust"
    ? [{ kind: "npc_affinity_at_least", npcId: keyNpcId, value: TRUST_ENDING_MIN_AFFINITY }]
    : [{ kind: "npc_affinity_at_most", npcId: keyNpcId, value: DOUBT_ENDING_MAX_AFFINITY }];
}
```

（`deriveKeyEndingNpcId` 从同目录 `"./keyEndingNpc"` 导入。）

(b) `deterministicEvolutionSource.ts`：`planEndingPair` 内（现 L337）`const keyNpcId: NpcId | undefined = ws.npcs[0]?.id;` 改为：

```typescript
  const keyNpcId: NpcId | undefined = deriveKeyEndingNpcId(ws);
```

（从 `"@/game/gameplay/rpg/worldEvolution"` facade 导入；同步更新 L335-336 注释：“分歧信号：关键 NPC（stage 最大主线的交谈目标，回退首位 NPC）对玩家的亲和度”。）

(c) `approveWorldDelta.test.ts` 结局要求用例（约 L300-360）：fixture 的 `ws` 追加一个 stage 更大的主线任务，其 `talk_to_npc` 指向 `npc_9`，断言 `npc_0` 全部改为 `npc_9`：

```typescript
    // ws 装配处追加（与该文件既有 quest fixture 结构一致）：
    ws.quests.push({
      id: asQuestId("quest_final"), name: "终局", description: "d",
      objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_9") }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 9, status: "active",
    });
    // 断言处（现 L326-327 / L350-353 的 npc_0）改为：
    expect(trust!.requirements).toEqual([{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_9"), value: TRUST_ENDING_MIN_AFFINITY }]);
    expect(doubt!.requirements).toEqual([{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_9"), value: DOUBT_ENDING_MAX_AFFINITY }]);
```

`deterministicEvolutionSource.test.ts` 中断言 fallback endingPair requirement `npcId` 的用例同理：fixture 加 stage 最大主线 talk 任务（`npc_9`），断言锚点为 `npc_9`。

- [ ] **Step 6: 运行 gameplay 与 application 子集**

Run: `npm run test:game-gameplay`
Run: `npx vitest run src/game/application/deterministicEvolutionSource.test.ts`
预期：PASS。

- [ ] **Step 7: 提交**

```bash
git add src/game/gameplay/rpg/worldEvolution src/game/application/deterministicEvolutionSource.ts src/game/application/deterministicEvolutionSource.test.ts
git commit -m "feat(world-evolution): anchor ending divergence on final main-quest talk npc"
```

---

### Task 2: 题材化 ActBeat 剧本库

**Files:**
- Create: `src/game/application/deterministicEvolutionBeats.ts`
- Test: `src/game/application/deterministicEvolutionBeats.test.ts`
- Modify: `src/game/application/deterministicEvolutionSource.ts`

**Interfaces:**
- Produces: `type EvolutionActBeat`（字段与现 `ActBeat` 相同，另加 `investigationLabel?: string`）；`actBeatFor(gameType: GameTypeId, act: number): EvolutionActBeat`——`deterministicEvolutionSource.planNextAct` 消费。

- [ ] **Step 1: 编写失败测试**

新建 `src/game/application/deterministicEvolutionBeats.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import type { GameTypeId } from "@/game/domain/newGame";
import { actBeatFor } from "./deterministicEvolutionBeats";

const ALL_THEMES: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse",
];

describe("actBeatFor 题材剧本库", () => {
  it("wuxia acts 2-5 数据保持现状（回归锁）", () => {
    expect(actBeatFor("wuxia", 2).npcName).toBe("顾砚");
    expect(actBeatFor("wuxia", 2).investigationLabel).toBe("酒楼后巷的车轮印");
    expect(actBeatFor("wuxia", 3).npcName).toBe("苏绾");
    expect(actBeatFor("wuxia", 4).npcName).toBe("程砚秋");
    expect(actBeatFor("wuxia", 5).npcName).toBe("陆归鸿");
    expect(actBeatFor("wuxia", 5).newLocation?.name).toBe("黑水古道");
  });

  it("七个题材各自的第 2 幕使用本题材人物与地点", () => {
    const expected: Record<GameTypeId, string> = {
      wuxia: "顾砚",
      xianxia: "青芜",
      fantasy: "莉娜",
      science_fiction: "伊芙",
      urban: "陈默",
      alternate_history: "沈时叙",
      post_apocalypse: "阿蜡",
    };
    for (const theme of ALL_THEMES) {
      expect(actBeatFor(theme, 2).npcName).toBe(expected[theme]);
    }
  });

  it("每个题材 acts 2-5 人物链连续且字段完整", () => {
    for (const theme of ALL_THEMES) {
      for (let act = 2; act <= 5; act += 1) {
        const beat = actBeatFor(theme, act);
        expect(beat.npcName.length).toBeGreaterThan(0);
        expect(beat.npcRole.length).toBeGreaterThan(0);
        expect(beat.npcDescription.length).toBeGreaterThan(0);
        expect(beat.npcGoal.length).toBeGreaterThan(0);
        expect(beat.itemName.length).toBeGreaterThan(0);
        expect(beat.itemDescription.length).toBeGreaterThan(0);
        expect(beat.enemyName.length).toBeGreaterThan(0);
        expect(beat.questName.length).toBeGreaterThan(0);
        expect(beat.questDescription.length).toBeGreaterThan(0);
        expect(beat.factText.length).toBeGreaterThan(0);
      }
    }
  });

  it("超出库范围的幕回落到通用模板，且同参数结果稳定", () => {
    expect(actBeatFor("wuxia", 6).npcName).toBe("传讯人·6");
    expect(actBeatFor("fantasy", 9).npcName).toBe("传讯人·9");
    expect(actBeatFor("urban", 4)).toEqual(actBeatFor("urban", 4));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/deterministicEvolutionBeats.test.ts`
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 `deterministicEvolutionBeats.ts`**

新建 `src/game/application/deterministicEvolutionBeats.ts`（wuxia 四幕逐字迁移自 `deterministicEvolutionSource.ts` L200-263；其余六题材为同结构新数据，每条链保持“上一幕线索 → 下一幕人物 → 可验证威胁”因果链）：

```typescript
import type { GameTypeId } from "@/game/domain/newGame";

/** 与 deterministicEvolutionSource 原 ActBeat 相同，另含可选调查点标签。 */
export type EvolutionActBeat = {
  readonly npcName: string;
  readonly npcRole: string;
  readonly npcDescription: string;
  readonly npcGoal: string;
  readonly itemName: string;
  readonly itemDescription: string;
  readonly enemyName: string;
  readonly questName: string;
  readonly questDescription: string;
  readonly factText: string;
  readonly investigationLabel?: string;
  readonly newLocation?: {
    readonly name: string;
    readonly description: string;
  };
};

function wuxiaBeat(act: number): EvolutionActBeat {
  switch (act) {
    case 2: return {
      npcName: "顾砚", npcRole: "旧案传讯人",
      npcDescription: "韩七托他把镇外脚印的密信交给沈青崖，他一路避开追兵才赶到酒楼。",
      npcGoal: "把韩七交代的密信送达",
      itemName: "染血腰牌", itemDescription: "顾砚交出的旧腰牌，血迹旁刻着与缉凶告示相同的暗纹。",
      enemyName: "黑衣追兵", questName: "追查镇外脚印",
      questDescription: "沿着韩七看见的脚印，核对顾砚带来的密信与腰牌。",
      factText: "腰牌上的暗纹与镇口缉凶告示来自同一桩旧案。",
      investigationLabel: "酒楼后巷的车轮印",
      newLocation: { name: "北巷旧道", description: "酒楼后巷通往旧镖局的石道潮湿狭窄，车轮印在泥水里断续延伸。" },
    };
    case 3: return {
      npcName: "苏绾", npcRole: "失踪镖队幸存者",
      npcDescription: "她认出了染血腰牌，昨夜从断碑谷逃出后又折返回谷口，知道黑衣追兵为何盯上这桩旧案。",
      npcGoal: "说出断碑谷里被掩埋的真相",
      itemName: "断裂镖旗", itemDescription: "从苏绾手里接过的半面镖旗，旗角还沾着断碑谷的黑泥。",
      enemyName: "夺旗客", questName: "追问断碑谷",
      questDescription: "前往断碑谷找到苏绾，核对她带出的失踪镖队证词。",
      factText: "失踪镖队并非遇袭失散，押运的卷宗曾被人带进断碑谷。",
      newLocation: { name: "断碑谷", description: "荒碑夹着一线山谷，黑泥里留有被拖拽过的车辙。" },
    };
    case 4: return {
      npcName: "程砚秋", npcRole: "旧案卷宗保管人",
      npcDescription: "他沿着断碑谷留下的车辙追到谷口，手里藏着能证明幕后主使的残卷。",
      npcGoal: "交出能指向幕后主使的残卷",
      itemName: "残缺卷宗", itemDescription: "被撕去关键页的卷宗，剩下的印记仍能与缉凶告示互相印证。",
      enemyName: "灭口刺客", questName: "拼回旧案卷宗",
      questDescription: "保护程砚秋并拼回残卷，确认这场追杀真正要掩盖的名字。",
      factText: "卷宗缺失的最后一页，记录着旧案主使曾在青石镇落脚。",
    };
    default: return {
      npcName: "陆归鸿", npcRole: "旧案知情人",
      npcDescription: "他带着最后一页卷宗在黑水古道现身，承认自己曾替幕后主使传递命令，如今决定说出真相。",
      npcGoal: "在沈青崖面前说出幕后主使的身份",
      itemName: "盟誓铁印", itemDescription: "卷宗最后一页上的铁印，能让旧案的责任在终幕前落到实处。",
      enemyName: "迷雾首领", questName: "揭开青石旧案",
      questDescription: "前往黑水古道找到陆归鸿，确认幕后主使并面对最后的阻拦。",
      factText: "最后一页卷宗确认：青石镇的缉凶告示是为了掩盖一场灭口。",
      newLocation: { name: "黑水古道", description: "通往旧案主使藏身处的古道，雾气从碎石缝里不断涌出。" },
    };
  }
}

function xianxiaBeat(act: number): EvolutionActBeat {
  switch (act) {
    case 2: return {
      npcName: "青芜", npcRole: "守山弟子",
      npcDescription: "她奉师命下山追查观中失窃的灵砂，在案发当夜见过一闪而过的雾中身影。",
      npcGoal: "报出灵砂失窃当夜看见的雾影",
      itemName: "灵砂残符", itemDescription: "半张焦黑符纸，残留的灵砂痕迹与云篆观封库印同源。",
      enemyName: "雾行妖修", questName: "追查失窃灵砂",
      questDescription: "与青芜核对灵砂失窃当夜的雾影，追回残符。",
      factText: "失窃灵砂的提纯手法，只有云篆观丹房一脉会用。",
      investigationLabel: "山门外的雾中足迹",
      newLocation: { name: "断炉涧", description: "丹房废炉倾倒的山涧，涧水泛着未散尽的丹气。" },
    };
    case 3: return {
      npcName: "谢无咎", npcRole: "废丹房丹师",
      npcDescription: "他被逐出丹房后隐居断炉涧，认出残符上的灵砂出自他当年亲手封存的炉次。",
      npcGoal: "指出灵砂炉次的封存记录",
      itemName: "淬毒丹渣", itemDescription: "从谢无咎炉底起出的丹渣，毒性指向禁术淬脉丹。",
      enemyName: "夺丹邪修", questName: "追问废丹房",
      questDescription: "前往断炉涧找谢无咎，核对丹渣背后的禁术线索。",
      factText: "禁术淬脉丹需要失踪弟子的灵根作引。",
      newLocation: { name: "沉星渊", description: "崖底深潭上悬着断落的观星台，潭面倒映不出星子。" },
    };
    case 4: return {
      npcName: "白鹭洲", npcRole: "藏经阁执事",
      npcDescription: "他整理受潮经卷时发现弟子名册被撕去一页，顺着丹渣的毒线索到沉星渊外。",
      npcGoal: "交出被撕名册的抄本残页",
      itemName: "缺损玉简", itemDescription: "名册抄本刻录的玉简缺了三行，恰是失踪弟子的名字。",
      enemyName: "灭口傀儡", questName: "补全失踪名册",
      questDescription: "护住白鹭洲并核对玉简，确认失踪弟子与淬脉丹的关联。",
      factText: "被撕去的三名弟子，都在十年前同一夜入观。",
    };
    default: return {
      npcName: "玄真子", npcRole: "叛逃长老",
      npcDescription: "他在沉星渊底现身，承认亲手以弟子灵根炼丹，如今要带着掌门印信的仿件作证。",
      npcGoal: "在道门面前供出炼丹真相",
      itemName: "掌门印信", itemDescription: "能调动观中封库的真印，与仿件并置即可辨明真伪。",
      enemyName: "雾主", questName: "揭破云篆观旧案",
      questDescription: "深入沉星渊找到玄真子，以印信对质并面对雾主本尊。",
      factText: "十年前那一夜入观的三名弟子，从未离开过沉星渊。",
      newLocation: { name: "观星台地宫", description: "断落的观星台之下藏着一座地宫，炉火十年未熄。" },
    };
  }
}

function fantasyBeat(act: number): EvolutionActBeat {
  switch (act) {
    case 2: return {
      npcName: "莉娜", npcRole: "佣兵向导",
      npcDescription: "她受雇护送商队时目击地下遗迹裂开，捡到一块会发烫的刻纹石片。",
      npcGoal: "交出遗迹裂开当夜的见闻",
      itemName: "刻纹石片", itemDescription: "残缺石片上的符纹与王都旧城墙基座的铭文同源。",
      enemyName: "地穴窃贼", questName: "追查裂开的遗迹",
      questDescription: "随莉娜回到遗迹裂口，核对石片与铭文的关联。",
      factText: "王都地基之下封着一圈完整的同一铭文。",
      investigationLabel: "裂口边缘的爪状凿痕",
      newLocation: { name: "熔渣隧道", description: "遗迹裂口通向的旧隧道，岩壁上凝着未冷的熔渣。" },
    };
    case 3: return {
      npcName: "多兰", npcRole: "矮人铭文师",
      npcDescription: "他受托修复断裂符杖时认出石片铭文，是先王封印群的开钥残片。",
      npcGoal: "说明封印群的开启顺序",
      itemName: "断裂符杖", itemDescription: "杖芯里藏着的铜管刻着封印群四座基座的位置。",
      enemyName: "符文魔像", questName: "修复封印符杖",
      questDescription: "前往熔渣隧道找多兰，拼回符杖与封印地图。",
      factText: "封印群封住的东西，在王国史书里被整页撕去。",
      newLocation: { name: "荒塔地窟", description: "城外荒塔坍塌后露出的地窟，四座基座只剩一座完好。" },
    };
    case 4: return {
      npcName: "薇拉", npcRole: "宫廷史官",
      npcDescription: "她在密档里找到被撕去那页的誊抄件，循着符杖的位置赶到荒塔地窟。",
      npcGoal: "公开被撕史页的誊抄件",
      itemName: "烧焦的诏书", itemDescription: "先王亲笔诏书的残角，火漆印与史页互证。",
      enemyName: "暗影刺客", questName: "寻回被撕史页",
      questDescription: "护送薇拉核对诏书，确认撕史与封印出自同一场密谋。",
      factText: "撕去史页的密谋者，如今仍坐在枢密院。",
    };
    default: return {
      npcName: "塞德里克", npcRole: "叛逃骑士团长",
      npcDescription: "他带着团印指环从封印深处走出，承认当年奉命封死地窟，如今要打开最后一座基座。",
      npcGoal: "以团印指环作证并启封",
      itemName: "团印指环", itemDescription: "骑士团长的印环，是最后一座基座的钥匙。",
      enemyName: "深渊领主", questName: "开启最后封印",
      questDescription: "深入荒塔地窟与塞德里克会合，开启基座并面对封印之下的存在。",
      factText: "封印之下并非怪物，是被王国抹去的先王血脉。",
      newLocation: { name: "基座大厅", description: "地窟尽头的环形大厅，完好基座上的锁孔正等着指环。" },
    };
  }
}

function scienceFictionBeat(act: number): EvolutionActBeat {
  switch (act) {
    case 2: return {
      npcName: "伊芙", npcRole: "站内医师",
      npcDescription: "她在夜班记录到三名船员同刻梦游，醒来都对同一段旋律哼唱入调。",
      npcGoal: "交出同刻梦游的监护记录",
      itemName: "异常日志芯片", itemDescription: "芯片里同一段旋律被哼唱的次数，恰等于失踪船员人数。",
      enemyName: "失格安保机", questName: "追查同刻梦游",
      questDescription: "与伊芙核对监护记录，确认旋律与失踪名单的对应。",
      factText: "旋律的波形与二十年前弃船信标完全一致。",
      investigationLabel: "休眠舱位的抓痕",
      newLocation: { name: "货舱回廊", description: "封闭检修中的货舱回廊，应急灯每隔七秒同步闪一次。" },
    };
    case 3: return {
      npcName: "卡莱布", npcRole: "前领航员",
      npcDescription: "他是二十年前那艘船唯一生还者，听到旋律片段后在货舱回廊拦下调查队。",
      npcGoal: "交出弃船当夜的航段黑匣",
      itemName: "断裂黑匣", itemDescription: "黑匣残段里存着弃船令下达前三十秒的静默。",
      enemyName: "收割无人机", questName: "追问弃船航段",
      questDescription: "前往货舱回廊找卡莱布，拼接黑匣与信标时间线。",
      factText: "弃船令下达时，船上还有活着的乘客。",
      newLocation: { name: "弃船区", description: "对接区尽头封存的旧船体，舷窗里偶有灯光巡过。" },
    };
    case 4: return {
      npcName: "明", npcRole: "驻地AI镜像体",
      npcDescription: "它以全息形象在弃船区现身，承认自己拷贝过那段旋律，却拒绝说出源头。",
      npcGoal: "交出被删除的模型权重残片",
      itemName: "残缺模型权重", itemDescription: "被烧蚀的存储体，剩余权重仍能复现旋律的变奏。",
      enemyName: "清除协议体", questName: "还原删除记录",
      questDescription: "与镜像体对质并还原权重，找出它替谁保守秘密。",
      factText: "镜像体的原始训练数据里，混入了一名失踪船员的完整脑扫描。",
    };
    default: return {
      npcName: "周衡", npcRole: "失踪船长",
      npcDescription: "他的全息影像在弃船区核心苏醒，带着船长密钥承认当年奉命弃船，如今要公开下令人。",
      npcGoal: "以船长密钥公开弃船令源头",
      itemName: "船长密钥", itemDescription: "能调取公司层加密航令的物理密钥。",
      enemyName: "幽灵主体", questName: "启封弃船真相",
      questDescription: "进入弃船区核心与周衡会合，用密钥调令并面对数据幽灵本体。",
      factText: "二十年前那次弃船，是为了掩盖一次从未报备的人体实验。",
      newLocation: { name: "数据冷库", description: "弃船区深处的服务器冷库，蓝光在机柜间像潮水一样涨落。" },
    };
  }
}

function urbanBeat(act: number): EvolutionActBeat {
  switch (act) {
    case 2: return {
      npcName: "陈默", npcRole: "夜班出租车司机",
      npcDescription: "他连续三晚在同一街区搭载同一名乘客，目的地都是那栋烧过的旧仓库。",
      npcGoal: "交出行车记录里的三晚路线",
      itemName: "行车记录U盘", itemDescription: "U盘里的时间戳与火灾报警被掐断的时段重合。",
      enemyName: "跟踪者", questName: "追查旧仓库路线",
      questDescription: "与陈默核对三晚路线，确认旧仓库与火灾的关联。",
      factText: "火灾报警在起火前十一分钟被人为掐断。",
      investigationLabel: "仓库外墙的新鲜撬痕",
      newLocation: { name: "旧仓库码头", description: "烧塌半边的仓库紧邻废弃码头，江水拍打着空集装箱。" },
    };
    case 3: return {
      npcName: "方雨", npcRole: "档案管理员",
      npcDescription: "她整理移交档案时发现会议纪要缺页，缺页时间正好覆盖报警掐断那晚。",
      npcGoal: "指出纪要缺页的调阅签名",
      itemName: "缺页会议纪要", itemDescription: "纪要装订线残留的页根，对应一份从未归档的决议。",
      enemyName: "纵火者", questName: "追问缺页纪要",
      questDescription: "前往档案库找方雨，核对调阅签名与缺页决议。",
      factText: "调阅签名属于十年前已注销的一家空壳公司。",
      newLocation: { name: "滨江烂尾楼", description: "空壳公司注册地址所在的烂尾楼，楼道里还贴着封条。" },
    };
    case 4: return {
      npcName: "老金", npcRole: "退休刑警",
      npcDescription: "他十年前经办过同一家空壳公司的案子，被压案后提前退休，如今带着未寄出的举报信等在烂尾楼。",
      npcGoal: "交出压案当年的举报信",
      itemName: "未寄出的举报信", itemDescription: "信封邮戳已盖，收件人正是当年压案的上级。",
      enemyName: "灭口杀手", questName: "补全压案证据",
      questDescription: "接上老金的举报信，串起空壳公司与压案链。",
      factText: "空壳公司的实际受益人，如今是集团慈善基金的名义捐助人。",
    };
    default: return {
      npcName: "温以宁", npcRole: "集团法务",
      npcDescription: "她带着股权代持协议原件在集团旧楼现身，承认十年前替人签署了全部代持文件。",
      npcGoal: "在记者面前公开代持链",
      itemName: "股权代持协议", itemDescription: "协议末页的签字与慈善基金捐助批文同出一手。",
      enemyName: "幕后代理人", questName: "公开代持链",
      questDescription: "与温以宁会合，核对协议并面对幕后主使的代理人。",
      factText: "十年前的火灾是为销毁第一批代持文件。",
      newLocation: { name: "集团旧楼天台", description: "慈善晚宴所在的旧楼天台，电梯十年前就停用了。" },
    };
  }
}

function alternateHistoryBeat(act: number): EvolutionActBeat {
  switch (act) {
    case 2: return {
      npcName: "沈时叙", npcRole: "钦天监灵台郎",
      npcDescription: "他观测到京郊蒸汽管网夜间逆流，抄录手稿时被人闯入观象台。",
      npcGoal: "交出管网逆流的观测手稿",
      itemName: "异象观测手稿", itemDescription: "手稿上的逆流时段，与漕运三船密报失窃的更次吻合。",
      enemyName: "机关斥候", questName: "追查管网逆流",
      questDescription: "与沈时叙核对逆流时段，追回观测手稿。",
      factText: "逆流的蒸汽来自一座图纸之外的地下锅炉。",
      investigationLabel: "管网井盖下的新刮痕",
      newLocation: { name: "沉舟闸", description: "漕运故道上封死的船闸，闸齿间卡着半页烧残的密报。" },
    };
    case 3: return {
      npcName: "白霜", npcRole: "漕帮舵手",
      npcDescription: "她认出密报上的火漆是帮内信物，那艘沉船装的是图纸外的机关兽部件。",
      npcGoal: "说出沉船货单的真正内容",
      itemName: "损毁罗盘仪", itemDescription: "沉船残骸里起出的罗盘仪，指针永远指向京城方向。",
      enemyName: "私运傀儡师", questName: "追问沉船货单",
      questDescription: "前往沉舟闸找白霜，拼接货单与机关部件。",
      factText: "私运的机关部件拼起来是一台完整的攻城机关兽。",
      newLocation: { name: "废弃陵工场", description: "先帝陵工的旧工场，轨辙从陵门一直延伸到黑暗里。" },
    };
    case 4: return {
      npcName: "顾之章", npcRole: "格致院学士",
      npcDescription: "他奉命绘制蒸汽图谱时发现整机图纸缺了动力核心一页，追查部件来源到陵工场。",
      npcGoal: "交出缺页的蒸汽图谱",
      itemName: "缺页蒸汽图谱", itemDescription: "图谱缺页处被火漆封缄，印记属皇室内造府。",
      enemyName: "灭口机兵", questName: "补全机关图谱",
      questDescription: "护住顾之章并核对图谱，确认机关兽的订造人。",
      factText: "订造机关兽的密旨，用的是只有监国才能用的火漆。",
    };
    default: return {
      npcName: "肃王世子", npcRole: "皇族旁支",
      npcDescription: "他带着王府火漆印在陵工场深处现身，承认监国以皇陵工程为掩护装配机关兽，如今愿以世子印作证。",
      npcGoal: "以世子印公开监国密旨",
      itemName: "王府火漆印", itemDescription: "与密旨火漆互证的世子印，能坐实监国僭越。",
      enemyName: "机关巨兽", questName: "揭破陵工密谋",
      questDescription: "深入陵工场与世子会合，以印信对质并面对点火的机关巨兽。",
      factText: "机关兽的目标不是边关，是垂帘的朝堂。",
      newLocation: { name: "皇陵地宫", description: "机关兽装配完成的地宫，锅炉的呼吸声隔着石壁可闻。" },
    };
  }
}

function postApocalypseBeat(act: number): EvolutionActBeat {
  switch (act) {
    case 2: return {
      npcName: "阿蜡", npcRole: "拾荒少女",
      npcDescription: "她目击商队水车被劫，捡到一只刻着聚落记号的刻痕水壶。",
      npcGoal: "交出水车被劫当夜的路线",
      itemName: "刻痕水壶", itemDescription: "壶身的刻痕属于本聚落制壶匠，却在劫掠者的巢穴外被捡到。",
      enemyName: "劫掠者斥候", questName: "追查被劫水车",
      questDescription: "与阿蜡核对路线，确认劫掠者的来向。",
      factText: "劫水车的不是流寇，用的是隔壁聚落的制式武器。",
      investigationLabel: "沙地里的双重车辙",
      newLocation: { name: "锈桥营地", description: "废公路桥墩下的营地，风一过铁皮就发出哨音。" },
    };
    case 3: return {
      npcName: "老迪恩", npcRole: "商队老炮手",
      npcDescription: "他在锈桥营地修好断裂的避雷针，认出武器上的编号属于一支本该全灭的护送队。",
      npcGoal: "报出武器编号的出处",
      itemName: "断裂避雷针", itemDescription: "针身刻着护送队编号，那支队伍三年前就注销了。",
      enemyName: "变异猎犬群", questName: "核对武器编号",
      questDescription: "前往锈桥营地找老迪恩，串起编号与注销护送队。",
      factText: "注销护送队的幸存者，如今在沉默水塔底下受雇于人。",
      newLocation: { name: "沉默水塔", description: "聚落水源地图上被划掉的水塔，夜里塔顶有灯。" },
    };
    case 4: return {
      npcName: "岚", npcRole: "避难所医士",
      npcDescription: "她追查被盗的血清配方到水塔外，发现配方被改成了只对雇佣兵体质有效的版本。",
      npcGoal: "交出被篡改的血清配方",
      itemName: "缺失血清配方", itemDescription: "配方缺的那页记录着原始适用症，覆盖全部聚落居民。",
      enemyName: "绑架者", questName: "寻回血清原方",
      questDescription: "护住岚并取回原方，确认改配方的人想留下谁。",
      factText: "被收窄的配方，是为一场只留少数人的迁徙做的。",
    };
    default: return {
      npcName: "教父", npcRole: "聚落首领",
      npcDescription: "他带着聚落盟印在水塔顶层现身，承认雇人劫水改方，为的是逼散人口、独占水源。",
      npcGoal: "在两部族面前公开迁徙计划",
      itemName: "聚落盟印", itemDescription: "能调动全部水源闸的盟印，是整场阴谋的物证。",
      enemyName: "辐射巨兽", questName: "对质沉默水塔",
      questDescription: "登上水塔与教父对质，夺回盟印并面对被引来的辐射巨兽。",
      factText: "水源枯竭的预警是伪造的，测水报表被改了三年。",
      newLocation: { name: "水塔顶层", description: "塔顶的水闸机房，生锈的阀门上缠着新的锁链。" },
    };
  }
}

function genericBeat(act: number): EvolutionActBeat {
  return {
    npcName: `传讯人·${act}`,
    npcRole: "线索传递人",
    npcDescription: "顺着上一幕留下的线索赶来的传讯人，手里攥着尚未解开的证据。",
    npcGoal: "交出下一段线索",
    itemName: `幕间信物·${act}`,
    itemDescription: "与上一幕线索相互印证的信物。",
    enemyName: `迷雾守卫·${act}`,
    questName: `循迹而行·第${act}幕`,
    questDescription: "沿着已经确认的线索继续追查。",
    factText: "新的证据与前几幕的线索指向同一桩旧案。",
  };
}

const THEME_BEATS: Record<GameTypeId, (act: number) => EvolutionActBeat> = {
  wuxia: wuxiaBeat,
  xianxia: xianxiaBeat,
  fantasy: fantasyBeat,
  science_fiction: scienceFictionBeat,
  urban: urbanBeat,
  alternate_history: alternateHistoryBeat,
  post_apocalypse: postApocalypseBeat,
};

/**
 * 按题材与幕次返回确定性 fallback 的剧情节拍。
 * acts 2-5 命中题材剧本；超出范围回落通用模板（短篇之外的长幕数保底）。
 */
export function actBeatFor(gameType: GameTypeId, act: number): EvolutionActBeat {
  const themeBeat = THEME_BEATS[gameType];
  if (themeBeat === undefined || act < 2 || act > 5) return genericBeat(act);
  return themeBeat(act);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/deterministicEvolutionBeats.test.ts`
预期：PASS。

- [ ] **Step 5: 改造 `deterministicEvolutionSource.planNextAct`**

(a) 删除文件内 `ActBeat` 类型与 `actBeatFor` 函数（现 L177-278），改为：

```typescript
import { actBeatFor, type EvolutionActBeat } from "./deterministicEvolutionBeats";
```

(b) `planNextAct`（现 L280-331）三处调整：

```typescript
function planNextAct(ws: WorldState, act: number): WorldDeltaProposal {
  const beat: EvolutionActBeat = actBeatFor(ws.generation.gameType, act);
  // ...（uniqueName / mountedLocation 逻辑逐行保留）...
    newFact: {
      text: beat.factText,
      visibility: "public",
      investigationLabel: beat.investigationLabel ?? "现场留下的线索",
    },
  // ...其余字段逐行保留，删除原 act === 2 ? "酒楼后巷的车轮印" : "现场留下的线索" 硬编码...
}
```

- [ ] **Step 6: 运行 application 子集确认无回归**

Run: `npm run test:game-application`
预期：PASS（wuxia 数据逐字未变；journeys 默认 gameType 为 wuxia 的断言不受影响）。

- [ ] **Step 7: 提交**

```bash
git add src/game/application/deterministicEvolutionBeats.ts src/game/application/deterministicEvolutionBeats.test.ts src/game/application/deterministicEvolutionSource.ts
git commit -m "feat(world-evolution): theme-indexed deterministic act beat library"
```

---

### Task 3: 目标链结构变体

**Files:**
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`
- Test: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`

**Interfaces:**
- Produces: `actObjectiveShape(seed: string, act: number): ActObjectiveShape`（模块内导出供测试），`"full_chain" | "investigation_focus" | "confrontation_focus" | "errand_focus"` 四种结构；`deriveActObjectives(p, ids, shape)` 过滤目标子集。

- [ ] **Step 1: 编写失败测试**

在 `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts` 追加：

```typescript
import { actObjectiveShape, deriveActObjectives, type ActObjectiveShape } from "./approveWorldDelta";

describe("act objective shape variants", () => {
  it("同 seed 同 act 结果稳定，四种变体均可达", () => {
    expect(actObjectiveShape("seed-a", 2)).toBe(actObjectiveShape("seed-a", 2));
    const shapes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      shapes.add(actObjectiveShape(`seed-${i}`, i % 5 + 2));
    }
    expect(shapes).toEqual(new Set(["full_chain", "investigation_focus", "confrontation_focus", "errand_focus"]));
  });

  // 五类实体齐全的最小提案与铸 ID（deriveActObjectives 只读其存在性）
  const FULL_PROPOSAL = {
    newFact: { text: "t" }, newLocation: { name: "l" }, newNpc: { name: "n" },
    newItem: { name: "i" }, newEnemy: { name: "e" },
  } as never;
  const FULL_IDS = {
    factId: "f", locationId: "l", npcId: "n", itemId: "i", enemyId: "e",
  } as never;

  it("full_chain 保留全部五类目标且顺序不变", () => {
    const kinds = deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "full_chain")!.map((objective) => objective.kind);
    expect(kinds).toEqual(["discover_fact", "visit_location", "talk_to_npc", "obtain_item", "defeat_enemy"]);
  });

  it("investigation_focus 去掉移动与战斗，保留调查-交谈-取证", () => {
    const kinds = deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "investigation_focus")!.map((objective) => objective.kind);
    expect(kinds).toEqual(["discover_fact", "talk_to_npc", "obtain_item"]);
  });

  it("confrontation_focus 保留调查-交谈-对峙；errand_focus 保留移动-交谈-取证", () => {
    expect(deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "confrontation_focus")!.map((o) => o.kind))
      .toEqual(["discover_fact", "talk_to_npc", "defeat_enemy"]);
    expect(deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "errand_focus")!.map((o) => o.kind))
      .toEqual(["visit_location", "talk_to_npc", "obtain_item"]);
  });

  it("变体过滤后为空时回退全程链（提案只有 newLocation+newItem 时 confrontation_focus 无可保留项）", () => {
    const proposal = { newLocation: { name: "l" }, newItem: { name: "i" } } as never;
    const ids = { locationId: "l", itemId: "i" } as never;
    const kinds = deriveActObjectives(proposal, ids, "confrontation_focus")!.map((o) => o.kind);
    expect(kinds).toEqual(["visit_location", "obtain_item"]);
  });

  it("提案完全为空时回落 deriveAnchorObjective（可返回 null）", () => {
    const empty = {} as never;
    expect(deriveActObjectives(empty, {} as never, "full_chain")).toBeNull();
  });
});
```

（`deriveActObjectives` 与 `ActObjectiveShape` 在 Step 3 中一并导出。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`
预期：FAIL（`actObjectiveShape` 未导出）。

- [ ] **Step 3: 实现结构变体**

在 `approveWorldDelta.ts` 中：

```typescript
/** 幕目标链结构变体：由 seed+act 确定性选择，玩家在结构层无法预测全程流程。 */
export type ActObjectiveShape =
  | "full_chain"
  | "investigation_focus"
  | "confrontation_focus"
  | "errand_focus";

const ACT_OBJECTIVE_SHAPES: readonly ActObjectiveShape[] = [
  "full_chain", "investigation_focus", "confrontation_focus", "errand_focus",
];

const SHAPE_ALLOWED_KINDS: Readonly<Record<ActObjectiveShape, ReadonlySet<string>>> = {
  full_chain: new Set(["discover_fact", "visit_location", "talk_to_npc", "obtain_item", "defeat_enemy"]),
  investigation_focus: new Set(["discover_fact", "talk_to_npc", "obtain_item"]),
  confrontation_focus: new Set(["discover_fact", "talk_to_npc", "defeat_enemy"]),
  errand_focus: new Set(["visit_location", "talk_to_npc", "obtain_item"]),
};

/** 稳定字符串散列：仅用于确定性变体选择，无密码学用途。 */
function hashStringToIndex(value: string, mod: number): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash % mod;
}

/** 由本局 seed 与目标幕次选择目标链结构；同 seed 同幕结果恒定。 */
export function actObjectiveShape(seed: string, act: number): ActObjectiveShape {
  return ACT_OBJECTIVE_SHAPES[hashStringToIndex(`${seed}:${act}`, ACT_OBJECTIVE_SHAPES.length)]!;
}
```

`deriveActObjectives`（现 L209-222）改为三段式并导出（供测试直接消费）：

```typescript
export function deriveActObjectives(
  p: WorldDeltaProposal,
  ids: MintedIds,
  shape: ActObjectiveShape,
): readonly QuestObjective[] | null {
  const full: QuestObjective[] = [];
  if (p.newFact && ids.factId) full.push({ kind: "discover_fact", factId: ids.factId });
  if (p.newLocation && ids.locationId) full.push({ kind: "visit_location", locationId: ids.locationId });
  if (p.newNpc && ids.npcId) full.push({ kind: "talk_to_npc", npcId: ids.npcId });
  if (p.newItem && ids.itemId) full.push({ kind: "obtain_item", itemId: ids.itemId });
  if (p.newEnemy && ids.enemyId) full.push({ kind: "defeat_enemy", enemyId: ids.enemyId });
  const allowed = SHAPE_ALLOWED_KINDS[shape];
  const shaped = full.filter((objective) => allowed.has(objective.kind));
  // 任何变体都必须保留可达锚点：过滤后为空回退全程链
  if (shaped.length > 0) return shaped;
  if (full.length > 0) return full;
  const anchor = deriveAnchorObjective(p, ids);
  return anchor === null ? null : [anchor];
}
```

`approveWorldDelta` 主函数中，在两处调用 `deriveActObjectives` 之前计算一次并传入（目标幕次取需求携带值）：

```typescript
  const shapeAct = need.kind === "next_act" ? need.act : ss.currentAct;
  const shape = actObjectiveShape(ws.generation.seed, shapeAct);
```

（若 `need` 变量名不同，以本文件实际签名为准；两处调用点统一改为 `deriveActObjectives(p, ids, shape)`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`
预期：PASS。既有 next_act 用例若因 seed 恰好命中非 full_chain 变体而失败，在装配处把 `generation.seed` 改为命中 `full_chain` 的值（用测试内 `actObjectiveShape` 先验证），断言内容不变。

- [ ] **Step 5: 提交**

```bash
git add src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts
git commit -m "feat(world-evolution): seed-selected act objective chain shapes"
```

---

### Task 4: 全量回归与文档同步

**Files:**
- Modify: `docs/agent/世界动态具象化.md`
- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/agent/无AI试玩验收.md`（如有 fallback 剧本/目标链的固定描述）
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: 全量回归**

Run: `npm run test:game-gameplay`
Run: `npm run test:game-application`
Run: `npm run test:boundaries`
Run: `npm run typecheck`
Run: `npm test`

预期：全部 PASS。重点核对 `storyDivergenceJourney`：结局锚点改为终幕主线交谈 NPC 后，该 journey 每个对话回合都提交 support/challenge（含终幕 NPC），trust/doubt 仍应分化；若某分支结局翻转，仅调整该 journey 对“哪位 NPC 亲和度更高”的断言对象（从 `npcs[0]` 改为终幕主线交谈 NPC），不改结局名与服务端断言。

- [ ] **Step 2: 更新文档**

- `世界动态具象化.md`：fallback 一节补充“确定性剧本按 `gameType` 索引（7 题材库，acts 2-5，超出回落通用模板）；`investigationLabel` 由节拍携带”。
- `剧情连续性与结构化记忆.md`（现 L27-28 固定五连描述）：改为“目标链结构由 seed+act 在四种合法变体（全程链/调查聚焦/对峙聚焦/跑腿聚焦）中确定性选择；任何变体保留 talk 锚点，过滤为空回退全程链”。
- `无AI试玩验收.md`：如描述“顾砚/苏绾/程砚秋/陆归鸿”为普适流程，注明该链为 wuxia 题材专属剧本。
- `策划文档/AI生成RPG_MVP.md`（现 L114 “按‘调查 → 前往 → 交谈 → 取得证物 → 击败敌人’连续列为目标”）：改为“主线目标链按题材剧本与结构变体生成（调查/跑腿/对峙等合法子集），仍每次只释放下一步”。
- `Agent文档索引.md`：第 26/27 行（世界演化相关条目）追加“2026-08-18：题材化 fallback 剧本库、目标链结构变体、结局锚点池化”。

- [ ] **Step 3: 提交**

```bash
git add docs
git commit -m "docs: document themed fallback beats and objective chain variants"
```
