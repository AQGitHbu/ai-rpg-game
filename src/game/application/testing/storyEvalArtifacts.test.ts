// ---------------------------------------------------------------------------
// storyEvalArtifacts.test.ts：证据包与完整性校验契约（Task 13 Step 1）。
// 手工构造产物断言：缺 factId 的 fact_discovered、缺 S4 answer key、
// 缺 memory 的 NPC 场景、缺 prompt/contract 版本 → complete === false 且
// missing 含对应条目；完整行（previousScene、NPC profile、memory、关系、
// 安全事件 ID）→ complete === true；buildStoryEvalEvidence 正确装配证据包。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { StoryEvalEvidence } from "./storyEvalCases";
import {
  buildStoryEvalEvidence,
  validateStoryEvalArtifacts,
  type StoryEvalStoryRow,
} from "./storyEvalArtifacts";

function sceneRow(overrides: Partial<StoryEvalStoryRow> = {}): StoryEvalStoryRow {
  return {
    kind: "scene",
    sceneIndex: 1,
    sceneId: "scene-1",
    mainStage: 1,
    narration: "你走进一间昏暗的屋子。",
    npcLine: null,
    choices: [
      { label: "继续前行", actionKey: "move:loc_2" },
      { label: "谨慎观察", actionKey: "investigate:f_1" },
    ],
    directorPlan: { pacing: "setup", allowedRevealFactIds: [], introducedEntities: [] },
    memorySummary: [],
    npcProfile: null,
    relationshipSummary: null,
    fallback: false,
    playerChoice: { index: 0, actionKey: "move:loc_2", reason: "explore" },
    newEvents: [],
    ...overrides,
  };
}

/** 完整 NPC 场景行：带 memory、profile、关系与安全事件 ID。 */
function completeNpcSceneRow(): StoryEvalStoryRow {
  return sceneRow({
    sceneIndex: 2,
    sceneId: "scene-2",
    mainStage: 1,
    npcLine: { text: "这条路通向你想找的地方。", emotion: "warm" },
    npcProfile: { id: "n_1", name: "阿岚", role: "向导", description: "熟悉地形的向导", isCompanion: false },
    relationshipSummary: "neutral",
    memorySummary: [{ kind: "npc", npcId: "n_1", turn: 0 }],
    newEvents: [{ type: "fact_discovered", factId: "f_1" }],
  });
}

function completeStory(): readonly StoryEvalStoryRow[] {
  return [sceneRow({ sceneIndex: 1 }), completeNpcSceneRow()];
}

function completeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: "wuxia-a",
    strategy: "explore",
    status: "converged",
    answerKey: { ending: { exactAliases: ["归隐"], directionalAliases: ["江湖"] } },
    contractVersion: "runtime-narrative-v2",
    promptVersions: {
      scenario: "scenario-dynamic-v2",
      director: "runtime-narrative-v2",
      writer: "runtime-narrative-v2",
      npc: "runtime-narrative-v2",
    },
    ...overrides,
  };
}

const calls = [{ kind: "ai_call", role: "director", traceId: "t1", attempt: 1 }];

function validate(input: {
  story?: readonly StoryEvalStoryRow[];
  manifest?: Record<string, unknown>;
  calls?: readonly unknown[];
}) {
  return validateStoryEvalArtifacts({
    calls: input.calls ?? calls,
    story: input.story ?? completeStory(),
    manifest: input.manifest ?? completeManifest(),
  });
}

describe("validateStoryEvalArtifacts：完整性矩阵", () => {
  it("缺 factId 的 fact_discovered → incomplete", () => {
    const story = [sceneRow({ sceneIndex: 1 }), completeNpcSceneRow()].map((row) =>
      row.sceneIndex === 2 ? { ...row, newEvents: [{ type: "fact_discovered" }] } : row,
    ) as readonly StoryEvalStoryRow[];
    const result = validate({ story });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("eventId:fact_discovered");
  });

  it("缺 S4 answer key → incomplete", () => {
    const manifest = completeManifest();
    delete manifest.answerKey;
    const result = validate({ manifest });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("answerKey");
  });

  it("NPC 场景缺 memory → incomplete", () => {
    const story = [sceneRow({ sceneIndex: 1 }), completeNpcSceneRow()].map((row) =>
      row.sceneIndex === 2 ? { ...row, memorySummary: undefined } : row,
    ) as readonly StoryEvalStoryRow[];
    const result = validate({ story });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("memory");
  });

  it("缺 prompt/contract 版本 → incomplete", () => {
    const manifest = completeManifest();
    delete manifest.contractVersion;
    delete manifest.promptVersions;
    const result = validate({ manifest });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("contractVersion");
    expect(result.missing).toContain("promptVersions");
  });

  it("完整产物（previousScene、profile、memory、关系、安全事件 ID）→ complete", () => {
    const result = validate({});
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("空 calls / 空 story → incomplete", () => {
    expect(validate({ calls: [] }).missing).toContain("calls");
    expect(validate({ story: [] }).missing).toContain("story");
  });
});

describe("buildStoryEvalEvidence：证据包装配", () => {
  it("sceneIndex=2 时 previousScene 为 sceneIndex=1 的行，携带 profile/memory/关系", () => {
    const evidence: StoryEvalEvidence = buildStoryEvalEvidence(completeStory(), completeManifest(), 2);
    expect(evidence.sceneIndex).toBe(2);
    expect(evidence.previousScene?.sceneIndex).toBe(1);
    expect(evidence.currentScene.sceneIndex).toBe(2);
    expect(evidence.npcProfile).not.toBeNull();
    expect(evidence.relationshipSummary).toBe("neutral");
    expect(evidence.memorySummary.length).toBeGreaterThan(0);
  });

  it("sceneIndex=1 时 previousScene 为 null", () => {
    const evidence = buildStoryEvalEvidence(completeStory(), completeManifest(), 1);
    expect(evidence.previousScene).toBeNull();
  });
});
