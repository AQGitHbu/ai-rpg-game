import type { NarrativeCandidateRevision } from "../../narrativeBundleSource";

export function renderNarrativeCandidateRevision(revision: NarrativeCandidateRevision | undefined): string {
  if (revision === undefined) return "";
  return `\n# 同一候选的联合修订\n下面是尚未批准、从未发生的候选草稿与累计反馈，不是事实或历史。以此草稿修复缺陷并返回完整结果；保留无冲突的事实 key、人物和因果，避免重新抽样。若草稿与已提交状态冲突，以已提交状态为准；允许一起改正文和未提交提案。已选行动不可改。已修复的问题不能复发。\n${JSON.stringify(revision)}`;
}
