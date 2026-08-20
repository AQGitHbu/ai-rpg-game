// ---------------------------------------------------------------------------
// AI 文本审计事件契约（Task 1）。
//
// 本文件是纯类型端口，不引入 env/fs/transport 运行时依赖。
// 所有共享包引用必须是 import type，确保 application 本体和 composition root
// 可以从 ./server/ai/textAuditTypes 导入类型而不拉入 server-only 代码。
// ---------------------------------------------------------------------------

import type { AiMessage, AiCompletionResult } from "@ai-game/ai-transport";

/**
 * 审计模式：缺省、空白或非 "off" 值均按 "full" 处理，只有 trim 后等于 "off" 才关闭。
 */
export type AiTextAuditMode = "off" | "full";

/**
 * role 的唯一契约来源。textAuditTypes 不导入 rpgAiClient，rpgAiClient 复用此类型。
 */
export type AiTextAuditRole = "intent" | "opening" | "scene" | "world";

/**
 * 审计关联 link：只携带 traceId/gameId/jobId/turnNumber，不进入游戏状态。
 */
export type AiTextAuditLink = Readonly<
  Pick<AiTextAuditContext, "traceId" | "gameId" | "jobId" | "turnNumber">
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
  /** 内容修复重试编号与拒绝原因（scene/opening 的 repair 路径）。 */
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
    }
  | {
      readonly kind: "story_text";
      readonly context: AiTextAuditContext;
      readonly source: "generated" | "fallback" | "deterministic";
      readonly path?: "normal" | "prewarmed";
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
  /**
   * 记录一条审计事件。best-effort，永不 reject。
   * 写入失败只通过 onWriteFailure callback 通知。
   */
  record(payload: AiTextAuditPayload): Promise<void>;
  /** 等待写入队列并吞掉关闭异常。 */
  close(): Promise<void>;
};
