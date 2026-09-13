/** Shared author/reviewer interpretation of the existing opening compiler. */
export const OPENING_SEMANTIC_CONTRACT = [
  "开局候选契约：本次是建立初始世界，不是仅复述玩家输入。允许在事实目录/history 中建立与输入不冲突的必要新人物背景、核验凭据与因果；已明确的玩家经历和已发生行动不可改写。",
  "world.publicFacts 是历史命名的事实目录，不等于全部向玩家公开。privateFactKeys 必须引用该目录，目录中出现秘密本身不是披露；实际泄密检查 prologue、场景正文、选项与公开历史/thread 的受众。不能要求把秘密移出目录或增加 privateFacts 字段。",
  "目录按数组顺序编译 fact_0、fact_1……；opening_npc 编译 npc_0。usedFactIds 使用编译后的 ID，不能要求改成本地 key。",
  "首屏恰好两个选项；完整故事可有多种路线，自定义输入与后续正式选项逐步展开。不能要求首屏两个选项同时枚举四条路线，或要求 trust/doubt 主题枚举所有终局；仍须检查当前对白承诺的两项具体回应与选项一致。",
  "NPC 初始知识可以由一致的初始设定建立；不能仅因玩家输入未写 NPC 如何得知就禁止创作。若候选明确只限其他人知晓、与 NPC 能力/经历矛盾或正文泄露未授权事实，则必须报告具体冲突。",
].join("\n");
