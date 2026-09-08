import type { OpeningGenerationCandidate } from "./openingGenerationCandidate";

export function makeOpeningQualityCandidate(): OpeningGenerationCandidate {
  return {
    world: { summary: "浮港依靠旧式动力机维持航道，船厂正在安排维修。", tone: "克制", themes: ["责任", "生计"], publicFacts: [
      { key: "fact_past", text: "主角过去曾与船厂技师共同维修引擎。" },
      { key: "fact_request", text: "技师希望先停机检查，船厂却急于恢复作业。" },
      { key: "fact_records", text: "维修记录可以在现场核对。" },
      { key: "fact_secret", text: "技师私自隐去了上次维修失误。" },
    ] },
    player: { name: "沈砚", identity: "返乡的修理师", backgroundSummary: "曾在船厂修理引擎。", baseStats: { hp: 100, attack: 10, defense: 5 } },
    prologue: "你重返浮港，旧日同事正为停机检查与恢复作业的争执发愁。",
    storyContract: { version: 1, targetActs: 3, centralConflict: "如何兼顾维修安全与船厂生计", endingDirections: [{ key: "trust", theme: "共同承担责任" }, { key: "doubt", theme: "保留独立判断" }] },
    opening: {
      location: { name: "浮港", description: "航道边的船厂聚落。", buildingName: "维修棚", scale: "town" },
      npc: { name: "林舟", role: "船厂技师", description: "你的旧日同事，担心仓促开机会伤人。", knownFactKeys: ["fact_past", "fact_request", "fact_records"], privateFactKeys: ["fact_secret"], anchors: { selfConcept: "对维修负责的技师", values: ["安全"], speechStyle: "直说顾虑", capabilityBoundaries: ["无权独自停掉整个船厂"], taboos: [] }, goals: [{ horizon: "short", description: "争取停机检查", priority: 3, reason: "担心仓促开机" }] },
      quest: { name: "回应停机请求", description: "与林舟商量如何处理眼前分歧。", objective: { kind: "talk_to_opening_npc" } },
      situation: {
        history: [{ key: "worked_together", factKeys: ["fact_past"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] }],
        threads: [{ key: "shutdown", questionFactKey: "fact_request", supportingFactKeys: ["fact_records", "fact_secret"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: ["worked_together"] }],
        npcConnection: { familiarity: "known", stance: "neutral", basisHistoryKeys: ["worked_together"] },
        responses: [{ key: "ask_records", dialogueAct: "ask", topic: { kind: "fact", key: "fact_records" } }, { key: "refuse_shutdown", dialogueAct: "refuse", topic: { kind: "thread", key: "shutdown" } }],
      },
    },
  };
}
