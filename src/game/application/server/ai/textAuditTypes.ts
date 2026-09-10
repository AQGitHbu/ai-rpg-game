// ---------------------------------------------------------------------------
// AI 文本审计事件契约（Task 1）。
//
// 本文件是纯类型端口，不引入 env/fs/transport 运行时依赖。
// 所有共享包引用必须是 import type，确保 application 本体和 composition root
// 可以从 ./server/ai/textAuditTypes 导入类型而不拉入 server-only 代码。
// ---------------------------------------------------------------------------

import type { AiMessage, AiCompletionResult } from "@ai-game/ai-transport";
import type { NarrativeContextManifest } from "./narrativeContext/contextBlock";
import type { Stage } from "@/game/domain/narrativeUnit";

/**
 * 审计模式：缺省、空白或非 "off" 值均按 "full" 处理，只有 trim 后等于 "off" 才关闭。
 */
export type AiTextAuditMode = "off" | "full";

/**
 * 游戏 HTTP API 审计模式：轮询默认只保留摘要，full 才保存完整 body。
 */
export type GameApiAuditMode = "off" | "compact" | "full";

/**
 * role 的唯一契约来源。textAuditTypes 不导入 rpgAiClient，rpgAiClient 复用此类型。
 * planning/narration/character/choices 是分阶段剧情生成的四个 stage role
 * （Spec 2026-09-09）；旧 role 仅保留 fixture/审计兼容。
 */
export type AiTextAuditRole =
  | "intent" | "opening" | "scene" | "world" | "narrative_bundle"
  | "planning" | "narration" | "character" | "choices";

/**
 * 重试来源：初始化于首次普通调用或手动失败 job 重试。legacy_unknown 只作为
 * CLI 对历史仅含 repair 字段的只读派生显示值，不属于本联合类型。
 */
export type AiRetryOrigin = "normal" | "manual_failed_job";

/**
 * 重试机制：
 * - initial：首次调用；
 * - transport：RpgAiClient 在 maxAttempts 内的超时/网络/限流/5xx 重试；
 * - content_repair：非法 JSON/schema/reference 或审批拒绝触发的单次内容修复。
 */
export type AiRetryMechanism = "initial" | "transport" | "content_repair";

/**
 * 结构化重试元数据。只记录稳定类型、原因码与关联 attempt/traceId/gameId/
 * jobId/turnNumber，不记录 API key、Authorization、Cookie 或完整 URL。
 */
export type AiRetryContext = Readonly<{
  readonly origin: AiRetryOrigin;
  readonly mechanism: AiRetryMechanism;
  readonly attempt: number;
  readonly reason?: string;
}>;

/**
 * 审计关联 link：只携带 traceId/gameId/jobId/turnNumber/retry，不进入游戏状态。
 * 通过 link.retry.origin 判定来源，不再新增独立 retryOrigin 字段。
 */
export type AiTextAuditLink = Readonly<
  Pick<AiTextAuditContext, "traceId" | "gameId" | "jobId" | "turnNumber" | "retry">
>;

/**
 * 审计上下文：每个 AI 调用、API 交换或 story 事件携带的关联元数据。
 */
export type AiTextAuditContext = {
  readonly purpose:
    | "opening_generation"
    | "intent_parsing"
    | "world_evolution"
    | "scene_performance"
    | "narrative_bundle_generation"
    | "staged_narrative_generation"
    | "final_story_text"
    | "game_api";
  readonly trigger: string;
  readonly gameId?: string;
  readonly traceId?: string;
  readonly jobId?: string;
  readonly actionId?: string;
  readonly turnNumber?: number;
  readonly revision?: number;
  readonly action?: unknown;
  /**
   * 分阶段生成（Spec 2026-09-09）的关联字段：只含稳定 ID/枚举与摘要值，
   * 不含 prompt 正文、模型输出或玩家原文。
   */
  readonly stage?: Stage;
  readonly unitKey?: string;
  readonly inputDigest?: string;
  readonly cycle?: number;
  readonly dependencyVersion?: string;
  /**
   * 编译后的叙事上下文清单：只含 block 元数据、预算与裁剪结果，不含 Prompt 正文。
   */
  readonly narrativeContext?: NarrativeContextManifest;
  /**
   * 结构化重试元数据（来源 + 机制）。新事件统一使用 retry，
   * CLI 对 retry ?? repair 做只读归一。
   */
  readonly retry?: AiRetryContext;
  /**
   * @deprecated 只读兼容。历史事件可能仅含此字段，新事件不再写入；
   * CLI 将其归一为 origin="legacy_unknown"、mechanism="content_repair"。
   */
  readonly repair?: { readonly attempt: number; readonly reason: string };
};

/**
 * 审计请求选项投影：不是 foundation 导出，只能写入 timeoutMs/temperature/
 * maxTokens/jsonMode/thinking，不能把 transport config、API key、Authorization、
 * AbortSignal 或 extraBody 原文写入记录。
 */
export type AiTextAuditRequestOptions = Readonly<{
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly jsonMode?: "json_object" | "prompt_only";
  readonly thinking?: "on" | "off";
}>;

/**
 * 所有事件共享的公共信封：递增序号 + ISO 时间戳（来自 options.now）。
 */
export type AiTextAuditEnvelope = {
  readonly sequence: number;
  readonly timestamp: string;
};

/**
 * 审计事件 payload 联合类型。record() 的入参不含 sequence/timestamp，
 * recorder 负责附加公共信封后落盘。
 */
export type AiTextAuditPayload =
  | {
      readonly kind: "ai_call";
      readonly callId: string;
      readonly role: AiTextAuditRole;
      readonly attempt: number;
      readonly context: AiTextAuditContext;
      readonly input: {
        readonly messages: readonly AiMessage[];
        readonly options?: AiTextAuditRequestOptions;
      };
      readonly output: AiCompletionResult;
    }
  | {
      readonly kind: "game_api";
      readonly detail: "compact";
      readonly route: string;
      readonly method: string;
      readonly context: AiTextAuditContext;
      readonly request: { readonly hasBody: boolean };
      readonly response: { readonly hasBody: boolean; readonly errorName?: string };
      readonly httpStatus: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "game_api";
      readonly detail: "full";
      readonly route: string;
      readonly method: string;
      readonly context: AiTextAuditContext;
      readonly request: { readonly rawBody: string | null; readonly json?: unknown };
      readonly response: {
        readonly rawBody: string | null;
        readonly json?: unknown;
        readonly errorName?: string;
      };
      readonly httpStatus: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "story_text";
      readonly context: AiTextAuditContext;
      readonly source: "generated" | "fixture" | "rule" | "deterministic";
      readonly path?: "normal";
      readonly scene?: unknown;
      readonly visibleText: unknown;
      readonly qualityWarnings?: readonly string[];
    };

/**
 * 审计事件条目：payload + envelope。
 */
export type AiTextAuditEntry = AiTextAuditPayload & AiTextAuditEnvelope;

/**
 * 审计记录器端口：best-effort、永不把写入异常抛回游戏主流程。
 */
export type AiTextAuditRecorder = {
  /** 是否开启审计记录。 */
  readonly enabled: boolean;
  /** 游戏 API 审计模式，与 AI 文本审计独立。 */
  readonly gameApiMode: GameApiAuditMode;
  /**
   * 记录一条审计事件。best-effort，永不 reject。
   * 写入失败只通过 onWriteFailure callback 通知。
   */
  record(payload: AiTextAuditPayload): Promise<void>;
  /** 等待写入队列并吞掉关闭异常。 */
  close(): Promise<void>;
};
