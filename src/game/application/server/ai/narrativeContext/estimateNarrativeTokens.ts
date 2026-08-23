import type { NarrativeContextBlock } from "./contextBlock";

export function estimateNarrativeTokens(text: string): number {
  let total = 0;
  for (const char of text) {
    total += char.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  }
  return Math.max(1, Math.ceil(total));
}

export function estimateNarrativeBlockTokens(block: NarrativeContextBlock): number {
  return estimateNarrativeTokens(
    `## [${block.slot}] ${block.title.trim()}\n${block.content.trim()}\n\n`,
  );
}
