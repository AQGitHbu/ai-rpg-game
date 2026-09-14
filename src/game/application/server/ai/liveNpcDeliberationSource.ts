import type {
  AiTransport,
  AiTransportConfig,
} from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseStructuredJsonObject } from "@/game/core/json";
import {
  parseNpcDeliberationProposal,
  type NpcDeliberationSource,
} from "../../npcDeliberationSource";
import type { ProviderJsonMode } from "./providerRequestOptions";
import {
  createRpgAiClient,
  RPG_AI_NPC_DELIBERATION_PURPOSE,
  RPG_AI_NPC_DELIBERATION_ROLE,
  type RpgAiClient,
} from "./rpgAiClient";
import { storyInteractionPrompt } from "./storyInteractionPrompt";
import type { NarrativeRequestClient } from "./narrativeRequestClient";
import { estimateNarrativeTokens } from "./narrativeContext/estimateNarrativeTokens";

export type LiveNpcDeliberationSourceDeps = Readonly<{
  readonly aiClient?: RpgAiClient;
  readonly requestClient?: NarrativeRequestClient;
  readonly transport?: AiTransport;
  readonly config?: AiTransportConfig;
  readonly jsonMode?: ProviderJsonMode;
  readonly logger?: GameLogger;
}>;

const SYSTEM_PROMPT = [
  "selectedExpression records the current selected player action or freeform input; a player_choice label is not necessarily spoken dialogue. Evidence references must come from currentEvidence; discloseFactIds must be in outwardAuthority.allowedDiscloseFactIds. Knowing a private fact does not authorize disclosing it. allowedIntroductionFactIds additionally permits references in request_introduction/request_verification proposals, not current speech or discloseFactIds; the player must execute that interaction before learning the fact.",
  storyInteractionPrompt(false),
  "Return only NPC deliberation and interactionProposals; do not output choices, continuationScenes or worldDelta.",
  "你正在进行一次单个 NPC 的私下角色判断。",
  "只依据输入中该 NPC 自己知道的事实、目标、关系、承诺、已提交证据和本次行动上下文作决定。",
  "输出严格 JSON，不输出解释、叙事、玩家文案或思维链。",
  "goalIds、evidenceEventIds、discloseFactIds 只能引用输入中的 ID；interactionProposals 只能提出结构化互动，不得自授资格。",
  "response 只能是 cooperate、refuse、question、offer_condition 之一。",
].join("\n");

function outputSchema(): string {
  return JSON.stringify({
    npcId: "<same npcId>",
    goalIds: [],
    response: "question",
    evidenceEventIds: [],
    discloseFactIds: [],
    interactionProposals: [],
  });
}

/** Live provider adapter. It performs no state mutation or disclosure writeback. */
export function createLiveNpcDeliberationSource(deps: LiveNpcDeliberationSourceDeps): NpcDeliberationSource {
  const aiClient = deps.aiClient ?? (deps.transport !== undefined && deps.config !== undefined
    ? createRpgAiClient({
      transport: deps.transport,
      config: deps.config,
      logger: deps.logger,
      policies: { narrative_bundle: { jsonMode: deps.jsonMode ?? "prompt_only" } },
    })
    : undefined);

  return {
    async generate(input) {
      if (aiClient === undefined) {
        deps.logger?.warn("npc_deliberation_provider_unavailable", {});
        return { ok: false, code: "PROVIDER_FAILURE" };
      }
      try {
        const messages = [
          { role: "system" as const, content: SYSTEM_PROMPT },
          {
            role: "user" as const,
            content: `${input.privateContext}\n\n只返回以下 JSON 形状：${outputSchema()}`,
          },
        ];
        const auditContext = {
          ...(input.auditLink ?? {}),
          purpose: RPG_AI_NPC_DELIBERATION_PURPOSE,
          trigger: "npc_deliberation",
          jobId: String(input.jobId),
          revision: input.candidateVersion,
        } as const;
        if (input.maxEstimatedTokens !== undefined && estimateNarrativeTokens(JSON.stringify(messages)) > input.maxEstimatedTokens) {
          return { ok: false, code: "CONTEXT_OVERFLOW" };
        }
        const result = deps.requestClient === undefined
          ? await aiClient.complete(RPG_AI_NPC_DELIBERATION_ROLE, messages, auditContext)
          : await deps.requestClient.completeNarrativeRequest({
              purpose: "npc_deliberation",
              messages,
              auditContext,
              signal: input.signal ?? new AbortController().signal,
              ...(input.maxEstimatedTokens === undefined ? {} : { maxEstimatedTokens: input.maxEstimatedTokens }),
              ...(input.reserveHttpAttempt === undefined ? {} : { reserveHttpAttempt: input.reserveHttpAttempt }),
            });
        if (!result.ok) {
          if (result.code === "context_budget_exceeded") return { ok: false, code: "CONTEXT_OVERFLOW" };
          deps.logger?.warn("npc_deliberation_provider_failed", { code: result.code });
          return { ok: false, code: "PROVIDER_FAILURE" };
        }
        const parsed = parseStructuredJsonObject(result.content);
        if (!parsed.ok) {
          deps.logger?.warn("npc_deliberation_invalid_json", {});
          return { ok: false, code: "INVALID_PROPOSAL" };
        }
        const root = parsed.value;
        const rawProposal = Object.keys(root).length === 1 && "proposal" in root ? root.proposal : root;
        const proposal = parseNpcDeliberationProposal(rawProposal);
        if (proposal === null || String(proposal.npcId) !== String(input.npcId)) {
          deps.logger?.warn("npc_deliberation_invalid_proposal", {});
          return { ok: false, code: "INVALID_PROPOSAL" };
        }
        return { ok: true, proposal };
      } catch {
        deps.logger?.warn("npc_deliberation_transport_failed", {});
        return { ok: false, code: "PROVIDER_FAILURE" };
      }
    },
  };
}
