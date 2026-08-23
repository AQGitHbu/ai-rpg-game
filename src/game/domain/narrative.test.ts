import { describe, expect, it } from "vitest";
import { asNarrativeJobId, asTurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import { createPendingNarrativeJob } from "./pendingNarrativeJob";
import { asNpcId } from "./worldEntity";
import type {
  NarrativeGenerationState,
  NarrativeSceneState,
  PlayerNpcChatState,
} from "./narrative";
import { buildNpcDialoguePages } from "./narrative";
import type { NarrativeGenerationFailure } from "./narrativeGenerationFailure";

function canonicalResolvedEvent(): ResolvedEvent {
  return {
    actionId: "action-1",
    status: "success",
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
}

function pendingWithJob(): Extract<
  NarrativeGenerationState,
  { readonly status: "pending" }
> {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job-1"),
    turnId: asTurnId("turn-1"),
    actionId: "action-1",
    expectedRevision: 41,
    turnNumber: 3,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    utterance: "我想打听矿坑的事",
    resolvedEvent: canonicalResolvedEvent(),
    domainEventRange: { fromLedgerIndex: 12, toLedgerIndexExclusive: 15 },
    focusNpcId: asNpcId("npc_1"),
    requestedAt: "2026-08-08T08:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
  });
  if (!result.ok) throw new Error("fixture 构造失败");
  return { status: "pending", job: result.job };
}

describe("NarrativeSceneState", () => {
  it("requires exactly two approved choices", () => {
    const scene = {
      sceneId: "scene-1",
      turn: 1,
      narration: "雨声压低了酒馆里的交谈。",
      usedFactIds: [],
      npcLine: null,
      choices: [
        { choiceToken: "c_0123456789abcdef", label: "询问掌柜" },
        { choiceToken: "c_fedcba9876543210", label: "检查角落", hint: "可能发现新线索" }
      ],
      source: "generated"
    } satisfies NarrativeSceneState;
    expect(scene.choices).toHaveLength(2);
    expect(JSON.stringify(scene)).not.toContain("actionKey");
  });

  it("AI 生成的非焦点 NPC 台词保留 generated 来源，不走确定性 fallback", () => {
    const dialogues = buildNpcDialoguePages([
      { id: asNpcId("npc_1"), name: "老周", role: "茶摊老人" },
      { id: asNpcId("npc_2"), name: "赵四", role: "客栈掌柜" },
    ], {
      focusNpcId: asNpcId("npc_1"),
      focusSpeech: "旧案的线索我会说清楚。你去客栈找赵四，他见过那晚的来客。",
      generatedNpcLines: new Map([
        ["npc_2", "客官若是来打听旧案，先坐下喝口热茶。店里的出入我都记得几分。"],
      ]),
    });

    expect(dialogues[0]?.speechSource).toBe("generated");
    expect(dialogues[1]?.speechSource).toBe("generated");
    expect(dialogues[1]?.speechPages.join("")).toContain("出入我都记得几分");
    expect(dialogues[1]?.speechPages.join("")).not.toContain("有什么要问的");
  });
});

describe("PlayerNpcChatState 快照类型", () => {
  it("正确构造", () => {
    const chat: PlayerNpcChatState = { npcId: "npc_1" as never, playerText: "你好", npcName: "铁匠", npcRole: "铁匠铺老板" };
    expect(chat.npcId).toBe("npc_1");
    expect(chat.playerText).toBe("你好");
  });
});

describe("NarrativeGenerationState 契约", () => {
  it("pending 变体必须携带 job（唯一载体）", () => {
    const pending = pendingWithJob();

    expect(pending.status).toBe("pending");
    expect(pending.job.actionId).toBe("action-1");
    expect(pending.job.requestedAt).toBe("2026-08-08T08:00:00.000Z");
    expect(pending.job.utterance).toBe("我想打听矿坑的事");
  });

  it("pending 变体不允许只有 requestedAt 而无 job", () => {
    // @ts-expect-error pending 的唯一载体是 job，不能再单有 requestedAt
    const legacy: NarrativeGenerationState = { status: "pending", requestedAt: "2026-01-01T00:00:00Z" };
    expect(legacy.status).toBe("pending");
  });

  it("idle 变体不残留玩家原文", () => {
    const idle: NarrativeGenerationState = { status: "idle" };
    // @ts-expect-error idle 不是玩家原文的载体
    const playerText: string | undefined = idle.playerText;
    expect(playerText).toBeUndefined();
  });

  it("failed 变体携带 job 与稳定 failure", () => {
    const failure: NarrativeGenerationFailure = {
      kind: "AI_RESPONSE_INVALID",
      phase: "scene",
      failedAt: "2026-08-21T00:00:00.000Z",
    };
    const failed: NarrativeGenerationState = {
      status: "failed",
      job: pendingWithJob().job,
      failure,
    };

    expect(failed.status).toBe("failed");
    expect(failed.failure.kind).toBe("AI_RESPONSE_INVALID");
    expect(failed.failure.phase).toBe("scene");
    expect(failed.failure.failedAt).toBe("2026-08-21T00:00:00.000Z");
    expect(failed.job.actionId).toBe("action-1");
  });

  it("failed 变体不允许缺失 failure", () => {
    // @ts-expect-error failed 必须携带 failure
    const missingFailure: NarrativeGenerationState = {
      status: "failed",
      job: pendingWithJob().job,
    };
    expect(missingFailure.status).toBe("failed");
  });

  it("failed 变体不允许缺失 job", () => {
    // @ts-expect-error failed 必须携带 job
    const missingJob: NarrativeGenerationState = {
      status: "failed",
      failure: {
        kind: "AI_CALL_FAILED",
        phase: "scene",
        failedAt: "2026-08-21T00:00:00.000Z",
      },
    };
    expect(missingJob.status).toBe("failed");
  });
});
