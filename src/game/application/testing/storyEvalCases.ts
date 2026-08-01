// ---------------------------------------------------------------------------
// storyEvalCases：v2 评测集（spec §7 + Task 13）。
// 数据事实源：data/story-eval/cases/v2.json（6 个固定 long case：
// wuxia / science_fiction / urban 各两种不同主线前提）。
// 门禁脚本对每个 case 生成两个 StoryEvalRun（explore 与 objective），
// 真实基线共 12 条主旅程；--case=<caseId> 只用于试点或定向复测，
// 不能改变 case 输入。本模块承载 case/run/S4 预测类型；证据包与完整性
// 类型定义于 storyEvalArtifacts.ts，此处再导出（brief 要求本模块
// 同时暴露 case/evidence 类型面，遵循 Files/Interfaces 归属）。
// ---------------------------------------------------------------------------

import type { NewGameInput } from "@/game/domain";
import casesData from "../../../../data/story-eval/cases/v2.json";

/** 单个评测 case：caseId 全局唯一，input 固定且通过 domain 校验。 */
export type StoryEvalCase = Readonly<{
  caseId: string;
  input: NewGameInput; // gameLength 固定为 "long"
}>;

/** 一条主旅程的运行规格：case × 策略。 */
export type StoryEvalRun = Readonly<{
  caseId: string;
  strategy: "explore" | "objective";
}>;

/** 单场景评审证据包（C1/C2 输入；字段不足时相应维度不得评分）。 */
export type StoryEvalEvidence = import("./storyEvalArtifacts").StoryEvalEvidence;

/** 产物完整性校验结果：complete=false 时 missing 列出缺失项，不可进入分析/评审。 */
export type StoryEvalCompleteness = import("./storyEvalArtifacts").StoryEvalCompleteness;

/** S4 早期预测评分（确定性匹配器产出，非 judge 自报分数）。 */
export type EarlyPredictionScore = Readonly<{
  score: 1 | 2 | 3 | 4 | 5 | null;
  hitWeight: number;
  matched: readonly { item: string; match: "exact" | "directional" | "miss"; confidence: number }[];
}>;

/** S4 answer key：每个预测项目的规范答案与别名集合（manifest.answerKey）。
 *  比对前做 Unicode/空白规范化，禁止用空字符串或任意单词的 substring 误判精确命中。 */
export type EarlyPredictionAnswerKey = Readonly<
  Record<
    string,
    Readonly<{
      exactAliases: readonly string[];
      directionalAliases: readonly string[];
    }>
  >
>;

const RAW_CASES = casesData as readonly { readonly caseId: string; readonly input: NewGameInput }[];

/** 加载全部 case（数据事实源在仓库内，编译期 JSON 导入，零 IO）。 */
export function loadStoryEvalCases(): readonly StoryEvalCase[] {
  return RAW_CASES as readonly StoryEvalCase[];
}

/** 按 caseId 解析：缺省参数 → undefined（运行全部 case）；未知 → null（INVALID_CASE）。 */
export function resolveStoryEvalCase(caseId: string | undefined): StoryEvalCase | undefined | null {
  if (caseId === undefined) return undefined;
  const found = RAW_CASES.find((item) => item.caseId === caseId);
  return (found as StoryEvalCase | undefined) ?? null;
}
