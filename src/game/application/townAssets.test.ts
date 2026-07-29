import { describe, expect, it } from "vitest";
import {
  TOWN_ASSET_CONTRACT_VERSION,
  createUnavailableTownIllustrationSource,
  type TownAssetKind,
  type TownAssetRequest
} from "./townAssets";

// Task 7：预留生图 port。用户硬约束——不接入任何 AI 生图，
// 生产实现恒返回 not_requested，且不得携带 assetUrl。
describe("townAssets 预留生图 port", () => {
  it("契约版本钉死为 town-assets-v0", () => {
    expect(TOWN_ASSET_CONTRACT_VERSION).toBe("town-assets-v0");
  });

  it("unavailable source 对任意请求恒返回 not_requested 且不含 assetUrl", async () => {
    const source = createUnavailableTownIllustrationSource();
    const kinds: readonly TownAssetKind[] = ["building_exterior", "town_illustration"];
    for (const kind of kinds) {
      const request: TownAssetRequest = { kind, targetId: "building-1", prompt: "a tavern" };
      const result = await source.request(request);
      expect(result.status).toBe("not_requested");
      expect("assetUrl" in result).toBe(false);
    }
  });

  it("重复调用同样恒定（无内部状态）", async () => {
    const source = createUnavailableTownIllustrationSource();
    const request: TownAssetRequest = {
      kind: "town_illustration",
      targetId: "town-1",
      prompt: "bird's-eye view"
    };
    expect(await source.request(request)).toEqual({ status: "not_requested" });
    expect(await source.request(request)).toEqual({ status: "not_requested" });
  });
});
