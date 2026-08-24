/** 玩家可见叙事文本的生成来源。 */
export type NarrativeTextSource = "generated" | "rule" | "fixture";

export const FIXTURE_NARRATIVE_MARKER = "【fallback】";

/**
 * 在 read model 的统一出口标记确定性兜底文本。
 *
 * 标记只属于展示层，不写回场景或存档；幂等性允许同一视图被重复投影。
 */
export function decorateNarrativeText(text: string, source: NarrativeTextSource): string {
  if (source !== "fixture" || text.trim() === "" || text.startsWith(FIXTURE_NARRATIVE_MARKER)) {
    return text;
  }
  return `${FIXTURE_NARRATIVE_MARKER}${text}`;
}

/** 对分页对白复用同一来源标记规则。 */
export function decorateNarrativePages(
  pages: readonly string[],
  source: NarrativeTextSource,
): readonly string[] {
  return pages.map((page) => decorateNarrativeText(page, source));
}
