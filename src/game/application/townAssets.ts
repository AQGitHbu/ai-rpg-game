// ---------------------------------------------------------------------------
// Task 7：小镇生图的预留 application port（契约 town-assets-v0）。
// 本文件只有类型与 unavailable 工厂：不读文件、不读 process.env、无网络。
// 用户硬约束：demo 不接入任何 AI 生图，生产实现恒返回 not_requested；
// 未来的 live source（若有）实现同一 TownIllustrationSource 接口即可替换。
// ---------------------------------------------------------------------------

/** 当前生图契约版本；扩展 kind/status 或接入真实实现时必须升级。 */
export const TOWN_ASSET_CONTRACT_VERSION = "town-assets-v0" as const;

export type TownAssetKind = "building_exterior" | "town_illustration";

export type TownAssetStatus = "not_requested" | "queued" | "generating" | "ready" | "failed";

export type TownAssetRequest = {
  readonly kind: TownAssetKind;
  readonly targetId: string;
  readonly prompt: string;
};

export type TownAssetResult = {
  readonly status: TownAssetStatus;
  readonly assetUrl?: string;
};

/** 生图来源门面：无 repository、无状态写权限。 */
export type TownIllustrationSource = {
  request(req: TownAssetRequest): Promise<TownAssetResult>;
};

/** 生产实现：恒 { status: "not_requested" }，不含 assetUrl。 */
export function createUnavailableTownIllustrationSource(): TownIllustrationSource {
  return {
    request: () => Promise.resolve({ status: "not_requested" })
  };
}
