import type { ContentIntensity, NarrativeStyle } from "@/game/domain/newGame";

// ---------------------------------------------------------------------------
// Task 8：开局呈现政策。
// 只承载呈现（呈现）信息——性格标签、叙事风格与内容强度只影响 AI/确定性叙述
// 的措辞与意象，绝不携带任何规则数值（stats/行动成败/奖励/预算）。规则层永远
// 不知道它的存在；本文件只被开局/场景提示词与确定性叙述消费。
// ---------------------------------------------------------------------------

/** 表单暴露的六个受控性格标签（最多选择 3 个）。 */
export const PERSONALITY_TRAIT_OPTIONS = [
  "冷静",
  "冲动",
  "善良",
  "多疑",
  "幽默",
  "寡言",
] as const;

export type PersonalityTrait = (typeof PERSONALITY_TRAIT_OPTIONS)[number];

/** 每个标签的呈现代言：只描述"怎么说/怎么演"，不存在规则含义。 */
const TRAIT_PORTRAYAL: Record<string, string> = {
  冷静: "沉着分析，情绪内敛",
  冲动: "敢作敢当，行动先于思考",
  善良: "心怀善意，优先体谅他人",
  多疑: "警惕他人，质疑表面说辞",
  幽默: "插科打诨，以轻松化解紧张",
  寡言: "惜字如金，以沉默观察局势",
};

const NARRATION_WORDS: Record<NarrativeStyle, string> = {
  concise: "行文简洁克制，短句直给，少修饰。",
  novel: "行文如小说，铺陈细腻，善用场景与心理描写。",
  cinematic: "行文如电影镜头，画面感强，注重节奏与镜头调度。",
};

export type StylePolicy = {
  readonly protagonistTraits: readonly string[];
  readonly narration: "concise" | "novel" | "cinematic";
  readonly intensity: "normal" | "dark";
  readonly narrationInstruction: string;
  readonly intensityInstruction: string;
};

/** 构建政策的输入：开局配置里呈现相关的字段。 */
export type StylePolicySource = {
  readonly personalityTags?: readonly string[];
  readonly narrativeStyle?: NarrativeStyle;
  readonly contentIntensity?: ContentIntensity;
};

/** 叙事指令：叙事风格基线 + 主角刻画 + 建议选项措辞（只影响呈现）。 */
export function buildNarrationInstruction(
  traits: readonly string[],
  narration: NarrativeStyle,
): string {
  const base = NARRATION_WORDS[narration];
  const traitPart = traits.length === 0
    ? "主角性格由剧情自然呈现。"
    : `主角刻画体现${traits
        .map((trait) => `${trait}（${TRAIT_PORTRAYAL[trait] ?? "相应性格"}）`)
        .join("、")}；建议选项的措辞贴合主角性格。`;
  return `${base}${traitPart}`;
}

/** 强度指令：dark 允许道德上艰难的结果与克制的暗色意象；normal 避免具体细节。 */
export function buildIntensityInstruction(intensity: ContentIntensity): string {
  if (intensity === "dark") {
    return "内容强度·黑暗：允许道德上艰难的结果与克制的暗色意象（阴影、谎言与代价可以出现，血腥细节适度隐去）。";
  }
  return "内容强度·普通：避免血腥与恐怖的具体细节，保持含蓄叙述。";
}

/** 把开局配置的呈现字段映射为完整 StylePolicy（缺省 → concise/normal/空标签）。 */
export function buildStylePolicy(source: StylePolicySource = {}): StylePolicy {
  const traits = source.personalityTags ?? [];
  const narration = source.narrativeStyle ?? "concise";
  const intensity = source.contentIntensity ?? "normal";
  return {
    protagonistTraits: [...traits],
    narration,
    intensity,
    narrationInstruction: buildNarrationInstruction(traits, narration),
    intensityInstruction: buildIntensityInstruction(intensity),
  };
}