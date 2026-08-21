import {
  createOpenAiCompatibleTransport,
  type AiCompletionResult,
  type AiMessage,
  type AiTransport,
  type AiTransportConfig,
} from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import { createProviderRequestOptions, type ProviderJsonMode, type ProviderThinking } from "./providerRequestOptions";
import type { AiTextAuditContext, AiTextAuditRecorder, AiTextAuditRequestOptions, AiTextAuditRole } from "./textAuditTypes";

export const RPG_AI_ROLES = ["intent", "opening", "scene", "world"] as const;
/** Reuses the AiTextAuditRole union from textAuditTypes.ts; textAuditTypes never imports rpgAiClient, eliminating a type-cycle. */
export type RpgAiRole = AiTextAuditRole;
export type RpgAiThinking = ProviderThinking;

export type RpgAiRolePolicy = Readonly<{
  readonly thinking: RpgAiThinking;
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
};

export type RpgAiClient = Readonly<{
  complete(role: RpgAiRole, messages: readonly AiMessage[], context?: AiTextAuditContext): Promise<AiCompletionResult>;
  policy(role: RpgAiRole): RpgAiRolePolicy;
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

function mergePolicies(overrides: RpgAiRolePolicyOverrides | undefined): Record<RpgAiRole, RpgAiRolePolicy> {
  return Object.fromEntries(
    RPG_AI_ROLES.map((role) => [
      role,
      { ...RPG_AI_DEFAULT_POLICIES[role], ...(overrides?.[role] ?? {}) },
    ]),
  ) as Record<RpgAiRole, RpgAiRolePolicy>;
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

    async complete(role, messages, auditContext) {
      const policy = policies[role];
      const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
      const callId = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const auditContextToUse = auditContext ?? defaultAuditContext(role);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const providerOptions = createProviderRequestOptions(
          policy.timeoutMs,
          policy.maxTokens,
          policy.jsonMode,
          policy.thinking,
        );
        const result = await options.transport.complete(
          options.config,
          messages,
          providerOptions,
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
          try {
            await audit.record({
              kind: "ai_call",
              callId,
              role,
              attempt,
              context: auditContextToUse,
              input: { messages, options: auditOptions },
              output: result,
            });
          } catch {
            // Audit write failure: never change the return result.
            options.logger?.warn("ai_text_audit_write_failed", { role, attempt });
          }
        }

        const reasoningTokens = result.reasoningTokens
          ?? (result.ok ? result.usage?.reasoningTokens : undefined);
        if (result.hasReasoningContent === true || (reasoningTokens ?? 0) > 0) {
          options.logger?.warn("rpg_ai_provider_reasoning_observed", {
            role,
            requestedThinking: policy.thinking,
            ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
            ...(result.hasReasoningContent === undefined ? {} : { hasReasoningContent: result.hasReasoningContent }),
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
            ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
            ...(result.reasoningTokens === undefined ? {} : { reasoningTokens: result.reasoningTokens }),
            ...(result.hasReasoningContent === undefined ? {} : { hasReasoningContent: result.hasReasoningContent }),
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
