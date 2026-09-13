import {
  createOpenAiCompatibleTransport,
  type AiCompletionResult,
  type AiMessage,
  type AiTransport,
  type AiTransportConfig,
} from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import { createProviderRequestOptions, type ProviderJsonMode, type ProviderReasoningEffort, type ProviderThinking } from "./providerRequestOptions";
import type { AiRetryContext, AiTextAuditContext, AiTextAuditRecorder, AiTextAuditRequestOptions, AiTextAuditRole } from "./textAuditTypes";

export const RPG_AI_ROLES = ["intent", "opening", "scene", "world", "narrative_bundle"] as const;
/** Reuses the AiTextAuditRole union from textAuditTypes.ts; textAuditTypes never imports rpgAiClient, eliminating a type-cycle. */
export type RpgAiRole = AiTextAuditRole;
export type RpgAiThinking = ProviderThinking;
export type RpgAiReasoningEffort = ProviderReasoningEffort;

/** NPC judgment reuses the existing transport/audit role; only its purpose differs. */
export const RPG_AI_NPC_DELIBERATION_ROLE: RpgAiRole = "narrative_bundle";
export const RPG_AI_NPC_DELIBERATION_PURPOSE = "npc_deliberation" as const;

export type RpgAiRolePolicy = Readonly<{
  readonly thinking: RpgAiThinking;
  readonly reasoningEffort?: RpgAiReasoningEffort;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  readonly jsonMode: ProviderJsonMode;
  readonly maxAttempts: number;
}>;

export type RpgAiRolePolicyOverrides = Partial<{
  [Role in RpgAiRole]: Partial<RpgAiRolePolicy>;
}>;

/**
 * Provider reasoning is disabled for every production role by default. The
 * budgets include a safety margin because this provider has been observed to
 * spend completion tokens on reasoning even after receiving the nested off
 * switch.
 */
export const RPG_AI_DEFAULT_POLICIES: Readonly<Record<RpgAiRole, RpgAiRolePolicy>> = {
  intent: {
    thinking: "off",
    timeoutMs: 30_000,
    maxTokens: 320,
    jsonMode: "prompt_only",
    maxAttempts: 2,
  },
  opening: {
    thinking: "off",
    timeoutMs: 240_000,
    maxTokens: 5_000,
    jsonMode: "prompt_only",
    maxAttempts: 2,
  },
  scene: {
    thinking: "off",
    timeoutMs: 45_000,
    maxTokens: 3_000,
    jsonMode: "prompt_only",
    maxAttempts: 2,
  },
  world: {
    thinking: "off",
    timeoutMs: 45_000,
    maxTokens: 3_200,
    jsonMode: "prompt_only",
    maxAttempts: 3,
  },
  narrative_bundle: {
    thinking: "off",
    // A decision bundle is player-facing scene generation.  It must obey the
    // same bounded wait as a scene: a longer timeout leaves every control
    // disabled while a stalled provider connection is still considered live.
    timeoutMs: 45_000,
    maxTokens: 8_000,
    jsonMode: "prompt_only",
    maxAttempts: 2,
  },
};

export type RpgAiClient = Readonly<{
  complete(
    role: RpgAiRole,
    messages: readonly AiMessage[],
    context?: AiTextAuditContext,
    options?: RpgAiCompleteOptions,
  ): Promise<AiCompletionResult>;
  policy(role: RpgAiRole): RpgAiRolePolicy;
}>;

/** RPG-only controls used by the durable narrative request wrapper. */
export type RpgAiCompleteOptions = Readonly<{
  readonly signal?: AbortSignal;
  /** Reserve one durable HTTP budget unit immediately before transport I/O. */
  readonly beforeTransportAttempt?: () => Promise<boolean> | boolean;
  /** Purpose-specific timeout/token/retry policy without changing shared transport. */
  readonly policyOverride?: Partial<RpgAiRolePolicy>;
}>;

export type CreateRpgAiClientOptions = Readonly<{
  readonly transport: AiTransport;
  readonly config: AiTransportConfig;
  readonly logger?: Pick<GameLogger, "warn">;
  readonly policies?: RpgAiRolePolicyOverrides;
  readonly auditRecorder?: AiTextAuditRecorder;
}>;

const RETRYABLE_ROLE_CODES = new Set([
  "timeout",
  "rate_limited",
  "service_error",
  "network_error",
]);

type RpgAiProviderMetadata = Readonly<{
  finishReason?: string;
  reasoningTokens?: number;
  hasReasoningContent?: boolean;
}>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * The mounted 0.1.0 transport exposes only the stable base result contract.
 * Newer compatible transports may add these safe provider metadata fields;
 * read them at this RPG boundary without widening the shared package type.
 */
function readProviderMetadata(result: AiCompletionResult): RpgAiProviderMetadata {
  const resultRecord = asRecord(result);
  const usageRecord = result.ok ? asRecord(result.usage) : undefined;
  const finishReason = resultRecord?.finishReason;
  const directReasoningTokens = readFiniteNumber(resultRecord?.reasoningTokens);
  const usageReasoningTokens = readFiniteNumber(usageRecord?.reasoningTokens);
  const hasReasoningContent = resultRecord?.hasReasoningContent;

  return {
    ...(typeof finishReason === "string" && finishReason.length > 0 ? { finishReason } : {}),
    ...(directReasoningTokens === undefined && usageReasoningTokens === undefined
      ? {}
      : { reasoningTokens: directReasoningTokens ?? usageReasoningTokens }),
    ...(typeof hasReasoningContent === "boolean" ? { hasReasoningContent } : {}),
  };
}

function mergePolicies(overrides: RpgAiRolePolicyOverrides | undefined): Record<RpgAiRole, RpgAiRolePolicy> {
  return Object.fromEntries(
    RPG_AI_ROLES.map((role) => [
      role,
      { ...RPG_AI_DEFAULT_POLICIES[role], ...(overrides?.[role] ?? {}) },
    ]),
  ) as Record<RpgAiRole, RpgAiRolePolicy>;
}

/**
 * Bound the RPG HTTP attempt independently of the transport's cooperative
 * abort. This includes its queue and response body, not just response headers.
 * A late result is observed only to settle its promise; it cannot reach audit,
 * source parsing or the game write-back path after this boundary has closed.
 */
function completeWithinRpgDeadline(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  send: (signal: AbortSignal) => Promise<AiCompletionResult>,
): Promise<AiCompletionResult> {
  const startedAt = Date.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({ ok: false, code: "invalid_config", retryable: false, latencyMs: 0 });
  }
  return new Promise(resolve => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: AiCompletionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = (code: "timeout" | "aborted"): void => {
      finish({ ok: false, code, retryable: code === "timeout", latencyMs: Date.now() - startedAt });
      // Cancellation is best effort. Settling does not wait for the provider to
      // acknowledge it and does not imply that provider billing has stopped.
      controller.abort();
    };
    const onAbort = (): void => stop("aborted");
    const timer = setTimeout(() => stop(externalSignal?.aborted ? "aborted" : "timeout"), timeoutMs);
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    if (externalSignal?.aborted) {
      stop("aborted");
      return;
    }
    try {
      send(controller.signal).then(
        result => externalSignal?.aborted ? stop("aborted") : finish(result),
        () => finish({ ok: false, code: "network_error", retryable: true, latencyMs: Date.now() - startedAt }),
      );
    } catch {
      finish({ ok: false, code: "network_error", retryable: true, latencyMs: Date.now() - startedAt });
    }
  });
}

/**
 * One RPG-local client is the only owner of provider request options and
 * retry policy. Sources keep prompt/schema/fallback responsibilities only.
 * When an auditRecorder is provided, every transport.complete call is recorded
 * with full messages and model output. Audit write failures never change the
 * return result.
 */
export function createRpgAiClient(options: CreateRpgAiClientOptions): RpgAiClient {
  const policies = mergePolicies(options.policies);
  const audit = options.auditRecorder;

  function defaultAuditContext(role: RpgAiRole): AiTextAuditContext {
    const purpose = role === "opening"
      ? "opening_generation"
      : role === "intent"
        ? "intent_parsing"
        : role === "world"
          ? "world_evolution"
          : "scene_performance";
    return { purpose, trigger: "unspecified" };
  }

  return {
    policy(role) {
      return policies[role];
    },

    async complete(role, messages, auditContext, completeOptions) {
      const policy = {
        ...policies[role],
        ...(completeOptions?.policyOverride ?? {}),
      };
      const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
      const callId = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const auditContextToUse = auditContext ?? defaultAuditContext(role);
      const callerRetry = auditContextToUse.retry;
      // transport retry 只在此层识别：attempt>1 时为 provider 重试，
      // 保留来源（origin），机制覆盖为 transport，reason 为上一失败的稳定码。
      let lastFailureCode: string | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (completeOptions?.signal?.aborted === true) {
          return { ok: false, code: "aborted", retryable: false, latencyMs: 0 };
        }
        if (completeOptions?.beforeTransportAttempt !== undefined) {
          let reserved = false;
          try {
            reserved = await completeOptions.beforeTransportAttempt();
          } catch {
            return { ok: false, code: "service_error", retryable: false, latencyMs: 0 };
          }
          if (!reserved) {
            return { ok: false, code: "rate_limited", retryable: false, latencyMs: 0 };
          }
        }
        const providerOptions = {
          ...createProviderRequestOptions(
          policy.timeoutMs,
          policy.maxTokens,
          policy.jsonMode,
          policy.thinking,
          policy.reasoningEffort,
          ),
        };
        const result = await completeWithinRpgDeadline(
          policy.timeoutMs,
          completeOptions?.signal,
          signal => options.transport.complete(options.config, messages, { ...providerOptions, signal }),
        );

        // Record the audit entry for this attempt. Best-effort: never throws.
        if (audit?.enabled) {
          const auditOptions: AiTextAuditRequestOptions = {
            timeoutMs: policy.timeoutMs,
            ...(providerOptions.temperature === undefined ? {} : { temperature: providerOptions.temperature }),
            ...(policy.maxTokens === undefined ? {} : { maxTokens: policy.maxTokens }),
            jsonMode: policy.jsonMode,
            thinking: policy.thinking,
          };
          const isTransportRetry = attempt > 1;
          const retry: AiRetryContext = {
            origin: callerRetry?.origin ?? "normal",
            mechanism: isTransportRetry ? "transport" : (callerRetry?.mechanism ?? "initial"),
            attempt: isTransportRetry ? attempt : (callerRetry?.attempt ?? 0),
            ...(isTransportRetry
              ? (lastFailureCode === undefined ? {} : { reason: lastFailureCode })
              : (callerRetry?.reason === undefined ? {} : { reason: callerRetry.reason })),
          };
          const recordContext = { ...auditContextToUse, retry };
          try {
            await audit.record({
              kind: "ai_call",
              callId,
              role,
              attempt,
              context: recordContext,
              input: { messages, options: auditOptions },
              output: result,
            });
          } catch {
            // Audit write failure: never change the return result.
            options.logger?.warn("ai_text_audit_write_failed", { role, attempt });
          }
        }

        const providerMetadata = readProviderMetadata(result);
        if (providerMetadata.hasReasoningContent === true || (providerMetadata.reasoningTokens ?? 0) > 0) {
          options.logger?.warn("rpg_ai_provider_reasoning_observed", {
            role,
            requestedThinking: policy.thinking,
            ...(providerMetadata.finishReason === undefined ? {} : { finishReason: providerMetadata.finishReason }),
            ...(providerMetadata.reasoningTokens === undefined ? {} : { reasoningTokens: providerMetadata.reasoningTokens }),
            ...(providerMetadata.hasReasoningContent === undefined ? {} : { hasReasoningContent: providerMetadata.hasReasoningContent }),
          });
        }

        if (result.ok) return result;

        // empty_response is intentionally not retried with the same request.
        // With the affected provider it usually means reasoning consumed the
        // budget and the final channel was never produced; repeating the same
        // body only doubles latency/cost and cannot repair the protocol issue.
        if (result.code === "empty_response") {
          options.logger?.warn("rpg_ai_provider_empty_final_content", {
            role,
            code: result.code,
            latencyMs: result.latencyMs,
            ...(providerMetadata.finishReason === undefined ? {} : { finishReason: providerMetadata.finishReason }),
            ...(providerMetadata.reasoningTokens === undefined ? {} : { reasoningTokens: providerMetadata.reasoningTokens }),
            ...(providerMetadata.hasReasoningContent === undefined ? {} : { hasReasoningContent: providerMetadata.hasReasoningContent }),
          });
          return result;
        }

        if (!RETRYABLE_ROLE_CODES.has(result.code) || !result.retryable || attempt >= maxAttempts) {
          return result;
        }

        options.logger?.warn("rpg_ai_request_retry", {
          role,
          attempt,
          code: result.code,
        });
        lastFailureCode = result.code;
      }

      // maxAttempts is normalized above, so this branch is unreachable.
      return {
        ok: false,
        code: "network_error",
        retryable: false,
        latencyMs: 0,
      };
    },
  };
}

/**
 * Production-only role switch. It is deliberately separate from the
 * story-evaluation AI_THINKING_ROLES setting so an evaluation experiment
 * cannot silently change player traffic.
 */
export function resolveRpgAiThinkingRoles(
  env: Record<string, string | undefined>,
): readonly RpgAiRole[] {
  const requested = new Set((env.AI_RUNTIME_THINKING_ROLES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0));
  return RPG_AI_ROLES.filter((role) => requested.has(role));
}

export function createServerRpgAiClient(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
  auditRecorder?: AiTextAuditRecorder,
): RpgAiClient | undefined {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status !== "available") return undefined;

  const jsonMode: ProviderJsonMode = runtime.outputFormat === "json_object" ? "json_object" : "prompt_only";
  const thinkingRoles = new Set(resolveRpgAiThinkingRoles(env));
  const policies = Object.fromEntries(
    RPG_AI_ROLES.map((role) => [
      role,
      {
        thinking: thinkingRoles.has(role) ? "on" : "off",
        jsonMode,
      },
    ]),
  ) as RpgAiRolePolicyOverrides;

  return createRpgAiClient({
    transport: createOpenAiCompatibleTransport(),
    config: runtime.config,
    logger,
    policies,
    ...(auditRecorder !== undefined ? { auditRecorder } : {}),
  });
}
