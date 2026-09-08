"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { resolveContentAssetCandidates, type ContentAssetInput } from "./contentAssets";
import { useContentAsset } from "./useContentAsset";

export type ContentAssetImageProps = ContentAssetInput & {
  readonly fallback: ReactNode;
  readonly sizes: string;
  readonly fit: "cover" | "contain";
  readonly className?: string;
  readonly priority?: boolean;
} & (
  | { readonly decorative: true; readonly label?: never }
  | { readonly decorative?: false; readonly label: string }
);

export function ContentAssetImage(props: ContentAssetImageProps) {
  return <ContentAssetImageEntry key={props.presentationKey} {...props} />;
}
function ContentAssetImageEntry(props: ContentAssetImageProps) {
  const { image, loaded, onLoad, onError } = useContentAsset(
    resolveContentAssetCandidates(props.query, props.binding),
  );
  // 当无图可显示（已耗尽）或未加载完成时展示静态 fallback；加载成功后隐藏。
  const showFallback = !loaded;
  return (
    <span className={`content-asset-frame ${props.className ?? ""}`}
      data-content-asset={props.query.kind}
      data-load-state={image === null ? "exhausted" : loaded ? "loaded" : "loading"}
      role={props.decorative ? undefined : "img"}
      aria-label={props.decorative ? undefined : props.label}
      aria-hidden={props.decorative || undefined}>
      <span className="content-asset-fallback" aria-hidden="true"
        style={{ visibility: showFallback ? "visible" : "hidden" }}>{props.fallback}</span>
      {image !== null && (
        <Image key={image.src} src={image.src} alt="" fill sizes={props.sizes}
          priority={props.priority} unoptimized={image.source === "generated"}
          style={{ objectFit: props.fit, visibility: loaded ? "visible" : "hidden" }}
          onLoad={onLoad} onError={onError} />
      )}
    </span>
  );
}
