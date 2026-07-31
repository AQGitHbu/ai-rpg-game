import type { GameState, NpcId, ScenarioBlueprint } from "@/game/domain";

// ---------------------------------------------------------------------------
// 确定性 NPC 闲聊回应生成器（spec §5.3）。
// 纯函数、零 AI、零 IO、零随机；不写 state、不写 eventLedger。
// 与 composeNpcSpeech 并列，互不干扰。
// ---------------------------------------------------------------------------

const ROLE_TEMPLATES: Record<string, (name: string) => string> = {
  "铁匠": (name) => `${name}笑了笑，继续低头打铁。`,
  "学者": (name) => `${name}推了推眼镜，似乎没听清。`,
  "卫兵": (name) => `${name}握紧长矛，警惕地扫视四周。`,
  "商人": (name) => `${name}捋了捋胡须，没有回答。`,
  "村民": (name) => `${name}憨厚地笑了笑。`,
  "酒馆老板": (name) => `${name}擦了擦酒杯，继续忙活。`,
  "默认": (name) => `${name}沉吟片刻，没有接话。`,
};

function getRoleTemplate(role: string): (name: string) => string {
  return ROLE_TEMPLATES[role] ?? ROLE_TEMPLATES["默认"];
}

export function composeNpcCasualReply(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
  playerText: string,
): string {
  const npc = blueprint.npcs.find((n) => n.id === npcId);
  const npcState = state.npcs.find((n) => n.npcId === npcId);
  if (npc === undefined || npcState === undefined) return "";
  if (npcState.locationId !== state.currentLocationId) return "";

  const template = getRoleTemplate(npc.role);
  let reply = template(npc.name);

  const text = playerText.trim();
  if (text.endsWith("？") || text.endsWith("?")) {
    reply += "我也不太清楚。";
  }
  if (text.length < 4) {
    reply += "嗯？";
  }

  return reply;
}
