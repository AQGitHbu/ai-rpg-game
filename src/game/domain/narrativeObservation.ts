// 认知变化与可观察表演（Spec §6、§7）。
//
// Observation 是“哪个已成立事件使哪些 audience 观察或获知什么”的唯一载体：
// 没有来源的全员同步不是观察，不能进入本模块。模块只做纯解析，规则审批在 gameplay。

import {
  hasOnlyKeys,
  isPlainRecord,
  fail,
  parseKey,
  parseKeys,
  parseScenePoint,
  type Check,
  type FactUse,
  type ScenePoint,
} from "./narrativeUnit";

// 共享引用与表演类型定义于 narrativeUnit（表达单元同样依赖它们）；
// 本模块是它们的正式导出面之一。
export type { CosmeticAction, EvidenceRef, FactUse, ScenePoint } from "./narrativeUnit";

export type ObservationSource =
  | { readonly kind: "witness" }
  | { readonly kind: "speech"; readonly speakerId: string };

export type Observation = {
  readonly key: string;
  readonly point: ScenePoint;
  readonly audienceIds: readonly string[];
  readonly fact: FactUse;
  readonly source: ObservationSource;
};

function parseObservationSource(value: unknown): ObservationSource | null {
  if (!isPlainRecord(value)) return null;
  if (value.kind === "witness") {
    return hasOnlyKeys(value, ["kind"]) ? { kind: "witness" } : null;
  }
  if (value.kind === "speech") {
    if (!hasOnlyKeys(value, ["kind", "speakerId"])) return null;
    const speakerId = parseKey(value.speakerId);
    return speakerId === null ? null : { kind: "speech", speakerId };
  }
  return null;
}

/** 逐字段重建观察；未知键、空受众和未知来源一律拒绝。 */
export function parseObservation(raw: unknown): Check<Observation> {
  if (!isPlainRecord(raw)) return fail("observation_not_object");
  if (!hasOnlyKeys(raw, ["key", "point", "audienceIds", "fact", "source"])) {
    return fail("observation_unknown_key");
  }
  const key = parseKey(raw.key);
  if (key === null) return fail("observation_key_invalid");
  const point = parseScenePoint(raw.point);
  if (point === null) return fail("observation_point_invalid");
  const audienceIds = parseKeys(raw.audienceIds);
  if (audienceIds === null || audienceIds.length === 0) return fail("observation_audience_invalid");
  if (!isPlainRecord(raw.fact) || !hasOnlyKeys(raw.fact, ["factId", "certainty"])) {
    return fail("observation_fact_shape_invalid");
  }
  const factId = parseKey(raw.fact.factId);
  if (factId === null) return fail("observation_fact_invalid");
  if (raw.fact.certainty !== "known" && raw.fact.certainty !== "suspected") {
    return fail("observation_certainty_invalid");
  }
  const source = parseObservationSource(raw.source);
  if (source === null) return fail("observation_source_invalid");
  return {
    ok: true,
    value: {
      key,
      point,
      audienceIds,
      fact: { factId, certainty: raw.fact.certainty },
      source,
    },
  };
}
