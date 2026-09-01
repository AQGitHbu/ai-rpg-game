// ---------------------------------------------------------------------------
// 对白分页纯函数（core 层）：把一段 NPC 对白按每页字符预算切成多页。
// 纯确定性：不读时间、随机数或 AI；所有页顺序拼接 === trim 后原文。
// ---------------------------------------------------------------------------

/** 句读切分：每段以 。！？…!? 连续串结尾（或到文末），保留标点不丢字。 */
const SENTENCE_SEGMENT = /[^。！？…!?]+[。！？…!?]*|[。！？…!?]+/g;
const SOFT_BREAK = /[，、；：,;:]\s*/g;

function preferredSplitIndex(text: string, maxCharsPerPage: number): number {
  const window = text.slice(0, maxCharsPerPage);
  const minimumUsefulPageLength = Math.floor(maxCharsPerPage / 2);
  let splitIndex = -1;
  for (const match of window.matchAll(SOFT_BREAK)) {
    const candidate = (match.index ?? 0) + match[0].length;
    if (candidate >= minimumUsefulPageLength) splitIndex = candidate;
  }
  return splitIndex > 0 ? splitIndex : maxCharsPerPage;
}

/**
 * 按每页字符预算把对白切成多页：优先在句读后断页，能装下的相邻句子
 * 贪心聚合进同一页；单句超预算时按预算硬切。
 */
export function paginateSpeechText(text: string, maxCharsPerPage: number): readonly string[] {
  if (!Number.isInteger(maxCharsPerPage) || maxCharsPerPage < 1) {
    throw new Error("对白分页失败：每页字符预算必须为正整数");
  }
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const segments = trimmed.match(SENTENCE_SEGMENT) ?? [trimmed];
  const pages: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (current !== "" && current.length + segment.length > maxCharsPerPage) {
      pages.push(current);
      current = "";
    }
    if (segment.length > maxCharsPerPage) {
      // 单句超预算：优先在逗号、分号等自然停顿后切分；确实没有
      // 可用停顿时才按预算硬切，剩余尾段留作当前页继续聚合。
      let rest = segment;
      while (rest.length > maxCharsPerPage) {
        const splitIndex = preferredSplitIndex(rest, maxCharsPerPage);
        pages.push(rest.slice(0, splitIndex));
        rest = rest.slice(splitIndex);
      }
      current = rest;
    } else {
      current += segment;
    }
  }
  if (current !== "") pages.push(current);
  return pages;
}
