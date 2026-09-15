import type { NarrativeEventPayload } from "@/game/domain/events";
import type { CommittedNarrativeEvent } from "@/game/domain/events";

/**
 * 固定 metadata policy：每种 payload type 对应的 actor/target/location/fact/quest refs、
 * outcome、salience、summary key 和默认 cause selector。
 * 用 satisfies Record<NarrativeEventPayload["type"], ...> 双向锁定。
 */

export type EventPolicyEntry = Readonly<{
  /** 默认 outcome，可被 draft 覆盖。 */
  readonly defaultOutcome: CommittedNarrativeEvent["outcome"];
  /** 默认 salience（0..100 整数）。 */
  readonly defaultSalience: number;
  /** 固定摘要 key，不含 AI/玩家 prose。 */
  readonly summaryKeys: readonly string[];
}>;

/**
 * 关键 salience 下限：
 * - ending 100
 * - quest/battle resolved 80
 * - fact discovered/relationship major 65
 * - scene presented 40
 * - 普通 travel/explore 20
 */
export const EVENT_POLICY = {
  game_initialized: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 100,
    summaryKeys: ["game_started"],
  },
  opening_history_established: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 70,
    summaryKeys: ["opening_history_established"],
  },
  opening_thread_established: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 80,
    summaryKeys: ["opening_thread_established"],
  },
  location_observed: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 20,
    summaryKeys: ["observed_location"],
  },
  npc_met: {
    defaultOutcome: "success" as const,
    defaultSalience: 50,
    summaryKeys: ["met_npc"],
  },
  npc_dialogue_completed: {
    defaultOutcome: "success" as const,
    defaultSalience: 55,
    summaryKeys: ["dialogue_completed"],
  },
  fact_discovered: {
    defaultOutcome: "success" as const,
    defaultSalience: 65,
    summaryKeys: ["fact_discovered"],
  },
  location_visited: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 20,
    summaryKeys: ["visited_location"],
  },
  location_explored: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 20,
    summaryKeys: ["explored_location"],
  },
  quest_completed: {
    defaultOutcome: "success" as const,
    defaultSalience: 80,
    summaryKeys: ["quest_completed"],
  },
  quest_unlocked: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 40,
    summaryKeys: ["quest_unlocked"],
  },
  location_unlocked: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 40,
    summaryKeys: ["location_unlocked"],
  },
  item_obtained: {
    defaultOutcome: "success" as const,
    defaultSalience: 30,
    summaryKeys: ["item_obtained"],
  },
  item_given: {
    defaultOutcome: "success" as const,
    defaultSalience: 45,
    summaryKeys: ["item_given"],
  },
  battle_started: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 70,
    summaryKeys: ["battle_started"],
  },
  battle_round_resolved: {
    defaultOutcome: "mixed" as const,
    defaultSalience: 50,
    summaryKeys: ["battle_round"],
  },
  battle_resolved: {
    defaultOutcome: "mixed" as const,
    defaultSalience: 80,
    summaryKeys: ["battle_resolved"],
  },
  enemy_defeated: {
    defaultOutcome: "success" as const,
    defaultSalience: 80,
    summaryKeys: ["enemy_defeated"],
  },
  quest_failed: {
    defaultOutcome: "failure" as const,
    defaultSalience: 80,
    summaryKeys: ["quest_failed"],
  },
  quest_abandoned: {
    defaultOutcome: "failure" as const,
    defaultSalience: 80,
    summaryKeys: ["quest_abandoned"],
  },
  ending_reached: {
    defaultOutcome: "success" as const,
    defaultSalience: 100,
    summaryKeys: ["ending_reached"],
  },
  blueprint_expanded: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 40,
    summaryKeys: ["world_expanded"],
  },
  narrative_scene_presented: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 40,
    summaryKeys: ["scene_presented"],
  },
  player_intent_expressed: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 15,
    summaryKeys: ["intent_expressed"],
  },
  candidate_event_approved: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 30,
    summaryKeys: ["candidate_approved"],
  },
  candidate_event_rejected: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 20,
    summaryKeys: ["candidate_rejected"],
  },
  candidate_event_expired: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 15,
    summaryKeys: ["candidate_expired"],
  },
  candidate_event_activated: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 30,
    summaryKeys: ["candidate_activated"],
  },
  npc_interaction_recorded: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 45,
    summaryKeys: ["npc_interaction"],
  },
  npc_knowledge_changed: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 55,
    summaryKeys: ["knowledge_changed"],
  },
  npc_relationship_changed: {
    defaultOutcome: "neutral" as const,
    defaultSalience: 65,
    summaryKeys: ["relationship_changed"],
  },
  npc_goal_status_changed: {
    defaultOutcome: "success" as const,
    defaultSalience: 70,
    summaryKeys: ["npc_goal_status_changed"],
  },
  story_interaction_resolved: {
    defaultOutcome: "success" as const,
    defaultSalience: 60,
    summaryKeys: ["story_interaction_resolved"],
  },
} satisfies Record<NarrativeEventPayload["type"], EventPolicyEntry>;

/** 查询某 payload type 的固定 metadata policy。 */
export function getEventPolicy<K extends NarrativeEventPayload["type"]>(
  kind: K,
): EventPolicyEntry {
  return EVENT_POLICY[kind];
}
