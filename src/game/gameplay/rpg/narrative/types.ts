import type { EnemyTier, NarrativeEmotion, NarrativeEventKind, ProposedEnding, StatBlock } from "@/game/domain";

/** Stable mapping from AvailableAction to a unique key, used by AI proposals. */
export type NarrativeActionCandidate = {
  readonly actionKey: string;
  readonly kind: string;
  readonly publicLabel: string;
};

// ---------------------------------------------------------------------------
// Director proposal types
// ---------------------------------------------------------------------------

export type ProposedNewLocation = {
  readonly name: string;
  readonly description: string;
  readonly scale: "scene" | "town";
  readonly connectFromLocationId: string;
  readonly reason: string;
};

export type ProposedNewNpc = {
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly locationId: string;
};

export type ProposedNewFact = {
  readonly text: string;
  readonly locationId: string;
  readonly reason: string;
};

export type ProposedNewItem = {
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly locationId: string;
};

export type ProposedNewEnemy = {
  readonly name: string;
  readonly tier: EnemyTier;
  readonly stats: StatBlock;
  readonly locationId: string;
  readonly reason: string;
};

export type DirectorProposal = {
  readonly sceneGoal: string;
  readonly tensionLevel: 1 | 2 | 3 | 4 | 5;
  readonly focusNpcId: string | null;
  readonly relevantFactIds: readonly string[];
  readonly allowedRevealFactIds: readonly string[];
  readonly suggestedActionKeys: readonly [string, string];
  readonly introducedEntities: readonly {
    readonly kind: "npc" | "location" | "item" | "enemy" | "fact";
    readonly id: string;
  }[];
  readonly pacing: "setup" | "develop" | "turn" | "climax" | "resolution";
  readonly proposedNewLocations: readonly ProposedNewLocation[];
  readonly proposedNewNpcs: readonly ProposedNewNpc[];
  /** 事件级懒资源：每场最多审批一种新资源。 */
  readonly proposedNewFacts?: readonly ProposedNewFact[];
  readonly proposedNewItems?: readonly ProposedNewItem[];
  readonly proposedNewEnemies?: readonly ProposedNewEnemy[];
  /** 原子事件类型；旧 fixture 缺失时由 application 根据 trigger 推导。 */
  readonly eventKind?: NarrativeEventKind;
  /** eventKind 对应的既有目标 ID；新资源由扩展审批后再绑定。 */
  readonly eventTargetId?: string;
  /** Phase 14: 结局提议（达阈值时导演可提议）。 */
  readonly proposedEnding?: ProposedEnding;
};

export type ApprovedDirectorPlan = DirectorProposal;

// ---------------------------------------------------------------------------
// Blueprint expansion approval types
// ---------------------------------------------------------------------------

export type ApprovedBlueprintExpansion = {
  readonly newLocation: ProposedNewLocation | null;
  readonly newNpc: ProposedNewNpc | null;
  readonly newFact?: ProposedNewFact | null;
  readonly newItem?: ProposedNewItem | null;
  readonly newEnemy?: ProposedNewEnemy | null;
};

export type BlueprintExpansionRejection =
  | "none_proposed"
  | "invalid_payload"
  | "soft_cap_reached"
  | "hard_cap_reached"
  | "endgame_locked"
  | "pacing_locked"
  | "connect_not_unlocked"
  | "town_cap_reached";

export type BlueprintExpansionDecision =
  | { readonly ok: true; readonly expansion: ApprovedBlueprintExpansion }
  | { readonly ok: false; readonly reason: BlueprintExpansionRejection };

// ---------------------------------------------------------------------------
// Scene script proposal types
// ---------------------------------------------------------------------------

/** Phase 14: NPC 对白指令——焦点 NPC 与附加 NPC 共用同一形状。 */
export type NpcInstruction = {
  readonly npcId: string;
  readonly speechAct: "inform" | "ask" | "evade" | "deny" | "warn" | "encourage";
  readonly emotion: NarrativeEmotion;
  readonly allowedFactIds: readonly string[];
  readonly mayLie: boolean;
};

export type SceneScriptProposal = {
  readonly narration: string;
  readonly usedFactIds: readonly string[];
  readonly npcInstruction: NpcInstruction | null;
  /** Phase 14: 多 NPC 对白指令——焦点 NPC 之外的在场 NPC 演员指令。 */
  readonly additionalNpcInstructions?: readonly NpcInstruction[];
  readonly choices: readonly [
    {
      readonly actionKey: string;
      readonly label: string;
      readonly strategy: string;
      readonly choiceKind?: "dialogue_response" | "world_action";
      readonly dialogueIntent?: string;
    },
    {
      readonly actionKey: string;
      readonly label: string;
      readonly strategy: string;
      readonly choiceKind?: "dialogue_response" | "world_action";
      readonly dialogueIntent?: string;
    },
  ];
};

export type ApprovedSceneScript = SceneScriptProposal;

// ---------------------------------------------------------------------------
// NPC performance proposal types
// ---------------------------------------------------------------------------

export type NpcPerformanceProposal = {
  readonly text: string;
  readonly usedFactIds: readonly string[];
  readonly emotion: NarrativeEmotion;
};

// ---------------------------------------------------------------------------
// Approval types
// ---------------------------------------------------------------------------

export type NarrativeApprovalCategory =
  | "schema_violation"
  | "reference_broken"
  | "knowledge_scope_violation"
  | "choice_not_legal"
  | "state_prose_mismatch"
  | "continuity_violation";

export type NarrativeApprovalResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; category: NarrativeApprovalCategory }>;
