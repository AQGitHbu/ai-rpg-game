// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getServerGameEntryPoints, shouldCompleteSceneInAction } from "./compositionRoot";
import { asFactId } from "@/game/domain/worldEntity";
import type { Action } from "@/game/domain/action";

describe("getServerGameEntryPoints", () => {
  it("returns one process-wide entry point so route bundles share the narrative ensure lock", () => {
    const first = getServerGameEntryPoints();
    const second = getServerGameEntryPoints();

    expect(second).toBe(first);
  });
});

describe("shouldCompleteSceneInAction", () => {
  it.each([
    ["move", true],
    ["take_item", true],
    ["investigate", true],
    ["explore", false],
    ["talk", false],
    ["freeform", false],
    ["give_item", false],
    ["attack", false],
    ["battle_action", false],
    ["ack_prologue", false],
  ] as const)("returns %s=%s", (type, expected) => {
    expect(shouldCompleteSceneInAction({ type })).toBe(expected);
  });

  it("returns false when no action was submitted", () => {
    expect(shouldCompleteSceneInAction(undefined)).toBe(false);
  });

  it("investigate 携带服务端下发的 approachId 时同样在 action 请求内完成场景写回", () => {
    const approachInvestigate: Action = { type: "investigate", factId: asFactId("fact_trace"), approachId: "follow" };
    expect(shouldCompleteSceneInAction(approachInvestigate)).toBe(true);
  });
});
