import type { NarrativeEventKind } from "./narrative";
import type { FactId, NpcId } from "./scenarioBlueprint";

export type ResolvedEventStatus = "success" | "partial_success" | "failure" | "blocked" | "invalid";

/** 事实知识传播的封闭来源：决定 audience 语义，禁止自动扩散。 */
export type FactChangeSource =
  | "scene_witness" // 在场可见（事件明确在场的 NPC）
  | "player_told" // 玩家明确告知（显式 audience）
  | "npc_revealed" // NPC 主动透露（不等于其他 NPC 自动知道）
  | "public_broadcast" // 公共广播（显式 audience 或全城）
  | "faction_shared"; // 阵营共享（显式 audience）

export type FactChange = {
  readonly factId: FactId;
  readonly change: "discovered" | "hidden" | "revealed";
  readonly source: FactChangeSource;
  readonly audience?: readonly NpcId[];
};

export type StateChange = {
  readonly path: string;
  readonly description: string;
  readonly operation: "set" | "add" | "remove" | "update";
  readonly value?: unknown;
};

export type Cost = { readonly description: string };
export type Reward = { readonly description: string };
export type RejectedEffect = { readonly description: string; readonly reason: string };

export type ResolvedEvent = {
  readonly actionId: string;
  readonly status: ResolvedEventStatus;
  readonly eventKind: NarrativeEventKind;
  readonly facts: readonly FactChange[];
  readonly stateChanges: readonly StateChange[];
  readonly costs: readonly Cost[];
  readonly rewards: readonly Reward[];
  readonly triggeredEvents: readonly string[];
  readonly rejectedEffects: readonly RejectedEffect[];
};
