import type { SafeContext, SafeFact } from "../narrativeGeneration/perspectiveContext";
import type { Unit } from "@/game/domain/narrativeUnit";
import { projectExpressionTask } from "../narrativeGeneration/expressionTask";
import { createStagedHarness } from "./stagedNarrativeHarness.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";

/** 受控失败重放上下文，不冒充真实游戏存档或 planner 输出。 */
export function expressionContext(stage: Unit["stage"], facts: readonly string[]): SafeContext {
  const visibleFacts: SafeFact[] = facts.map((text, i) => ({ id: `fact_${i}`, text, certainty: "known", sources: [] }));
  const unit: Unit = { key: `probe_${stage}`, stage, point: { stepKey: "current", order: 1 },
    speakerId: stage === "character" ? "npc_0" : null, dependencies: [], taskFactIds: visibleFacts.map(f => f.id),
    requiredObservationKeys: [], requiredBeats: [],
    ...(stage === "choices" ? {} : { task: { intent: stage === "narration" ? "describe" : "inform",
      focusFactIds: visibleFacts.map(f => f.id), prerequisiteFactIds: [] } as const }) };
  const task = unit.task === undefined ? undefined : projectExpressionTask(unit.task, visibleFacts);
  return { unit, visibleFacts, priorText: [], allowedActions: [], options: [], playerUtterance: null,
    style: "concise", requiredBeats: [], requiredObservations: [], choiceKind: stage === "choices" ? "ordinary" : null,
    ...(task?.ok ? { taskInstruction: task.value } : {}),
    persona: stage !== "character" ? null : { publicName: "陈守义",
      publicRole: { text: "辅警", facts: [], evidence: [], beatIds: [] }, anchors: [], goals: [],
      emotion: "neutral", relationshipTier: "acquainted", behavior: ["answer_directly"] },
  };
}

export function identityInquiryContext(): SafeContext {
  const context = expressionContext("choices", ["舱门旁发现了一串来源不明的脚印。", "登记名单上有六名乘员。"]);
  const tasks = [
    { intent: "ask" as const, focusFactIds: ["fact_0"], prerequisiteFactIds: [],
      inquiries: [{ factId: "fact_0", aspects: ["direction", "depth"] as const }] },
    { intent: "challenge" as const, focusFactIds: ["fact_1"], prerequisiteFactIds: [],
      inquiries: [{ factId: "fact_1", aspects: ["reliability"] as const }] },
  ];
  return { ...context,
    scene: { locationId: "loc_0", locationName: "舱门", playerName: "凯伦", speakers: [{ id: "npc_0", name: "林澈" }] },
    dialogue: { speakerId: "player_0", speakerName: "凯伦", addresseeId: "npc_0", addresseeName: "林澈" },
    priorText: [{ text: "凯伦，舱门旁发现了来源不明的脚印。我还不知道来源。", facts: [{ factId: "fact_0", certainty: "known" }], evidence: [], beatIds: [] }],
    options: tasks.map((task, i) => {
      const projected = projectExpressionTask(task, context.visibleFacts);
      if (!projected.ok) throw Error(projected.code);
      return { candidateId: i === 0 ? "ask_marks" : "challenge_list", dialogueAct: task.intent,
        publicIntent: { text: projected.value, facts: [], evidence: [], beatIds: [] } };
    }),
  };
}

/** 混合测试：上游输出受控，仅 reviewer 接真实服务，验证生产 runJob 的不传播闸门。 */
export async function controlledDisclosureHarness(text: string) {
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision") throw Error("fixture_job_missing");
  const world = stored.value.input.world;
  const factId = asFactId("fact_new_disclosure");
  const nextWorld = createWorldStateFixtureWith({ generation: world.generation, base: {
    ...world, worldFacts: [{ factId, text: "官差藏身义庄。", source: "generated", discovered: false }],
    npcs: world.npcs.map((npc, index) => index === 0 ? { ...npc,
      memory: { ...npc.memory, knownFactIds: [factId], hiddenFactIds: [] } } : npc),
  } });
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input: { ...stored.value.input, world: nextWorld } } });
  const generate = h.source.generate.bind(h.source);
  h.source.generate = async (request, execution) => {
    const response = await generate(request, execution);
    if (!response.ok) return response;
    if (response.stage === "planning") return { ...response, value: { ...response.value,
      observations: [{ key: "heard_new", source: { kind: "speech", speakerId: "npc_0" },
        point: { stepKey: "current", order: 2 }, audienceIds: ["player_0", "npc_0"],
        fact: { factId, certainty: "known" } }],
      units: response.value.units.map(u => u.key === "character_npc_0" ? { ...u, requiredObservationKeys: ["heard_new"] } : u),
    } };
    if (response.stage === "character" && response.value.stage === "character" && response.value.speakerId === "npc_0")
      return { ...response, value: { ...response.value, parts: [{ text,
        facts: [{ factId, certainty: "known" }], evidence: [], beatIds: [] }] } };
    return response;
  };
  return h;
}
