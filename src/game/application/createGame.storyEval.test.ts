/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/domain";
import { createGame } from "./createGame";
import {
  createFakeGameRepository,
  createTestDependencies,
} from "./applicationFixture.testutil";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateAttempt,
  type ScenarioCandidateSource,
  type ScenarioGenerationRequest,
} from "./scenarioGeneration";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";

const FIXTURE = wuxiaFixture as unknown as { input: NewGameInput; seed: string };

const TIMEOUT_ATTEMPT: ScenarioCandidateAttempt = {
  ok: false,
  contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
  origin: "fixture",
  category: "timeout",
  diagnostics: ["FIXTURE_TIMEOUT"],
};

// ---------------------------------------------------------------------------
// Task 3（ai-story-eval）：候选循环每次尝试传递唯一可解析的 request traceId。
// 第一次尝试 = 注入的 base traceId；第二次尝试 = base 后堆叠一个 -retry；
// 除 traceId 外请求完全复用（input/seed 不变），其余审批/fallback/事件逻辑
// 由 createGame.test.ts 的既有编排矩阵覆盖，此处只断言 traceId 可区分。
// ---------------------------------------------------------------------------

describe("createGame：候选请求 traceId 按尝试堆叠 -retry 后缀", () => {
  it("两次失败尝试收到 base / base-retry，且除 traceId 外请求完全复用", async () => {
    const calls: ScenarioGenerationRequest[] = [];
    const source: ScenarioCandidateSource = {
      async generate(request) {
        calls.push(request);
        return TIMEOUT_ATTEMPT;
      },
    };
    const repository = createFakeGameRepository();
    const result = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createTestDependencies(repository, {
        scenarioCandidateSource: source,
        newTraceId: () => "base",
      })
    );

    // 两次尝试均失败 ⇒ 稳定走 fallback，编排流程与事件逻辑不变。
    expect(result).toMatchObject({ ok: true, source: "fallback" });
    expect(calls).toHaveLength(2);
    expect(calls[0].traceId).toBe("base");
    expect(calls[1].traceId).toBe("base-retry");
    expect(calls[1]).toEqual({ ...calls[0], traceId: "base-retry" });
  });
});
