import { describe, it, expect } from "vitest";
import { resolveLiveNpcLine, resolveSelectedChoiceProposals } from "./sourceFactory";

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

describe("resolveSelectedChoiceProposals", () => {
  const selectable = [
    { candidateId: "candidate_1", proposal: { label: "探索", action: { type: "explore" as const } } },
    { candidateId: "candidate_2", proposal: { label: "休息", action: { type: "rest" as const } } },
  ];

  it("只把两个不同的服务端 candidateId 映射为 Action 提案", () => {
    const resolved = resolveSelectedChoiceProposals(selectable, [
      { candidateId: "candidate_2", label: "稍作休息" },
      { candidateId: "candidate_1", label: "查看四周" },
    ]);
    expect(resolved).toEqual([
      { label: "稍作休息", action: { type: "rest" } },
      { label: "查看四周", action: { type: "explore" } },
    ]);
  });

  it("拒绝任意/重复 candidateId，不能用 actionKey 绕过候选", () => {
    expect(resolveSelectedChoiceProposals(selectable, [
      { candidateId: "invented", label: "作弊" },
      { candidateId: "candidate_1", label: "探索" },
    ])).toBeNull();
    expect(resolveSelectedChoiceProposals(selectable, [
      { candidateId: "candidate_1", label: "A" },
      { candidateId: "candidate_1", label: "B" },
    ])).toBeNull();
  });
});
