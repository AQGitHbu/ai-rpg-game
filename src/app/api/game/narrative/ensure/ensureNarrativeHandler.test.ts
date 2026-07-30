import { describe, expect, it } from "vitest";
import { handleEnsureNarrativeRequest } from "./ensureNarrativeHandler";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

function entryPoints(result: "queued" | "already_running" | "not_pending" | "unavailable"):
  Pick<ServerGameEntryPoints, "ensureNarrativeGeneration"> {
  return { async ensureNarrativeGeneration() { return result; } };
}

describe("handleEnsureNarrativeRequest", () => {
  it.each([
    ["queued", 202, "pending"],
    ["already_running", 202, "pending"],
    ["not_pending", 200, "ready"],
    ["unavailable", 503, "unavailable"],
  ] as const)("%s maps to HTTP %i", async (result, status, bodyStatus) => {
    const response = await handleEnsureNarrativeRequest(entryPoints(result));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ status: bodyStatus });
  });

  it("does not leak an unexpected server error", async () => {
    const response = await handleEnsureNarrativeRequest({
      async ensureNarrativeGeneration() { throw new Error("provider credential leaked"); },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
