import { describe, it, expect } from "vitest";
import { parseV2ActionRequest, parseV2DialogueRequest, httpStatusForV2Code } from "./v2RequestParser";
import { PLAYER_UTTERANCE_MAX_LENGTH } from "@/game/domain/pendingNarrativeJob";

// ---------------------------------------------------------------------------
// Task 10：严格 API discriminated union 解析器。
// - 拒绝未知 kind、未知字段、空 token、空/超长 text、非法 targetNpcId、
//   负数/小数 revision；解析器只返回白名单 Interaction。
// ---------------------------------------------------------------------------

describe("parseV2ActionRequest — fixed_choice", () => {
  it("合法 fixed_choice：只含 kind + choiceToken", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.interaction).toEqual({ kind: "fixed_choice", choiceToken: "tok" });
      expect(r.actionId).toBe("a1");
      expect(r.expectedRevision).toBe(0);
    }
  });

  it("fixed_choice 拒绝空 token", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_INPUT");
  });

  it("fixed_choice 拒绝未知字段（如 text）", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok", text: "hack" } });
    expect(r.ok).toBe(false);
  });
});

describe("parseV2ActionRequest — free_text", () => {
  it("合法 free_text：kind + text + targetNpcId?", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.interaction).toEqual({ kind: "free_text", text: "我相信你", targetNpcId: "npc_1" });
    }
  });

  it("free_text 可省略 targetNpcId", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "free_text", text: "休息一下" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.interaction).toEqual({ kind: "free_text", text: "休息一下" });
  });

  it("free_text 拒绝空文本", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "free_text", text: "" } });
    expect(r.ok).toBe(false);
  });

  it("free_text 拒绝超长文本（引用统一常量）", () => {
    const tooLong = "田".repeat(PLAYER_UTTERANCE_MAX_LENGTH + 1);
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "free_text", text: tooLong } });
    expect(r.ok).toBe(false);
  });

  it("free_text 拒绝非法 targetNpcId（非字符串）", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "free_text", text: "嗨", targetNpcId: 123 } });
    expect(r.ok).toBe(false);
  });
});

describe("parseV2ActionRequest — 顶层字段", () => {
  it("拒绝未知 kind", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 0, interaction: { kind: "teleport" } });
    expect(r.ok).toBe(false);
  });

  it("拒绝负数 expectedRevision", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: -1, interaction: { kind: "fixed_choice", choiceToken: "tok" } });
    expect(r.ok).toBe(false);
  });

  it("拒绝小数 expectedRevision", () => {
    const r = parseV2ActionRequest({ actionId: "a1", expectedRevision: 1.5, interaction: { kind: "fixed_choice", choiceToken: "tok" } });
    expect(r.ok).toBe(false);
  });

  it("拒绝缺失 actionId / expectedRevision", () => {
    expect(parseV2ActionRequest({ expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok" } }).ok).toBe(false);
    expect(parseV2ActionRequest({ actionId: "a1", interaction: { kind: "fixed_choice", choiceToken: "tok" } }).ok).toBe(false);
  });

  it("拒绝非对象 body", () => {
    expect(parseV2ActionRequest(null).ok).toBe(false);
    expect(parseV2ActionRequest("x").ok).toBe(false);
  });
});

describe("httpStatusForV2Code — Spec §16.3 状态映射", () => {
  it("输入非法 → 400", () => expect(httpStatusForV2Code("INVALID_INPUT")).toBe(400));
  it("无活动存档 → 404", () => expect(httpStatusForV2Code("NO_ACTIVE_GAME")).toBe(404));
  it("stale revision → 409", () => expect(httpStatusForV2Code("STALE_GAME_REVISION")).toBe(409));
  it("业务拒绝/未知选项 → 422", () => {
    expect(httpStatusForV2Code("ACTION_REJECTED")).toBe(422);
    expect(httpStatusForV2Code("UNKNOWN_CHOICE")).toBe(422);
  });
  it("基础设施失败 → 503", () => expect(httpStatusForV2Code("INFRASTRUCTURE_FAILURE")).toBe(503));
  it("未知/损坏 → 500", () => expect(httpStatusForV2Code(undefined)).toBe(500));
});

describe("parseV2DialogueRequest", () => {
  it("合法 dialogue：npcId + text + expectedRevision", () => {
    const r = parseV2DialogueRequest({ npcId: "npc_1", text: "我相信你", expectedRevision: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.npcId).toBe("npc_1");
      expect(r.text).toBe("我相信你");
      expect(r.expectedRevision).toBe(0);
    }
  });

  it("拒绝空 npcId", () => {
    const r = parseV2DialogueRequest({ npcId: "", text: "嗨", expectedRevision: 0 });
    expect(r.ok).toBe(false);
  });

  it("拒绝空 text", () => {
    const r = parseV2DialogueRequest({ npcId: "npc_1", text: "", expectedRevision: 0 });
    expect(r.ok).toBe(false);
  });

  it("拒绝超长 text", () => {
    const tooLong = "田".repeat(PLAYER_UTTERANCE_MAX_LENGTH + 1);
    const r = parseV2DialogueRequest({ npcId: "npc_1", text: tooLong, expectedRevision: 0 });
    expect(r.ok).toBe(false);
  });

  it("拒绝负数/小数 expectedRevision", () => {
    expect(parseV2DialogueRequest({ npcId: "npc_1", text: "嗨", expectedRevision: -1 }).ok).toBe(false);
    expect(parseV2DialogueRequest({ npcId: "npc_1", text: "嗨", expectedRevision: 0.5 }).ok).toBe(false);
  });
});
