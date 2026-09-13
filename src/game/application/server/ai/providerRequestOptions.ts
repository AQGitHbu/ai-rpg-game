// 当前链路是 new-api → DeepSeek 官方 OpenAI-compatible API。
// DeepSeek 官方通过顶层 thinking.type 切换 enabled/disabled；不要发送
// Qwen/SGLang 专用的 chat_template_kwargs.enable_thinking。

/** 只启用已实测兼容的 OpenAI JSON object 模式；strict schema 仍由各角色另行定义。 */
export type ProviderJsonMode = "json_object" | "prompt_only";
export type ProviderThinking = "off" | "on";
/** DeepSeek V4 reasoning_effort values; medium/xhigh are intentionally omitted because the API maps them. */
export type ProviderReasoningEffort = "low" | "high" | "max";

/** 为所有 RPG live source 统一构建 provider 兼容的请求参数。 */
export type ProviderRequestOptions = Readonly<{
  timeoutMs: number;
  temperature?: number;
  extraBody: Record<string, unknown>;
}>;

/**
 * 每个 live role 都只需输出一个小型、可验证的 JSON。限制完成 token 并降低
 * temperature 能避免兼容 provider 在默认超大输出预算下长时间不结束请求；
 * 这不是 fallback，也不改变服务端的严格审批。
 */
export function createProviderRequestOptions(
  timeoutMs: number,
  maxTokens?: number,
  jsonMode: ProviderJsonMode = "prompt_only",
  thinking: ProviderThinking = "off",
  reasoningEffort?: ProviderReasoningEffort,
): ProviderRequestOptions {
  return {
    timeoutMs,
    ...(maxTokens === undefined ? {} : { temperature: 0.2 }),
    // JSON mode is a provider capability, not a side effect of choosing a
    // bounded output budget.  Opening generation deliberately has no token
    // cap, so it must still receive response_format when the verified mode is
    // enabled; otherwise an opening silently takes a different protocol from
    // every later narrative turn.
    extraBody: {
      thinking: { type: thinking === "on" ? "enabled" : "disabled" },
      ...(thinking === "on" && reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(jsonMode === "json_object" ? { response_format: { type: "json_object" } } : {}),
    },
  };
}
