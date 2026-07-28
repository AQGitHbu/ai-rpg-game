/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleClearDevelopmentGameRequest } from "./developmentGameHandler";

describe("handleClearDevelopmentGameRequest", () => {
  it("生产环境不可通过直接请求绕过：返回 404 且不调用清档", async () => {
    const clearDevelopmentCurrentGame = vi.fn();
    const response = await handleClearDevelopmentGameRequest({
      developmentToolsEnabled: false,
      clearDevelopmentCurrentGame
    } as Pick<ServerGameEntryPoints, "developmentToolsEnabled" | "clearDevelopmentCurrentGame">);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND" });
    expect(clearDevelopmentCurrentGame).not.toHaveBeenCalled();
  });

  it("开发环境只返回清档状态，不泄漏存档内容", async () => {
    const response = await handleClearDevelopmentGameRequest({
      developmentToolsEnabled: true,
      clearDevelopmentCurrentGame: async () => "cleared"
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cleared" });
  });
});
