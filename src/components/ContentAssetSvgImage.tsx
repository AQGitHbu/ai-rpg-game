"use client";

import { resolveContentAssetCandidates, type ContentAssetInput } from "./contentAssets";
import { useContentAsset } from "./useContentAsset";

export type ContentAssetSvgImageProps = ContentAssetInput & {
  readonly x: number; readonly y: number;
  readonly width: number; readonly height: number;
};
export function ContentAssetSvgImage(props: ContentAssetSvgImageProps) {
  return <ContentAssetSvgImageEntry key={props.presentationKey} {...props} />;
}
function ContentAssetSvgImageEntry(props: ContentAssetSvgImageProps) {
  const { image, onError } = useContentAsset(resolveContentAssetCandidates(props.query, props.binding));
  if (image === null) return null;
  return <image key={image.src} href={image.src}
    x={props.x} y={props.y} width={props.width} height={props.height}
    preserveAspectRatio="xMidYMid slice" aria-hidden="true" pointerEvents="none" onError={onError} />;
}
