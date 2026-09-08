import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ContentAssetImageView } from "@/game/application";
import { useContentAsset } from "./useContentAsset";

it("pins candidates and ignores late events for a failed source", () => {
  const a: ContentAssetImageView = { assetId: "a", version: "1", src: "/assets/a.webp", width: 1, height: 1, source: "generated" };
  const b = { ...a, assetId: "b", src: "/assets/b.webp" };
  const { result, rerender } = renderHook(({ images }) => useContentAsset(images), { initialProps: { images: [a, b] } });
  const lateA = result.current;
  act(() => result.current.onError());
  expect(result.current.image).toEqual(b);
  act(() => lateA.onLoad());
  act(() => lateA.onError());
  expect(result.current.image).toEqual(b);
  expect(result.current.loaded).toBe(false);
  rerender({ images: [a] });
  expect(result.current.image).toEqual(b);
  act(() => result.current.onError());
  expect(result.current.image).toBeNull();
});
