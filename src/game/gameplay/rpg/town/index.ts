// town 生成器公共门面：application 只允许从这里导入（deep-import 由
// dependencyBoundaries.test.ts 拦截）。内部工具（hashTownSeed 等）不出门面。
export { createFallbackTownPlan } from "./fallbackTownPlan";
export { createTownRng, type TownRng } from "./townRandom";
export { generateTown, TownGenerationError, type TownGenerationInput } from "./generateTown";
export { validateTownDraft, type TownDraft, type TownValidationIssue } from "./validateTown";
