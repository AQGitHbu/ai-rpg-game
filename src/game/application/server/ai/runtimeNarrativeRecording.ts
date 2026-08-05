import { fingerprint } from "./_shared/canonicalJson";
import { createReplayCursor, type RecordSink } from "./_shared/recording";
import type {
  DirectorAttempt,
  DirectorRequest,
  DirectorSource,
  NarrativeFailureCategory,
  NpcLineAttempt,
  NpcLineRequest,
  NpcLineSource,
  SceneScriptAttempt,
  SceneScriptRequest,
  SceneScriptSource,
} from "../../runtimeNarrative";
import { NARRATIVE_CONTRACT_VERSION } from "../../runtimeNarrative";

export const RUNTIME_NARRATIVE_FIXTURE_VERSION = "runtime-narrative-fixture-v1" as const;
export type RuntimeNarrativeRole = "director" | "writer" | "npc";

type RecordedSuccess =
  | Readonly<{ ok: true; plan: Extract<DirectorAttempt, { ok: true }>["plan"] }>
  | Readonly<{ ok: true; script: Extract<SceneScriptAttempt, { ok: true }>["script"] }>
  | Readonly<{ ok: true; performance: Extract<NpcLineAttempt, { ok: true }>["performance"] }>;

export type RuntimeNarrativeRecordedCall = Readonly<{
  fixtureVersion: typeof RUNTIME_NARRATIVE_FIXTURE_VERSION;
  contractVersion: typeof NARRATIVE_CONTRACT_VERSION;
  sequence: number;
  role: RuntimeNarrativeRole;
  requestFingerprint: string;
  result: RecordedSuccess | Readonly<{ ok: false; category: NarrativeFailureCategory }>;
}>;

export type RuntimeNarrativeRecordSink = RecordSink<RuntimeNarrativeRecordedCall>;

type RuntimeNarrativeSources = Readonly<{
  directorSource: DirectorSource;
  sceneScriptSource: SceneScriptSource;
  npcLineSource: NpcLineSource;
}>;

// 运行时易变/可重建字段：回放时 sceneId / choiceToken 不参与请求指纹。
// activeMainObjective、currentLocationCard、availableItemCards、coverageTargetActionKey
// 都是由同一份 blueprint/state/actionCandidates 派生的提示投影；排除它们可让旧黄金 fixture
// 在增加路由/物品卡字段后继续回放，同时仍由其原始输入字段检测真实上下文漂移。
const NARRATIVE_VOLATILE_KEYS = new Set(["sceneId", "choiceToken"]);
const NARRATIVE_REBUILDABLE_KEYS = new Set([
  "activeMainObjective",
  "currentLocationCard",
  "availableItemCards",
  "discoveredFactCards",
  "coverageTargetActionKey",
]);

export function fingerprintNarrativeContext(context: Record<string, unknown>): string {
  const stableContext = Object.fromEntries(
    Object.entries(context).filter(([key]) => !NARRATIVE_REBUILDABLE_KEYS.has(key)),
  );
  // knownFactIds is permission metadata derived from the same NPC definition;
  // omit only this new nested field so v1 golden writer calls remain replayable.
  if (typeof stableContext.npcProfile === "object" && stableContext.npcProfile !== null) {
    stableContext.npcProfile = Object.fromEntries(
      Object.entries(stableContext.npcProfile).filter(([key]) => key !== "knownFactIds"),
    );
  }
  // NPC handoff fields are additive presentation guidance.  They are derived
  // from the already fingerprinted state/plan and are intentionally omitted
  // so historical v1 replay calls remain consumable after the handoff grows.
  delete stableContext.sceneGoal;
  delete stableContext.playerName;
  delete stableContext.requestedEmotion;
  if (typeof stableContext.npcDefinition === "object" && stableContext.npcDefinition !== null) {
    stableContext.npcDefinition = Object.fromEntries(
      Object.entries(stableContext.npcDefinition).filter(([key]) => key !== "description"),
    );
  }
  // relevantFactIds is copied from the approved Director plan and the
  // allowedFactCards below remains the Writer's actual permission boundary.
  // Exclude this additive handoff field so v1 golden writer calls remain
  // replayable after the context contract gains the explicit intent.
  if (typeof stableContext.plan === "object" && stableContext.plan !== null) {
    stableContext.plan = Object.fromEntries(
      Object.entries(stableContext.plan).filter(([key]) => key !== "relevantFactIds"),
    );
  }
  return fingerprint(stableContext, NARRATIVE_VOLATILE_KEYS);
}

function recordedResult(
  role: RuntimeNarrativeRole,
  attempt: DirectorAttempt | SceneScriptAttempt | NpcLineAttempt,
): RuntimeNarrativeRecordedCall["result"] {
  if (!attempt.ok) return { ok: false, category: attempt.category };
  if (role === "director") return { ok: true, plan: (attempt as Extract<DirectorAttempt, { ok: true }>).plan };
  if (role === "writer") return { ok: true, script: (attempt as Extract<SceneScriptAttempt, { ok: true }>).script };
  return { ok: true, performance: (attempt as Extract<NpcLineAttempt, { ok: true }>).performance };
}

export function createRecordingRuntimeNarrativeSources(
  sources: RuntimeNarrativeSources,
  sink: RuntimeNarrativeRecordSink,
): RuntimeNarrativeSources {
  let sequence = 0;
  async function record(
    role: RuntimeNarrativeRole,
    request: DirectorRequest | SceneScriptRequest | NpcLineRequest,
    attempt: DirectorAttempt | SceneScriptAttempt | NpcLineAttempt,
  ): Promise<void> {
    await sink.append({
      fixtureVersion: RUNTIME_NARRATIVE_FIXTURE_VERSION,
      contractVersion: NARRATIVE_CONTRACT_VERSION,
      sequence: sequence++,
      role,
      requestFingerprint: fingerprintNarrativeContext(request.context),
      result: recordedResult(role, attempt),
    });
  }
  return {
    directorSource: {
      async generate(request) {
        const attempt = await sources.directorSource.generate(request);
        await record("director", request, attempt);
        return attempt;
      },
    },
    sceneScriptSource: {
      async generate(request) {
        const attempt = await sources.sceneScriptSource.generate(request);
        await record("writer", request, attempt);
        return attempt;
      },
    },
    npcLineSource: {
      async generate(request) {
        const attempt = await sources.npcLineSource.generate(request);
        await record("npc", request, attempt);
        return attempt;
      },
    },
  };
}

export class RuntimeNarrativeFixtureDriftError extends Error {
  readonly code = "RUNTIME_NARRATIVE_FIXTURE_DRIFT";
  constructor() {
    super("runtime narrative fixture does not match the current request");
    this.name = "RuntimeNarrativeFixtureDriftError";
  }
}

export function createReplayRuntimeNarrativeSources(
  calls: readonly RuntimeNarrativeRecordedCall[],
): RuntimeNarrativeSources & Readonly<{ assertComplete(): void }> {
  const cursor = createReplayCursor(calls, () => {
    throw new RuntimeNarrativeFixtureDriftError();
  });

  function consume(
    role: RuntimeNarrativeRole,
    request: DirectorRequest | SceneScriptRequest | NpcLineRequest,
  ): RuntimeNarrativeRecordedCall {
    const requestFingerprint = fingerprintNarrativeContext(request.context);
    return cursor.consume(
      (call) => {
        const matches =
        call.fixtureVersion === RUNTIME_NARRATIVE_FIXTURE_VERSION &&
        call.contractVersion === NARRATIVE_CONTRACT_VERSION &&
        call.role === role &&
        call.requestFingerprint === requestFingerprint;
        return matches;
      },
    );
  }

  function diagnostics(traceId: string, ok: boolean, category?: NarrativeFailureCategory) {
    return {
      traceId,
      contractVersion: NARRATIVE_CONTRACT_VERSION,
      stage: ok ? "candidate_received" as const : "failed" as const,
      ...(category === undefined ? {} : { category }),
    };
  }

  return {
    directorSource: {
      async generate(request) {
        const result = consume("director", request).result;
        if (!result.ok) return { ok: false, provenance: "fixture", category: result.category, diagnostics: diagnostics(request.traceId, false, result.category) };
        if (!("plan" in result)) throw new RuntimeNarrativeFixtureDriftError();
        return { ok: true, provenance: "fixture", plan: result.plan, diagnostics: diagnostics(request.traceId, true) };
      },
    },
    sceneScriptSource: {
      async generate(request) {
        const result = consume("writer", request).result;
        if (!result.ok) return { ok: false, provenance: "fixture", category: result.category, diagnostics: diagnostics(request.traceId, false, result.category) };
        if (!("script" in result)) throw new RuntimeNarrativeFixtureDriftError();
        return { ok: true, provenance: "fixture", script: result.script, diagnostics: diagnostics(request.traceId, true) };
      },
    },
    npcLineSource: {
      async generate(request) {
        const result = consume("npc", request).result;
        if (!result.ok) return { ok: false, provenance: "fixture", category: result.category, diagnostics: diagnostics(request.traceId, false, result.category) };
        if (!("performance" in result)) throw new RuntimeNarrativeFixtureDriftError();
        return { ok: true, provenance: "fixture", performance: result.performance, diagnostics: diagnostics(request.traceId, true) };
      },
    },
    assertComplete() {
      cursor.assertComplete();
    },
  };
}
