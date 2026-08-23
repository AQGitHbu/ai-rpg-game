import {
  NARRATIVE_CONTEXT_AUTHORITY_ORDER,
  NARRATIVE_CONTEXT_COMPILER_VERSION,
  NARRATIVE_CONTEXT_DROP_REASON_ORDER,
  NARRATIVE_CONTEXT_HEADER,
  NARRATIVE_CONTEXT_SLOT_ORDER,
  type CompiledNarrativeContext,
  type CompiledNarrativeContextBlock,
  type DroppedNarrativeContextBlock,
  type NarrativeContextAuthority,
  type NarrativeContextBlock,
  type NarrativeContextDropReason,
  type NarrativeContextManifest,
  type NarrativeContextRetention,
  type NarrativeContextSlot,
} from "./contextBlock";
import { estimateNarrativeBlockTokens, estimateNarrativeTokens } from "./estimateNarrativeTokens";

type CompilerInput = Readonly<{
  maxEstimatedTokens: number;
  blocks: readonly NarrativeContextBlock[];
}>;

type PreparedBlock = Readonly<{
  block: NarrativeContextBlock;
  trimmedTitle: string;
  trimmedContent: string;
  estimatedTokens: number;
}>;

const FRAMING_ESTIMATED_TOKENS = estimateNarrativeTokens(`${NARRATIVE_CONTEXT_HEADER}\n\n`);

const authorityRank = buildRankMap(NARRATIVE_CONTEXT_AUTHORITY_ORDER);
const slotRank = buildRankMap(NARRATIVE_CONTEXT_SLOT_ORDER);
const reasonRank = buildRankMap(NARRATIVE_CONTEXT_DROP_REASON_ORDER);

function buildRankMap<const T extends string>(items: readonly T[]): Readonly<Record<T, number>> {
  return Object.fromEntries(items.map((item, index) => [item, index])) as Record<T, number>;
}

function compareBinaryString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumberAsc(left: number, right: number): number {
  return left - right;
}

function compareNumberDesc(left: number, right: number): number {
  return right - left;
}

function compareAuthority(left: NarrativeContextAuthority, right: NarrativeContextAuthority): number {
  return compareNumberAsc(authorityRank[left], authorityRank[right]);
}

function compareRetention(left: NarrativeContextRetention, right: NarrativeContextRetention): number {
  if (left === right) return 0;
  return left === "mandatory" ? -1 : 1;
}

function compareSlot(left: NarrativeContextSlot, right: NarrativeContextSlot): number {
  return compareNumberAsc(slotRank[left], slotRank[right]);
}

function sourceRefsKey(refs: readonly string[]): string {
  return refs.join("\u0000");
}

function compareDuplicateWinner(left: PreparedBlock, right: PreparedBlock): number {
  return (
    compareAuthority(left.block.authority, right.block.authority) ||
    compareRetention(left.block.retention, right.block.retention) ||
    compareNumberDesc(left.block.priority, right.block.priority) ||
    compareSlot(left.block.slot, right.block.slot) ||
    compareBinaryString(left.trimmedTitle, right.trimmedTitle) ||
    compareBinaryString(right.trimmedContent, left.trimmedContent) ||
    compareBinaryString(left.block.source.kind, right.block.source.kind) ||
    compareBinaryString(sourceRefsKey(left.block.source.refs), sourceRefsKey(right.block.source.refs)) ||
    compareBinaryString(left.block.conflictKey ?? "", right.block.conflictKey ?? "")
  );
}

function compareConflictWinner(left: PreparedBlock, right: PreparedBlock): number {
  return (
    compareAuthority(left.block.authority, right.block.authority) ||
    compareRetention(left.block.retention, right.block.retention) ||
    compareNumberDesc(left.block.priority, right.block.priority) ||
    compareBinaryString(left.block.id, right.block.id)
  );
}

function compareOptionalSelection(left: PreparedBlock, right: PreparedBlock): number {
  return (
    compareNumberDesc(left.block.priority, right.block.priority) ||
    compareAuthority(left.block.authority, right.block.authority) ||
    compareSlot(left.block.slot, right.block.slot) ||
    compareBinaryString(left.block.id, right.block.id)
  );
}

function compareSelectedOutput(left: CompiledNarrativeContextBlock, right: CompiledNarrativeContextBlock): number {
  return (
    compareSlot(left.slot, right.slot) ||
    compareNumberDesc(left.priority, right.priority) ||
    compareBinaryString(left.id, right.id)
  );
}

function compareDroppedOutput(left: DroppedNarrativeContextBlock, right: DroppedNarrativeContextBlock): number {
  return (
    compareNumberAsc(reasonRank[left.reason], reasonRank[right.reason]) ||
    compareSlot(left.slot, right.slot) ||
    compareBinaryString(left.id, right.id) ||
    compareBinaryString(left.sourceKind, right.sourceKind) ||
    compareBinaryString(sourceRefsKey(left.sourceRefs), sourceRefsKey(right.sourceRefs))
  );
}

function toDroppedBlock(prepared: PreparedBlock, reason: NarrativeContextDropReason): DroppedNarrativeContextBlock {
  return {
    id: prepared.block.id,
    slot: prepared.block.slot,
    sourceKind: prepared.block.source.kind,
    sourceRefs: prepared.block.source.refs,
    estimatedTokens: prepared.estimatedTokens,
    reason,
  };
}

function toCompiledBlock(prepared: PreparedBlock): CompiledNarrativeContextBlock {
  return {
    ...prepared.block,
    estimatedTokens: prepared.estimatedTokens,
  };
}

function toManifestEntryFromSelected(block: CompiledNarrativeContextBlock): Omit<DroppedNarrativeContextBlock, "reason"> {
  return {
    id: block.id,
    slot: block.slot,
    sourceKind: block.source.kind,
    sourceRefs: block.source.refs,
    estimatedTokens: block.estimatedTokens,
  };
}

function toManifestEntryFromDropped(block: DroppedNarrativeContextBlock): Omit<DroppedNarrativeContextBlock, "reason"> {
  return {
    id: block.id,
    slot: block.slot,
    sourceKind: block.sourceKind,
    sourceRefs: block.sourceRefs,
    estimatedTokens: block.estimatedTokens,
  };
}

function ensureBudget(maxEstimatedTokens: number): void {
  if (!Number.isFinite(maxEstimatedTokens) || maxEstimatedTokens < 1) {
    throw new RangeError("maxEstimatedTokens must be a finite number greater than or equal to 1");
  }
}

function prepareBlock(block: NarrativeContextBlock): PreparedBlock {
  const trimmedTitle = block.title.trim();
  const trimmedContent = block.content.trim();
  return {
    block,
    trimmedTitle,
    trimmedContent,
    estimatedTokens: estimateNarrativeBlockTokens({
      ...block,
      title: trimmedTitle,
      content: trimmedContent,
    }),
  };
}

export function compileNarrativeContext(input: CompilerInput): CompiledNarrativeContext {
  ensureBudget(input.maxEstimatedTokens);

  const dropped: DroppedNarrativeContextBlock[] = [];
  const nonEmptyPrepared: PreparedBlock[] = [];

  for (const block of input.blocks) {
    const trimmedContent = block.content.trim();
    if (trimmedContent === "") {
      dropped.push({
        id: block.id,
        slot: block.slot,
        sourceKind: block.source.kind,
        sourceRefs: block.source.refs,
        estimatedTokens: 0,
        reason: "empty",
      });
      continue;
    }
    nonEmptyPrepared.push(prepareBlock(block));
  }

  const deduped: PreparedBlock[] = [];
  const byId = new Map<string, PreparedBlock[]>();
  for (const prepared of nonEmptyPrepared) {
    const group = byId.get(prepared.block.id);
    if (group === undefined) {
      byId.set(prepared.block.id, [prepared]);
    } else {
      group.push(prepared);
    }
  }

  for (const group of byId.values()) {
    const sorted = [...group].sort(compareDuplicateWinner);
    deduped.push(sorted[0]!);
    for (const duplicate of sorted.slice(1)) {
      dropped.push(toDroppedBlock(duplicate, "duplicate"));
    }
  }

  const conflictResolved: PreparedBlock[] = [];
  const byConflictKey = new Map<string, PreparedBlock[]>();
  for (const prepared of deduped) {
    const conflictKey = prepared.block.conflictKey;
    if (conflictKey === undefined) {
      conflictResolved.push(prepared);
      continue;
    }
    const group = byConflictKey.get(conflictKey);
    if (group === undefined) {
      byConflictKey.set(conflictKey, [prepared]);
    } else {
      group.push(prepared);
    }
  }

  for (const group of byConflictKey.values()) {
    const sorted = [...group].sort(compareConflictWinner);
    conflictResolved.push(sorted[0]!);
    for (const conflict of sorted.slice(1)) {
      dropped.push(toDroppedBlock(conflict, "conflict"));
    }
  }

  const mandatory = conflictResolved.filter((prepared) => prepared.block.retention === "mandatory");
  const optional = conflictResolved
    .filter((prepared) => prepared.block.retention === "optional")
    .sort(compareOptionalSelection);

  const selectedPrepared = [...mandatory];
  let selectedEstimatedTokens = FRAMING_ESTIMATED_TOKENS
    + mandatory.reduce((sum, prepared) => sum + prepared.estimatedTokens, 0);

  for (const prepared of optional) {
    if (selectedEstimatedTokens + prepared.estimatedTokens <= input.maxEstimatedTokens) {
      selectedPrepared.push(prepared);
      selectedEstimatedTokens += prepared.estimatedTokens;
      continue;
    }
    dropped.push(toDroppedBlock(prepared, "budget"));
  }

  const selected = selectedPrepared
    .map(toCompiledBlock)
    .sort(compareSelectedOutput);
  const sortedDropped = [...dropped].sort(compareDroppedOutput);
  const overflowEstimatedTokens = Math.max(0, selectedEstimatedTokens - input.maxEstimatedTokens);
  const manifest: NarrativeContextManifest = {
    compilerVersion: NARRATIVE_CONTEXT_COMPILER_VERSION,
    maxEstimatedTokens: input.maxEstimatedTokens,
    selectedEstimatedTokens,
    overflowEstimatedTokens,
    selected: selected.map((entry) => toManifestEntryFromSelected(entry)),
    dropped: sortedDropped.map((entry) => ({ ...toManifestEntryFromDropped(entry), reason: entry.reason })),
  };

  return {
    selected,
    dropped: sortedDropped,
    selectedEstimatedTokens,
    overflowEstimatedTokens,
    manifest,
  };
}
