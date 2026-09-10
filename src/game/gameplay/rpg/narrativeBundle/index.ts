export {
  buildNarrativeBundleDescriptors,
  narrativeBundleTriggerKey,
  type BundleDescriptorGraph,
  type BundleStepDescriptor,
  type BuildNarrativeBundleDescriptorsInput,
  type PreparedChoiceCandidate,
  type PreparedArrivalNpcContext,
} from "./descriptors";

export {
  validateNarrativeBundleCoverage,
  validateStagedReadyCoverage,
  type BundleCoverageErrorCode,
  type BundleCoverageResult,
  type StagedCoverageErrorCode,
  type StagedReadyCoverageResult,
} from "./coverage";

export {
  endingDecisionStances,
  isEndingDecisionDue,
  type EndingDecisionStance,
} from "./endingDecision";
