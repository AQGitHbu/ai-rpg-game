// Task 4 门面：把规则结果/任务变化转成强制叙事节拍与权威目标转换。
// 纯 gameplay 模块——只依赖 domain，不触达 application/UI/持久化。
export type { BuildOutcomeBeatsInput } from "./buildOutcomeBeats";
export { buildOutcomeBeats, capMandatoryBeats } from "./buildOutcomeBeats";
export type { DeriveObjectiveTransitionInput } from "./deriveObjectiveTransition";
export { deriveObjectiveTransition, currentObjectiveOf } from "./deriveObjectiveTransition";
