# Goal

修复动态剧情中“NPC刚提出一个问题，玩家选项却回答另一个问题”的脱节，并把一次 NPC 对话从单轮动作改为可连续推进的多轮对话。每一轮始终生成两项与当前 NPC 台词和上一轮话题相符的选项；完成连续对话后再允许 `talk_to_npc` 目标完成。完成代码测试后，在 Chrome 中清空当前档案、开启一局新游戏并实机验证真实首个 NPC 的对白链路。

# Architecture

- `TalkAction`、批准选项和 pending narrative job 保存对话行为与结构化主题，使“玩家选了什么”不会在叙事生成前丢失。
- `SceneGenerationContext` 从当前场景读取上一句 NPC 台词、上一轮选项和 NPC 最近交互摘要；live prompt 与确定性 fallback 都使用同一份上下文。
- 对话候选由服务端根据当前台词投影为两个权威候选，live AI 只负责选择候选，不得改写对话选项标签；这样保证可生成的 NPC 台词与选项在同一个话题上。
- narrative runtime 增加短对话会话进度：首轮回答后保留同一 NPC 的对话目标，达到最少两轮后才完成目标并交给主线推进。
- 增加单元测试覆盖主题保留、提示词上下文、连续轮次和选项锁定；最后用 Chrome 实机新开档验证至少两次连续选择。

# Tech Stack

- TypeScript、Vitest、现有 RPG rule engine / narrative scene source。
- Chrome control skill 进行真实浏览器操作、截图和网络请求结果检查。

# Global Constraints

- 不泄漏 NPC hidden facts；提示词只增加当前焦点 NPC 的公开/授权上下文。
- 不改变 opaque choice token 的客户端契约；主题只进入服务端批准动作和摘要。
- 每个可操作场景仍严格输出两个选择；拒绝无效/重复候选。
- 保留无对话事件和旧测试的现有行为；可选新增字段必须兼容旧存档读取。
- 所有实现与测试在 `.worktrees/real-browser-playtest` 中完成，不使用 `git checkout`。

## Implementation tasks

1. 扩展对话动作、批准选项和 pending job 的结构化摘要，保留 `dialogueAct` / `topic`，并覆盖 token 与语义去重。
2. 构造并传递上一轮 NPC 台词、玩家选项和交互摘要；更新 live prompt 的硬约束与 deterministic fallback 的对话文案。
3. 把对话候选标签改为服务端权威候选，确保 live AI 不能把相关选项改写成脱离当前台词的通用选项。
4. 增加最少两轮的对话会话状态，并让 `talk_to_npc` 任务只在会话收束后完成，同时兼容非会话旧调用。
5. 添加/更新单元测试，运行相关测试和全量测试，修复类型或回归问题。
6. 更新 NPC 对话驱动叙事的实现事实文档与索引。
7. 使用 Chrome 清除当前档案、创建新游戏、等待首幕生成，选择首个对话选项，再检查下一幕 NPC 是否承接上一轮；必要时完成第二轮，记录实机结果。

## Self-review checklist

- [ ] 第一轮 NPC 台词和两个选项语义一致。
- [ ] 第二轮提示词包含上一句 NPC 台词与玩家所选项。
- [ ] 同一轮始终只有两个不同选项。
- [ ] 第一次对话选择不会立即完成 talk 目标。
- [ ] 对话收束后主线仍能推进。
- [ ] AI 路径、fallback 路径和旧存档兼容路径均有测试。
