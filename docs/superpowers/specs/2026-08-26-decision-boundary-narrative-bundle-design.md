# 决策边界叙事生成包设计

## 1. 目标

运行时 AI 只在玩家真正改变剧情分支的边界工作。一次边界生成一个原子叙事包，包内覆盖从本次选择结果到下一次正式二选一（或游戏结局）之间的全部剧情文本和可消费步骤。

系统必须同时满足以下不变量：

1. 新游戏初始化、正式剧情二选一、自定义 NPC 输入是唯一正常 AI 触发点。
2. 重试复用原 `jobId`，不创造新的剧情触发语义。
3. NPC 卡片点击、移动、调查、探索、物品操作、建筑进入、战斗开始、战斗回合、战斗结算、轮询和刷新均不得触发 AI。
4. 每个决策边界只创建一个逻辑生成任务；世界增量、当前回应、线性续接文本和下一决策场景由同一份 provider 响应返回并原子审批。
5. 包内所有规则可达路径必须在写回前被证明能够到达下一正式决策或结局。缺项时整包失败并按同一任务重试，禁止运行到中途再补调 AI。
6. 任何玩家可见的剧情旁白、NPC 台词、动态剧情选项和剧情性动作反馈均来自 AI 已审批文本；生产代码不得提供硬编码剧情模板或伪造 fallback。

## 2. 术语

- **决策边界（Decision Boundary）**：初始化、玩家选择当前场景的一个正式剧情选项，或向当前焦点 NPC 提交自定义输入。
- **叙事生成包（Narrative Bundle）**：单次决策边界产生的世界提案、当前结果场景、后续可消费场景图和终点声明。
- **剧情动作（Narrative Action）**：会推进任务或切换剧情场景的行动，必须消费包内一个权威步骤。
- **机械动作（Mechanical Action）**：只改变规则/UI 状态、不产生新剧情正文的操作，例如战斗回合中的攻击、防御、技能以及纯地图查看。
- **正式决策（Formal Decision）**：当前焦点 NPC 的两个服务端批准剧情选项，并允许自定义输入。按钮数量相同但只表达战术操作的战斗控件不是正式决策。

## 3. Provider 触发矩阵

| 入口 | 创建逻辑生成任务 | 说明 |
|---|---:|---|
| 新游戏初始化 | 是 | 一次响应生成初始世界、序幕和第一处正式决策 |
| 正式剧情二选一 | 是 | token 必须属于当前 ready scene 的两个批准选项 |
| 当前焦点 NPC 自定义输入 | 是 | 原文进入同一生成包；不得先调用独立 intent AI |
| 同 job 自动内容修复/传输重试/人工重试 | 复用 | 保持相同 `jobId`、触发来源和规则结果 |
| 点击 NPC 卡片/打开或关闭弹窗 | 否 | 只投影已经生成的对白 |
| 移动、调查、拾取、交付、剧情探索 | 否 | 消费已审批步骤；没有步骤则零写入失败 |
| 普通回访、查看地图/背包 | 否 | 机械 UI，不生成剧情正文，不替换当前剧情场景 |
| 战斗开始 | 否 | 消费包内战斗开场步骤 |
| 战斗攻击/技能/防御 | 否 | 纯规则回合，只显示结构化数值和状态 |
| 战斗失败/撤退 | 否 | 恢复战前玩法检查点 |
| 战斗胜利 | 否 | 消费包内胜利后续步骤 |
| GET、poll、ensure | 否 | 只观察或恢复已经存在的 pending job |

`npc_fixed_choice` 不能继续作为宽泛 provider 白名单名。新契约使用语义明确的 `initialization | narrative_choice | npc_free_text`，并由服务端从当前场景 registry 证明触发来源。

## 4. 一个边界，一个原子包

生产环境使用一个统一 `NarrativeBundleSource`。一次成功响应必须同时包含：

```ts
export type NarrativeBundleProposal = {
  readonly worldDelta: WorldDeltaProposal | null;
  readonly currentScene: BundleSceneProposal;
  readonly continuationScenes: readonly BundleStepProposal[];
  readonly terminal:
    | { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } }
    | { readonly kind: "next_decision"; readonly target: { readonly kind: "continuation_step"; readonly stepKey: string } }
    | { readonly kind: "ending" };
};
```

`currentScene` 本身可以就是下一决策，例如开局首场景或同一 NPC 的下一轮回应；这时 `target.kind="current_scene"`，`continuationScenes` 必须为空，且当前场景必须映射到服务端生成的恰好两个正式候选。只有玩家还要先消费移动、调查、物品或胜利等线性步骤时，才使用 `target.kind="continuation_step"` 指向服务端图中的终点步骤；此时 `currentScene` 不得携带可执行选项。结局正文始终位于 `currentScene`，并且不得携带可执行选项或 continuation。

AI 可以提议世界内容和文本，不能提交持久化步骤 ID、图边、active roots、opaque choice token 或任意状态 patch。`BundleStepProposal.stepKey` 只是从封闭语法生成的 provider-facing 动作选择器，例如 `move:@new.location`、`investigate:@new.fact:<approachId>` 或 `battle_resolved:victory:@new.enemy`；其中实体部分只能是 prompt 已下发的现有实体 ID 或下列受限符号引用。服务端先解析符号，再将它规范化为真实 trigger key，与重建后的 descriptor 一一匹配，最后铸造持久化 `stepId`；provider key 不是图身份。

```text
@current.location
@current.focus_npc
@new.location
@new.npc
@new.item
@new.enemy
@new.fact
@new.quest
@ending.trust
@ending.doubt
```

服务端按以下顺序处理同一响应：

1. 解析完整 JSON。
2. 审批 `worldDelta`，铸造真实 ID，并构造只读预览状态。
3. 从预览状态和任务目标纯函数重建步骤描述符、合法 trigger、候选 action 和图边。
4. 解析符号引用，逐条匹配 AI 文本与服务端描述符。
5. 验证当前结果场景、所有可达步骤、终点位置和选项数量；当前场景终点与 continuation 终点不能同时存在。
6. 世界增量、当前场景、完整 continuation 和候选 token 在一次 CAS 中写回。

任一步失败都不得部分落库。内容修复重新提交完整包，并继续使用原 `jobId`。

## 5. 服务端权威续接图

续接图只描述玩家可执行的剧情动作。自动事实确认等同一规则回合内的零动作目标合并到触发它的场景，不制造虚假的“继续”按钮。

`visit_location -> discover_fact -> talk_to_npc` 必须被投影为：

```text
move(new_location)
  └─ 同场景表现：抵达 + 自动发现事实 + 新 NPC 开场对白
      └─ terminal next_decision：两个正式 NPC 选项 + 自定义输入
```

如果 `obtain_item`、`defeat_enemy` 等确实需要玩家动作，则保留独立可消费步骤。描述符遍历必须：

- 穿过所有零动作目标；
- 在真正的玩家剧情动作处生成 step；
- 扫描中间自动目标后仍能找到下一 `talk_to_npc`；
- 为每个规则分支生成服务端权威 successor；
- 不超过 `MAX_NARRATIVE_BUNDLE_STEPS = 12`；
- 所有叶节点恰好是下一正式 NPC 决策或结局。

超过上限不是增加“继续”按钮的理由。provider 应在修复请求中缩短单线过程，并更早落到有语义差异的正式决策。

## 6. 剧情文本来源

生产态 `NarrativeSceneState.source` 只允许 `generated`。`fixture` 仅用于离线测试，不得由生产 composition root 注入。`rule` 来源和 `buildRuleOwnedScene` 整体删除。

必须删除或阻断所有玩家可见的硬编码剧情文本，包括但不限于：

- “你确认了脚下的方向，暂时退回熟悉的路径。”
- “你按规则记录下眼前的调查结果。”
- “你收起了眼前的物品。”
- “你完成了物品交接。”
- “战斗结果已经由规则结算。”
- “你环顾当前地点，确认了周围的结构。”
- “行动未能完全达成。”
- “你记下了眼前的安排。”
- “行动结果已经由规则记录。”
- 自动合成的 NPC 问候、闲聊、`startChoice` 文案；
- 战斗 UI 拼接的“你攻击了……”“战斗结算完成”等剧情句子。

规则层仍可以保存稳定错误码、实体 ID、数值变化和审计字段；UI 仍可以显示“攻击”“防御”“生命”“第 N 回合”等机械标签。它们不是剧情正文。规则 `feedback`、`StateChange.description` 等内部字段不得直接进入剧情视图。

生产读模型只展示以下两类文本：

1. 已审批 AI 文本；
2. 明确的非剧情系统文案，例如网络错误、保存状态和控件标签。

## 7. 自定义输入

自定义输入只允许发给当前焦点 NPC。它直接转换为带原文的中性 `talk` 行动：

```ts
{
  type: "talk",
  npcId: focusedNpcId,
  dialogueAct: "ask",
  utterance: clippedPlayerText,
}
```

AI 在唯一的叙事生成包调用中理解语气和语义并生成回应。生产路径删除独立 `IntentParserSource` provider 调用，避免一次自定义输入先调 intent、再调 world、再调 scene。

关系变化仍由规则控制。首版对自由文本采用中性 `ask` 规则效果，不允许 AI 直接提交好感、任务或背包 patch。

## 8. 回合制战斗

战斗不是叙事决策边界。

### 8.1 开战

进入战斗时消费当前包的 `battle_started` 步骤并建立战前检查点。检查点至少保存：

- 玩家战前属性；
- 战前 `defeatedEnemyIds` 和 event ledger 截点；
- 战前剧情 scene、choice registry、continuation active roots；
- 战斗期间不得改变的剧情指标快照。

### 8.2 战斗回合

每个回合由玩家操作，规则引擎结算。回合提交只更新 battle state 和数据库 revision，不推进剧情 `turnNumber`、任务、张力、世界演化或 narrative scene，也不创建 pending job。

战斗界面直接展示结构化的单位名、HP、能量、伤害、行动类型和敌方意图；不生成或拼接剧情旁白。

### 8.3 失败与胜利

- 失败恢复战前玩法检查点，敌人保持可挑战，战斗状态回到 idle，数据库 revision 继续单调增加。失败不消费后续剧情、不调用 AI。
- 若保留撤退，撤退与失败使用同一恢复语义。
- 胜利提交规则结果，清除检查点，并消费已预生成的 `battle_resolved:victory` 后继。胜利后的剧情、奖励描述和下一 NPC 对话均来自原叙事包。
- 生成包无需提供 defeat/withdraw 剧情分支，因为这两种结果回到战前状态。

## 9. NPC 对话入口

NPC 卡片点击永远只打开已经生成的对话。读模型删除 `startChoice`，组件删除“点击卡片自动提交 ask”的逻辑。

当前目标 NPC 如果没有 ready 焦点台词、两个选项和 choice registry，说明已保存的包不完整。系统应显示非剧情错误状态并阻止提交，不能合成问候、不能显示单按钮、不能调用 provider 补场。

## 10. 结局

最终二选一仍然是正式决策边界，因此必须创建最后一个叙事生成任务。该包的 `terminal.kind` 为 `ending`，包含选择结果和结局正文，不要求后续两个选项。

规则可先确定 ending ID，但 UI 在最终包 ready 前继续显示生成状态；provider 失败时允许对同一 job 人工重试，不能绕过生成直接展示硬编码结局。

## 11. 存档与兼容

这是破坏性运行时契约变更，`STORY_STATE_SCHEMA_VERSION` 从 6 升到 7。v6 存档不做隐式 AI 修复，因为加载、NPC 点击或移动都不是合法触发点。

开发阶段接受重新开局。读取 v6 时返回明确的“旧叙事架构存档不兼容”系统状态；不删除数据库、不自动创建 job、不展示旧 `source="rule"` 文本。数据库 revision 在所有成功写入中保持单调。

## 12. 可观测性与验收

每条 provider 审计事件必须含 `gameId`、`jobId`、`triggerKind`、`turnNumber`、`attempt` 和结构化 `retry.origin`。统一调用使用 `role="narrative_bundle"`、`purpose="narrative_bundle_generation"`。初始化在第一次 source 调用前创建稳定的逻辑 `jobId`（即使不会持久化为 pending），所有开局 novelty/content/transport 重试复用它；正式选择和自定义输入使用持久化 pending job 的 `jobId`。同一边界产生的 proposal、repair 和最终 story-text 审计共享同一 `jobId`，不得再出现独立 world/scene 初始调用。

验收矩阵至少证明：

- 新游戏成功只产生一个逻辑 bundle 调用并直接得到第一处正式二选一；
- 正式固定选项和自定义输入分别只产生一个逻辑 bundle 调用；
- 自定义输入没有 intent provider 前置调用；
- NPC 卡片点击零网络提交；
- move/explore/investigate/take/give/battle start/battle round/victory/defeat 均零 provider 调用；
- 每个剧情动作都消费 `source="generated"` 的已审批步骤；
- 缺失步骤时规则状态、剧情状态和 revision 都不变；
- 战败恢复战前状态，胜利进入预生成剧情；
- 源码不存在生产 `source="rule"`、`buildRuleOwnedScene`、`startChoice` 和已列出的硬编码剧情模板；
- 所有 continuation 可达叶节点均为 `next_decision` 或 `ending`。
