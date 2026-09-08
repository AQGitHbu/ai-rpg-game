export type ContentAssetKind =
  | "genre_cover" | "town_building" | "location_backdrop" | "npc_portrait";

export type ContentAssetImageView = {
  readonly assetId: string;
  readonly version: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly source: "static" | "generated";
};

export type ContentAssetState =
  | { readonly status: "not_requested" }
  | { readonly status: "queued" | "generating" | "failed";
      readonly previous?: ContentAssetImageView }
  | { readonly status: "ready"; readonly image: ContentAssetImageView;
      readonly previous?: ContentAssetImageView }
  | { readonly status: "stale"; readonly image: ContentAssetImageView };

export type ContentAssetBindingView = {
  readonly bindingKey: string;
  readonly requestKey: string;
  readonly kind: ContentAssetKind;
  readonly gameType: string;
  readonly variant: string;
} & ContentAssetState;

export type GameVisualAssetsView = {
  readonly scopeKey: string;
  readonly locationBackdrop?: ContentAssetBindingView;
  readonly buildingBackdrops?: Readonly<Record<string, ContentAssetBindingView>>;
  readonly npcPortraits?: Readonly<Record<string, ContentAssetBindingView>>;
  readonly townBuildings?: Readonly<Record<string, ContentAssetBindingView>>;
};
