import { describe, expect, it } from "vitest";
import { handlePerformActionRequest } from "./actionHandler";
import type {
  PerformActionResult,
  GameSessionView,
  ActionFeedbackView
} from "@/game/application";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// Phase 3 Task 4：POST /api/game/actions HTTP adapter 测试。
// 覆盖 plan 要求：action 成功、拒绝无写入、陈旧 revision、非法 JSON/越权字段、
// 无存档、损坏存档以及不泄漏 SQL/state/seed。
// ---------------------------------------------------------------------------

/** 最小可用 view（结构完整即可，字段值不影响 HTTP 映射）。 */
const STUB_VIEW: GameSessionView = {
  gameId: "game-1" as never,
  world: { name: "测试世界", summary: "摘要", gameType: "wuxia" },
  player: { name: "测试角色", identity: "测试身份", stats: { hp: 30, attack: 6, defense: 4 } },
  currentLocation: { name: "地点A", description: "描述" },
  visibleNpcs: [{ name: "NPC1", role: "线人" }],
  initialItems: [],
  openingNarration: "开场叙事。",
  suggestedActions: ["观察周围"],
  generation: { generationId: "gen-1", templateVersion: "tpl-1" },
  revision: 0,
  availableActions: [
    { type: "observe", locationId: "loc_a", label: "观察地点A" }
  ],
  knownFacts: [],
  // Phase 4 Task 3：GameSessionView 新增字段（HTTP 映射不读内容）。
  presentNpcs: [],
  activeQuests: [],
  // Phase 5 Task 3：物品摘要字段（HTTP 映射同样不读内容）。
  obtainableItems: [],
  inventoryItems: [],
  // Phase 6 Task 3：战斗与结局摘要。
  battle: null,
  ending: null,
  storyEvents: [],
  // Phase 11 Task 7：本章进展里程碑（HTTP 映射不读内容）。
  storyContinuity: [],
  // Phase 7 Task 3：地图 / 地点场景 / 对话 read model（HTTP 映射同样不读内容）。
  worldMap: { nodes: [] },
  locationScene: { title: "地点A", description: "描述", backdrop: "location_backdrop", scale: "scene", interactions: [] },
  dialogues: [],
  // Town 层：默认非 town 地点（HTTP 映射不读内容）。
  townStatus: "none",
  // Phase 10：叙事场景视图。
  narrative: null,
  narrativeGeneration: { status: "ready" }
};

const STUB_FEEDBACK: ActionFeedbackView = { ok: true, message: "你观察了地点A。" };

/** 构造可注入的 fake entry points：performAction 返回可配置结果。 */
function fakeEntryPoints(result: PerformActionResult): Pick<ServerGameEntryPoints, "performAction"> {
  return {
    async performAction() {
      return result;
    }
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/game/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function parseBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("actionHandler：成功行动", () => {
  it("200 { view, feedback }", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(200);
    const body = await parseBody(response);
    expect(body["view"]).toEqual(STUB_VIEW);
    expect(body["feedback"]).toEqual(STUB_FEEDBACK);
  });
});

describe("actionHandler：规则拒绝", () => {
  it("200 { code: ACTION_REJECTED, view, feedback }", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      fakeEntryPoints({
        ok: false,
        code: "ACTION_REJECTED",
        view: STUB_VIEW,
        feedback: { ok: false, message: "你已经观察过这里了。" }
      })
    );
    expect(response.status).toBe(200);
    const body = await parseBody(response);
    expect(body["code"]).toBe("ACTION_REJECTED");
    expect(body["view"]).toEqual(STUB_VIEW);
    expect(body["feedback"]).toEqual({ ok: false, message: "你已经观察过这里了。" });
  });
});

describe("actionHandler：陈旧 revision", () => {
  it("409 { code: STALE_GAME_REVISION, view }", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      fakeEntryPoints({
        ok: false,
        code: "STALE_GAME_REVISION",
        view: { ...STUB_VIEW, revision: 5 }
      })
    );
    expect(response.status).toBe(409);
    const body = await parseBody(response);
    expect(body["code"]).toBe("STALE_GAME_REVISION");
    expect((body["view"] as GameSessionView).revision).toBe(5);
  });
});

describe("actionHandler：无存档/损坏/基础设施失败", () => {
  it("404 { code: NO_ACTIVE_GAME }", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      fakeEntryPoints({ ok: false, code: "NO_ACTIVE_GAME" })
    );
    expect(response.status).toBe(404);
    expect(await parseBody(response)).toEqual({ code: "NO_ACTIVE_GAME" });
  });

  it("500 { code: CORRUPT_GAME }", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      fakeEntryPoints({ ok: false, code: "CORRUPT_GAME" })
    );
    expect(response.status).toBe(500);
    expect(await parseBody(response)).toEqual({ code: "CORRUPT_GAME" });
  });

  it("503 { code: INFRASTRUCTURE_FAILURE }", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      fakeEntryPoints({ ok: false, code: "INFRASTRUCTURE_FAILURE" })
    );
    expect(response.status).toBe(503);
    expect(await parseBody(response)).toEqual({ code: "INFRASTRUCTURE_FAILURE" });
  });
});

describe("actionHandler：请求校验", () => {
  it("非法 JSON ⇒ 400 MALFORMED_JSON", async () => {
    const response = await handlePerformActionRequest(
      makeRequest("{broken json"),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect(await parseBody(response)).toEqual({ code: "MALFORMED_JSON" });
  });

  it("JSON 非对象 ⇒ 400 MALFORMED_JSON", async () => {
    const response = await handlePerformActionRequest(
      makeRequest([1, 2, 3]),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect(await parseBody(response)).toEqual({ code: "MALFORMED_JSON" });
  });

  it("越权字段（seed/state/gameId/freeText）⇒ 400 UNEXPECTED_FIELDS", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0,
        seed: "seed-xxx",
        gameId: "game-xxx",
        state: { foo: "bar" },
        freeText: "hello"
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    const body = await parseBody(response);
    expect(body["code"]).toBe("UNEXPECTED_FIELDS");
    expect(body["fields"]).toEqual(["freeText", "gameId", "seed", "state"]);
  });

  it("intent 内越权字段（actionLabel/freeText）⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a", actionLabel: "自定义", freeText: "hi" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    const body = await parseBody(response);
    expect(body["code"]).toBe("INVALID_INTENT");
  });

  it("intent.type 缺失 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { locationId: "loc_a" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    const body = await parseBody(response);
    expect(body["code"]).toBe("INVALID_INTENT");
  });

  it("intent.type 非法值 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "use_item", locationId: "loc_a" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
  });

  it("observe 缺少 locationId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "observe" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
  });

  it("talk 缺少 npcId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "talk" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
  });

  it("investigate 缺少 factId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "investigate" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
  });

  it("revision 缺失 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "observe", locationId: "loc_a" } }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
  });

  it("revision 非整数 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "observe", locationId: "loc_a" }, revision: 1.5 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
  });

  it("revision 负数 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "observe", locationId: "loc_a" }, revision: -1 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
  });
});

describe("actionHandler：move intent（Phase 4 Task 4）", () => {
  it("合法 move ⇒ 200，intent 与 revision 原样交给 performAction", async () => {
    let received: unknown;
    const entry: Pick<ServerGameEntryPoints, "performAction"> = {
      async performAction(command) {
        received = command;
        return { ok: true, view: STUB_VIEW, feedback: { ok: true, message: "你来到了地点B。" } };
      }
    };
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "move", locationId: "loc_b" }, revision: 3 }),
      entry
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      intent: { type: "move", locationId: "loc_b" },
      expectedRevision: 3
    });
  });

  it("move 缺少 locationId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "move" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("move locationId 非字符串 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "move", locationId: 42 }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("move 含 freeText 未知字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "move", locationId: "loc_b", freeText: "御剑飞过去" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });
});

describe("actionHandler：take_item intent（Phase 5 Task 3）", () => {
  it("合法 take_item ⇒ 200，intent 与 revision 原样交给 performAction", async () => {
    let received: unknown;
    const entry: Pick<ServerGameEntryPoints, "performAction"> = {
      async performAction(command) {
        received = command;
        return { ok: true, view: STUB_VIEW, feedback: { ok: true, message: "你取得了物品。" } };
      }
    };
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "take_item", itemId: "item_key" }, revision: 4 }),
      entry
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      intent: { type: "take_item", itemId: "item_key" },
      expectedRevision: 4
    });
  });

  it("take_item 缺少 itemId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "take_item" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("take_item itemId 为空字符串 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "take_item", itemId: "" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("take_item itemId 非字符串（数字伪造）⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "take_item", itemId: 42 }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("take_item itemId 为对象载荷 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "take_item", itemId: { id: "item_key" } }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("take_item 含 freeText 未知字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "take_item", itemId: "item_key", freeText: "把信物塑进袖口" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("take_item 附带伪造 locationId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "take_item", itemId: "item_key", locationId: "loc_hidden" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });
});

describe("actionHandler：既有 intent 携带多余目标字段 ⇒ 400（Phase 5 Task 5，T3-M1）", () => {
  // INTENT_TARGET_FIELD 白名单对既有 intent 同样生效：除 type + 本类型目标
  // 字段外，携带其他目标字段（伪造载荷）一律拒收。
  const cases: readonly { name: string; intent: Record<string, unknown> }[] = [
    { name: "observe 附带 npcId", intent: { type: "observe", locationId: "loc_a", npcId: "npc_1" } },
    { name: "talk 附带 locationId", intent: { type: "talk", npcId: "npc_1", locationId: "loc_a" } },
    { name: "investigate 附带 itemId", intent: { type: "investigate", factId: "fact_1", itemId: "item_key" } },
    { name: "move 附带 factId", intent: { type: "move", locationId: "loc_b", factId: "fact_1" } }
  ];

  for (const { name, intent } of cases) {
    it(`${name} ⇒ 400 INVALID_INTENT`, async () => {
      const response = await handlePerformActionRequest(
        makeRequest({ intent, revision: 0 }),
        fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
      );
      expect(response.status).toBe(400);
      expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
    });
  }
});

describe("actionHandler：不泄漏敏感信息", () => {
  it("成功响应 body 不含 SQL/seed/state/blueprint/inputDigest", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    const bodyJson = JSON.stringify(await parseBody(response));
    expect(bodyJson).not.toContain("seed");
    expect(bodyJson).not.toContain("inputDigest");
    expect(bodyJson).not.toContain("blueprint");
    expect(bodyJson).not.toContain("state_json");
    expect(bodyJson).not.toContain("contentBudget");
  });

  it("facade 契约外抛错 ⇒ 500 INTERNAL_ERROR，异常文本不外泄", async () => {
    const throwingEntry: Pick<ServerGameEntryPoints, "performAction"> = {
      async performAction() {
        throw new Error("libsql 驱动崩溃：connection refused at F:\\db\\rpg.sqlite");
      }
    };
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "observe", locationId: "loc_a" },
        revision: 0
      }),
      throwingEntry
    );
    expect(response.status).toBe(500);
    const body = await parseBody(response);
    expect(body).toEqual({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(body)).not.toContain("connection refused");
    expect(JSON.stringify(body)).not.toContain("libsql");
  });
});

// ---------------------------------------------------------------------------
// Phase 6 Task 3d：start_battle / battle_action intent 的 HTTP 白名单。
// 客户端只能提交 type + 对应字段；hp、damage、round、quest status、ending、
// state/freeText 等一律拒收。
// ---------------------------------------------------------------------------

describe("actionHandler：start_battle intent（Phase 6 Task 3d）", () => {
  it("合法 start_battle ⇒ 200，intent 与 revision 原样交给 performAction", async () => {
    let received: unknown;
    const entry: Pick<ServerGameEntryPoints, "performAction"> = {
      async performAction(command) {
        received = command;
        return { ok: true, view: STUB_VIEW, feedback: { ok: true, message: "战斗开始！" } };
      }
    };
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "start_battle", enemyId: "enemy_boss" }, revision: 7 }),
      entry
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      intent: { type: "start_battle", enemyId: "enemy_boss" },
      expectedRevision: 7
    });
  });

  it("start_battle 缺少 enemyId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "start_battle" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle enemyId 为空字符串 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "start_battle", enemyId: "" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle enemyId 非字符串（数字伪造）⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "start_battle", enemyId: 42 }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle 携带客户端伪造 hp 字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "start_battle", enemyId: "enemy_boss", hp: 999 },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle 携带 damage 字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "start_battle", enemyId: "enemy_boss", damage: 50 },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle 携带 round 字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "start_battle", enemyId: "enemy_boss", round: 3 },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle 携带 freeText 未知字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "start_battle", enemyId: "enemy_boss", freeText: "必胜！" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle 附带伪造 locationId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "start_battle", enemyId: "enemy_boss", locationId: "loc_hidden" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("start_battle 附带伪造 action 字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "start_battle", enemyId: "enemy_boss", action: "attack" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });
});

describe("actionHandler：battle_action intent（Phase 6 Task 3d）", () => {
  for (const action of ["attack", "guard", "withdraw"] as const) {
    it(`合法 battle_action ${action} ⇒ 200，intent 原样交给 performAction`, async () => {
      let received: unknown;
      const entry: Pick<ServerGameEntryPoints, "performAction"> = {
        async performAction(command) {
          received = command;
          return { ok: true, view: STUB_VIEW, feedback: { ok: true, message: `执行了 ${action}。` } };
        }
      };
      const response = await handlePerformActionRequest(
        makeRequest({ intent: { type: "battle_action", action }, revision: 5 }),
        entry
      );
      expect(response.status).toBe(200);
      expect(received).toEqual({
        intent: { type: "battle_action", action },
        expectedRevision: 5
      });
    });
  }

  it("battle_action 缺少 action ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "battle_action" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("battle_action action 为非法值（use_item）⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "battle_action", action: "use_item" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("battle_action action 非字符串（数字伪造）⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "battle_action", action: 1 }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("battle_action 携带客户端伪造 hp 字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "battle_action", action: "attack", hp: 100 },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("battle_action 携带 damage 字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "battle_action", action: "attack", damage: 30 },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("battle_action 携带 round 字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "battle_action", action: "guard", round: 5 },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("battle_action 携带 enemyId 伪造字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "battle_action", action: "attack", enemyId: "enemy_boss" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("battle_action 携带 freeText 未知字段 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({
        intent: { type: "battle_action", action: "withdraw", freeText: "撤退！" },
        revision: 0
      }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });
});

describe("actionHandler：Phase 14 dialogue_choice 废除 + ack_prologue 新增", () => {
  it("dialogue_choice 不再在白名单中 ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "dialogue_choice", npcId: "npc_1", choiceId: "npc_1:greet" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("合法 ack_prologue ⇒ 200，intent 与 revision 原样交给 performAction", async () => {
    let received: unknown;
    const entry: Pick<ServerGameEntryPoints, "performAction"> = {
      async performAction(command) {
        received = command;
        return { ok: true, view: STUB_VIEW, feedback: { ok: true, message: "" } };
      }
    };
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "ack_prologue" }, revision: 0 }),
      entry
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      intent: { type: "ack_prologue" },
      expectedRevision: 0
    });
  });

  it("ack_prologue 附带伪造 npcId ⇒ 400 INVALID_INTENT", async () => {
    const response = await handlePerformActionRequest(
      makeRequest({ intent: { type: "ack_prologue", npcId: "npc_1" }, revision: 0 }),
      fakeEntryPoints({ ok: true, view: STUB_VIEW, feedback: STUB_FEEDBACK })
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });
});
