import { describe, expect, it } from "vitest";
import { handleNpcDialogueRequest } from "./dialogueHandler";
import type { GameSessionView, HandleNpcDialogueResult } from "@/game/application";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// POST /api/game/npc/dialogue HTTP adapter 测试。
// 薄壳纪律：只做参数解析→调 use case→状态码映射，零业务逻辑；
// 白名单外字段拒收；响应不泄漏 SQL/state/seed/异常文本。
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
  presentNpcs: [],
  activeQuests: [],
  obtainableItems: [],
  inventoryItems: [],
  battle: null,
  ending: null,
  storyEvents: [],
  storyContinuity: [],
  worldMap: { nodes: [] },
  locationScene: { title: "地点A", description: "描述", backdrop: "location_backdrop", scale: "scene", interactions: [] },
  dialogues: [],
  townStatus: "none",
  narrative: null,
  narrativeGeneration: { status: "ready" }
};

/** 构造可注入的 fake entry points：handleNpcDialogue 返回可配置结果。 */
function fakeEntryPoints(result: HandleNpcDialogueResult): Pick<ServerGameEntryPoints, "handleNpcDialogue"> {
  return {
    async handleNpcDialogue() {
      return result;
    }
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/game/npc/dialogue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function parseBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const VALID_BODY = { npcId: "npc_1", text: "今天天气真不错啊", revision: 0 };

describe("dialogueHandler：闲聊回应", () => {
  it("200 { kind: chat, npcSpeech, view }", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest(VALID_BODY),
      fakeEntryPoints({ ok: true, kind: "chat", npcSpeech: "铁匠笑了笑，继续低头打铁。", view: STUB_VIEW })
    );
    expect(response.status).toBe(200);
    const body = await parseBody(response);
    expect(body["kind"]).toBe("chat");
    expect(body["npcSpeech"]).toBe("铁匠笑了笑，继续低头打铁。");
    expect(body["view"]).toEqual(STUB_VIEW);
  });
});

describe("dialogueHandler：叙事触发", () => {
  it("200 { kind: narrative_trigger, view }", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest({ ...VALID_BODY, text: "我想去废弃矿坑" }),
      fakeEntryPoints({ ok: true, kind: "narrative_trigger", view: STUB_VIEW })
    );
    expect(response.status).toBe(200);
    const body = await parseBody(response);
    expect(body["kind"]).toBe("narrative_trigger");
    expect(body["view"]).toEqual(STUB_VIEW);
    expect(body["npcSpeech"]).toBeUndefined();
  });
});

describe("dialogueHandler：规则拒绝", () => {
  it("200 { code: ACTION_REJECTED, view, feedback }", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest(VALID_BODY),
      fakeEntryPoints({
        ok: false,
        code: "ACTION_REJECTED",
        view: STUB_VIEW,
        feedback: { ok: false, message: "正在编排下一幕，请稍候。" }
      })
    );
    expect(response.status).toBe(200);
    const body = await parseBody(response);
    expect(body["code"]).toBe("ACTION_REJECTED");
    expect(body["view"]).toEqual(STUB_VIEW);
    expect(body["feedback"]).toEqual({ ok: false, message: "正在编排下一幕，请稍候。" });
  });
});

describe("dialogueHandler：陈旧 revision", () => {
  it("409 { code: STALE_GAME_REVISION, view }", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest(VALID_BODY),
      fakeEntryPoints({ ok: false, code: "STALE_GAME_REVISION", view: STUB_VIEW })
    );
    expect(response.status).toBe(409);
    const body = await parseBody(response);
    expect(body["code"]).toBe("STALE_GAME_REVISION");
    expect(body["view"]).toEqual(STUB_VIEW);
  });
});

describe("dialogueHandler：无存档 / 损坏 / 基础设施失败", () => {
  it("404 { code: NO_ACTIVE_GAME }", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest(VALID_BODY),
      fakeEntryPoints({ ok: false, code: "NO_ACTIVE_GAME" })
    );
    expect(response.status).toBe(404);
    expect((await parseBody(response))["code"]).toBe("NO_ACTIVE_GAME");
  });

  it("500 { code: CORRUPT_GAME }", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest(VALID_BODY),
      fakeEntryPoints({ ok: false, code: "CORRUPT_GAME" })
    );
    expect(response.status).toBe(500);
    expect((await parseBody(response))["code"]).toBe("CORRUPT_GAME");
  });

  it("503 { code: INFRASTRUCTURE_FAILURE }", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest(VALID_BODY),
      fakeEntryPoints({ ok: false, code: "INFRASTRUCTURE_FAILURE" })
    );
    expect(response.status).toBe(503);
    expect((await parseBody(response))["code"]).toBe("INFRASTRUCTURE_FAILURE");
  });
});

describe("dialogueHandler：请求体校验", () => {
  const rejectingEntryPoints: Pick<ServerGameEntryPoints, "handleNpcDialogue"> = {
    async handleNpcDialogue() {
      throw new Error("校验失败时不得调用 use case");
    }
  };

  it("400 { code: MALFORMED_JSON }：非法 JSON", async () => {
    const response = await handleNpcDialogueRequest(makeRequest("{bad json"), rejectingEntryPoints);
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("MALFORMED_JSON");
  });

  it("400 { code: UNEXPECTED_FIELDS }：白名单外字段拒收", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest({ ...VALID_BODY, seed: "hack", state: {} }),
      rejectingEntryPoints
    );
    expect(response.status).toBe(400);
    const body = await parseBody(response);
    expect(body["code"]).toBe("UNEXPECTED_FIELDS");
    expect(body["fields"]).toEqual(["seed", "state"]);
  });

  it("400 { code: INVALID_INTENT }：npcId 缺失或非字符串", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest({ text: "你好呀朋友", revision: 0 }),
      rejectingEntryPoints
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("400 { code: INVALID_INTENT }：text 为空白", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest({ npcId: "npc_1", text: "   ", revision: 0 }),
      rejectingEntryPoints
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("400 { code: INVALID_INTENT }：revision 非法", async () => {
    const response = await handleNpcDialogueRequest(
      makeRequest({ npcId: "npc_1", text: "你好呀朋友", revision: -1 }),
      rejectingEntryPoints
    );
    expect(response.status).toBe(400);
    expect((await parseBody(response))["code"]).toBe("INVALID_INTENT");
  });

  it("500 { code: INTERNAL_ERROR }：use case 契约外抛错兜底", async () => {
    const response = await handleNpcDialogueRequest(makeRequest(VALID_BODY), rejectingEntryPoints);
    expect(response.status).toBe(500);
    expect((await parseBody(response))["code"]).toBe("INTERNAL_ERROR");
  });
});
