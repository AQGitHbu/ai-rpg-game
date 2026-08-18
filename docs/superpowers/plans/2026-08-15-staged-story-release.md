# 分阶段剧情释放实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans) to implement this plan.

**Goal:** 保留“下一段剧情一次生成一条单向链”的能力，但把线索、地点、NPC、物品和敌人按玩家完成当前调查步骤的顺序逐步释放，修复老陈—酒楼后巷—北巷旧道—顾砚之间的空间、目标和对白跳跃。

**Architecture:** 在 StoryState 中保存当前主线的剧情释放游标。世界演化仍可一次物化完整剧情链，但新地点、目标和实体是否进入玩家可见读模型、选择映射和动作合法性，由释放游标统一控制。新主线优先生成“调查现场线索 → 前往新地点 → 与NPC交谈 → 获取关键物 → 击败追兵”的显式目标链；每次当前目标完成后，规则层推进释放游标并解锁下一步。AI只负责生成叙事表现，不能绕过释放规则展示未来内容。

**Tech Stack:** TypeScript, Vitest, SQLite/libSQL persistence, React/Vite browser playtest.

## Global Constraints

- 只修改 `F:/AI2/ai-rpg-game/.worktrees/real-browser-playtest`，不操作受保护的 foundation sibling 或其他 worktree。
- 保持现有六条路由、CAS 写回和 AI 提案/规则审批边界。
- 隐藏内容必须同时从地图、任务投影、选择映射、场景上下文和动作合法性中排除，不能只做前端隐藏。
- 兼容没有释放游标的旧存档；旧存档按当前既有行为读取，新生成主线使用新规则。
- 不让对白声称玩家已持有或已见过尚未释放的密信、腰牌、追兵等信息。

## Task 1: 建立可持久化的剧情释放状态与目标链

**Files:**
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/worldDelta.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/gameplay/rpg/narrativeContext/objectiveRules.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`
- Modify: `src/game/application/deterministicEvolutionSource.ts`
- Test: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`
- Test: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts`
- Test: `src/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition.test.ts`

1. 增加可选的 `StoryRevealState`，记录 questId 和当前已释放 objective index；旧存档缺失时保持兼容。
2. 为世界事实增加不泄露事实正文的调查提示字段，并让“酒楼后巷的车轮印”成为第一阶段目标。
3. 将包含新事实、新地点、新NPC、新物品和新敌人的动态主线审批为有序目标链：调查 → 前往 → 交谈 → 获取 → 击败；没有新事实时保留通用提案的兼容行为，并在有新地点时显式插入 visit 目标。
4. 新事实初始保持 `discovered:false`；新地点只有在释放到 visit 阶段时才加入 unlockedLocationIds。
5. 为释放状态和目标链补充单元测试，覆盖初始隐藏、地点解锁顺序和调查提示不泄露事实正文。

## Task 2: 在规则层推进释放游标并收紧动作入口

**Files:**
- Add: `src/game/gameplay/rpg/worldEvolution/storyReveal.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/buildChoiceMap.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/gameplay/rpg/narrativeContext/objectiveRules.ts`
- Test: `src/game/application/gameSessionView.test.ts`
- Test: `src/game/application/performTurn.test.ts`
- Test: `src/game/application/buildChoiceMap.test.ts`

1. 提供纯规则函数，判断目标是否已释放、实体是否随目标释放，并在当前目标满足后推进到下一目标。
2. 在正常解析和修复解析两条成功写回路径中推进释放状态，确保叙事过渡看到的是推进后的目标。
3. 过滤地图、任务目标、可调查事实、NPC/物品/敌人和可操作 choice；隐藏目标不能通过伪造 action token 或意图上下文越权执行。
4. 让任务目标标签显式呈现“调查酒楼后巷的车轮印”“前往北巷旧道”“与顾砚交谈”，不再用“前往地点，与NPC交谈”压缩两个步骤。
5. 补测试确保第一步看不到北巷和顾砚，到达北巷前不能获取腰牌/攻击追兵，完成每一步后只释放下一步。

## Task 3: 修复场景对白的上下文衔接

**Files:**
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/domain/npcSpeech.ts`
- Modify: `src/game/gameplay/rpg/narrativeContext/resolveEntityDescriptions.ts`
- Test: `src/game/application/deterministicSceneSource.test.ts`
- Test: `src/game/domain/npcSpeech.test.ts`

1. 保留老陈的目击信息，但将“酒楼后巷”作为当前调查现场，不把它直接跳译成已经抵达北巷旧道。
2. 为顾砚增加“顺着同一条车轮印/受韩七所托而来”的过渡对白，并只在玩家抵达且目标已释放后出现。
3. 对隐藏实体和未发现事实使用安全描述，避免场景上下文或 fallback 对白提前说出腰牌、追兵和旧案答案。
4. 补对白测试，验证新链路中的称谓、来历和先后关系。

## Task 4: 更新玩法事实文档并回归测试

**Files:**
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/世界动态具象化.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/Agent文档索引.md`
- Test: `src/game/application/testing/dynamicMaterializationJourney.test.ts`
- Test: `src/game/application/testing/mediumActJourney.test.ts`

1. 把“完整生成、分阶段释放”和“子地点/场景节点”的边界写入实现文档与策划文档。
2. 更新已有动态物化旅程测试的断言，使其验证玩家可见链路而非仅验证后台实体数量。
3. 运行相关 Vitest、类型检查和构建，修复回归。

## Task 5: 浏览器实机验收

1. 启动项目开发服务器并打开本地游戏。
2. 创建或重置一局新游戏，确认初始地图只显示青石镇，老陈对白只给出酒楼后巷车轮印。
3. 选择调查酒楼后巷，确认调查完成后才出现“前往北巷旧道”；移动前不出现顾砚、腰牌和追兵。
4. 移动到北巷旧道，确认此时才出现顾砚和交谈目标；对白能说明双方沿同一线索汇合，不再假定早已认识。
5. 交谈后确认腰牌和后续追兵按顺序释放，并记录浏览器控制台、网络请求和最终任务文本无错误。
6. 若实机发现文案或读模型仍跳步，回到规则层修复后重新跑完整链路。

## Verification Commands

- `npm test -- --run src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts src/game/application/gameSessionView.test.ts src/game/application/performTurn.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts src/game/application/testing/mediumActJourney.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run dev -- --host 127.0.0.1`

## Self-Review Checklist

- 任何未来实体是否仍能从 `projectGameSessionView`、`buildChoiceMap` 或 scene context 泄露？
- 当前目标完成后，是否恰好只推进一个释放阶段？
- 旧存档没有 reveal 字段时是否仍能读取并继续？
- fallback 和 AI 生成场景是否遵守同一条目标链？
- 浏览器看到的地点名称、NPC对白和任务目标是否一致使用“酒楼后巷 → 北巷旧道”的空间关系？
