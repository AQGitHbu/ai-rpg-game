import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ScenarioBlueprintCandidate } from "@/game/domain";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  SCENARIO_CANDIDATE_FAILURE_CATEGORIES,
  type ScenarioCandidateAttempt,
  type ScenarioCandidateFailureCategory,
  type ScenarioCandidateSource
} from "../../scenarioGeneration";

// ---------------------------------------------------------------------------
// Phase 4A server-only fixture source（spec §3）。
//
// 只读 data/fixtures/phase4 形态的目录（root 由调用方注入，测试用临时目录）。
// 约束：
// - 只使用 node:fs/promises、node:path 与纯 port/domain 类型；不 import repository。
// - manifest file 路径不得逃出 fixtureRoot；异常一律映射 service_error。
// - diagnostics 只含稳定代码，不含 prompt、玩家原文或原始响应内容。
// - candidate 返回前只做结构存在性检查（root object、各数组、三个子 object）；
//   完整业务校验仍由既有 validateScenarioBlueprintCandidate 负责。
// ---------------------------------------------------------------------------

export type FixtureScenarioCandidateSourceOptions = Readonly<{
  fixtureRoot: string;
  fixtureId: string;
}>;

type ManifestEntry = { id: string; file: string };

const CANDIDATE_ARRAY_FIELDS = [
  "locations",
  "npcs",
  "quests",
  "items",
  "enemies",
  "endings"
] as const;

const CANDIDATE_OBJECT_FIELDS = ["world", "openingScene", "player", "startAnchor", "endingDirection"] as const;

const FAILURE_CATEGORY_SET: ReadonlySet<string> = new Set(SCENARIO_CANDIDATE_FAILURE_CATEGORIES);

export function createFixtureScenarioCandidateSource(
  options: FixtureScenarioCandidateSourceOptions
): ScenarioCandidateSource {
  return {
    async generate() {
      try {
        return await loadAttempt(options);
      } catch {
        // 读盘/解析等基础设施异常：不泄漏 message，映射稳定 service_error。
        return failure("service_error", ["FIXTURE_SOURCE_ERROR"]);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

async function loadAttempt(
  options: FixtureScenarioCandidateSourceOptions
): Promise<ScenarioCandidateAttempt> {
  const entry = await resolveManifestEntry(options);
  if (!entry.ok) return entry.attempt;

  const filePath = path.resolve(options.fixtureRoot, entry.value.file);
  const rootPrefix = `${path.resolve(options.fixtureRoot)}${path.sep}`;
  if (!filePath.startsWith(rootPrefix)) {
    return failure("service_error", ["FIXTURE_PATH_ESCAPE"]);
  }

  let rawText: string;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch {
    return failure("service_error", ["FIXTURE_FILE_UNREADABLE"]);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return failure("service_error", ["FIXTURE_FILE_MALFORMED"]);
  }
  if (!isRecord(payload)) {
    return failure("service_error", ["FIXTURE_FILE_MALFORMED"]);
  }

  // 故障模式 fixture：直接按声明类别失败。
  if (typeof payload.failureMode === "string") {
    if (!FAILURE_CATEGORY_SET.has(payload.failureMode)) {
      return failure("service_error", ["FIXTURE_FAILURE_MODE_UNKNOWN"]);
    }
    return failure(
      payload.failureMode as ScenarioCandidateFailureCategory,
      sanitizeDiagnostics(payload.diagnostics)
    );
  }

  // 坏响应 fixture：responseText 解析失败即 invalid_json。
  if (typeof payload.responseText === "string") {
    try {
      payload = { candidate: JSON.parse(payload.responseText) };
    } catch {
      return failure("invalid_json", ["FIXTURE_INVALID_JSON"]);
    }
  }

  const candidate = (payload as Record<string, unknown>).candidate;
  if (!hasCandidateShape(candidate)) {
    return failure("schema_violation", ["FIXTURE_CANDIDATE_SHAPE_INVALID"]);
  }
  return {
    ok: true,
    contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
    origin: "fixture",
    candidate: candidate as unknown as ScenarioBlueprintCandidate,
    diagnostics: []
  };
}

async function resolveManifestEntry(
  options: FixtureScenarioCandidateSourceOptions
): Promise<{ ok: true; value: ManifestEntry } | { ok: false; attempt: ScenarioCandidateAttempt }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(options.fixtureRoot, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, attempt: failure("service_error", ["FIXTURE_MANIFEST_UNREADABLE"]) };
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.fixtures)) {
    return { ok: false, attempt: failure("service_error", ["FIXTURE_MANIFEST_MALFORMED"]) };
  }
  if (manifest.contractVersion !== SCENARIO_CANDIDATE_CONTRACT_VERSION) {
    return { ok: false, attempt: failure("service_error", ["FIXTURE_MANIFEST_CONTRACT_MISMATCH"]) };
  }
  const entry = manifest.fixtures.find(
    (item: unknown): item is ManifestEntry =>
      isRecord(item) && item.id === options.fixtureId && typeof item.file === "string"
  );
  if (entry === undefined) {
    return { ok: false, attempt: failure("service_error", ["FIXTURE_ID_UNKNOWN"]) };
  }
  return { ok: true, value: entry };
}

function failure(
  category: ScenarioCandidateFailureCategory,
  diagnostics: readonly string[]
): ScenarioCandidateAttempt {
  return {
    ok: false,
    contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
    origin: "fixture",
    category,
    diagnostics
  };
}

/** 结构存在性检查：根 object、六个数组字段、三个 object 字段。 */
function hasCandidateShape(candidate: unknown): candidate is Record<string, unknown> {
  if (!isRecord(candidate)) return false;
  for (const field of CANDIDATE_ARRAY_FIELDS) {
    if (!Array.isArray(candidate[field])) return false;
  }
  for (const field of CANDIDATE_OBJECT_FIELDS) {
    if (!isRecord(candidate[field])) return false;
  }
  return true;
}

/** 诊断码白名单化：只保留短字符串，杜绝把原始响应塞进 diagnostics。 */
function sanitizeDiagnostics(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length <= 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
