// ---------------------------------------------------------------------------
// storyEvalStrategy：评估旅程的确定性选择策略（spec §7）。
// 只依赖评估专用 repository 读取结果的结构化子集（本地 StoryEvalGameRecord，
// 与真实 GameRecord/GameState 结构兼容），不经过客户端投影，
// 不触碰 entry points 安全红线。PRNG 为 mulberry32 级别，种子稳定可复现。
// ---------------------------------------------------------------------------

import type { NewGameInput } from "@/game/domain";

/** GameRecord.state 的本地结构化子集：仅含策略实际读取的字段（边界守卫要求
 *  application 层不 import server 端口实现；真实 GameRecord/GameState 可赋值给本类型）。
 *  id 字段为 unknown：策略只做 String() 归一比较，不依赖 id 的具体品牌类型。 */
type StoryEvalGameRecord = Readonly<{
  state: Readonly<{
    readonly visitedLocationIds: readonly unknown[];
    readonly npcs: readonly Readonly<{ readonly npcId: unknown; readonly met: boolean }>[];
    readonly worldFacts: readonly Readonly<{ readonly factId: unknown; readonly discovered: boolean }>[];
    readonly narrative: Readonly<{
      readonly currentScene: Readonly<{
        readonly choices: readonly { readonly actionKey: string }[];
      }> | null;
    }>;
  }>;
}>;

/** mulberry32：32 位种子 PRNG，返回 [0,1) 均匀序列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意字符串稳定散列为 32 位种子（FNV-1a 变体）。 */
export function hashStringToSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function splitAction(actionKey: string): { kind: string; target: string } {
  const separator = actionKey.indexOf(":");
  if (separator < 0) return { kind: actionKey, target: "" };
  return { kind: actionKey.slice(0, separator), target: actionKey.slice(separator + 1) };
}

/**
 * 行动是否为探索性：前往未访问地点 / 与未见 NPC 交谈 / 调查未发现事实 /
 * 拾取物品（功能推进）。move/talk/investigate 是否探索取决于 GameRecord 状态。
 */
export function isExploratory(actionKey: string, record: StoryEvalGameRecord): boolean {
  const { kind, target } = splitAction(actionKey);
  if (kind === "take_item") return true;
  if (kind === "investigate") {
    const fact = record.state.worldFacts.find((entry) => String(entry.factId) === target);
    return fact === undefined || !fact.discovered;
  }
  if (kind === "move") {
    return !record.state.visitedLocationIds.some((id) => String(id) === target);
  }
  if (kind === "talk") {
    const npc = record.state.npcs.find((entry) => String(entry.npcId) === target);
    return npc === undefined || !npc.met;
  }
  return false;
}

/** 探索优先选择：唯一探索选项必选；同类掷硬币；无探索随机。返回下标与理由（记入 story.jsonl）。 */
export function pickNarrativeChoice(
  record: StoryEvalGameRecord,
  rand: () => number,
): { index: 0 | 1; reason: "explore" | "random" } {
  const choices = record.state.narrative.currentScene?.choices ?? [];
  if (choices.length !== 2) return { index: 0, reason: "random" };
  const exploreIndexes = choices
    .map((choice, index) => (isExploratory(choice.actionKey, record) ? index : -1))
    .filter((index): index is 0 | 1 => index === 0 || index === 1);
  if (exploreIndexes.length === 1) return { index: exploreIndexes[0], reason: "explore" };
  if (exploreIndexes.length === 2) return { index: rand() < 0.5 ? 0 : 1, reason: "explore" };
  return { index: rand() < 0.5 ? 0 : 1, reason: "random" };
}

/** 评估旅程固定开局：合法 long/short 输入（满足 domain 校验下限），seed 仅作参考。 */
export function buildStoryEvalInput(
  gameLength: "long" | "short",
  seed: number,
): { input: NewGameInput; seed: number } {
  return {
    input: {
      gameType: "wuxia",
      characterName: "沈孤鸿",
      characterIdentity: "落魄镖师",
      personalityTags: ["重义", "沉默"],
      worldPremise: "江湖动荡，镖局衰败，各派为一部失传剑谱明争暗斗，庙堂亦暗中插手。",
      storyOpening: "雨夜押镖入城，镖车半路被劫，唯一线索是一枚寒山派的青铜令牌。",
      narrativeStyle: "concise",
      contentIntensity: "normal",
      gameLength,
    },
    seed,
  };
}
