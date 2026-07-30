export type GameTypeId =
  | "wuxia" | "xianxia" | "fantasy" | "science_fiction"
  | "urban" | "alternate_history" | "post_apocalypse";

export type NarrativeStyle = "concise" | "novel" | "cinematic";
export type ContentIntensity = "normal" | "dark";
export type GameLength = "short" | "medium" | "long" | "open";

export type NewGameInput = {
  gameType: GameTypeId;
  characterName: string;
  characterIdentity: string;
  characterProfile?: string;   // 角色基础信息, optional, max 300 chars
  personalityTags: string[];   // 0–3 tags, deduplicate before validating count
  worldPremise: string;        // 世界观背景, 20–500 chars
  storyOpening: string;        // 故事开端, 20–300 chars
  narrativeStyle: NarrativeStyle;
  contentIntensity: ContentIntensity;
  gameLength?: GameLength;
};

export type NewGameInputErrorCode =
  | "REQUIRED"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "INVALID_ENUM"
  | "BLANK"
  | "DUPLICATE_TAG"
  | "TOO_MANY_TAGS";

export type NewGameInputError = {
  field: keyof NewGameInput;
  code: NewGameInputErrorCode;
  params: Record<string, string | number>;
};

declare const validatedNewGameInputBrand: unique symbol;

/** 规范化后的输入：字段已 trim、标签已去空白。与原始 NewGameInput 类型不可互换。 */
export type ValidatedNewGameInput = NewGameInput & {
  gameLength: GameLength;
  readonly [validatedNewGameInputBrand]: true;
};

export type ValidateNewGameInputResult =
  | { ok: true; value: ValidatedNewGameInput }
  | { ok: false; errors: NewGameInputError[] };

const GAME_TYPE_IDS: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction",
  "urban", "alternate_history", "post_apocalypse"
];
const NARRATIVE_STYLES: readonly NarrativeStyle[] = ["concise", "novel", "cinematic"];
const CONTENT_INTENSITIES: readonly ContentIntensity[] = ["normal", "dark"];
const GAME_LENGTHS: readonly GameLength[] = ["short", "medium", "long", "open"];

const LIMITS = {
  characterName: { min: 2, max: 20 },
  characterIdentity: { min: 2, max: 80 },
  characterProfile: { max: 300 },
  worldPremise: { min: 20, max: 500 },
  storyOpening: { min: 20, max: 300 },
  personalityTags: { max: 3 }
} as const;

/** 以 Unicode code point 计数，而非 UTF-16 单元。 */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function validateNewGameInput(input: NewGameInput): ValidateNewGameInputResult {
  const errors: NewGameInputError[] = [];

  const characterName = validateRequiredText(errors, "characterName", input.characterName, LIMITS.characterName);
  const characterIdentity = validateRequiredText(errors, "characterIdentity", input.characterIdentity, LIMITS.characterIdentity);
  const worldPremise = validateRequiredText(errors, "worldPremise", input.worldPremise, LIMITS.worldPremise);
  const storyOpening = validateRequiredText(errors, "storyOpening", input.storyOpening, LIMITS.storyOpening);
  const characterProfile = validateProfile(errors, input.characterProfile);
  const personalityTags = validateTags(errors, input.personalityTags);
  validateEnum(errors, "gameType", input.gameType, GAME_TYPE_IDS);
  validateEnum(errors, "narrativeStyle", input.narrativeStyle, NARRATIVE_STYLES);
  validateEnum(errors, "contentIntensity", input.contentIntensity, CONTENT_INTENSITIES);
  // 时长档位：缺省视为 open（不选=随剧情推演）
  const gameLength = input.gameLength ?? "open";
  validateEnum(errors, "gameLength", gameLength, GAME_LENGTHS);

  if (errors.length > 0) return { ok: false, errors };

  const value = {
    gameType: input.gameType,
    characterName,
    characterIdentity,
    characterProfile,
    personalityTags,
    worldPremise,
    storyOpening,
    narrativeStyle: input.narrativeStyle,
    contentIntensity: input.contentIntensity,
    gameLength
  } as ValidatedNewGameInput;
  return { ok: true, value };
}

function validateRequiredText(
  errors: NewGameInputError[],
  field: keyof NewGameInput,
  raw: string,
  limits: { min: number; max: number }
): string {
  const trimmed = raw.trim();
  const actual = codePointLength(trimmed);
  if (actual === 0) {
    errors.push({ field, code: "REQUIRED", params: {} });
  } else if (actual < limits.min) {
    errors.push({ field, code: "TOO_SHORT", params: { min: limits.min, actual } });
  } else if (actual > limits.max) {
    errors.push({ field, code: "TOO_LONG", params: { max: limits.max, actual } });
  }
  return trimmed;
}

function validateProfile(errors: NewGameInputError[], raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const actual = codePointLength(trimmed);
  if (actual > LIMITS.characterProfile.max) {
    errors.push({
      field: "characterProfile",
      code: "TOO_LONG",
      params: { max: LIMITS.characterProfile.max, actual }
    });
  }
  return trimmed;
}

function validateTags(errors: NewGameInputError[], raw: readonly string[]): string[] {
  const trimmed = raw.map((tag) => tag.trim());
  trimmed.forEach((tag, index) => {
    if (tag === "") errors.push({ field: "personalityTags", code: "BLANK", params: { index } });
  });

  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const tag of trimmed) {
    if (tag === "") continue;
    if (seen.has(tag) && !reported.has(tag)) {
      errors.push({ field: "personalityTags", code: "DUPLICATE_TAG", params: { tag } });
      reported.add(tag);
    }
    seen.add(tag);
  }

  if (seen.size > LIMITS.personalityTags.max) {
    errors.push({
      field: "personalityTags",
      code: "TOO_MANY_TAGS",
      params: { max: LIMITS.personalityTags.max, actual: seen.size }
    });
  }
  return trimmed;
}

function validateEnum(
  errors: NewGameInputError[],
  field: keyof NewGameInput,
  value: string,
  allowed: readonly string[]
): void {
  if (!allowed.includes(value)) {
    errors.push({ field, code: "INVALID_ENUM", params: { value } });
  }
}
