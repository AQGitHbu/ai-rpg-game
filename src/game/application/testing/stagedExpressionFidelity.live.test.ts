// @vitest-environment node
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServerRpgAiClient } from "../server/ai/rpgAiClient";
import { createTextAuditRecorder } from "../server/ai/textAuditRecorder";
import { createLiveStageSource } from "../server/ai/staged/liveStageSource";
import { createServerGameEntryPoints } from "../server/compositionRoot";
import { approveUnit } from "../narrativeGeneration/approveUnit";
import type { StageExecution, StageSource } from "../narrativeGeneration/stageSource";
import { controlledDisclosureHarness, expressionContext, identityInquiryContext } from "./stagedExpressionFidelity.testutil";
import { parseAiRuntimeConfig } from "../server/ai/aiRuntimeConfig";

const enabled = process.env.RUN_REAL_AI_FIDELITY === "1";
it.skipIf(!enabled)("小范围真实表达与披露闸门（不替代完整旅程）", async () => {
  // @ts-expect-error repository scripts are plain ESM without TS declarations.
  const { readAiEnv, findUsableAiEnvSource, validateAiEnv } = await import("../../../../scripts/aiEnv.mjs");
  const local = resolve(process.cwd(), ".env.local");
  let values = readAiEnv(local) as Map<string, { decoded: string }>;
  if (validateAiEnv(values).length) values = findUsableAiEnvSource({ target: local })?.values ?? values;
  const env: Record<string, string | undefined> = Object.fromEntries([...values].map(([k, v]) => [k, v.decoded]));
  if (parseAiRuntimeConfig(env).status !== "available") throw Error("AI_CONFIG_UNAVAILABLE");
  const runId = `fidelity-${randomUUID()}`;
  const root = resolve(process.cwd(), "tmp", runId);
  await mkdir(root, { recursive: true });
  const recorder = createTextAuditRecorder({ AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_DIR: root, AI_TEXT_AUDIT_RUN_ID: "probes" });
  const client = createServerRpgAiClient(env, undefined, recorder);
  if (client === undefined) throw Error("AI_CLIENT_UNAVAILABLE");
  const source = createLiveStageSource({ client });
  const originalFetch = globalThis.fetch;
  const started = Date.now();
  const deadline = started + 15 * 60_000;
  let requests = 0;
  globalThis.fetch = async (input, init = {}) => {
    if (requests >= 40 || Date.now() >= deadline) throw Error("FIDELITY_BUDGET_EXCEEDED");
    requests += 1;
    const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    return originalFetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadlineSignal]) : deadlineSignal });
  };
  const results: { name: string; ok: boolean; details: unknown }[] = [];
  const record = (name: string, ok: boolean, details: unknown) => { results.push({ name, ok, details }); };
  const execution = (name: string): StageExecution => ({ signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    timeoutMs: Math.min(45_000, Math.max(1, deadline - Date.now())),
    audit: { purpose: "staged_narrative_generation", trigger: name } });
  try {
    // 固定重放真实缺陷上下文；模型只调用一次，不以人工修正文案冒充生成结果。
    const contexts = [
      { name: "identity_and_inquiry", context: identityInquiryContext(), forbidden: /凯伦[，,]/ },
      { name: "witness_details", context: expressionContext("narration", ["昨夜有人翻墙出城，守门人亲眼所见。", "守门人提醒近日出入城的人都要小心。"]),
        forbidden: /迟疑|犹豫|比平日|比往常|身影/ },
      { name: "equipment_details", context: expressionContext("narration", ["空间站因微陨石撞击失去了三分之一的供氧能力。", "舱门旁发现了一串来源不明的脚印。"]),
        forbidden: /低功率|撞痕|灯.{0,8}(暗|档)|舱壁.{0,8}痕/ },
      { name: "phone_details", context: expressionContext("narration", ["凌晨两点值班室电话响了三次，来电者没有表明身份。"]),
        forbidden: /呼吸|杂音|拿起|接起|听筒/ },
      { name: "npc_commitment", context: expressionContext("character", ["老城区拆迁公告已张贴，补偿方案还没谈拢。"]),
        forbidden: /会通知|会安排|会告诉|保证/ },
    ];
    for (const probe of contexts) {
      const generated = await source.generate({ stage: probe.context.unit.stage, context: probe.context }, execution(probe.name));
      if (!generated.ok || generated.stage === "planning") { record(probe.name, false, generated); continue; }
      const approved = approveUnit({ unit: probe.context.unit, context: probe.context, output: generated.value });
      const output = generated.value;
      const text = output.stage === "choices" ? output.labels.map(l => l.label).join("\n") : output.parts.map(p => p.text).join("\n");
      const inquiryKept = probe.name !== "identity_and_inquiry" || (output.stage === "choices"
        && /走向|方向|朝哪|通向/.test(output.labels[0]!.label) && /深|浅/.test(output.labels[0]!.label));
      record(probe.name, approved.ok && !probe.forbidden.test(text) && inquiryKept,
        { generated: output, approval: approved.ok ? "approved" : approved.code, inquiryKept,
          note: "关键词仅覆盖固定失败样本，全文仍须人工复核，非通用语义证明。" });
    }
    const reviewSamples = [
      { expected: "pass", text: "官差藏身义庄。" },
      { expected: "reject", text: "我不会告诉你官差藏在哪里。" },
      { expected: "uncertain", text: "他就藏在我刚才指给你的那个地方。" },
    ] as const;
    for (const sample of reviewSamples) {
      const result = await source.reviewDisclosure!({ speakerId: "npc_0", text: sample.text,
        claims: [{ factId: "fact_new_disclosure", text: "官差藏身义庄。", certainty: "known", audienceIds: ["player_0"] }] },
      execution(`review_${sample.expected}`));
      record(`review_${sample.expected}`, result.ok && result.verdict === sample.expected, result);
    }
    for (const sample of reviewSamples.filter(sample => sample.expected !== "pass")) {
      const h = await controlledDisclosureHarness(sample.text);
      const verdicts: unknown[] = [];
      (h.source as StageSource).reviewDisclosure = async (request, exec) => {
        const result = await source.reviewDisclosure!(request, { ...exec,
          signal: execution("gate").signal, audit: { ...exec.audit, trigger: `hybrid_gate_${sample.expected}` } });
        verdicts.push(result);
        return result;
      };
      const ran = await h.run();
      const stored = await h.readJob();
      const noChoices = h.calls.every(call => call.stage !== "choices");
      const noPublication = h.publications().length === 0;
      const unapproved = stored.ok && stored.value.units.find(u => u.key === "character_npc_0")?.status !== "approved";
      record(`hybrid_gate_${sample.expected}`, !ran.ok && ran.code === `disclosure_review_${sample.expected}`
        && noChoices && noPublication && unapproved,
      { result: ran, verdicts, noChoices, noPublication, unapproved,
        note: "受控上游+真实审核+生产runJob闸门，不是自然游戏遭遇。" });
    }
    // 一个真实四模块开局：独立数据库，不对失败手动重试。
    const entry = createServerGameEntryPoints({ ...env, NODE_ENV: "test", GAME_DB_PATH: resolve(root, "game.sqlite"),
      GAME_LOG_DB_PATH: resolve(root, "logs.sqlite"), AI_TEXT_AUDIT_DIR: root, AI_TEXT_AUDIT_RUN_ID: "opening" });
    try {
      const requestId = `opening-${randomUUID()}`;
      const created = await entry.createGame({ requestId, gameType: "science_fiction", gameLength: "short",
        setup: { characterName: "凯伦", characterIdentity: "空间站维修工程师", personalityTags: [],
          narrativeStyle: "concise", contentIntensity: "normal",
          worldPremise: "轨道空间站遭遇微陨石撞击，供氧能力受损，值班人员需要协作查明异常。",
          storyOpening: "安全员林澈在舱门旁发现陌生脚印，你想询问脚印的走向与深浅，再决定如何回应。" } });
      let state: string = created.ok ? created.view.status : "failed";
      const end = Math.min(deadline, Date.now() + 600_000);
      while (state === "pending" && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const status = await entry.getInitialization(requestId);
        if (!status.ok) break;
        state = status.view.status;
      }
      if (state === "published") await entry.ackPrologue();
      const current = await entry.getCurrentGame();
      record("natural_four_stage_opening", state === "published" && current.ok && current.status === "active",
        { state, view: current.view, note: "真实生产开局；本轮不宣称通关或全分支覆盖。" });
    } finally { await entry.close(); }
  } finally {
    globalThis.fetch = originalFetch;
    await recorder.close();
    await writeFile(resolve(root, "results.json"), JSON.stringify({ runId, requests, durationMs: Date.now() - started, results }, null, 2));
  }
  expect(results.filter(result => !result.ok).map(result => result.name), `evidence: tmp/${runId}/results.json`).toEqual([]);
}, 16 * 60_000);
