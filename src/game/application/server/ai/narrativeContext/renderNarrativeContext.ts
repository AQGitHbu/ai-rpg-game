import {
  NARRATIVE_CONTEXT_HEADER,
  type CompiledNarrativeContext,
  type NarrativePromptCompilation,
} from "./contextBlock";

function renderBlock(block: CompiledNarrativeContext["selected"][number]): string {
  return `## [${block.slot}] ${block.title.trim()}\n${block.content.trim()}\n`;
}

export function renderNarrativeContext(context: CompiledNarrativeContext): string {
  if (context.selected.length === 0) {
    return `${NARRATIVE_CONTEXT_HEADER}\n`;
  }
  let prompt = `${NARRATIVE_CONTEXT_HEADER}\n\n`;
  for (const block of context.selected) {
    prompt += renderBlock(block);
  }
  return prompt;
}

export function createNarrativePromptCompilation(
  context: CompiledNarrativeContext,
): NarrativePromptCompilation {
  return {
    prompt: renderNarrativeContext(context),
    context,
    manifest: context.manifest,
  };
}
