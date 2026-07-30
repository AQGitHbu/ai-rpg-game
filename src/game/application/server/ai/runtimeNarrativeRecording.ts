import { createHash } from "node:crypto";
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

export type RuntimeNarrativeRecordSink = {
  append(call: RuntimeNarrativeRecordedCall): void | Promise<void>;
};

type RuntimeNarrativeSources = Readonly<{
  directorSource: DirectorSource;
  sceneScriptSource: SceneScriptSource;
  npcLineSource: NpcLineSource;
}>;

const VOLATILE_CONTEXT_KEYS = new Set(["sceneId", "choiceToken"]);

function canonicalJson(value: unknown, parentKey?: string): string {
  if (parentKey !== undefined && VOLATILE_CONTEXT_KEYS.has(parentKey)) {
    return JSON.stringify("<volatile>");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key], key)}`
  ).join(",")}}`;
}

export function fingerprintNarrativeContext(context: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(context)).digest("hex");
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
  let cursor = 0;

  function consume(
    role: RuntimeNarrativeRole,
    request: DirectorRequest | SceneScriptRequest | NpcLineRequest,
  ): RuntimeNarrativeRecordedCall {
    const call = calls[cursor];
    if (
      call === undefined ||
      call.sequence !== cursor ||
      call.fixtureVersion !== RUNTIME_NARRATIVE_FIXTURE_VERSION ||
      call.contractVersion !== NARRATIVE_CONTRACT_VERSION ||
      call.role !== role ||
      call.requestFingerprint !== fingerprintNarrativeContext(request.context)
    ) {
      throw new RuntimeNarrativeFixtureDriftError();
    }
    cursor += 1;
    return call;
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
      if (cursor !== calls.length) throw new RuntimeNarrativeFixtureDriftError();
    },
  };
}
