/** RPG question semantics shared by planning and review; never a keyword classifier. */
export const INQUIRY_SEMANTICS = `问询角色与维度：answer/plan_answer 的 inquiries 仅表示玩家已经向 NPC 提出的问题，是 NPC 的回答义务。NPC 主动向玩家提问不转换成玩家的 inquiries 或回答义务；未来玩家候选也不成为本轮已问问题。NPC 问话的完整含义仍须由自己的 brief/intent 批准，实际表达必须忠实保留，不得擅加问题。
按实际索取的信息区分维度，不按关键词或问号判定，不穷举相邻维度补齐合同：identity 辨认身份或信物；reliability 求证事实真假或可信程度，认不认得令牌不等于问令牌真假。source 问信息或信物的起源；location 问独立的空间所在，“信号来自哪里”可仅问来源，不必额外 location；只有明确另问位置或坐标才增加该维度。cause 问成因，“是不是也撞上了”问遭遇，不是成因。method 问具体做法，“有没有真去调查”问是否发生，不等于“如何调查”。time 问尚待提供的时间；“这几夜住店的生面孔是谁”已给时间范围，不是索取时间。明确维度必须编码，存在歧义则保留不确定性，不能把报告地址当成已问维度或新增知识。
玩家 offer/support 不携带新的事实问题。混合建议与问询时，改为 ask/challenge 并逐项登记真正索取的事实维度，或只保留提议；不把所有相邻维度补进 inquiries。NPC 自己的意图仍独立判断。
prerequisiteFactIds 仅能复核原事实本身，不能新增条件结论或升级事实强度：“没有其他船只的应答记录”不等于“没有其他船只”，不能用核实前者的条件去要求确认后者。条件不授予事实、知识、披露权限或已经完成的行动。`;
