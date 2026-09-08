import { expectTypeOf, it } from "vitest";
import type { ContentAssetState, ContentAssetImageView, GameSessionView, GameVisualAssetsView } from "@/game/application";

it("requires a usable image at ready/stale and keeps the optional extension off old views", () => {
  expectTypeOf<Extract<ContentAssetState, { status: "ready" }>["image"]>().toEqualTypeOf<ContentAssetImageView>();
  expectTypeOf<Extract<ContentAssetState, { status: "stale" }>["image"]>().toEqualTypeOf<ContentAssetImageView>();
  expectTypeOf<GameSessionView["visualAssets"]>().toEqualTypeOf<GameVisualAssetsView | undefined>();
  // @ts-expect-error ready is not a URL-free success state
  const bad: ContentAssetState = { status: "ready" };
  void bad;
});
