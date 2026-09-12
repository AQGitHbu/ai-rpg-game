import { describe, expect, it } from "vitest";
import {
  createStoryContract,
  type EndingDirectionKey,
  type StoryContract,
} from "./storyContract";

describe("createStoryContract", () => {
  it("stores only abstract ending directions and act count", () => {
    const contract = createStoryContract({
      gameLength: "short",
      centralConflict: "旧案背后的盟约正在瓦解",
      endingThemes: { trust: "共同承担真相", doubt: "独自揭露真相" },
    });
    expect(contract.targetActs).toBe(3);
    expect(JSON.stringify(contract)).not.toMatch(/npc_|loc_|item_|enemy_|quest_/);
  });

  it("maps medium length to five acts", () => {
    const contract = createStoryContract({
      gameLength: "medium",
      centralConflict: "c",
      endingThemes: { trust: "t", doubt: "d" },
    });
    expect(contract.targetActs).toBe(5);
  });

  it("orders ending directions as trust then doubt with their themes", () => {
    const contract = createStoryContract({
      gameLength: "short",
      centralConflict: "c",
      endingThemes: { trust: "共同承担真相", doubt: "独自揭露真相" },
    });
    expect(contract.endingDirections).toEqual([
      { key: "trust", theme: "共同承担真相" },
      { key: "doubt", theme: "独自揭露真相" },
    ]);
    expect(contract.endingDirections.map((d) => d.key)).toEqual(["trust", "doubt"]);
  });

  it("fixes contract version at 1", () => {
    const contract = createStoryContract({
      gameLength: "short",
      centralConflict: "c",
      endingThemes: { trust: "t", doubt: "d" },
    });
    expect(contract.version).toBe(1);
  });

  it("exposes EndingDirectionKey covering trust and doubt", () => {
    const key: EndingDirectionKey = "doubt";
    expect(key).toBe("doubt");
  });

  it("types the factory result as StoryContract", () => {
    const contract: StoryContract = createStoryContract({
      gameLength: "medium",
      centralConflict: "c",
      endingThemes: { trust: "t", doubt: "d" },
    });
    expect(contract.targetActs).toBe(5);
  });

  it("keeps delivery references as local story keys", () => {
    const contract = createStoryContract({
      gameLength: "short",
      centralConflict: "c",
      endingThemes: { trust: "t", doubt: "d" },
      delivery: {
        itemKey: "sealed_letter",
        recipientKey: "ferry_contact",
        verificationFactKeys: ["fact_signature"],
      },
    });

    expect(contract.delivery).toEqual({
      itemKey: "sealed_letter",
      recipientKey: "ferry_contact",
      verificationFactKeys: ["fact_signature"],
    });
    expect(JSON.stringify(contract)).not.toMatch(/item_0|npc_0|fact_0/);
  });
});
