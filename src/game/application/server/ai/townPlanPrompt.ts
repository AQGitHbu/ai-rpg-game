import type { AiMessage } from "@ai-game/ai-transport";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanRequest } from "../../townPlanGeneration";

// ---------------------------------------------------------------------------
// Town 层：town-plan-v1 prompt 构建（prompt-only JSON，provider 不支持
// guided grammar）。封闭词汇表全部写入 system 指令；AI 永不接触坐标——
// 输出只有语义规划，几何由 generateTown 编译。上下文只含地点/NPC/世界
// 基调的公开语义信息：不含 seed、traceId、蓝图其余部分或任何密钥。
// ---------------------------------------------------------------------------

const TOWN_PLAN_INSTRUCTION = [
  "You are a town planner for an RPG. Return one JSON object only: no markdown, no explanation, no extra keys.",
  "Exact shape: {\"theme\":\"short string in the world's language\",\"gridSize\":{\"width\":24-40,\"height\":24-40},\"terrain\":{\"river\":\"north|south|none\",\"externalRoad\":\"east_west|north_south\"},\"districts\":[{\"type\":\"market|residential|craft|reserved\",\"preferredArea\":\"center|north|south|east|west|edge\",\"weight\":positive integer}],\"requiredBuildings\":[{\"key\":\"string\",\"buildingType\":\"tavern|blacksmith|house|shop|workshop|warehouse|well|gatehouse\",\"preferredDistrict\":\"market|residential|craft|reserved\",\"displayName\":\"short name\"}],\"landmarks\":[{\"type\":\"well\",\"preferredArea\":\"center|north|south|east|west|edge\"}]}.",
  "For every entry in npcs you MUST include one requiredBuildings entry whose key is exactly story_npc_<npc id>; choose a buildingType that fits the npc role and give it a fitting displayName.",
  "Keep requiredBuildings at 8 entries or fewer. Never output coordinates, positions or grid cells. Never invent an npc id.",
].join(" ");

/** 构建 town-plan-v1 的 prompt 消息：system 指令 + 最小语义上下文。 */
export function buildTownPlanPromptMessages(request: TownPlanRequest): readonly AiMessage[] {
  const context = {
    locationName: request.locationName,
    locationDescription: request.locationDescription,
    locationTags: request.locationTags,
    npcs: request.npcs,
    worldTone: request.worldTone,
    worldThemes: request.worldThemes
  };
  return [
    { role: "system", content: `${TOWN_PLAN_INSTRUCTION} Contract: ${TOWN_PLAN_CONTRACT_VERSION}.` },
    { role: "user", content: JSON.stringify(context) }
  ];
}
