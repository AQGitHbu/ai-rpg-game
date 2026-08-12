/**
 * 展示层的轻量文本清洗：不改变存档或日志中的原始文本，只压缩连续重复的句末标点。
 */
export function normalizeDisplayText(text: string): string {
  return text.replace(/([。！？])\1+/g, "$1");
}
