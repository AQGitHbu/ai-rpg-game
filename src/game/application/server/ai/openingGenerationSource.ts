import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { OpeningGenerationSource } from "../../createGame";
import { createFixtureOpeningSource } from "../../createGame";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { parseOpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { GameLength, GameSetup } from "@/game/domain/newGame";
import { validateOpeningGenerationCandidate } from "@/game/gameplay/rpg/openingGeneration";
import { TARGET_ACTS } from "@/game/domain/storyBudget";
import { buildStylePolicy } from "../../stylePolicy";
import { createProviderRequestOptions, type ProviderJsonMode } from "./providerRequestOptions";

// ---------------------------------------------------------------------------
// 开局生成源（live/fixture）。
//
// 编排：AI 原始 JSON → schema parse → 机械修复（无创意）→ 引用完整性修复 →
// 纯 validator → 确定性 fallback（fixture 必须通过同一 validator/compiler）。
// 机械修复只允许空数组/空字符串/数值回退等无创意修复；不得修改剧情语义。
// 敏感信息不进入日志。
// ---------------------------------------------------------------------------

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 机械修复：只做无创意、可推导的修复。返回是否发生变更。
//   - 数组字段为 null/非数组 → 空数组；
//   - 字符串字段为 null/非字符串 → 空字符串；
//   - 旧候选数值字段非法 → fixture 默认（仅为旧 fixture 解析兼容，编译阶段不采纳）；
//   不修改剧情语义、不新增/删除实体、不重写文本。
export function repairOpeningGenerationCandidate(
  raw: unknown,
): { readonly candidate: OpeningGenerationCandidate | null; readonly repaired: boolean } {
  if (!isRecord(raw)) return { candidate: null, repaired: false };
  let repaired = false;

  const fixArray = (v: unknown): readonly unknown[] => {
    if (Array.isArray(v)) return v;
    repaired = true;
    return [];
  };
  const fixString = (v: unknown): string => {
    if (typeof v === "string" && v !== "") return v;
    repaired = true;
    return "";
  };

  const world = isRecord(raw.world) ? raw.world : null;
  const player = isRecord(raw.player) ? raw.player : null;
  const storyContract = isRecord(raw.storyContract) ? raw.storyContract : null;
  const opening = isRecord(raw.opening) ? raw.opening : null;
  if (world === null || player === null || storyContract === null || opening === null) {
    return { candidate: null, repaired: repaired || true };
  }

  const rawBase = isRecord(player.baseStats) ? player.baseStats : null;
  // 缺省/非法数值回退 fixture 默认（100/10/5），避免 AI 用自定义属性键时生成 0 HP 不可玩开局。
  const pickStat = (key: "hp" | "attack" | "defense", fallback: number): number => {
    const value = rawBase?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    repaired = true;
    return fallback;
  };

  const fixed: Record<string, unknown> = {
    ...raw,
    world: {
      ...world,
      summary: fixString(world.summary),
      tone: fixString(world.tone),
      themes: fixArray(world.themes),
      publicFacts: fixArray(world.publicFacts),
    },
    player: {
      ...player,
      name: fixString(player.name),
      identity: fixString(player.identity),
      backgroundSummary: fixString(player.backgroundSummary),
      baseStats: {
        hp: pickStat("hp", 100),
        attack: pickStat("attack", 10),
        defense: pickStat("defense", 5),
      },
    },
    storyContract: {
      ...storyContract,
      centralConflict: fixString(storyContract.centralConflict),
      endingDirections: fixArray(storyContract.endingDirections),
    },
    opening: {
      location: (() => {
        const location = isRecord(opening.location) ? opening.location : null;
        if (location === null) {
          repaired = true;
          return { name: "", description: "", scale: "town" };
        }
        return {
          ...location,
          name: fixString(location.name),
          description: fixString(location.description),
        };
      })(),
      npc: (() => {
        const npc = isRecord(opening.npc) ? opening.npc : null;
        if (npc === null) {
          repaired = true;
          return { name: "", role: "", description: "", knownFactKeys: [], privateFactKeys: [], goals: [] };
        }
        return {
          ...npc,
          name: fixString(npc.name),
          role: fixString(npc.role),
          description: fixString(npc.description),
          knownFactKeys: fixArray(npc.knownFactKeys),
          privateFactKeys: fixArray(npc.privateFactKeys),
          goals: fixArray(npc.goals),
        };
      })(),
      quest: (() => {
        const quest = isRecord(opening.quest) ? opening.quest : null;
        if (quest === null) {
          repaired = true;
          return { name: "", description: "", objective: { kind: "talk_to_opening_npc" } };
        }
        return {
          ...quest,
          name: fixString(quest.name),
          description: fixString(quest.description),
        };
      })(),
    },
  };

  const parsed = parseOpeningGenerationCandidate(fixed);
  if (!parsed.ok) return { candidate: null, repaired: repaired || true };
  return { candidate: parsed.value, repaired };
}

// 引用完整性修复：过滤 NPC known/private fact keys 中不存在于 publicFacts 的
// 悬空引用。不新增实体、不修改文本，仅保证引用闭合，属无创意修复。
export function sanitizeOpeningFactReferences(
  candidate: OpeningGenerationCandidate,
): OpeningGenerationCandidate {
  const factKeys = new Set(candidate.world.publicFacts.map((fact) => fact.key));
  const known = candidate.opening.npc.knownFactKeys.filter((key) => factKeys.has(key));
  const privateKeys = candidate.opening.npc.privateFactKeys.filter((key) => factKeys.has(key));
  if (known.length === candidate.opening.npc.knownFactKeys.length
    && privateKeys.length === candidate.opening.npc.privateFactKeys.length) {
    return candidate;
  }
  return {
    ...candidate,
    opening: {
      ...candidate.opening,
      npc: { ...candidate.opening.npc, knownFactKeys: known, privateFactKeys: privateKeys },
    },
  };
}

export type OpeningGenerationSourceDeps = {
  readonly transport?: AiTransport;
  readonly config?: AiTransportConfig;
  readonly jsonMode?: ProviderJsonMode;
  readonly logger?: GameLogger;
  /** 生产 live 模式关闭静默 fixture 降级，保证开局设计确实来自 API。 */
  readonly allowFallback?: boolean;
  /** 只回传安全来源标记；用于严格区分 AI 成功和可恢复 fallback。 */
  readonly onResult?: (result: OpeningGenerationResultMarker) => void;
};

export type OpeningGenerationResultMarker = Readonly<{
  readonly seed: string;
  readonly source: "generated" | "fallback";
}>;

// live 开局源：AI 产出 → parse → 机械修复 → 引用修复 → 校验 → 失败回退 fixture。
// fixture 必须通过同一 validator/compiler（由 createFixtureOpeningSource 保证）。
export function createOpeningGenerationSource(
  deps: OpeningGenerationSourceDeps,
): OpeningGenerationSource {
  const fixture = createFixtureOpeningSource();
  const { transport, config, logger, jsonMode, onResult } = deps;

  return {
    async generate(input) {
      const fallback = async (): Promise<OpeningGenerationCandidate> => {
        if (deps.allowFallback === false) {
          throw new Error("LIVE_OPENING_UNAVAILABLE");
        }
        onResult?.({ seed: input.seed, source: "fallback" });
        return fixture.generate(input);
      };
      const generated = (candidate: OpeningGenerationCandidate): OpeningGenerationCandidate => {
        onResult?.({ seed: input.seed, source: "generated" });
        return candidate;
      };
      // 无 transport/config：确定性 fallback（fixture 通过同一 validator/compiler）。
      if (!transport || !config) {
        return fallback();
      }

      try {
        // 推理模型偶发返回空内容（empty_response）或瞬时超时：
        // 对瞬时失败最多重试一次，仍失败再走确定性 fallback。
        let result = await transport.complete(config, [
          { role: "system", content: buildOpeningPrompt(input) },
          { role: "user", content: `生成游戏类型 ${input.gameType} / 长度 ${input.gameLength} / 种子 ${input.seed} 的开场切片。` },
        ], createProviderRequestOptions(240_000, undefined, jsonMode));
        if (!result.ok && (result.code === "empty_response" || result.code === "timeout" || result.code === "service_error")) {
          logger?.warn("opening_generation_retry", { code: result.code });
          result = await transport.complete(config, [
            { role: "system", content: buildOpeningPrompt(input) },
            { role: "user", content: `生成游戏类型 ${input.gameType} / 长度 ${input.gameLength} / 种子 ${input.seed} 的开场切片。` },
          ], createProviderRequestOptions(240_000, undefined, jsonMode));
        }

        if (!result.ok) {
          logger?.warn("opening_generation_ai_failed", { code: result.code });
          return fallback();
        }
        const parsed = parseJsonResponse(result.content);
        if (parsed === null) {
          logger?.warn("opening_generation_parse_failed", { reason: "json_parse_error" });
          return fallback();
        }

        // 机械修复（无创意）后走同一 schema parser + validator。
        const repaired = repairOpeningGenerationCandidate(parsed);
        if (repaired.candidate === null) {
          logger?.warn("opening_generation_repair_failed", { reason: "schema_invalid" });
          return fallback();
        }

        // 引用完整性修复（无创意）：NPC fact key 必须存在于 publicFacts，
        // 删除悬空引用不改剧情语义，避免整局回退 fixture 丢失玩家世界观。
        const sanitized = sanitizeOpeningFactReferences(repaired.candidate);

        const validated = validateOpeningGenerationCandidate(sanitized, {
          gameLength: input.gameLength,
          targetActs: TARGET_ACTS[input.gameLength],
        });
        if (!validated.ok) {
          logger?.warn("opening_generation_validation_failed", {
            reason: validated.issues[0]?.code ?? "unknown",
            issueCount: validated.issues.length,
          });
          return fallback();
        }
        // 玩家开局配置是权威输入：无论 AI 返回什么，角色名/身份/背景必须以配置为准。
        if (input.setup !== undefined) {
          const candidate = validated.validated;
          return generated({
            ...candidate,
            player: {
              ...candidate.player,
              name: input.setup.characterName,
              identity: input.setup.characterIdentity,
              backgroundSummary: input.setup.characterProfile ?? candidate.player.backgroundSummary,
            },
          });
        }
        return generated(validated.validated);
      } catch (error) {
        logger?.warn("opening_generation_transport_failed", { message: (error as Error)?.message });
        return fallback();
      }
    },
  };
}

function buildOpeningPrompt(input: { gameType: string; gameLength: GameLength; seed: string; setup?: GameSetup }): string {
  const targetActs = TARGET_ACTS[input.gameLength];
  const setup = input.setup;
  const setupSection = setup === undefined
    ? ""
    : (() => {
        const policy = buildStylePolicy(setup);
        return `
玩家已提交开局配置，开场切片必须围绕它构建：
- 主角姓名：${setup.characterName}（player.name 必须原样返回，不得更改）
- 主角身份/职业：${setup.characterIdentity}（player.identity 必须原样返回）
${setup.characterProfile !== undefined && setup.characterProfile !== "" ? `- 主角背景（写入 player.backgroundSummary）：${setup.characterProfile}\n` : ""}- 世界观背景（world.summary/publicFacts/开场地点与 NPC 设定必须与之吻合）：${setup.worldPremise}
- 故事开端（开场地点、开场 NPC 与首个任务必须服务于这个开端）：${setup.storyOpening}
- 叙事风格：${policy.narration}（所有文本描述遵循该风格）
- 角色标签：${policy.protagonistTraits.join("、") || "无"}（只影响呈现风格，不得改变规则数值）
- 内容强度：${policy.intensity}（影响描写的克制程度，不得改变规则数值）
- 呈现指令：${policy.narrationInstruction}
- 强度指令：${policy.intensityInstruction}
`;
      })();
  return `你是一个 RPG 世界设计师。只生成游戏的开场切片，返回严格 JSON（fact key 为普通字符串；实体 ID 一律由服务端铸造，你不得提供实体 ID）。
游戏类型：${input.gameType}
游戏长度：${input.gameLength}
种子：${input.seed}
${setupSection}
要求：
1. world：summary/tone/themes/publicFacts（key 必须形如 fact_xxx，且全局唯一）
2. player：name/identity/backgroundSummary；战斗属性由服务端规则配置，禁止生成 baseStats
3. prologue：故事序幕（2-3 句），聚焦故事钩子、主角动机和背景冲突：说明主角为什么会来到这条故事线上、什么未解事件或危险正在逼近、以及为什么值得继续行动。它可以提及已确定的世界背景，但不是当前地点的感官镜头；不要描写雨声、光线、气味、脚步、材质等即时细节，不要写 NPC 台词、玩家选项或完整场景表演
4. storyContract：version=1、targetActs=${targetActs}（必须与档位一致）、centralConflict、endingDirections 恰好两个（key 分别为 "trust" 与 "doubt"）
5. opening.location：开场地点，scale 必须是 "town"（小镇层级）
6. opening.npc：开场焦点 NPC，knownFactKeys/privateFactKeys 必须且只能引用 world.publicFacts 中已定义的 fact key
7. opening.quest：首个主线任务，objective 只能是 { "kind": "talk_to_opening_npc" }

不得生成未来：不得输出任何未来地点、未来 NPC、未来任务、敌人、物品或结局；世界只存在开场切片的这一个地点、一个 NPC、一个任务。
叙事职责边界：prologue 只回答“为什么要继续这段故事”，通过故事钩子、人物动机和背景冲突建立期待；不要抢写首个场景的空间氛围或即时感官体验，首个场景的 atmosphere 段由场景表演源负责。
必须严格使用以下字段名与嵌套结构（禁止改名）：
{
  "world": { "summary": "...", "tone": "...", "themes": ["..."], "publicFacts": [{ "key": "fact_xxx", "text": "..." }] },
  "player": { "name": "...", "identity": "...", "backgroundSummary": "..." },
  "prologue": "...",
  "storyContract": { "version": 1, "targetActs": ${targetActs}, "centralConflict": "...", "endingDirections": [{ "key": "trust", "theme": "..." }, { "key": "doubt", "theme": "..." }] },
  "opening": {
    "location": { "name": "...", "description": "...", "scale": "town" },
    "npc": { "name": "...", "role": "...", "description": "...", "knownFactKeys": ["fact_xxx"], "privateFactKeys": [], "goals": [] },
    "quest": { "name": "...", "description": "...", "objective": { "kind": "talk_to_opening_npc" } }
  }
}
只返回 JSON，不要其他文字。`;
}
