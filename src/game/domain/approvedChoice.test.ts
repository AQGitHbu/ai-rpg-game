import { describe, expect, it } from "vitest";
import { asEnemyId, asItemId, asLocationId, asNpcId, asFactId } from "./worldEntity";
import type { Action } from "./action";
import {
  createApprovedChoice,
  deriveChoiceToken,
  semanticSummaryOf,
  type ApprovedChoice,
} from "./approvedChoice";

const TALK_ACTION = {
  type: "talk" as const,
  npcId: asNpcId("npc_blacksmith_01"),
  dialogueAct: "ask" as const,
};

const MOVE_ACTION = {
  type: "move" as const,
  locationId: asLocationId("loc_forest_02"),
};

describe("createApprovedChoice", () => {
  it("逐字段绑定 sceneId/basedOnRevision/label/action/semanticSummary", () => {
    const result = createApprovedChoice({
      sceneId: "scene-abc",
      basedOnRevision: 7,
      label: "问铁匠烟熏鱼的做法",
      action: TALK_ACTION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const choice = result.choice;
    expect(choice.sceneId).toBe("scene-abc");
    expect(choice.basedOnRevision).toBe(7);
    expect(choice.label).toBe("问铁匠烟熏鱼的做法");
    expect(choice.action).toEqual(TALK_ACTION);
    expect(choice.semanticSummary).toBe("talk:npc_blacksmith_01:ask:general");
    expect(choice.choiceToken).toBe(deriveChoiceToken({
      sceneId: "scene-abc",
      basedOnRevision: 7,
      action: TALK_ACTION,
    }));
  });

  it("action 被逐字段重建而非原引用", () => {
    const result = createApprovedChoice({
      sceneId: "scene-abc",
      basedOnRevision: 1,
      label: "询问",
      action: TALK_ACTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.action).not.toBe(TALK_ACTION);
  });

  it("空 label 拒绝", () => {
    const result = createApprovedChoice({
      sceneId: "scene-abc",
      basedOnRevision: 1,
      label: "   ",
      action: TALK_ACTION,
    });
    expect(result.ok).toBe(false);
  });

  it("negative basedOnRevision 拒绝", () => {
    const result = createApprovedChoice({
      sceneId: "scene-abc",
      basedOnRevision: -1,
      label: "询问",
      action: TALK_ACTION,
    });
    expect(result.ok).toBe(false);
  });
});

describe("deriveChoiceToken", () => {
  it("相同输入 → 相同 token（确定性）", () => {
    const a = deriveChoiceToken({ sceneId: "scene-abc", basedOnRevision: 7, action: TALK_ACTION });
    const b = deriveChoiceToken({ sceneId: "scene-abc", basedOnRevision: 7, action: TALK_ACTION });
    expect(a).toBe(b);
  });

  it("不同 action / sceneId / revision → 不同 token", () => {
    const base = { sceneId: "scene-abc", basedOnRevision: 7, action: TALK_ACTION };
    const tokens = new Set([
      deriveChoiceToken(base),
      deriveChoiceToken({ ...base, action: MOVE_ACTION }),
      deriveChoiceToken({ ...base, action: { ...TALK_ACTION, npcId: asNpcId("npc_innkeeper_02") } }),
      deriveChoiceToken({ ...base, sceneId: "scene-other" }),
      deriveChoiceToken({ ...base, basedOnRevision: 8 }),
    ]);
    expect(tokens.size).toBe(5);
  });

  it("token 是 opaque 十六进制串，不含 actionKey/NPC-ID/location-ID", () => {
    const token = deriveChoiceToken({
      sceneId: "scene-abc",
      basedOnRevision: 7,
      action: { type: "talk", npcId: asNpcId("npc_blacksmith_01"), dialogueAct: "ask" },
    });
    expect(token).toMatch(/^c_[0-9a-f]{16}$/);
    expect(token).not.toContain("talk");
    expect(token).not.toContain("move");
    expect(token).not.toContain("npc_blacksmith_01");
    expect(token).not.toContain("scene-abc");
  });

  it("另一类 action 的 token 也不泄露实体 ID", () => {
    const token = deriveChoiceToken({
      sceneId: "scene-def",
      basedOnRevision: 3,
      action: { type: "attack", enemyId: asEnemyId("enemy_goblin_chief") },
    });
    expect(token).not.toContain("enemy_goblin_chief");
    expect(token).not.toContain("attack");
  });
});

describe("semanticSummaryOf", () => {
  it("talk 摘要派生自 npc + act", () => {
    expect(semanticSummaryOf(TALK_ACTION)).toBe("talk:npc_blacksmith_01:ask:general");
    expect(semanticSummaryOf({ ...TALK_ACTION, dialogueAct: "threaten" as const }))
      .toBe("talk:npc_blacksmith_01:threaten:general");
  });

  it("同 fact 不同 approach 铸造不同 token 与语义摘要，缺省 approach 保持基础摘要", () => {
    const base = { sceneId: "scene-abc", basedOnRevision: 7 };
    const follow: Action = { type: "investigate", factId: asFactId("fact_trace"), approachId: "follow" };
    const search: Action = { type: "investigate", factId: asFactId("fact_trace"), approachId: "search" };
    const plain: Action = { type: "investigate", factId: asFactId("fact_trace") };
    const tokens = new Set([
      deriveChoiceToken({ ...base, action: follow }),
      deriveChoiceToken({ ...base, action: search }),
      deriveChoiceToken({ ...base, action: plain }),
    ]);
    expect(tokens.size).toBe(3);
    expect(semanticSummaryOf(follow)).toBe("investigate:fact_trace:follow");
    expect(semanticSummaryOf(search)).toBe("investigate:fact_trace:search");
    expect(semanticSummaryOf(plain)).toBe("investigate:fact_trace");
  });

  it("转义调查实体与方式中的分隔符，避免摘要或 token 发生拼接碰撞", () => {
    const colonA: Action = { type: "investigate", factId: asFactId("fact:a"), approachId: "b" };
    const colonB: Action = { type: "investigate", factId: asFactId("fact"), approachId: "a:b" };
    expect(semanticSummaryOf(colonA)).not.toBe(semanticSummaryOf(colonB));

    const pipeA: Action = { type: "investigate", factId: asFactId("fact"), approachId: "a|b" };
    const pipeB: Action = { type: "investigate", factId: asFactId("fact|a"), approachId: "b" };
    expect(deriveChoiceToken({ sceneId: "scene-abc", basedOnRevision: 7, action: pipeA }))
      .not.toBe(deriveChoiceToken({ sceneId: "scene-abc", basedOnRevision: 7, action: pipeB }));
  });

  it("同类无参行动摘要稳定且不同类互异", () => {
    const exploreA: ApprovedChoice["action"] = { type: "explore" };
    const exploreB: ApprovedChoice["action"] = { type: "explore" };
    expect(semanticSummaryOf(exploreA)).toBe(semanticSummaryOf(exploreB));
    expect(semanticSummaryOf({ type: "ack_prologue" })).toBe("ack_prologue");
  });

  it("带目标行动摘要包含稳定目标 ID", () => {
    expect(semanticSummaryOf(MOVE_ACTION)).toBe("move:loc_forest_02");
    expect(semanticSummaryOf({ type: "take_item", itemId: asItemId("item_rusty_key") }))
      .toBe("take_item:item_rusty_key");
    expect(semanticSummaryOf({ type: "attack", enemyId: asEnemyId("wolf_alpha") }))
      .toBe("attack:wolf_alpha");
  });
});

describe("registry 持久化往返", () => {
  it("JSON 序列化后 semantic 数据不变，token 可再次解析", () => {
    const choice = createApprovedChoice({
      sceneId: "scene-abc",
      basedOnRevision: 5,
      label: "攻击狼",
      action: { type: "attack", enemyId: asEnemyId("wolf_alpha") },
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;

    const registry: readonly ApprovedChoice[] = [choice.choice];
    const revived = JSON.parse(JSON.stringify(registry)) as readonly ApprovedChoice[];
    expect(revived).toEqual(registry);
    expect(revived[0].choiceToken).toBe(choice.choice.choiceToken);
    expect(revived[0].action).toEqual({ type: "attack", enemyId: "wolf_alpha" });
  });
});
