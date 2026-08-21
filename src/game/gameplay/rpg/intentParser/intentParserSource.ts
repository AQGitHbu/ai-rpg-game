import type { IntentContext } from "./intentContext";
import type { Action } from "@/game/domain/action";
import type { NpcId } from "@/game/domain/worldEntity";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";

/** Optional request correlation metadata; never part of gameplay state or intent rules. */
export type IntentAuditLink = Readonly<{
  readonly traceId?: string;
  readonly gameId?: string;
  readonly jobId?: string;
  readonly turnNumber?: number;
}>;

// ---------------------------------------------------------------------------
// IntentParserSource：可注入的 AI 意图解析 port。
// 纯类型定义，供 application 回合编排安全导入。
// 生产环境注入 live source（小模型），测试/离线注入 fixture source。
// fixture 实现在 application/server/ai/intentParserSource.ts。
// Task 9：targetNpcId 可选——自由输入绑定目标 NPC 时，源必须先做目标合法性校验。
// ---------------------------------------------------------------------------

export type IntentParserResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unclassifiable" }
  | {
      readonly ok: false;
      readonly reason: "service_error";
      readonly failureKind: AiFailureKind;
    };

export type IntentParserSource = {
  readonly sourceVersion: string;
  parseIntent(text: string, ctx: IntentContext, targetNpcId?: NpcId, auditLink?: IntentAuditLink): Promise<IntentParserResult>;
};
