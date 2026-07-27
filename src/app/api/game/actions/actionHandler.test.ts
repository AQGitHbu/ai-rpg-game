import { describe, expect, it } from "vitest";
import { handlePerformActionRequest } from "./actionHandler";
import type {
  PerformActionResult,
  OpeningGameView,
  ActionFeedbackView
} from "@/game/application";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// Phase 3 Task 4：POST /api/game/actions HTTP adapter 测试。
// 覆盖 plan 要求：action 成功、拒绝无写入、陈旧 revision、非法 JSON/越权字段、
// 无存档、损坏存档以及不泄漏 SQL/state/seed。
// ---------------------------------------------------------------------------

/** 最小可用 view（结构完整即可，字段值不影响 HTTP 映射）。 */
const STUB_VIEW: OpeningGameView = {
  gameId: "game-1" as never,
  world: { name: "测试世界", summary: "摘要", gameType: "wuxia" },
  player: { name: "测试角色", identity: "测试身份" },
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
  knownFacts: []
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
    expect((body["view"] as OpeningGameView).revision).toBe(5);
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
      makeRequest({ intent: { type: "move", locationId: "loc_a" }, revision: 0 }),
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
