import { describe, expect, it } from "vitest";
import {
  createStructuredScenarioGenerationAudit,
  type ScenarioAuditEvent
} from "./scenarioGenerationAudit";

// ---------------------------------------------------------------------------
// scenarioGenerationAudit 契约测试：audit port 只接受稳定的诊断字段
// （traceId / attempt / outcome / category / transportCode / latencyMs /
// usage tokens / 基于本地单价的估算成本）。默认 logger 只结构化输出这些字段，
// 绝不输出 prompt、模型原文或密钥——即使调用方偷偷塞入这些字段也不会泄漏。
// ---------------------------------------------------------------------------

function captureLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

const OK_EVENT: ScenarioAuditEvent = {
  traceId: "trace-live-0001",
  attempt: 1,
  outcome: "ok",
  latencyMs: 1234,
  usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }
};

describe("createStructuredScenarioGenerationAudit", () => {
  it("结构化输出成功事件的允许字段（含 usage tokens）", () => {
    const sink = captureLog();
    const audit = createStructuredScenarioGenerationAudit({ log: sink.log });
    audit.record(OK_EVENT);

    expect(sink.lines).toHaveLength(1);
    const payload = JSON.parse(sink.lines[0]);
    expect(payload).toMatchObject({
      traceId: "trace-live-0001",
      attempt: 1,
      outcome: "ok",
      latencyMs: 1234,
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500
    });
  });

  it("失败事件记录 category 与 transportCode", () => {
    const sink = captureLog();
    const audit = createStructuredScenarioGenerationAudit({ log: sink.log });
    audit.record({
      traceId: "trace-live-0002",
      attempt: 2,
      outcome: "failure",
      category: "rate_limited",
      transportCode: "rate_limited",
      latencyMs: 42
    });
    const payload = JSON.parse(sink.lines[0]);
    expect(payload).toMatchObject({
      outcome: "failure",
      category: "rate_limited",
      transportCode: "rate_limited",
      latencyMs: 42
    });
  });

  it("配置单价时基于 usage tokens 估算成本", () => {
    const sink = captureLog();
    const audit = createStructuredScenarioGenerationAudit({
      log: sink.log,
      pricing: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 }
    });
    audit.record(OK_EVENT);
    const payload = JSON.parse(sink.lines[0]);
    // 1000 * 1e-6 + 500 * 2e-6 = 0.002
    expect(payload.estimatedCostUsd).toBeCloseTo(0.002, 12);
  });

  it("缺单价时估算成本为 undefined（字段不出现）", () => {
    const sink = captureLog();
    const audit = createStructuredScenarioGenerationAudit({ log: sink.log });
    audit.record(OK_EVENT);
    const payload = JSON.parse(sink.lines[0]);
    expect("estimatedCostUsd" in payload).toBe(false);
  });

  it("即使输入夹带假 key/prompt/response，输出也绝不泄漏", () => {
    const sink = captureLog();
    const audit = createStructuredScenarioGenerationAudit({
      log: sink.log,
      pricing: { promptUsdPerToken: 0.001 }
    });
    const secretKey = "sk-fake-secret-key-should-never-appear";
    const fakePrompt = "SYSTEM PROMPT: 你是绝密裁决官，禁止外泄";
    const fakeResponse = '{"world":{"summary":"绝密世界原文不得出现"}}';
    // 通过 cast 模拟调用方误塞敏感字段：默认 logger 必须只挑选白名单字段。
    audit.record({
      ...OK_EVENT,
      // @ts-expect-error 故意塞入端口未声明的敏感字段以证明不泄漏
      apiKey: secretKey,
      prompt: fakePrompt,
      response: fakeResponse
    });
    const line = sink.lines[0];
    expect(line).not.toContain(secretKey);
    expect(line).not.toContain("绝密");
    expect(line).not.toContain("SYSTEM PROMPT");
  });

  it("默认（无注入 log）record 不抛出", () => {
    const audit = createStructuredScenarioGenerationAudit();
    expect(() => audit.record({ traceId: "t", attempt: 1, outcome: "ok" })).not.toThrow();
  });
});
