import type { NewGameInput } from "@/game/domain";
import casesData from "../../../../data/story-eval/cases/v2.json";

// ---------------------------------------------------------------------------
// 离线开局基线：从 v2.json 按 caseId 取 NewGameInput，seed 由 caseId 确定性
// 派生（FNV-1a，零新数据、可复现）。compositionRoot 的 createOfflineJourneyGame
// 按 caseId 解析后复用现有 offline 链路（unavailable source → fallback 蓝图 +
// runtimeNarrativeMode:"offline"）。本模块是离线下拉 caseId 的唯一白名单来源。
// ---------------------------------------------------------------------------

type StoryEvalCase = Readonly<{ readonly caseId: string; readonly input: NewGameInput }>;
const RAW_CASES = casesData as readonly StoryEvalCase[];

/** 题材 → 代表 case 映射（下拉 7 个选项的唯一来源）。 */
export const GENRE_TO_CASE: readonly {
  readonly label: string;
  readonly gameType: NewGameInput["gameType"];
  readonly caseId: string;
}[] = Object.freeze([
  { label: "武侠", gameType: "wuxia", caseId: "wuxia-a" },
  { label: "仙侠", gameType: "xianxia", caseId: "xianxia-a" },
  { label: "奇幻", gameType: "fantasy", caseId: "fantasy-a" },
  { label: "科幻", gameType: "science_fiction", caseId: "science-fiction-a" },
  { label: "都市", gameType: "urban", caseId: "urban-a" },
  { label: "架空历史", gameType: "alternate_history", caseId: "alternate-history-a" },
  { label: "末日", gameType: "post_apocalypse", caseId: "post-apocalypse-a" },
]);

/** caseId 白名单（由 GENRE_TO_CASE 派生，外部校验用）。 */
export const OFFLINE_CASE_IDS: readonly string[] = Object.freeze(
  GENRE_TO_CASE.map((entry) => entry.caseId),
);

/** FNV-1a 双路 32 位 → 16 位十六进制串（稳定可复现，与 fallback 同思路）。 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  let hash2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash2 ^= text.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0") + hash2.toString(16).padStart(8, "0");
}

/**
 * 按 caseId 解析离线基线。input 取自 v2.json；seed 由 caseId 派生。
 * 未知 caseId → null（由调用方映射为 400）。
 */
export function resolveOfflineBaseline(
  caseId: string,
): { readonly input: NewGameInput; readonly seed: string } | null {
  const found = RAW_CASES.find((entry) => entry.caseId === caseId);
  if (found === undefined) return null;
  return {
    input: found.input,
    seed: fnv1aHex(`offline-baseline:${caseId}`),
  };
}
