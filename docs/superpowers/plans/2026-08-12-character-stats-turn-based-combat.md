# 角色属性、多人接口与真正回合制战斗 Implementation Plan

> 实施评审记录（2026-08-13）：Tasks 1–6 已按当前代码完成并提交到 `codex/character-stats-turn-based`。Task 5 采用现有 `LocationSceneScreen` 内的多单位渲染路径，未额外拆出 `BattleViewport.tsx`；Task 3 的平衡数值由确定性规则测试覆盖，未加入单独模拟脚本。Chrome 真机已验证：开局、开战、技能消耗、敌方自动回合、有序行动日志、角色五项属性面板、reload 后战斗状态恢复与继续行动。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不实现角色成长的前提下，把现有单主角对单敌人的固定反击升级为确定性的固定轮次战斗；敌方立即支持多只怪物，玩家方状态与行动接口从第一版就能容纳后续队友。

**Architecture:** active battle 由通用 `BattleCombatant[]`、轮次行动队列和游标驱动，不再保存写死的 `playerHp/enemyHp`。服务器只在轮到玩家控制单位时下发 actor/target 绑定的 opaque token；提交后结算该单位，并自动推进所有规则控制单位，直到下一名玩家控制单位需要决策或战斗结束。当前我方只装配主角，敌方装配一个 Boss 或最多两个普通敌人；未来加入队友只新增我方 combatant，不改 BattleState、回合解析器或 API 形状。

**Tech Stack:** TypeScript 5.8、Next.js 16、React 19、Vitest、SQLite CAS、现有 domain → gameplay/rpg → application → components 分层。

## Global Constraints

- 本阶段不实现队友获得、队友属性来源或队友 AI；只预留玩家方多单位接口并以单主角验收。
- 敌方本阶段支持多单位：普通敌人遭遇为 1–2 只，Boss 遭遇暂为 Boss 单体；底层数组和队列不设 2 人硬编码。
- 不实现等级、经验、属性点、装备加成、掉落或其他角色成长。
- 不实现命中、闪避、暴击、元素、随机伤害、站位、仇恨、范围技能或通用 Buff/Debuff；唯一持续状态是防御。
- 不实现战斗物品；当前物品没有规则效果，不恢复空壳 `use_item` Action。
- AI 不决定属性、敌人数量上限、行动、目标、胜负、消耗或效果；AI 只生成题材内容和描述已提交结果。
- 客户端不能提交 actor ID、target ID、Action、伤害或 HP；只消费服务端为“行动者 + 行动 + 目标”铸造的 opaque token。
- 每次玩家控制单位的指令至多一次规则 CAS；stale、tampered、重复 token 零写入。
- `WorldState.version` 从 `2` 升为 `3`；按当前开发规范不新增兼容 runtime 或旧存档迁移 facade，旧开发存档明确提示重开。

---

## 1. 现状与设计判断

### 应保留的基础

- `battleResolver.ts` 已是无 IO、无随机、无 AI 的纯规则函数。
- `performTurn.ts` 已统一处理 token、revision、任务、结局和单次 CAS。
- 世界演化 AI 只提交敌人 `name/tier/locationRef`，敌人数值由服务端审批器填充。
- active battle 屏蔽非战斗行动；胜利、失败、撤退和击败列表均为结构化状态。
- UI 只消费 `GameSessionView`，没有直接计算伤害或胜负。

### 必须解决的问题

1. `StatBlock` 只有 `hp/attack/defense`，且开局 AI 仍能提交玩家属性，违反“规则负责属性”。
2. active state 写死 `playerHp/enemyHp`，无法加入第二只怪或队友。
3. 一次点击永远先玩家、后敌人固定反击；`round` 没有队列、游标和当前行动者语义。
4. `max(1, ATK - DEF)` 容易把大量组合压成 1 点；防御固定减 2 也常被最小伤害吞掉。
5. UI 通过前后 HP 差猜动画，双方同次推进发生多段行动时无法按顺序展示。
6. 每个战斗动作都会创建 `PendingNarrativeJob`，玩家要等待 AI 后才能继续战斗。
7. 角色面板将 HP 当成百分比，并把生命上限显示成持续生命。

## 2. 推荐角色属性

玩家、后续队友和敌人统一使用五项属性：

| 显示名 | 字段 | 作用 |
|---|---|---|
| 生命上限 | `maxHp` | 当前 HP 降至 0 时失去战斗能力 |
| 能量上限 | `maxEnergy` | 限制技能频率；适用于全部七种题材 |
| 攻击 | `attack` | 决定基础伤害 |
| 防御 | `defense` | 按比例降低所受伤害 |
| 速度 | `speed` | 决定每轮行动顺序 |

属性是静态定义，当前 HP、能量和防御状态只存在于 active battle。战斗结束后不把剩余 HP 写回永久角色，因为当前没有治疗、休息和消耗品系统，持久伤势会制造不可恢复软锁。

### 2.1 规则拥有的首轮平衡档

| 档位 | maxHp | maxEnergy | attack | defense | speed | 初始 energy |
|---|---:|---:|---:|---:|---:|---:|
| 玩家 | 100 | 40 | 20 | 10 | 12 | 20 |
| 普通敌人 | 55 | 30 | 13 | 7 | 8 | 15 |
| Boss | 120 | 50 | 18 | 12 | 10 | 25 |

- 玩家身份、背景、性格和题材不改变数值。
- 开局 AI 候选删除 `baseStats`，compiler 注入玩家档位。
- 世界演化继续只接受敌人名称、档位和位置，审批器按 tier 注入数值。
- 将来队友系统必须提供同一个 `CombatStats`，战斗内核不关心属性来自招募、职业还是装备。

### 2.2 伤害公式

```text
rawDamage = floor(ATK × ATK × actionMultiplier / (ATK + DEF))
guardedDamage = floor(rawDamage × 0.5)
finalDamage = max(1, guardedDamage or rawDamage)
```

- 普通攻击倍率 `1.0`，技能倍率 `1.6`。
- 使用整数向下取整；没有随机浮动、命中和暴击。
- 防御在最终阶段乘 `0.5`，不再固定减 2。

## 3. 双方多单位的数据接口

```ts
export type BattleSide = "allies" | "enemies";
export type BattleController = "player" | "rule";

export type BattleCombatantSource =
  | { readonly kind: "protagonist" }
  | { readonly kind: "companion"; readonly npcId: NpcId }
  | { readonly kind: "enemy"; readonly enemyId: EnemyId };

export type BattleCombatant = {
  readonly combatantId: BattleCombatantId;
  readonly side: BattleSide;
  readonly controller: BattleController;
  readonly source: BattleCombatantSource;
  readonly stats: CombatStats;
  readonly hp: number;
  readonly energy: number;
  readonly guarding: boolean;
};

export type CombatCommand = {
  readonly actorId: BattleCombatantId;
  readonly kind: "attack" | "skill" | "guard" | "flee";
  readonly targetId?: BattleCombatantId;
};

export type CombatActionResult = {
  readonly round: number;
  readonly sequence: number;
  readonly actorId: BattleCombatantId;
  readonly targetId?: BattleCombatantId;
  readonly kind: CombatCommand["kind"];
  readonly damage: number;
  readonly actorEnergyAfter: number;
  readonly targetHpAfter?: number;
};

export type ActiveBattleState = {
  readonly status: "active";
  readonly round: number;
  readonly combatants: readonly BattleCombatant[];
  readonly turnOrder: readonly BattleCombatantId[];
  readonly turnIndex: number;
  readonly enemyIntents: readonly { readonly actorId: BattleCombatantId; readonly kind: "attack" | "skill" | "guard" }[];
  readonly downedEnemyIds: readonly EnemyId[];
  readonly lastAdvance: readonly CombatActionResult[];
};
```

### 接口不变式

- `combatants` 至少有一名 ally 和一名 enemy；`combatantId` 在单场战斗内唯一。
- 当前只装配 `{kind:"protagonist"}` 一名 ally，`controller:"player"`。
- 后续队友只需追加 `{kind:"companion"}` combatant，并选择 `controller:"player"` 或 `"rule"`。
- 敌人全部为 `controller:"rule"`；`source.enemyId` 仍用于任务与世界状态，但客户端只看到 read-model slot，不看到领域 ID。
- `turnOrder` 只包含本轮开始时存活的单位；单位中途倒下后到其位置时直接跳过。
- 任意时刻返回客户端的 active battle 必须停在一名存活的 `controller:"player"` 单位上，不允许 UI 等待敌方按钮。

## 4. 真正的固定轮次流程

### 4.1 创建遭遇

玩家仍通过挑战某个敌人的 opaque token 开战。服务器从当前地点确定本次 encounter：

- 目标为普通敌人：包含该目标，再按稳定 enemy ID 顺序加入至多一名未击败普通敌人，合计 1–2 只。
- 目标为 Boss：本阶段只包含该 Boss，避免未经验证的 Boss + 群怪数值峰值。
- 其他未纳入的敌人留在地点，战斗结束后仍可挑战。
- 创建一名主角 combatant 和 encounter 内全部 enemy combatants，复制静态属性并设置满 HP/半能量。

底层 `combatants[]` 不限制人数；1–2 只是当前内容与平衡政策。

### 4.2 生成轮次

```text
读取所有存活 combatant
  → SPD 降序
  → 同速：allies 优先，再按 combatantId 稳定排序
  → 写入 turnOrder，turnIndex = 0
  → 为本轮每名存活敌人生成确定性 intent
```

### 4.3 推进到下一次玩家决策

`advanceUntilPlayerDecision` 是战斗内核的关键接口：

1. 跳过已倒下的队列成员。
2. 若当前成员由玩家控制，停止并返回 active state。
3. 若当前成员由规则控制，执行其预先生成的 intent 与规则目标选择，再继续推进。
4. 队列结束且双方均有存活者时，`round + 1` 并生成新队列，然后继续。
5. 任一方全部倒下或撤退时立即停止并解析结局。

开始战斗时也调用该函数，因此比主角更快的怪会先行动；客户端拿到的状态仍总是轮到玩家。玩家提交一个 token 后，规则执行该名我方单位的指令，再自动执行后续敌方单位，直到下一名玩家控制单位需要选择。

这个模型同时满足：

- 当前单主角 + 多怪：一次选择后，多只怪按各自速度依次行动。
- 后续多队友：每名玩家控制队友轮到时分别选择，不需要一次提交整队指令组合。
- 固定轮次：每个存活单位在一轮队列中最多行动一次。
- 现有安全模型：每次选择仍是一个 opaque token 和一次 CAS。

## 5. 行动与目标规则

| 指令 | 目标 | 效果 |
|---|---|---|
| 普通攻击 | 任一存活敌方单位 | `1.0×` 伤害；行动后恢复 10 能量 |
| 技能 | 任一存活敌方单位 | 能量至少 20；扣 20；造成 `1.6×` 伤害 |
| 防御 | 自身 | 不伤害；恢复 15 能量；防御持续到自身下一次行动开始 |
| 撤退 | 无 | 轮到该玩家单位时立即结束整场战斗为 `withdraw` |

- 所有恢复不超过 `maxEnergy`。
- 单位行动开始时先清除自己上一轮留下的 `guarding`，然后执行新指令。
- actor、target、能量与存活状态都在消费 token 时再次校验。
- 当前只有单体技能；多目标技能属于单独的技能系统，不能靠一个无目标 `skill` 偷渡。
- 题材只改变技能显示名：规则 ID 固定，application 可把它显示为武侠“破势一击”、仙侠“灵息爆发”、科幻“过载攻击”等。

### 5.1 敌人意图与目标

- 普通敌人循环：`attack → attack → skill`。
- Boss 循环：`attack → skill → guard`。
- 技能能量不足时降级为普通攻击。
- attack/skill 选择当前 HP 比例最低的存活 ally；同值按 combatantId 排序。
- UI 展示尚未行动敌人的 intent，玩家可据此选择目标和防御。

规则敌人不调用模型，保证同状态同结果。

## 6. 击倒、胜负与重试

- 某 enemy HP 到 0 后立即从后续行动中跳过，并加入 battle 内部 `downedEnemyIds`。
- active battle 期间不把 downed enemy 提前写进世界 `defeatedEnemyIds`，避免任务/幕演化在战斗尚未结束时启动。
- 战斗以 victory、defeat 或 withdraw 结束时，一次性把全部 `downedEnemyIds` 写入世界并发出逐个 `enemy_defeated` 事件；因此即使撤退或败北，已经击倒的怪也不会复活。
- enemies 全部倒下为 victory；allies 全部倒下为 defeat；玩家指令成功执行 flee 为 withdraw。
- 未倒下的敌人保留，可再次挑战；新 encounter 双方以满 HP/半能量开始。
- defeat/withdraw 不永久扣属性、不删档，也不自动失败主线；结构化结果交给现有叙事和节奏系统表现。

## 7. AI 与 CAS 边界

### Active battle

```text
opaque token
  → performTurn
  → execute player-controlled actor command
  → advanceUntilPlayerDecision（自动敌方行动）
  → TurnResolution
  → 单次 StateCommit/CAS
  → 立即返回 GameSessionView
```

- 进入 active battle和仍处于 active 的推进不创建 `PendingNarrativeJob`。
- 不调用 scene source，不等待 AI，不显示“正在编排下一幕”。
- `lastAdvance` 提供本次 CAS 内按真实顺序发生的全部行动，UI 不从 HP 差推断。

### Terminal battle

```text
终结推进
  → battle_resolved + enemy_defeated + quest events
  → 任务/故事/结局 reconciliation
  → PendingNarrativeJob
  → AI 只表演已提交结果
```

这保留现有 AI RPG 的故事整合，同时把 AI 从战斗交互延迟和规则循环中移除。

## 8. Read model 与 UI

```ts
export type BattleCombatantView = {
  readonly slot: string; // ally-0 / enemy-0；仅作本场 UI key
  readonly name: string;
  readonly side: "allies" | "enemies";
  readonly current: boolean;
  readonly defeated: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly energy: number;
  readonly maxEnergy: number;
  readonly speed: number;
  readonly guarding: boolean;
  readonly intent: "attack" | "skill" | "guard" | null;
};

export type BattleControlView = {
  readonly label: string;
  readonly targetName: string | null;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly choiceToken: string | null;
};
```

- UI 左侧渲染 `allies[]`，右侧渲染 `enemies[]`，不再写死一个玩家和一个敌人。
- 当前行动者有明显高亮；每个敌人独立显示 HP、能量、防御状态和未执行 intent。
- 普通攻击/技能为每个存活敌方目标生成控制，例如“攻击 灰狼甲”“破势一击 灰狼乙”。
- 技能能量不足时保留禁用项并显示“需要 20 能量”，但没有 token。
- 角色面板显示五项静态属性；战斗条按 `current/max`，不假设 HP 上限为 100。
- 动画和日志严格按 `lastAdvance[sequence]` 播放；reduced-motion 下直接显示同一有序文本。
- active battle 隐藏地图返回、对话、探索和物品入口。

## 9. 验收标准

1. 每轮开始生成一次稳定行动队列；每个当轮存活单位最多行动一次。
2. SPD 决定顺序，同速规则确定；中途倒下者不能在队列中继续行动。
3. 当前 1 主角对 2 普通敌人可完整战斗、选择目标并分别击倒。
4. resolver 与 BattleState 不读取 `playerHp/enemyHp` 单数字段，也不假设双方长度为 1。
5. 返回客户端的 active battle 永远停在玩家控制单位，规则控制单位不会生成按钮。
6. 后续测试追加第二名 player-controlled companion 后，轮到两名 allies 时能分别暂停等待指令，且无需修改 resolver。
7. 相同 state + token 得到完全一致的队列、目标、伤害、状态与事件。
8. 普通单怪在 3–5 轮可击败；双普通怪存在 6–10 轮胜利策略；Boss 存在 6–10 轮胜利策略，纯攻击不保证 Boss 胜利。
9. active battle 每次玩家指令只递增一次 revision、只提交一次 CAS、无 pending narrative。
10. 胜利/失败/撤退终结推进仍能原子处理击败列表、任务、结局和 pending scene。
11. 中途 reload 后 round、turnOrder、turnIndex、combatants、intents、downed IDs 和 lastAdvance 一致。
12. stale/tampered/重复 token 不产生伤害、能量、击倒、任务或事件。

---

## 10. Implementation Tasks

### Task 1: Generic multi-combatant domain contract

**Files:**
- Create: `src/game/domain/combat.ts`
- Modify: `src/game/domain/worldEntity.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/action.ts`
- Modify: `src/game/domain/events.ts`
- Test: `src/game/domain/combat.test.ts`
- Test: `src/game/domain/worldState.test.ts`

**Interfaces:**
- Produces: `CombatStats`, `BattleCombatantId`, `BattleCombatant`, `CombatCommand`, `CombatActionResult`, `ActiveBattleState`.
- Produces: `PLAYER_COMBAT_STATS`, `ENEMY_COMBAT_STATS`, `initialEnergy(stats)`.
- Later tasks consume exactly these types; no player/enemy scalar HP contract remains.

- [ ] **Step 1: Write failing tests for stats and array-shaped battle state**

```ts
expect(PLAYER_COMBAT_STATS).toEqual({ maxHp: 100, maxEnergy: 40, attack: 20, defense: 10, speed: 12 });
expect(ENEMY_COMBAT_STATS.normal).toEqual({ maxHp: 55, maxEnergy: 30, attack: 13, defense: 7, speed: 8 });
expect(initialEnergy(PLAYER_COMBAT_STATS)).toBe(20);
expect(active.combatants.filter((unit) => unit.side === "enemies")).toHaveLength(2);
```

- [ ] **Step 2: Run focused tests and verify missing exports fail**

Run: `npx vitest run src/game/domain/combat.test.ts src/game/domain/worldState.test.ts`

Expected: FAIL because `combat.ts` and the new battle shape do not exist.

- [ ] **Step 3: Add exact combat types and profiles**

Define the contracts in sections 2–3, plus constants:

```ts
export const SKILL_ENERGY_COST = 20;
export const ATTACK_ENERGY_GAIN = 10;
export const GUARD_ENERGY_GAIN = 15;
export const SKILL_MULTIPLIER = 1.6;
export const GUARD_MULTIPLIER = 0.5;
```

- [ ] **Step 4: Replace Action and event contracts**

```ts
| { readonly type: "battle_action"; readonly command: CombatCommand }
```

Change battle started/resolved events from one `enemyId` to `enemyIds`; add an ordered `battle_advanced` event carrying `CombatActionResult[]`. Terminal resolution emits one `enemy_defeated` per downed domain enemy.

- [ ] **Step 5: Bump `WorldState.version` to 3 and update domain fixtures**

Run: `npm run test:game-domain && npm run typecheck`

Expected: domain tests PASS; typecheck identifies downstream old battle fixtures for the next tasks, with no domain union mismatch.

- [ ] **Step 6: Commit**

```bash
git add src/game/domain
git commit -m "refactor: define multi-combatant battle state"
```

### Task 2: Rule-owned stats and deterministic encounter assembly

**Files:**
- Modify: `src/game/domain/openingGenerationCandidate.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Create: `src/game/gameplay/rpg/ruleEngine/buildEncounter.ts`
- Create: `src/game/gameplay/rpg/ruleEngine/buildEncounter.test.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`
- Modify: `src/game/application/createGame.ts`

**Interfaces:**
- Consumes: Task 1 profiles.
- Produces: `buildEncounter(worldState, challengedEnemyId): BattleCombatant[]` containing one protagonist and 1–2 normal enemies or one Boss.

- [ ] **Step 1: Test that opening AI no longer owns player stats**

```ts
expect(buildOpeningPrompt(input)).not.toContain("baseStats");
expect(parseOpeningGenerationCandidate(candidateWithoutStats).ok).toBe(true);
expect(compile(candidateWithoutStats).worldState.player.stats).toEqual(PLAYER_COMBAT_STATS);
```

- [ ] **Step 2: Remove `baseStats` from candidate parsing, repair, prompt and fallback**

The compiler and deterministic fallback both import `PLAYER_COMBAT_STATS`; enemy approval imports `ENEMY_COMBAT_STATS[p.newEnemy.tier]`. Do not duplicate numeric literals.

- [ ] **Step 3: Write failing encounter tests**

Cover challenged normal + stable second normal, exclusion of Boss from a normal encounter, Boss-only encounter, other locations, defeated enemies and stable combatant IDs.

```ts
expect(encounter.filter((unit) => unit.side === "enemies").map(enemySourceId)).toEqual([challengedId, secondNormalId]);
```

- [ ] **Step 4: Implement encounter assembly without hard-coding resolver lengths**

Only `buildEncounter` applies the current content policy of at most two normals/Boss alone. The resolver receives a generic non-empty array.

- [ ] **Step 5: Run generation and gameplay tests**

Run: `npm run test:game-domain && npm run test:game-gameplay && npm run test:game-application`

Expected: PASS after old three-stat fixtures are mechanically updated.

- [ ] **Step 6: Commit**

```bash
git add src/game/domain/openingGenerationCandidate.ts src/game/application/server/ai/openingGenerationSource.ts src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/ruleEngine/buildEncounter* src/game/gameplay/rpg/worldEvolution src/game/application/createGame.ts
git commit -m "refactor: make encounter stats rule owned"
```

### Task 3: Queue-driven round engine

**Files:**
- Create: `src/game/gameplay/rpg/ruleEngine/combatMath.ts`
- Create: `src/game/gameplay/rpg/ruleEngine/combatMath.test.ts`
- Create: `src/game/gameplay/rpg/ruleEngine/advanceBattle.ts`
- Create: `src/game/gameplay/rpg/ruleEngine/advanceBattle.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/validateAction.ts`

**Interfaces:**
- Produces: `calculateDamage`, `createTurnOrder`, `chooseEnemyIntent`, `chooseEnemyTarget`, `advanceUntilPlayerDecision`.
- `battleResolver` starts/executes/finishes battles by composing these pure functions.

- [ ] **Step 1: Write failing formula and order tests**

```ts
expect(calculateDamage(PLAYER_COMBAT_STATS, ENEMY_COMBAT_STATS.normal, 1, false)).toBe(14);
expect(calculateDamage(PLAYER_COMBAT_STATS, ENEMY_COMBAT_STATS.normal, 1.6, true)).toBe(11);
expect(createTurnOrder(units)).toEqual([fastEnemyId, allyAId, allyBId, slowEnemyId]);
```

- [ ] **Step 2: Implement integer math, stable ties and enemy policies**

Use speed descending, allies before enemies on an exact tie, then `combatantId.localeCompare`. Enemy target is the lowest HP ratio alive ally with ID tie-break.

- [ ] **Step 3: Write failing queue tests**

Cover initial fast enemy auto-action; two enemy actions after protagonist; dead unit skipped; new round generation; guard expiry; insufficient energy; target death; flee; terminal downed enemy materialization; immutable input.

- [ ] **Step 4: Add a two-player-controller contract test**

Construct protagonist + companion fixtures. Assert `advanceUntilPlayerDecision` stops first on ally A, after A's command stops on ally B, and after B's command runs enemies until the next player decision without any resolver code change.

- [ ] **Step 5: Replace fixed counterattack with generic advancement**

At a player command, validate `actorId === current turnOrder[turnIndex]`, actor is player-controlled, target is alive/opposing for attack/skill, and resource cost is available. Execute, then auto-advance rule actors.

- [ ] **Step 6: Add balance simulations**

Use deterministic policies to prove single normal 3–5 rounds, two normals have a winning policy within 10 rounds, Boss has a mixed-action win within 10 rounds, and pure attack does not guarantee Boss victory.

- [ ] **Step 7: Run and commit**

Run: `npm run test:game-gameplay && npm run typecheck`

Expected: PASS.

```bash
git add src/game/gameplay/rpg/ruleEngine
git commit -m "feat: add queue-driven combat rounds"
```

### Task 4: Target-bound opaque controls and combat fast path

**Files:**
- Create: `src/game/application/combatView.ts`
- Create: `src/game/application/combatView.test.ts`
- Modify: `src/game/application/buildChoiceMap.ts`
- Modify: `src/game/application/buildChoiceMap.test.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`

**Interfaces:**
- Produces: `BattleView`, `BattleCombatantView`, `BattleControlView`.
- Each enabled target-specific control maps one opaque token to one exact `CombatCommand`.

- [ ] **Step 1: Test target-specific token generation**

For two living enemies, assert two attack and two skill controls; every token maps to the current actor and exactly one target. Dead targets and non-current allies receive no tokens.

- [ ] **Step 2: Test resource and controller legality**

Skill below 20 energy remains a disabled read-model control with no token. A crafted command for a rule-controlled actor, wrong current actor, dead target or same-side target is rejected with zero write.

- [ ] **Step 3: Test the active-combat no-AI path**

```ts
expect(applyCalls()).toHaveLength(1);
expect(saved.storyState.narrative.generation.status).toBe("idle");
expect(saved.worldState.battle.status).toBe("active");
expect(saved.revision).toBe(1);
```

Terminal victory/defeat/withdraw must still create exactly one pending job after same-turn quest/ending reconciliation.

- [ ] **Step 4: Implement direct active-battle commit**

If the post-resolution state remains active, commit next world/story state directly with existing `commitState`; do not call `createPendingNarrativeJob`. Preserve action ID, turn count and one-CAS semantics.

- [ ] **Step 5: Remove active battle from scene-generated choices**

Battle controls come only from `combatView`; scene registry and live/deterministic scene proposals no longer invent attack/guard/flee choices while active.

- [ ] **Step 6: Verify no internal actor/target IDs leak**

Serialize `GameSessionView` and assert it contains only UI slots, names, numeric public state and opaque tokens; reject `combatantId`, `enemyId`, `npcId`, `actorId`, `targetId`, `actionKey` and registry fields.

- [ ] **Step 7: Run and commit**

Run: `npm run test:game-application && npm run typecheck`

Expected: PASS.

```bash
git add src/game/application
git commit -m "feat: project secure multi-target combat controls"
```

### Task 5: Multi-unit battle viewport

**Files:**
- Create: `src/components/BattleViewport.tsx`
- Create: `src/components/BattleViewport.test.tsx`
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/AdventureDetailsPanel.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes only application `BattleView`; submits only a non-null opaque token.
- Renders variable-length allies/enemies and ordered `lastAdvance`.

- [ ] **Step 1: Write failing multi-enemy UI tests**

Assert two distinct enemy cards, current actor highlight, independent HP/energy, intent labels and target-specific action buttons.

- [ ] **Step 2: Write failing ordered-action tests**

Provide one protagonist action followed by two enemy actions. Assert all three render in `sequence` order and use authoritative `damage/targetHpAfter`, not prop differences.

- [ ] **Step 3: Extract `BattleViewport` and delete HP-diff inference**

Replace fixed left-player/right-enemy markup with mapped side formations. Use `slot` as UI key; never decode tokens or infer domain IDs.

- [ ] **Step 4: Update controls and character panel**

Show disabled skill reason; show exact target name on attack/skill buttons; display all five character stats and proper current/max meters.

- [ ] **Step 5: Add responsive and reduced-motion behavior**

Wide layout uses two formations; narrow layout stacks side groups without overlapping controls. Reduced motion preserves the complete textual log.

- [ ] **Step 6: Run and commit**

Run: `npm run test:components && npm run typecheck`

Expected: PASS.

```bash
git add src/components src/app/globals.css
git commit -m "feat: render multi-unit turn-based battles"
```

### Task 6: Terminal integration, journeys and docs

**Files:**
- Modify: `src/game/gameplay/rpg/narrativeContext/buildOutcomeBeats.ts`
- Modify: `src/game/gameplay/rpg/narrativeContext/buildOutcomeBeats.test.ts`
- Modify: `src/game/application/testing/foundationJourney.test.ts`
- Modify: `src/game/application/testing/storyDivergenceJourney.test.ts`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/agent/战斗与结局.md`
- Modify: `docs/agent/行动裁决.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Consumes terminal multi-enemy events and final world state.
- Produces battle resolution narrative beats and reload proof.

- [ ] **Step 1: Test terminal event batching**

Victory over two enemies emits one battle-resolved event with both encounter IDs and two enemy-defeated events. Withdrawal after downing one emits one enemy-defeated event and leaves the survivor challengeable. No active advancement starts world evolution.

- [ ] **Step 2: Add reload and replay journeys**

Cover: single normal, two normals with target switching, Boss mixed-action victory, defeat, partial-kill withdrawal, retry, reload mid-round queue, and stale replay of a previous actor token.

- [ ] **Step 3: Keep story integration terminal-only**

Assert active advances have no pending job. Terminal outcome builds `battle_resolved` plus any same-turn `quest_progress/quest_advanced` beats and remains compatible with ending resolution.

- [ ] **Step 4: Update player-visible and implementation docs**

Document five stats, multi-unit queue, target selection, encounter policy, exact formula/actions, AI fast path, partial kills and the explicit no-growth boundary. Update the three agent docs and index with the new implementation facts.

- [ ] **Step 5: Run complete acceptance**

Run: `npm run lint && npm run typecheck && npm test && npm run test:fast && npm run build`

Expected: every command PASS; short/medium offline journeys still reload and reach endings; no active battle invokes scene generation.

- [ ] **Step 6: Commit**

```bash
git add src/game/gameplay/rpg/narrativeContext src/game/application/testing docs/策划文档/AI生成RPG_MVP.md docs/agent docs/Agent文档索引.md
git commit -m "docs: define extensible turn-based combat"
```

## 11. Review gates

- Task 1–2：确认存档与生成边界从一开始支持双方多单位，AI 不再拥有数值。
- Task 3：只评审纯战斗规则、多人队列和确定性平衡，不受 UI/AI 干扰。
- Task 4：确认 actor/target 全部绑定在服务端 token，且 active battle 不等待 AI。
- Task 5：确认 UI 只投影任意长度阵营，不重新裁决规则。
- Task 6：确认多敌人、reload、任务、结局和文档构成完整闭环。

角色成长、队友招募/属性、范围技能、战斗道具和通用状态系统是独立后续项目。此方案只为它们保留稳定 combatant/command 接口，不提前实现没有当前消费者的业务规则。
