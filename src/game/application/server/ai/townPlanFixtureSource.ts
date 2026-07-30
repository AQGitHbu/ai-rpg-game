import {
  TOWN_PLAN_CONTRACT_VERSION,
  type TownPlanAttempt,
  type TownPlanCandidateSource,
  type TownPlanRequest
} from "../../townPlanGeneration";

// ---------------------------------------------------------------------------
// Town 层：town plan fixture source——离线测试与无 AI 环境的确定性通道。
// 候选完全由请求语义派生（剧情 NPC 全覆盖，key = story_npc_<id>），
// 必然通过 validateTownPlanCandidate；不涉及任何 provider 调用。
// ---------------------------------------------------------------------------

/** 由请求确定性派生候选：同请求 ⇒ 深度相等的候选。 */
export function buildTownPlanFixtureCandidate(request: TownPlanRequest): Record<string, unknown> {
  return {
    theme: `${request.locationName}（fixture 规划）`,
    gridSize: { width: 32, height: 32 },
    terrain: { river: "none", externalRoad: "east_west" },
    districts: [
      { type: "market", preferredArea: "center", weight: 3 },
      { type: "residential", preferredArea: "south", weight: 2 },
      { type: "craft", preferredArea: "east", weight: 2 },
      { type: "reserved", preferredArea: "edge", weight: 1 }
    ],
    requiredBuildings: request.npcs.map((npc) => ({
      key: `story_npc_${npc.id}`,
      buildingType: "house",
      preferredDistrict: "residential",
      displayName: `${npc.name}的居所`
    })),
    landmarks: [{ type: "well", preferredArea: "center" }]
  };
}

/** 创建 fixture source：永远成功，origin = "fixture"。 */
export function createTownPlanFixtureSource(): TownPlanCandidateSource {
  return {
    async generate(request: TownPlanRequest): Promise<TownPlanAttempt> {
      return {
        ok: true,
        contractVersion: TOWN_PLAN_CONTRACT_VERSION,
        origin: "fixture",
        candidate: buildTownPlanFixtureCandidate(request),
        diagnostics: []
      };
    }
  };
}
