import { describe, expect, it } from "vitest";
import { parseWorldDeltaProposal } from "./worldDeltaProposal";

const minimalLocation = {
  beatSummary: "官道尽头出现一座废弃驿站。",
  newLocation: {
    name: "北岭废驿",
    description: "官道旁荒废多年的驿站，梁柱上还挂着半幅旧幡。",
    scale: "scene",
    placement: "world",
    connectFromLocationId: "loc_0",
  },
};

describe("parseWorldDeltaProposal", () => {
  it("parses a location-only proposal", () => {
    const result = parseWorldDeltaProposal(minimalLocation);
    expect(result).not.toBeNull();
    expect(result?.proposal.newLocation?.name).toBe("北岭废驿");
  });

  it("rejects unknown keys", () => {
    expect(parseWorldDeltaProposal({ ...minimalLocation, hidden: "leak" })).toBeNull();
  });

  it("rejects a missing beat summary", () => {
    expect(parseWorldDeltaProposal({ newLocation: minimalLocation.newLocation })).toBeNull();
  });

  it("rejects an empty beat summary", () => {
    expect(parseWorldDeltaProposal({ ...minimalLocation, beatSummary: "   " })).toBeNull();
  });

  it("rejects a proposal with no concrete increment", () => {
    expect(parseWorldDeltaProposal({ beatSummary: "什么也没有发生。" })).toBeNull();
  });

  it("rejects an unsupported placement", () => {
    expect(
      parseWorldDeltaProposal({
        ...minimalLocation,
        newLocation: { ...minimalLocation.newLocation, placement: "basement" },
      }),
    ).toBeNull();
  });

  it("rejects a location without a connection target", () => {
    expect(
      parseWorldDeltaProposal({
        ...minimalLocation,
        newLocation: { ...minimalLocation.newLocation, connectFromLocationId: "  " },
      }),
    ).toBeNull();
  });

  it("rejects a non-object input", () => {
    expect(parseWorldDeltaProposal("leak")).toBeNull();
    expect(parseWorldDeltaProposal(null)).toBeNull();
    expect(parseWorldDeltaProposal([])).toBeNull();
  });
});
