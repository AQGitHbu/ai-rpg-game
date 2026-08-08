import { describe, it, expect } from "vitest";
import { resolveLiveNpcLine } from "./v2SourceFactory";

const presentNpcs = [{ id: "npc_1" }, { id: "npc_2" }] as readonly { readonly id: unknown }[];

describe("resolveLiveNpcLine", () => {
  it("keeps a line whose npcId belongs to a present NPC", () => {
    const resolved = resolveLiveNpcLine({ npcId: "npc_2", text: "  有事吗？  ", emotion: "warm" }, presentNpcs);
    expect(resolved).not.toBeNull();
    expect(String(resolved!.npcId)).toBe("npc_2");
    expect(resolved!.text).toBe("有事吗？");
    expect(resolved!.emotion).toBe("warm");
  });

  it("rejects npcId not present in the location", () => {
    const resolved = resolveLiveNpcLine({ npcId: "npc_hallucinated", text: "你好。", emotion: "neutral" }, presentNpcs);
    expect(resolved).toBeNull();
  });

  it("rejects empty text and null candidate", () => {
    expect(resolveLiveNpcLine({ npcId: "npc_1", text: "   ", emotion: "neutral" }, presentNpcs)).toBeNull();
    expect(resolveLiveNpcLine(null, presentNpcs)).toBeNull();
  });

  it("normalizes invalid emotion to neutral", () => {
    const resolved = resolveLiveNpcLine({ npcId: "npc_1", text: "你好。", emotion: "furious" }, presentNpcs);
    expect(resolved?.emotion).toBe("neutral");
  });
});