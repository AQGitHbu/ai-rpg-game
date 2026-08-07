import type { IntentContext } from "./intentContext";
import type { Action } from "@/game/domain/action";

// ---------------------------------------------------------------------------
// IntentParserSource：可注入的 AI 意图解析 port。
// 纯类型定义，放在 gameplay 层（performActionV2 可安全导入）。
// 生产环境注入 live source（小模型），测试/离线注入 fixture source。
// fixture 实现在 application/server/ai/intentParserSource.ts。
// ---------------------------------------------------------------------------

export type IntentParserResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unclassifiable" | "service_error" };

export type IntentParserSource = {
  readonly sourceVersion: string;
  parseIntent(text: string, ctx: IntentContext): Promise<IntentParserResult>;
};
