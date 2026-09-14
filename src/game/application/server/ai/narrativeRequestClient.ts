import type { AiCompletionResult, AiMessage } from "@ai-game/ai-transport";
import type { AiTextAuditContext } from "./textAuditTypes";
import type { RpgAiClient, RpgAiRolePolicy } from "./rpgAiClient";

export const NARRATIVE_REQUEST_PURPOSES = ["author", "npc_deliberation", "review", "memory_summary"] as const;
export type NarrativeRequestPurpose = (typeof NARRATIVE_REQUEST_PURPOSES)[number];

export type CompleteNarrativeRequestInput = Readonly<{
  readonly purpose: NarrativeRequestPurpose;
  readonly messages: readonly AiMessage[];
  readonly auditContext: AiTextAuditContext;
  readonly signal: AbortSignal;
  /** Called immediately before every underlying transport attempt. */
  readonly reserveHttpAttempt?: () => Promise<boolean> | boolean;
}>;

export type NarrativeRequestClient = Readonly<{
  completeNarrativeRequest(input: CompleteNarrativeRequestInput): Promise<AiCompletionResult>;
}>;

const AUTHOR_POLICY: Partial<RpgAiRolePolicy> = {
  thinking: "on",
  reasoningEffort: "low",
  jsonMode: "prompt_only",
  timeoutMs: 240_000,
  maxTokens: undefined,
  maxAttempts: 2,
};
const NPC_POLICY: Partial<RpgAiRolePolicy> = AUTHOR_POLICY;
const REVIEW_POLICY: Partial<RpgAiRolePolicy> = {
  thinking: "on",
  reasoningEffort: "low",
  jsonMode: "prompt_only",
  timeoutMs: 240_000,
  maxTokens: undefined,
  maxAttempts: 2,
};

function policyFor(purpose: NarrativeRequestPurpose): Partial<RpgAiRolePolicy> {
  return purpose === "review" ? REVIEW_POLICY : purpose === "author" ? AUTHOR_POLICY : NPC_POLICY;
}

/**
 * RPG-local request wrapper. It keeps the three logical purposes explicit
 * while reusing the existing narrative_bundle transport role and audit type.
 * The RPG client owns the actual retry loop; its callback is therefore invoked
 * once per HTTP attempt, including transport retries.
 */
export function createNarrativeRequestClient(
  deps: Readonly<{
    readonly aiClient?: RpgAiClient;
    /** Optional batch-wide guard, used by the P1 journey protocol. */
    readonly beforeTransportAttempt?: () => Promise<boolean> | boolean;
  }>,
): NarrativeRequestClient {
  return {
    async completeNarrativeRequest(input) {
      if (deps.aiClient === undefined) {
        return { ok: false, code: "invalid_config", retryable: false, latencyMs: 0 };
      }
      const reserveHttpAttempt = deps.beforeTransportAttempt === undefined
        ? input.reserveHttpAttempt
        : async (): Promise<boolean> => {
            if (input.reserveHttpAttempt !== undefined && !(await input.reserveHttpAttempt())) return false;
            return deps.beforeTransportAttempt!();
          };
      return deps.aiClient.complete(
        "narrative_bundle",
        input.messages,
        input.auditContext,
        {
          signal: input.signal,
          ...(reserveHttpAttempt === undefined ? {} : { beforeTransportAttempt: reserveHttpAttempt }),
          policyOverride: policyFor(input.purpose),
        },
      );
    },
  };
}
