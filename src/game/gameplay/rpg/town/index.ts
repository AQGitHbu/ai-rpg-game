// Town 生成器公共门面：application 只允许从这里导入（deep-import 由
// dependencyBoundaries.test.ts 拦截）。内部工具不出门面。
export { createTownRng, type TownRng } from "./townRandom";
export { generateTown, type TownGenerationInput, TownGenerationError } from "./generateTown";
export { createTownRuntime, townSeedFor, type CreateTownRuntimeInput } from "./createTownRuntime";
export { bindNpcToTownSlot, type BindNpcToTownSlotResult } from "./bindNpcToTownSlot";