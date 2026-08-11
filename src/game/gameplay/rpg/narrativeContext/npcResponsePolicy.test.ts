import { describe, it, expect } from "vitest";
import { createNpcResponsePolicy, selectAllowedDisclosureFactIds } from "./npcResponsePolicy";
import type { NpcResponsePolicy } from "./npcResponsePolicy";
import { asFactId } from "@/game/domain/worldEntity";

// Task 5 Step 1：关系档位 → NPC 回应政策（tone/initiative/披露边界）。
// 纯函数：零 AI/IO/随机；同一 tier 恒定映射。

const KNOWN = asFactId("fact_known");
const PRIVATE = asFactId("fact_private");

describe("createNpcResponsePolicy — 档位映射", () => {
  it("hostile 是简短冷淡的拒绝式（initiative refuse）", () => {
    const policy = createNpcResponsePolicy({ tier: "hostile", allowedDisclosureFactIds: [], privateKnowledgeIds: [] });
    expect(policy.initiative).toBe("refuse");
    expect(policy.toneInstruction).toMatch(/简短|冷淡|拒绝/);
  });

  it("cold 是谨慎防备的守卫式（initiative guarded）", () => {
    const policy = createNpcResponsePolicy({ tier: "cold", allowedDisclosureFactIds: [], privateKnowledgeIds: [] });
    expect(policy.initiative).toBe("guarded");
    expect(policy.toneInstruction).toMatch(/谨慎|防备/);
  });

  it("neutral 是就事论事的被动回应（initiative reactive、tone 就事论事）", () => {
    const policy = createNpcResponsePolicy({ tier: "neutral", allowedDisclosureFactIds: [], privateKnowledgeIds: [] });
    expect(policy.initiative).toBe("reactive");
    expect(policy.toneInstruction).toMatch(/就事论事/);
  });

  it("friendly 是温和主动帮忙（initiative helpful、tone 温和）", () => {
    const policy = createNpcResponsePolicy({ tier: "friendly", allowedDisclosureFactIds: [], privateKnowledgeIds: [] });
    expect(policy.initiative).toBe("helpful");
    expect(policy.toneInstruction).toMatch(/温和|帮忙/);
  });

  it("trusted 是坦诚主动（initiative proactive、tone 坦诚）", () => {
    const policy = createNpcResponsePolicy({ tier: "trusted", allowedDisclosureFactIds: [], privateKnowledgeIds: [] });
    expect(policy.initiative).toBe("proactive");
    expect(policy.toneInstruction).toMatch(/坦诚|主动/);
  });

  it("保留服务端给定的披露/私密 ID 集合", () => {
    const policy: NpcResponsePolicy = createNpcResponsePolicy({
      tier: "friendly",
      allowedDisclosureFactIds: [KNOWN],
      privateKnowledgeIds: [PRIVATE],
    });
    expect(policy.allowedDisclosureFactIds).toEqual([KNOWN]);
    expect(policy.privateKnowledgeIds).toEqual([PRIVATE]);
  });

  it("五个档位的 initiative 两两不同", () => {
    const initiatives = (["hostile", "cold", "neutral", "friendly", "trusted"] as const).map((tier) =>
      createNpcResponsePolicy({ tier, allowedDisclosureFactIds: [], privateKnowledgeIds: [] }).initiative);
    expect(new Set(initiatives).size).toBe(5);
  });
});

describe("selectAllowedDisclosureFactIds — 规则拥有的披露集合", () => {
  it("hostile/cold 档位基线坦诚度不足 → 不授权披露任何已知事实", () => {
    for (const tier of ["hostile", "cold"] as const) {
      const allowed = selectAllowedDisclosureFactIds({ tier, knownFactIds: [KNOWN], hiddenFactIds: [] });
      expect(allowed).toEqual([]);
    }
  });

  it("neutral/friendly/trusted 授权披露已知且非私密的事实", () => {
    for (const tier of ["neutral", "friendly", "trusted"] as const) {
      const allowed = selectAllowedDisclosureFactIds({ tier, knownFactIds: [KNOWN], hiddenFactIds: [] });
      expect(allowed).toEqual([KNOWN]);
    }
  });

  it("私密（hidden）事实永远不在披露集合内，即使档位坦诚", () => {
    const allowed = selectAllowedDisclosureFactIds({ tier: "trusted", knownFactIds: [KNOWN, PRIVATE], hiddenFactIds: [PRIVATE] });
    expect(allowed).toEqual([KNOWN]);
    expect(allowed).not.toContain(PRIVATE);
  });
});
