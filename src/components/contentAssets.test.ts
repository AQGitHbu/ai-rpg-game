import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentAssetBindingView, ContentAssetImageView, ContentAssetState } from "@/game/application";
import {
  CONTENT_ASSET_MANIFEST, isContentAssetImage, normalizeAssetGameType, ownAssetBinding,
  resolveContentAssetCandidates, usableVisualAssets, type ContentAssetManifestEntry, type ContentAssetQuery,
} from "./contentAssets";

const query = { kind: "npc_portrait", gameType: "wuxia", variant: "neutral" } as const;
const image = (name: string): ContentAssetImageView => ({
  assetId: name, version: "1", src: `/assets/test/${name}.webp`, width: 768, height: 1024, source: "generated",
});
const binding = (state: ContentAssetState): ContentAssetBindingView => ({
  ...query, bindingKey: "opaque-npc-a", requestKey: "opaque-request-1", ...state,
});
const templates: readonly ContentAssetManifestEntry[] = [
  { ...query, image: image("theme") },
  { ...query, gameType: "generic", image: image("generic") },
];

describe("content asset resolution", () => {
  it("registers 23 distinct queries referencing 15 nonempty local files", () => {
    const keys = CONTENT_ASSET_MANIFEST.map(({ kind, gameType, variant }) => JSON.stringify([kind, gameType, variant]));
    expect(keys).toHaveLength(23);
    expect(new Set(keys).size).toBe(keys.length);
    const urls = new Set(CONTENT_ASSET_MANIFEST.map((entry) => entry.image.src));
    expect(urls.size).toBe(15);
    for (const entry of CONTENT_ASSET_MANIFEST) {
      expect(isContentAssetImage(entry.image)).toBe(true);
      const file = statSync(path.join(process.cwd(), "public", entry.image.src.slice(1)));
      expect(file.isFile()).toBe(true);
      expect(file.size).toBeGreaterThan(0);
      expect([entry.image.width, entry.image.height]).toEqual(entry.kind === "genre_cover" ? [1368, 768] : [512, 512]);
    }
    for (const genre of ["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"] as const) {
      expect(resolveContentAssetCandidates({ kind: "genre_cover", gameType: genre, variant: "default" })[0]?.src)
        .toBe(`/assets/genres/${genre}.jpg`);
    }
    for (const variant of ["tavern", "blacksmith", "house", "shop", "workshop", "warehouse", "well", "gatehouse"] as const) {
      expect(resolveContentAssetCandidates({ kind: "town_building", gameType: "wuxia", variant })[0]?.src)
        .toBe(`/assets/town/${variant}.webp`);
    }
  });
  it.each(["science_fiction", "urban", "fantasy", "alternate_history", "post_apocalypse", "generic"] as const)("does not use Chinese roofs for %s", (gameType) => {
    expect(resolveContentAssetCandidates({ kind: "town_building", variant: "tavern", gameType })).toEqual([]);
  });
  it.each([undefined, null, "__proto__", "constructor", "toString", 42])("rejects invalid game type %s", (value) => {
    expect(normalizeAssetGameType(value)).toBe("generic");
    expect(resolveContentAssetCandidates({ ...query, gameType: value } as ContentAssetQuery)).toEqual([]);
  });
  it("rejects invalid kind/variant, binding mismatch and inherited map keys", () => {
    for (const patch of [{ kind: "__proto__" }, { kind: "invented" }, { variant: "constructor" }]) {
      expect(resolveContentAssetCandidates({ ...query, ...patch } as ContentAssetQuery)).toEqual([]);
    }
    expect(resolveContentAssetCandidates(query, { ...binding({ status: "ready", image: image("wrong") }), variant: "angry" })).toEqual([]);
    expect(ownAssetBinding({}, "toString")).toBeUndefined();
    expect(usableVisualAssets({ scopeKey: "" })).toBeUndefined();
  });
  it.each([
    "https://provider.example/image.png", "//host/image.png", "data:image/png;base64,x",
    "blob:abc", "/assets/../private.png", "/assets/%2e%2e/private.png", "/assets/a.svg",
    "/assets/a.webp?token=secret", "/assets/a.webp#fragment", "",
  ])("rejects unsafe URL %s", (src) => expect(isContentAssetImage({ ...image("a"), src })).toBe(false));
  it("rejects invalid dimensions and empty identity", () => {
    for (const patch of [{ width: 0 }, { height: NaN }, { width: 0.5 }, { assetId: "" }, { version: " " }]) {
      expect(isContentAssetImage({ ...image("a"), ...patch })).toBe(false);
    }
  });
  it("orders current, previous, genre, generic and removes duplicate URLs", () => {
    const current = image("current");
    expect(resolveContentAssetCandidates(query, binding({ status: "ready", image: current, previous: image("old") }), templates)
      .map((entry) => entry.assetId)).toEqual(["current", "old", "theme", "generic"]);
    expect(resolveContentAssetCandidates(query, binding({ status: "ready", image: current, previous: current }), [])).toEqual([current]);
  });
  it.each(["queued", "generating", "failed"] as const)("%s preserves same-binding previous image", (status) => {
    expect(resolveContentAssetCandidates(query, binding({ status, previous: image("old") }), templates)
      .map((entry) => entry.assetId)).toEqual(["old", "theme", "generic"]);
  });
  it("handles not_requested, stale and unusable ready images", () => {
    expect(resolveContentAssetCandidates(query, binding({ status: "not_requested" }), templates).map((entry) => entry.assetId)).toEqual(["theme", "generic"]);
    expect(resolveContentAssetCandidates(query, binding({ status: "stale", image: image("old") }), templates)[0]?.assetId).toBe("old");
    expect(resolveContentAssetCandidates(query, binding({ status: "ready", image: { ...image("bad"), src: "https://x.test/a.webp" } }), templates)[0]?.assetId).toBe("theme");
  });
});
