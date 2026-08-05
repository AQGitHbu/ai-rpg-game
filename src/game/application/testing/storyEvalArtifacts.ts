// ---------------------------------------------------------------------------
// storyEvalArtifacts：评估产物共享类型与完整性校验（spec §6.3 + Task 13）。
// StoryEvalStoryRow 是 story.jsonl 单行契约（场景行/结局行）；Evidence/
// Completeness 类型定义于此，同时从 storyEvalCases.ts 再导出（brief 要求
// case/evidence 类型面均可在 storyEvalCases.ts 取到）。本模块只承载类型与
// 纯函数校验/装配逻辑：零 node:fs、零 server 依赖、零 process.env。
// 安全红线：不得写入 prompt、provider 原文或评估采集开关外的敏感资料。
// ---------------------------------------------------------------------------

/** story.jsonl 单行：场景行或结局行（sceneIndex 为场景序号，1-based）。 */
export type StoryEvalStoryRow = Readonly<{
  kind: "scene" | "ending";
  sceneIndex: number;
  sceneId?: string;
  mainStage?: number | null;
  narration?: string;
  npcLine?: { text: string; emotion: string } | null;
  choices?: readonly { label: string; actionKey: string }[];
  directorPlan?: Readonly<Record<string, unknown>> | null;
  /** 当前主线未满足目标的安全投影，不含任务描述/事实原文。 */
  activeMainObjective?: Readonly<{
    questId: string;
    stage: number;
    kind: string;
    targetId: string;
    targetActionKey: string;
    suggestedActionKey: string | null;
  }> | null;
  /** 当时结构化 memory 摘要（storyMemory.recent 条目；AI 文案不入记忆）。 */
  memorySummary?: readonly Readonly<Record<string, unknown>>[];
  /** 当前场景焦点 NPC 的档案快照（id/name/role/description/knownFactIds）。 */
  npcProfile?: Readonly<Record<string, unknown>> | null;
  /** 焦点 NPC 的关系摘要（tier/affinity + 最近接触摘要，文本形式）。 */
  relationshipSummary?: string | null;
  fallback?: boolean;
  playerChoice?: { index: number; actionKey: string; reason: string };
  /**
   * 进入当前场景前已经发生的规则事件；只带稳定 ID
   * （factId/entityId/questId/endingId）。
   */
  newEvents?: readonly { type: string; factId?: string; entityId?: string; questId?: string; endingId?: string }[];
  /**
   * 当前场景所选 action 直接产生的规则事件；与 activeMainObjective/玩家选择
   * 同行，避免把下一幕才读到的 eventLedger 增量错配到当前目标。
   */
  actionEvents?: readonly { type: string; factId?: string; entityId?: string; questId?: string; endingId?: string }[];
  /** 编剧实际声明在场景叙事中使用的已授权事实 ID。 */
  usedFactIds?: readonly string[];
  /** NPC 演员实际声明在台词中使用的已授权事实 ID。 */
  npcUsedFactIds?: readonly string[];
  /** 结局行的稳定 ID 与玩家可见标题/描述；用于区分“收敛”与“可解释收敛”。 */
  endingId?: string;
  endingName?: string;
  endingDescription?: string;
  outcome?: string | null;
}>;

/** 单场景评审证据包（C1/C2 输入；字段不足时相应维度不得评分）。 */
export type StoryEvalEvidence = Readonly<{
  sceneIndex: number;
  previousScene: StoryEvalStoryRow | null;
  currentScene: StoryEvalStoryRow;
  npcProfile: Readonly<Record<string, unknown>> | null;
  relationshipSummary: string | null;
  memorySummary: readonly Readonly<Record<string, unknown>>[];
}>;

/** 产物完整性校验结果：complete=false 时 missing 列出缺失项，不可进入分析/评审。 */
export type StoryEvalCompleteness = Readonly<{
  complete: boolean;
  missing: readonly string[];
}>;

/** 需要安全 ID 的事件类型 → 对应字段。其余事件类型不要求 ID。 */
const EVENT_ID_FIELDS: Readonly<Record<string, "factId" | "entityId" | "questId" | "endingId">> = {
  fact_discovered: "factId",
  location_observed: "entityId",
  location_visited: "entityId",
  npc_met: "entityId",
  item_obtained: "entityId",
  quest_completed: "questId",
  quest_unlocked: "questId",
  quest_failed: "questId",
  battle_started: "entityId",
  battle_round_resolved: "entityId",
  battle_resolved: "entityId",
  enemy_defeated: "entityId",
  ending_reached: "endingId",
};

/**
 * 装配某场景的评审证据包（judge C1/C2 输入）：当前行 + 紧邻前序行 +
 * 该行已携带的 NPC profile / 关系摘要 / memory 摘要。
 * sceneIndex 不存在时抛错（调用方应先过完整性校验）。
 */
export function buildStoryEvalEvidence(
  story: readonly StoryEvalStoryRow[],
  _manifest: Readonly<Record<string, unknown>>,
  sceneIndex: number,
): StoryEvalEvidence {
  const currentScene = story.find((row) => row.sceneIndex === sceneIndex);
  if (currentScene === undefined) {
    throw new Error(`sceneIndex ${sceneIndex} not found in story`);
  }
  const previousScene = story.find((row) => row.sceneIndex === sceneIndex - 1) ?? null;
  return {
    sceneIndex,
    previousScene,
    currentScene,
    npcProfile: currentScene.npcProfile ?? null,
    relationshipSummary: currentScene.relationshipSummary ?? null,
    memorySummary: currentScene.memorySummary ?? [],
  };
}

/**
 * 产物完整性校验（spec §7：缺 calls/必要 manifest/S4 answer key 或任一场景
 * 评估字段时标为 incomplete，不可进入分析或评审）。missing 为去重后的
 * 缺失项列表；命中即 complete=false。
 */
export function validateStoryEvalArtifacts(input: {
  calls: readonly unknown[];
  story: readonly StoryEvalStoryRow[];
  manifest: Readonly<Record<string, unknown>>;
}): StoryEvalCompleteness {
  const missing: string[] = [];
  const push = (item: string) => {
    if (!missing.includes(item)) missing.push(item);
  };

  if (!Array.isArray(input.calls) || input.calls.length === 0) push("calls");
  if (!Array.isArray(input.story) || input.story.length === 0) push("story");

  const manifest = input.manifest;
  if (manifest === null || typeof manifest !== "object") {
    push("manifest");
  } else {
    const answerKey = manifest.answerKey;
    if (answerKey === null || typeof answerKey !== "object" || Object.keys(answerKey as object).length === 0) {
      push("answerKey");
    }
    if (typeof manifest.contractVersion !== "string" || manifest.contractVersion.length === 0) {
      push("contractVersion");
    }
    if (manifest.pairingVersion === "paired-v1") {
      if (typeof manifest.pairId !== "string" || manifest.pairId.trim() === "") push("pairId");
      if (typeof manifest.caseId !== "string" || manifest.caseId.trim() === "") push("caseId");
      if (typeof manifest.gameType !== "string" || manifest.gameType.trim() === "") push("gameType");
      if (typeof manifest.strategySeed !== "number" || !Number.isFinite(manifest.strategySeed)) push("strategySeed");
    }
    const versions = manifest.promptVersions;
    if (versions === null || typeof versions !== "object") {
      push("promptVersions");
    } else {
      for (const role of ["scenario", "director", "writer", "npc"]) {
        if (typeof (versions as Record<string, unknown>)[role] !== "string") push("promptVersions");
      }
    }
  }

  for (const row of input.story) {
    if (row.kind === "ending") {
      if (typeof row.outcome !== "string" || row.outcome.trim() === "") push("endingOutcome");
      if (typeof row.endingName !== "string" || row.endingName.trim() === "") push("endingName");
      if (typeof row.endingDescription !== "string" || row.endingDescription.trim() === "") push("endingDescription");
    }
    if (row.kind === "scene") {
      // 场景衔接证据：sceneIndex > 1 的场景必须有紧邻前序行（C2 前提）。
      if (row.sceneIndex > 1 && !input.story.some((entry) => entry.sceneIndex === row.sceneIndex - 1)) {
        push("previousScene");
      }
      // NPC 场景必须携带 C1 证据包：memory / profile / 关系摘要。
      if (row.npcLine !== undefined && row.npcLine !== null) {
        if (row.memorySummary === undefined || row.memorySummary === null) push("memory");
        if (row.npcProfile === undefined || row.npcProfile === null) push("npcProfile");
        if (row.relationshipSummary === undefined || row.relationshipSummary === null) push("relationship");
      }
    }
    // 规则事件必须携带其安全 ID（fact_discovered 缺 factId 即不完整）。
    for (const events of [row.newEvents ?? [], row.actionEvents ?? []]) {
      for (const event of events) {
        const field = EVENT_ID_FIELDS[event.type];
        if (field !== undefined && event[field] === undefined) push(`eventId:${event.type}`);
      }
    }
  }

  return { complete: missing.length === 0, missing };
}
