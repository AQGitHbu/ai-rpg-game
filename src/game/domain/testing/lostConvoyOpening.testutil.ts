import type { OpeningGenerationCandidate } from "../openingGenerationCandidate";
import { makeOpeningQualityCandidate } from "../openingSituation.testutil";

/** Minimal reproduction of publication-failure-review.json W2 / first wuxia planning call.
 * The convoy fact and player background come from call 89787ccb-eae1-414d-871e-26d8cd40858e.
 * A stranger innkeeper knows the public trade situation, not the player's lost convoy.
 */
export function makeLostConvoyOpening(): OpeningGenerationCandidate {
  const base = makeOpeningQualityCandidate();
  return {
    ...base,
    world: { summary: "镖局败落，失镖的镖师来到平安客栈。", tone: "克制", themes: ["失镖"], publicFacts: [
      { key: "he_shan_token", text: "被劫的镖车旁只留下一枚寒山派的青铜令牌，别无他物。" },
      { key: "guilds_falling", text: "城中镖局接连败落，长趟镖已少有人敢接。" },
      { key: "night_cart", text: "雨夜三更，客栈后巷有一辆车马不点灯出城。" },
    ] },
    player: { ...base.player, name: "沈孤鸿", identity: "落魄镖师",
      backgroundSummary: "这一趟押的镖半路被劫，唯一线索是他在现场拾得的一枚寒山派青铜令牌。",
      knownFactKeys: ["he_shan_token", "guilds_falling"] },
    prologue: "你押的镖半路被劫，来到平安客栈。",
    opening: { ...base.opening,
      location: { name: "平安客栈", description: "镖师落脚的客栈。", scale: "town" },
      npc: { ...base.opening.npc, name: "掌柜", role: "客栈掌柜", description: "素不相识的掌柜。",
        knownFactKeys: ["guilds_falling"], privateFactKeys: ["night_cart"] },
      situation: {
        history: [{ key: "lost_convoy", factKeys: ["he_shan_token"], participantRefs: ["player"], causeHistoryKeys: [] }],
        threads: [{ key: "guilds", questionFactKey: "guilds_falling", supportingFactKeys: [], participantRefs: ["opening_npc"], causeHistoryKeys: [] }],
        npcConnection: { familiarity: "stranger", stance: "neutral", basisHistoryKeys: [] },
        responses: [{ key: "ask_lead", dialogueAct: "ask", topic: { kind: "fact", key: "guilds_falling" } },
          { key: "challenge_lead", dialogueAct: "challenge", topic: { kind: "thread", key: "guilds" } }],
      },
    },
  };
}
