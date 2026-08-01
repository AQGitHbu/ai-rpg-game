import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStoryEvalSink, createStoryEvalApprovalObserver } from "./storyEvalCapture";
import type { StoryEvalApprovalEvent, StoryEvalCallRecord } from "../../storyEvalCaptureTypes";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "story-eval-"));
  dirs.push(dir);
  return dir;
}

const sampleCall: StoryEvalCallRecord = {
  kind: "ai_call",
  role: "director",
  traceId: "trace-1",
  attempt: 1,
  messages: [{ role: "system", content: "instr" }, { role: "user", content: "{}" }],
  rawResponse: '{"ok":true}',
  parsedCandidate: { ok: true },
  failureCategory: null,
  latencyMs: 12,
};

describe("createFileStoryEvalSink", () => {
  it("同步追加写 JSONL 到 calls.jsonl，每条一行", () => {
    const dir = tempDir();
    const sink = createFileStoryEvalSink(dir);
    sink.append(sampleCall);
    sink.append({ kind: "role_approval", traceId: "trace-1", role: "director", attempt: 1, category: null });
    const lines = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "ai_call", role: "director", traceId: "trace-1" });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: "role_approval", category: null });
  });

  it("目录创建失败时降级为 no-op，绝不抛错", () => {
    const dir = tempDir();
    const occupiedFile = join(dir, "occupied");
    writeFileSync(occupiedFile, "x", "utf8");
    const sink = createFileStoryEvalSink(occupiedFile); // mkdirSync 在已存在文件路径上失败
    expect(() => sink.append(sampleCall)).not.toThrow();
    expect(readdirSync(dir)).toEqual(["occupied"]);
  });
});

describe("createStoryEvalApprovalObserver", () => {
  it("把三类审批事件映射为 sink 记录", () => {
    const dir = tempDir();
    const sink = createFileStoryEvalSink(dir);
    const observer = createStoryEvalApprovalObserver(sink);
    const events: StoryEvalApprovalEvent[] = [
      { kind: "role_approval", traceId: "t1", role: "director", attempt: 1, category: "reference_violation" },
      { kind: "plan_approved", traceId: "t1", attempt: 1, planSummary: { pacing: "setup", tensionLevel: 2, focusNpcId: null } },
      { kind: "expansion_decision", traceId: "t1", decision: { ok: false, reason: "none_proposed" } },
    ];
    for (const event of events) observer(event);
    const lines = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.kind)).toEqual(["role_approval", "plan_approved", "expansion_decision"]);
    expect(lines[1].planSummary.tensionLevel).toBe(2);
    expect(lines[2].decision.reason).toBe("none_proposed");
  });

  it("observer 回调抛错时静默降级（sink.append 抛错也被吞掉）", () => {
    const dir = tempDir();
    const sink = createFileStoryEvalSink(dir);
    const observer = createStoryEvalApprovalObserver(sink);
    const throwingObserver = createStoryEvalApprovalObserver({
      append() { throw new Error("sink boom"); },
    });
    expect(() => throwingObserver({ kind: "plan_approved", traceId: "t", attempt: 1, planSummary: {} })).not.toThrow();
    expect(() => observer({ kind: "role_approval", traceId: "t", role: "npc", attempt: 1, category: null })).not.toThrow();
  });
});
