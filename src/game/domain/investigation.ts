import type { WorldFactEntry } from "./worldEntries";

/** 事实进入玩家知识的规则入口。 */
export type DiscoveryMode = "automatic" | "investigation";

/**
 * 兼容旧的兼容投影：没有声明模式的普通事实仍是 automatic。
 * 新的生产事实应显式写出 discoveryMode，避免从 approaches 猜测玩法。
 */
export function discoveryModeOf(fact: Pick<WorldFactEntry, "discoveryMode">): DiscoveryMode {
  return fact.discoveryMode ?? "automatic";
}

export function isExplicitInvestigation(fact: Pick<WorldFactEntry, "discoveryMode">): boolean {
  return discoveryModeOf(fact) === "investigation";
}
