// 整包发布的复核与原子提交（Plan 2026-09-09 / Task 9）。
//
// publishJob 是发布前的最后一道闸门：先复核产物（每个表达单元都已批准且
// 装配得出来）、复核输入（计划仍能在当前 job 输入上通过规则审批）、复核
// ready coverage（终幕 choices 单元计入必需，失败即阻止整个终幕包发布），
// 三者全过才调用仓储的原子 publish。
//
// 本函数不 claim/release，也不生成：它只在一个已持有有效 lease 的协调器
// 作用域内被调用。publish 与游戏状态写入在同一事务内完成——这是为什么
// 复核必须在调用前做完：事务里不能再回头改主意。

import { fail, type Check, type Unit, type UnitOutput } from "@/game/domain/narrativeUnit";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import { approvePlanningContext } from "./approvePlanningContext";
import { validateStagedReadyCoverage } from "@/game/gameplay/rpg/narrativeBundle";
import { assembleBundle } from "./assembleBundle";
import { validateJobDialogueConsistencyReview } from "./dialogueConsistencyReview";
import { validateJobDisclosureReviews } from "./disclosureReview";
import type {
  Lease,
  NarrativeJobRepository,
  Publication,
  StoredJob,
  StoredUnit,
} from "../server/persistence/narrativeJobRepository";

const PLANNING_UNIT_KEY = "planning";

export type PublishJobInput = Readonly<{
  job: StoredJob;
  lease: Lease;
  publication: Publication;
  now: () => string;
}>;

/** approved 的表达单元输出；planning 单元不是表达单元，返回 null。 */
function approvedOutputOf(unit: StoredUnit): UnitOutput | null {
  return unit.status === "approved" && unit.value !== null && !("steps" in (unit.value as object))
    ? unit.value as UnitOutput
    : null;
}

/**
 * 复核 + 原子发布。返回的 StoredJob 是 publish 之后的存储态（status:
 * published，version 已递增），调用方不得再对它做 save。
 */
export async function publishJob(
  input: PublishJobInput,
  jobs: NarrativeJobRepository,
): Promise<Check<StoredJob>> {
  const { job, lease, publication } = input;
  if (input.now() >= job.deadline) return fail("job_deadline_exceeded");
  if (job.id !== lease.jobId) return fail("job_lease_mismatch");
  if (job.status !== "pending") return fail("job_not_pending");

  // 复核产物：全部单元 approved，planning 单元产出的是计划提案。
  if (job.units.length === 0) return fail("job_units_missing");
  if (!job.units.every((unit) => unit.status === "approved")) {
    return fail("job_unit_not_approved");
  }
  const planningUnit = job.units.find((unit) => unit.key === PLANNING_UNIT_KEY);
  if (planningUnit === undefined || planningUnit.value === null) return fail("job_planning_missing");
  if (!("steps" in (planningUnit.value as object))) return fail("job_planning_invalid");
  const proposal = planningUnit.value as PlanProposal;

  // 复核输入：计划仍必须在当前 job 输入上通过规则审批（决策路径）。
  const approvedOutputs = new Map<string, UnitOutput>();
  for (const unit of job.units) {
    const output = approvedOutputOf(unit);
    if (output !== null) approvedOutputs.set(unit.key, output);
  }

  let units: readonly Unit[] = proposal.units;
  let terminalKind: "ending" | "next_decision" = proposal.terminal.kind === "ending" ? "ending" : "next_decision";

  if (job.input.kind === "decision") {
    const planApproval = approvePlanningContext(job.input, proposal);
    if (!planApproval.ok) return fail(planApproval.code);
    const reviews = validateJobDisclosureReviews(job, planApproval.value);
    if (!reviews.ok) return reviews;
    const dialogueReview = validateJobDialogueConsistencyReview(job, planApproval.value);
    if (!dialogueReview.ok) return dialogueReview;
    units = planApproval.value.units;
    terminalKind = planApproval.value.proposal.terminal.kind === "ending" ? "ending" : "next_decision";
    // 复核产物装配：缺单元 / stage 不符 / secret 泄漏在这里被拒在事务之外。
    const assembled = assembleBundle({ plan: planApproval.value, approved: approvedOutputs });
    if (!assembled.ok) return fail(assembled.code);
  } else {
    // opening job：结构由 envelope 里的初始化输入重建（不读现成世界/剧情），
    // 装配复核与 decision 同源——但发布载荷由编排层安装好叙事后再传入，
    // 这里只做覆盖复核，绝不伪造 ID 或重跑结构编译。
    if (job.initialization === null) return fail("job_initialization_missing");
    const planApproval = approvePlanningContext({ ...job.input, generation: job.initialization.generation }, proposal);
    if (!planApproval.ok) return fail(planApproval.code);
    const reviews = validateJobDisclosureReviews(job, planApproval.value);
    if (!reviews.ok) return reviews;
    const dialogueReview = validateJobDialogueConsistencyReview(job, planApproval.value);
    if (!dialogueReview.ok) return dialogueReview;
    units = planApproval.value.units;
    terminalKind = planApproval.value.proposal.terminal.kind === "ending" ? "ending" : "next_decision";
    const assembled = assembleBundle({ plan: planApproval.value, approved: approvedOutputs });
    if (!assembled.ok) return fail(assembled.code);
    if (publication.kind !== "opening") return fail("job_publication_kind_mismatch");
  }

  // 复核 ready coverage：终幕 choices 单元计入必需单元。
  const coverage = validateStagedReadyCoverage({
    units,
    approvedKeys: new Set(approvedOutputs.keys()),
    terminalKind,
  });
  if (!coverage.ok) return fail(coverage.code);

  return jobs.publish({ lease, expectedVersion: job.version, publication });
}
