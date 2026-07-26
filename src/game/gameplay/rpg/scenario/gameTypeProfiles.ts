import type { GameTypeId } from "@/game/domain";
import defaultArtStyleProfiles from "../../../../../data/base/artStyleProfiles.json";
import defaultGameTypeProfiles from "../../../../../data/base/gameTypeProfiles.json";

export type GameTypeProfile = {
  id: GameTypeId;
  label: string;
  worldConstraints: string[];
  allowedTags: string[];
  forbiddenTags: string[];
  namingGuide: string[];
  artStyleProfileId: string;
};

export type ArtStyleProfile = {
  id: string;
  promptPrefix: string;
  palette: string;
  texture: string;
  composition: string;
  negativePrompt: string;
};

export type ScenarioConfigIssueCode =
  | "INVALID_TYPE"
  | "REQUIRED"
  | "MISSING_GAME_TYPE"
  | "UNKNOWN_GAME_TYPE"
  | "ID_KEY_MISMATCH"
  | "UNKNOWN_ART_STYLE"
  | "EMPTY_LIST"
  | "BLANK_ENTRY"
  | "DUPLICATE_ENTRY";

export type ScenarioConfigIssue = {
  path: string;
  code: ScenarioConfigIssueCode;
  params: Record<string, string | number>;
};

/** 配置错误面向开发者：加载即抛出，携带全部结构化问题，禁止吞掉部分问题。 */
export class ScenarioConfigError extends Error {
  readonly issues: readonly ScenarioConfigIssue[];

  constructor(issues: readonly ScenarioConfigIssue[]) {
    super(
      `场景配置校验失败（${issues.length} 个问题）：` +
        issues.map((issue) => `${issue.path}:${issue.code}`).join("; ")
    );
    this.name = "ScenarioConfigError";
    this.issues = issues;
  }
}

export type RawScenarioConfig = {
  gameTypeProfiles: unknown;
  artStyleProfiles: unknown;
};

export type ScenarioProfiles = {
  gameTypeProfiles: Readonly<Record<GameTypeId, GameTypeProfile>>;
  artStyleProfiles: Readonly<Record<string, ArtStyleProfile>>;
};

const GAME_TYPE_IDS: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction",
  "urban", "alternate_history", "post_apocalypse"
];

const PROFILE_LIST_FIELDS = ["worldConstraints", "allowedTags", "forbiddenTags", "namingGuide"] as const;
const ART_STYLE_TEXT_FIELDS = ["promptPrefix", "palette", "texture", "composition", "negativePrompt"] as const;

/** 校验并加载类型与艺术风格配置。默认读取 data/base 下的 JSON；测试可注入原始数据。 */
export function loadScenarioProfiles(
  raw: RawScenarioConfig = {
    gameTypeProfiles: defaultGameTypeProfiles,
    artStyleProfiles: defaultArtStyleProfiles
  }
): ScenarioProfiles {
  const issues: ScenarioConfigIssue[] = [];
  const artStyleKeys = validateArtStyles(issues, raw.artStyleProfiles);
  validateGameTypes(issues, raw.gameTypeProfiles, artStyleKeys);
  if (issues.length > 0) throw new ScenarioConfigError(issues);

  return {
    gameTypeProfiles: raw.gameTypeProfiles as Record<GameTypeId, GameTypeProfile>,
    artStyleProfiles: raw.artStyleProfiles as Record<string, ArtStyleProfile>
  };
}

function validateArtStyles(issues: ScenarioConfigIssue[], raw: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!isRecord(raw)) {
    issues.push({ path: "artStyleProfiles", code: "INVALID_TYPE", params: { expected: "object" } });
    return keys;
  }
  for (const [key, style] of Object.entries(raw)) {
    // 即使风格内容有问题，key 也计入存在集合，避免连带产生 UNKNOWN_ART_STYLE 噪音。
    keys.add(key);
    const path = `artStyleProfiles.${key}`;
    if (!isRecord(style)) {
      issues.push({ path, code: "INVALID_TYPE", params: { expected: "object" } });
      continue;
    }
    const id = validateText(issues, `${path}.id`, style.id);
    if (id !== undefined && id !== key) {
      issues.push({ path: `${path}.id`, code: "ID_KEY_MISMATCH", params: { key, id } });
    }
    for (const field of ART_STYLE_TEXT_FIELDS) {
      validateText(issues, `${path}.${field}`, style[field]);
    }
  }
  return keys;
}

function validateGameTypes(
  issues: ScenarioConfigIssue[],
  raw: unknown,
  artStyleKeys: ReadonlySet<string>
): void {
  if (!isRecord(raw)) {
    issues.push({ path: "gameTypeProfiles", code: "INVALID_TYPE", params: { expected: "object" } });
    return;
  }
  for (const id of GAME_TYPE_IDS) {
    if (!(id in raw)) {
      issues.push({ path: "gameTypeProfiles", code: "MISSING_GAME_TYPE", params: { id } });
    }
  }
  for (const [key, profile] of Object.entries(raw)) {
    const path = `gameTypeProfiles.${key}`;
    if (!GAME_TYPE_IDS.includes(key as GameTypeId)) {
      issues.push({ path, code: "UNKNOWN_GAME_TYPE", params: { key } });
      continue;
    }
    if (!isRecord(profile)) {
      issues.push({ path, code: "INVALID_TYPE", params: { expected: "object" } });
      continue;
    }
    const id = validateText(issues, `${path}.id`, profile.id);
    if (id !== undefined && id !== key) {
      issues.push({ path: `${path}.id`, code: "ID_KEY_MISMATCH", params: { key, id } });
    }
    validateText(issues, `${path}.label`, profile.label);
    for (const field of PROFILE_LIST_FIELDS) {
      validateStringList(issues, `${path}.${field}`, profile[field]);
    }
    const artStyleProfileId = validateText(issues, `${path}.artStyleProfileId`, profile.artStyleProfileId);
    if (artStyleProfileId !== undefined && !artStyleKeys.has(artStyleProfileId)) {
      issues.push({
        path: `${path}.artStyleProfileId`,
        code: "UNKNOWN_ART_STYLE",
        params: { artStyleProfileId }
      });
    }
  }
}

/** 必填文本：必须是非空白字符串；通过时返回原值，否则记录问题并返回 undefined。 */
function validateText(issues: ScenarioConfigIssue[], path: string, value: unknown): string | undefined {
  if (typeof value !== "string") {
    issues.push({ path, code: "INVALID_TYPE", params: { expected: "string" } });
    return undefined;
  }
  if (value.trim() === "") {
    issues.push({ path, code: "REQUIRED", params: {} });
    return undefined;
  }
  return value;
}

/** 字符串列表：非空数组、逐项非空白、无重复（重复值只报一次）。 */
function validateStringList(issues: ScenarioConfigIssue[], path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    issues.push({ path, code: "INVALID_TYPE", params: { expected: "string[]" } });
    return;
  }
  if (value.length === 0) {
    issues.push({ path, code: "EMPTY_LIST", params: {} });
    return;
  }
  const entries: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      issues.push({ path: `${path}[${index}]`, code: "INVALID_TYPE", params: { expected: "string" } });
    } else if (entry.trim() === "") {
      issues.push({ path: `${path}[${index}]`, code: "BLANK_ENTRY", params: { index } });
    } else {
      entries.push(entry);
    }
  });
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry) && !reported.has(entry)) {
      issues.push({ path, code: "DUPLICATE_ENTRY", params: { value: entry } });
      reported.add(entry);
    }
    seen.add(entry);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
