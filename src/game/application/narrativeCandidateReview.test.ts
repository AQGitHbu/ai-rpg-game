import { describe, expect, it } from "vitest";
import type { NarrativeBundleProposal, BundleSceneProposal } from "@/game/domain/narrativeBundle";
import type { NarrativeBundleSourceContext } from "./narrativeBundleSource";
import {
  hashNarrativeCandidate,
  type CandidateReviewResult,
  type NarrativeCandidateReviewer,
} from "./narrativeCandidateReview";

function scene(): BundleSceneProposal {
  return {
    segments: [{ beatId: "atmosphere", text: "场景" }],
    npcLine: null,
    objectiveLink: null,
    choices: [
      { candidateId: "choice_1", label: "先核验" },
      { candidateId: "choice_2", label: "直接交付" },
    ],
  };
}

function proposal(): NarrativeBundleProposal {
  return {
    worldDelta: null,
    currentScene: scene(),
    continuationScenes: [],
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
}

const context = {} as NarrativeBundleSourceContext;

describe("narrative candidate review contract", () => {
  it("hashes the complete candidate, including audience-aware NPC outward evidence", () => {
    const base = proposal();
    const withOutward = {
      ...base,
      npcOutwardProposals: [{
        npcId: "npc_1",
        response: "cooperate",
        evidenceEventIds: ["turn-1:event-1"],
        discloseFactIds: ["fact_public"],
        interactionProposals: [],
      }],
    } as NarrativeBundleProposal;
    const reordered = JSON.parse(JSON.stringify(withOutward)) as NarrativeBundleProposal;
    const outward = reordered.npcOutwardProposals![0]!;
    (reordered as { npcOutwardProposals: typeof reordered.npcOutwardProposals }).npcOutwardProposals = [{
      ...outward,
      discloseFactIds: [...outward.discloseFactIds],
    }];

    expect(hashNarrativeCandidate(base)).not.toBe(hashNarrativeCandidate(withOutward));
    expect(hashNarrativeCandidate(withOutward)).toBe(hashNarrativeCandidate(reordered));
  });

  it("requires a non-empty defect list for a rejected candidate", () => {
    const reviewer: NarrativeCandidateReviewer = {
      async reviewNarrativeCandidate(input): Promise<CandidateReviewResult> {
        return {
          ok: false,
          candidateVersion: input.candidateVersion,
          candidateHash: input.candidateHash,
          defects: [{
            candidateVersion: input.candidateVersion,
            candidateHash: input.candidateHash,
            scope: "scene",
            code: "MISSED_INPUT",
            path: "currentScene.expressions",
            reason: "漏写玩家先核验条件。",
          }],
        };
      },
    };

    return expect(reviewer.reviewNarrativeCandidate({
      context,
      proposal: proposal(),
      candidateVersion: 1,
      candidateHash: hashNarrativeCandidate(proposal()),
    })).resolves.toMatchObject({
      ok: false,
      defects: [{ code: "MISSED_INPUT" }],
    });
  });
});
