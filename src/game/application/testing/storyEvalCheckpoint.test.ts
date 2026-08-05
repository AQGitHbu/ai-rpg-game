/** @vitest-environment node */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertResumableFingerprint,
  fingerprintMismatches,
  readStoryEvalPartialRows,
  readStoryEvalProgress,
  storyEvalCheckpointPaths,
  writeStoryEvalPartialRowsAtomic,
  writeStoryEvalProgressAtomic,
  STORY_EVAL_CHECKPOINT_VERSION,
  type StoryEvalProgress,
} from "./storyEvalCheckpoint";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function progress(): StoryEvalProgress {
  return {
    checkpointVersion: STORY_EVAL_CHECKPOINT_VERSION,
    status: "running",
    fingerprint: { caseId: "urban-b", strategy: "explore", seed: 42, model: "ai-slg-game-model" },
    nextSceneIndex: 2,
    sceneCount: 1,
    fallbackScenes: 0,
    openingSource: "generated",
    endingOutcome: null,
    previousLedgerLength: 8,
    branchCheckpointsDone: [2],
    continuationBridges: [],
    pendingScene: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "story-eval-checkpoint-"));
  tempDirectories.push(directory);
  return directory;
}

describe("story-eval checkpoint contract", () => {
  it("writes progress atomically and rejects malformed/versioned data", () => {
    const directory = tempDir();
    const path = join(directory, "progress.json");
    writeStoryEvalProgressAtomic(path, progress());
    expect(readStoryEvalProgress(path)).toMatchObject({ nextSceneIndex: 2, sceneCount: 1 });
    expect(readStoryEvalProgress(join(directory, "missing.json"))).toBeNull();
  });

  it("deduplicates partial rows by scene identity and keeps latest row", () => {
    const directory = tempDir();
    const path = storyEvalCheckpointPaths(directory).partialStory;
    writeStoryEvalPartialRowsAtomic(path, [
      { kind: "scene", sceneIndex: 1, sceneId: "s1", narration: "old" },
      { kind: "scene", sceneIndex: 1, sceneId: "s1", narration: "new" },
      { kind: "ending", sceneIndex: 2, outcome: "success" },
    ]);
    expect(readStoryEvalPartialRows(path)).toEqual([
      { kind: "scene", sceneIndex: 1, sceneId: "s1", narration: "new" },
      { kind: "ending", sceneIndex: 2, outcome: "success" },
    ]);
  });

  it("reports exact fingerprint mismatch and fails closed", () => {
    const expected = { model: "ai-slg-game-model", seed: 42, gitCommit: "a" } as const;
    const actual = { model: "ai-slg-game-model", seed: 43, gitCommit: "b" } as const;
    expect(fingerprintMismatches(expected, actual)).toEqual(["seed", "gitCommit"]);
    expect(() => assertResumableFingerprint(expected, actual)).toThrow(/seed,gitCommit/);
  });
});
