/**
 * 展示层的轻量文本清洗：不改变存档或日志中的原始文本，只压缩连续重复的句末标点。
 */
export function normalizeDisplayText(text: string): string {
  return text.replace(/([。！？])\1+/g, "$1");
}

const IGNORED_CHARS = /[\s，,、。！？!?；;：:“”"'‘’「」『』（）()…—\-·]/gu;
const CLAUSES = /[^，。！？；,!?;]+[，。！？；,!?;]?/gu;

function stripPunctuation(value: string): string {
  return value.replace(IGNORED_CHARS, "");
}

function characterBigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index + 1 < value.length; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

function coveredRatio(clause: string, reference: Set<string>): number {
  const grams = characterBigrams(stripPunctuation(clause));
  if (grams.size === 0 || reference.size === 0) return 0;
  let shared = 0;
  for (const gram of grams) {
    if (reference.has(gram)) shared += 1;
  }
  return shared / grams.size;
}

/**
 * 去掉 text 中已被 coveredBy 表达过的小句。
 *
 * 旁注与描述常由同一批氛围素材写成，措辞略变但景象相同，逐字包含判断
 * 抓不住这种改写；因此按小句统计字符重合度，只丢弃重复部分，保留其余信息。
 */
export function removeCoveredClauses(text: string, coveredBy: string): string {
  if (text.trim() === "" || coveredBy.trim() === "") return text;
  const reference = characterBigrams(stripPunctuation(coveredBy));
  const kept = (text.match(CLAUSES) ?? []).filter((clause) => coveredRatio(clause, reference) < 0.5);
  const joined = kept.join("").trim();
  if (joined === "") return "";
  return joined
    .replace(/^[，、；,]+/u, "")
    .replace(/[，、；,]+$/u, "。")
    .replace(/([。！？]){2,}/gu, "$1");
}
