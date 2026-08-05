import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StoryEvalStoryRow } from "./storyEvalArtifacts";

export const STORY_EVAL_CHECKPOINT_VERSION = 1 as const;

export type StoryEvalRunFingerprint = Readonly<Record<string, string | number | null>>;

export type StoryEvalPendingScene = Readonly<{
  row: StoryEvalStoryRow;
  ledgerLengthBeforeAction: number;
  choiceToken: string;
  choiceIndex: number;
}>;

export type StoryEvalProgress = Readonly<{
  checkpointVersion: typeof STORY_EVAL_CHECKPOINT_VERSION;
  status: "running" | "failed" | "completed";
  fingerprint: StoryEvalRunFingerprint;
  nextSceneIndex: number;
  sceneCount: number;
  fallbackScenes: number;
  openingSource: string;
  endingOutcome: string | null;
  previousLedgerLength: number;
  branchCheckpointsDone: readonly number[];
  continuationBridges: readonly Readonly<Record<string, unknown>>[];
  pendingScene: StoryEvalPendingScene | null;
  lastError: Readonly<{ sceneIndex: number; message: string }> | null;
  updatedAt: string;
}>;

export const storyEvalCheckpointPaths = (artifactDir: string) => ({
  progress: join(artifactDir, "progress.json"),
  partialStory: join(artifactDir, "story.partial.jsonl"),
  database: join(artifactDir, "checkpoint.sqlite"),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFingerprint(value: unknown): value is StoryEvalRunFingerprint {
  return isRecord(value) && Object.values(value).every((entry) => entry === null || typeof entry === "string" || typeof entry === "number");
}

function isProgress(value: unknown): value is StoryEvalProgress {
  if (!isRecord(value)) return false;
  if (value.checkpointVersion !== STORY_EVAL_CHECKPOINT_VERSION) return false;
  if (!(["running", "failed", "completed"] as const).includes(value.status as "running" | "failed" | "completed")) return false;
  if (!isFingerprint(value.fingerprint)) return false;
  if (!Number.isInteger(value.nextSceneIndex) || !Number.isInteger(value.sceneCount) || !Number.isInteger(value.fallbackScenes)) return false;
  if (typeof value.openingSource !== "string") return false;
  if (value.endingOutcome !== null && typeof value.endingOutcome !== "string") return false;
  if (!Number.isInteger(value.previousLedgerLength)) return false;
  if (!Array.isArray(value.branchCheckpointsDone) || !value.branchCheckpointsDone.every((entry) => Number.isInteger(entry))) return false;
  if (!Array.isArray(value.continuationBridges) || !value.continuationBridges.every(isRecord)) return false;
  if (value.pendingScene !== null && !isRecord(value.pendingScene)) return false;
  if (value.lastError !== null && !isRecord(value.lastError)) return false;
  return typeof value.updatedAt === "string";
}

export function readStoryEvalProgress(path: string): StoryEvalProgress | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isProgress(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoryEvalProgressAtomic(path: string, progress: StoryEvalProgress): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function rowKey(row: StoryEvalStoryRow): string {
  return row.kind === "scene" ? `scene:${row.sceneId ?? row.sceneIndex}` : `ending:${row.sceneIndex}`;
}

export function readStoryEvalPartialRows(path: string): readonly StoryEvalStoryRow[] {
  if (!existsSync(path)) return [];
  const rows = new Map<string, StoryEvalStoryRow>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && (parsed.kind === "scene" || parsed.kind === "ending") && Number.isInteger(parsed.sceneIndex)) {
        rows.set(rowKey(parsed as StoryEvalStoryRow), parsed as StoryEvalStoryRow);
      }
    } catch {
      // Ignore a torn final JSONL line; the last atomic progress checkpoint is authoritative.
    }
  }
  return [...rows.values()].sort((left, right) => left.sceneIndex - right.sceneIndex);
}

export function writeStoryEvalPartialRowsAtomic(path: string, rows: readonly StoryEvalStoryRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
  renameSync(temporaryPath, path);
}

export function fingerprintMismatches(
  expected: StoryEvalRunFingerprint,
  actual: StoryEvalRunFingerprint,
): readonly string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((key) => expected[key] !== actual[key]);
}

export function assertResumableFingerprint(
  expected: StoryEvalRunFingerprint,
  actual: StoryEvalRunFingerprint,
): void {
  const mismatches = fingerprintMismatches(expected, actual);
  if (mismatches.length > 0) {
    throw new Error(`story-eval resume fingerprint mismatch: ${mismatches.join(",")}`);
  }
}
