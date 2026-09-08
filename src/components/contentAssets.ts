import type {
  ContentAssetBindingView, ContentAssetImageView, GameVisualAssetsView,
  NewGameInput, TownRenderSnapshot,
} from "@/game/application";

export type GameTypeId = NewGameInput["gameType"];
export type TownBuildingType = TownRenderSnapshot["buildings"][number]["buildingType"];
export type ContentAssetQuery = { readonly gameType: GameTypeId | "generic" } & (
  | { readonly kind: "genre_cover" | "location_backdrop"; readonly variant: "default" }
  | { readonly kind: "npc_portrait"; readonly variant: "neutral" }
  | { readonly kind: "town_building"; readonly variant: TownBuildingType }
);
export type ContentAssetManifestEntry = ContentAssetQuery & {
  readonly image: ContentAssetImageView;
};
export type ContentAssetInput = {
  readonly query: ContentAssetQuery;
  readonly binding?: ContentAssetBindingView;
  readonly presentationKey: string;
};

const GENRE_COVERS = {
  wuxia: "/assets/genres/wuxia.jpg",
  xianxia: "/assets/genres/xianxia.jpg",
  fantasy: "/assets/genres/fantasy.jpg",
  science_fiction: "/assets/genres/science_fiction.jpg",
  urban: "/assets/genres/urban.jpg",
  alternate_history: "/assets/genres/alternate_history.jpg",
  post_apocalypse: "/assets/genres/post_apocalypse.jpg",
} as const satisfies Record<GameTypeId, string>;
const TOWN_BUILDINGS = {
  tavern: "/assets/town/tavern.webp",
  blacksmith: "/assets/town/blacksmith.webp",
  house: "/assets/town/house.webp",
  shop: "/assets/town/shop.webp",
  workshop: "/assets/town/workshop.webp",
  warehouse: "/assets/town/warehouse.webp",
  well: "/assets/town/well.webp",
  gatehouse: "/assets/town/gatehouse.webp",
} as const satisfies Record<TownBuildingType, string>;

export function normalizeAssetGameType(value: unknown): GameTypeId | "generic" {
  return typeof value === "string" && Object.hasOwn(GENRE_COVERS, value)
    ? value as GameTypeId : "generic";
}
function validQuery(query: ContentAssetQuery): boolean {
  if (!query || (query.gameType !== "generic" && normalizeAssetGameType(query.gameType) === "generic")) return false;
  switch (query.kind) {
    case "genre_cover": case "location_backdrop": return query.variant === "default";
    case "npc_portrait": return query.variant === "neutral";
    case "town_building": return typeof query.variant === "string" && Object.hasOwn(TOWN_BUILDINGS, query.variant);
    default: return false;
  }
}
function staticImage(assetId: string, src: string, width: number, height: number): ContentAssetImageView {
  return { assetId, src, width, height, version: "1", source: "static" };
}
export const CONTENT_ASSET_MANIFEST: readonly ContentAssetManifestEntry[] = [
  ...Object.entries(GENRE_COVERS).map(([gameType, src]) => ({
    kind: "genre_cover" as const, gameType: gameType as GameTypeId, variant: "default" as const,
    image: staticImage(`genre-${gameType}`, src, 1368, 768),
  })),
  ...(["wuxia", "xianxia"] as const).flatMap((gameType) =>
    Object.entries(TOWN_BUILDINGS).map(([variant, src]) => ({
      kind: "town_building" as const, gameType, variant: variant as TownBuildingType,
      image: staticImage(`legacy-roof-${variant}`, src, 512, 512),
    })),
  ),
];

// 同源路径合同：目录不可出现点段、编码或查询参数；版本点号只出现在文件名。
export function isContentAssetImage(value: unknown): value is ContentAssetImageView {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<ContentAssetImageView>;
  return typeof item.assetId === "string" && item.assetId.trim().length > 0
    && typeof item.version === "string" && item.version.trim().length > 0
    && typeof item.width === "number" && Number.isSafeInteger(item.width) && item.width > 0
    && typeof item.height === "number" && Number.isSafeInteger(item.height) && item.height > 0
    && (item.source === "static" || item.source === "generated")
    && typeof item.src === "string"
    && /^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp|avif)$/.test(item.src);
}

export function resolveContentAssetCandidates(
  query: ContentAssetQuery,
  binding?: ContentAssetBindingView,
  manifest: readonly ContentAssetManifestEntry[] = CONTENT_ASSET_MANIFEST,
): readonly ContentAssetImageView[] {
  if (!validQuery(query)) return [];
  const candidates: unknown[] = [];
  if (binding && binding.kind === query.kind && binding.gameType === query.gameType
    && binding.variant === query.variant
    && typeof binding.bindingKey === "string" && binding.bindingKey.trim() !== ""
    && typeof binding.requestKey === "string" && binding.requestKey.trim() !== "") {
    switch (binding.status) {
      case "ready": candidates.push(binding.image, binding.previous); break;
      case "stale": candidates.push(binding.image); break;
      case "queued": case "generating": case "failed": candidates.push(binding.previous); break;
      case "not_requested": break;
    }
  }
  for (const gameType of [query.gameType, "generic"] as const) {
    for (const entry of manifest) {
      if (entry.kind === query.kind && entry.variant === query.variant && entry.gameType === gameType) {
        candidates.push(entry.image);
      }
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is ContentAssetImageView => {
    if (!isContentAssetImage(candidate) || seen.has(candidate.src)) return false;
    seen.add(candidate.src);
    return true;
  });
}

export function usableVisualAssets(visuals?: GameVisualAssetsView): GameVisualAssetsView | undefined {
  return typeof visuals?.scopeKey === "string" && visuals.scopeKey.trim() !== "" ? visuals : undefined;
}
export function ownAssetBinding(
  entries: Readonly<Record<string, ContentAssetBindingView>> | undefined,
  key: string | null | undefined,
): ContentAssetBindingView | undefined {
  return entries && typeof key === "string" && Object.hasOwn(entries, key) ? entries[key] : undefined;
}
export function assetPresentationKey(
  scope: string | undefined, query: ContentAssetQuery, subject: string, bindingKey?: string,
): string {
  return JSON.stringify([scope ?? "static", query.kind, query.gameType, query.variant, subject, bindingKey ?? null]);
}
