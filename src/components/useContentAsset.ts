"use client";

import { useState } from "react";
import type { ContentAssetImageView } from "@/game/application";

// 由 renderer 的 keyed 子组件拥有一次展示期。禁止加入依赖 API 更新的重置 effect。
export function useContentAsset(input: readonly ContentAssetImageView[]) {
  const [candidates] = useState(() => input.map((image) => ({ ...image })));
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState<readonly string[]>([]);
  const image = candidates.find((entry) => !failed.includes(entry.src)) ?? null;
  const src = image?.src;
  return {
    image,
    loaded: src !== undefined && loaded.includes(src),
    onLoad: () => {
      if (src !== undefined) setLoaded((seen) => seen.includes(src) ? seen : [...seen, src]);
    },
    onError: () => {
      if (src !== undefined) setFailed((seen) => seen.includes(src) ? seen : [...seen, src]);
    },
  };
}
