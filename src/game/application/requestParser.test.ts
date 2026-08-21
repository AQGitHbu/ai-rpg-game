import { describe, it, expect } from "vitest";
import { parseActionRequest, parseEnsureNarrativeBody, httpStatusForCode } from "./requestParser";
import { PLAYER_UTTERANCE_MAX_LENGTH } from "@/game/domain/pendingNarrativeJob";

const ACTION_ID = "11111111-1111-4111-8111-111111111111";

describe("parseEnsureNarrativeBody", () => {
  it("accepts polling and explicit retry bodies", () => {
    expect(parseEnsureNarrativeBody({})).toEqual({ ok: true });
    expect(parseEnsureNarrativeBody({ retry: true })).toEqual({ ok: true, retry: true });
  });

  it.each([null, [], { retry: false }, { retry: "true" }, { retry: true, extra: 1 }, { unknown: true }])(
    "rejects non-canonical body %#",
    (body) => expect(parseEnsureNarrativeBody(body)).toEqual({ ok: false, code: "INVALID_INPUT" }),
  );
});

// ---------------------------------------------------------------------------
// Task 10：严格 API discriminated union 解析器。
// - 拒绝未知 kind、未知字段、空 token、空/超长 text、非法 targetNpcId、
//   负数/小数 revision；解析器只返回白名单 Interaction。
// ---------------------------------------------------------------------------

describe("parseActionRequest — fixed_choice", () => {
  it("合法 fixed_choice：只含 kind + choiceToken", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.interaction).toEqual({ kind: "fixed_choice", choiceToken: "tok" });
      expect(r.actionId).toBe(ACTION_ID);
      expect(r.expectedRevision).toBe(0);
    }
  });

  it("fixed_choice 拒绝空 token", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_INPUT");
  });

  it("fixed_choice 拒绝未知字段（如 text）", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok", text: "hack" } });
    expect(r.ok).toBe(false);
  });
});

describe("parseActionRequest — free_text", () => {
  it("合法 free_text：kind + text + targetNpcId", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.interaction).toEqual({ kind: "free_text", text: "我相信你", targetNpcId: "npc_1" });
    }
  });

  it("free_text 必须提供 targetNpcId", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: "我想说点什么" } });
    expect(r.ok).toBe(false);
  });

  it("free_text 拒绝空文本", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: "", targetNpcId: "npc_1" } });
    expect(r.ok).toBe(false);
  });

  it("free_text 拒绝超长文本（引用统一常量）", () => {
    const tooLong = "田".repeat(PLAYER_UTTERANCE_MAX_LENGTH + 1);
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: tooLong, targetNpcId: "npc_1" } });
    expect(r.ok).toBe(false);
  });

  it("free_text 拒绝非法 targetNpcId（非字符串）", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: "嗨", targetNpcId: 123 } });
    expect(r.ok).toBe(false);
  });
});

describe("parseActionRequest — 顶层字段", () => {
  it("拒绝未知 kind", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "teleport" } });
    expect(r.ok).toBe(false);
  });

  it("拒绝负数 expectedRevision", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: -1, interaction: { kind: "fixed_choice", choiceToken: "tok" } });
    expect(r.ok).toBe(false);
  });

  it("拒绝小数 expectedRevision", () => {
    const r = parseActionRequest({ actionId: ACTION_ID, expectedRevision: 1.5, interaction: { kind: "fixed_choice", choiceToken: "tok" } });
    expect(r.ok).toBe(false);
  });

  it("拒绝缺失 actionId / expectedRevision", () => {
    expect(parseActionRequest({ expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok" } }).ok).toBe(false);
    expect(parseActionRequest({ actionId: ACTION_ID, interaction: { kind: "fixed_choice", choiceToken: "tok" } }).ok).toBe(false);
  });

  it("拒绝非 UUID actionId", () => {
    expect(parseActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok" } }).ok).toBe(false);
  });

  it("拒绝非对象 body", () => {
    expect(parseActionRequest(null).ok).toBe(false);
    expect(parseActionRequest("x").ok).toBe(false);
  });
});

describe("httpStatusForCode — Spec §16.3 状态映射", () => {
  it("输入非法 → 400", () => expect(httpStatusForCode("INVALID_INPUT")).toBe(400));
  it("无活动存档 → 404", () => expect(httpStatusForCode("NO_ACTIVE_GAME")).toBe(404));
  it("stale revision → 409", () => expect(httpStatusForCode("STALE_GAME_REVISION")).toBe(409));
  it("业务拒绝/未知选项 → 422", () => {
    expect(httpStatusForCode("ACTION_REJECTED")).toBe(422);
    expect(httpStatusForCode("UNKNOWN_CHOICE")).toBe(422);
  });
  it("基础设施失败 → 503", () => expect(httpStatusForCode("INFRASTRUCTURE_FAILURE")).toBe(503));
  it("未知/损坏 → 500", () => expect(httpStatusForCode(undefined)).toBe(500));
});
