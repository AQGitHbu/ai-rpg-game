// 当前链路是 new-api → DeepSeek 官方 OpenAI-compatible API。
// DeepSeek 官方通过顶层 thinking.type 切换 enabled/disabled；不要发送
// Qwen/SGLang 专用的 chat_template_kwargs.enable_thinking。

/** 只启用已实测兼容的 OpenAI JSON object 模式；strict schema 仍由各角色另行定义。 */
export type ProviderJsonMode = "json_object" | "prompt_only";
export type ProviderThinking = "off" | "on";

/** 为所有 RPG live source 统一构建 provider 兼容的请求参数。 */
export type ProviderRequestOptions = Readonly<{
  timeoutMs: number;
  temperature?: number;
  extraBody: Record<string, unknown>;
}>;

/**
 * 非思考 live role 只需输出一个小型、可验证的 JSON，因此限制完成 token
 * 并降低 temperature 能避免兼容 provider 在默认超大输出预算下长时间不结束
 * 请求。思考模式不发送 max_tokens，避免推理消耗掉最终 JSON 的预算；这不是
 * fallback，也不改变服务端的严格审批。
 */
export function createProviderRequestOptions(
  timeoutMs: number,
  maxTokens?: number,
  jsonMode: ProviderJsonMode = "prompt_only",
  thinking: ProviderThinking = "off",
): ProviderRequestOptions {
  // DeepSeek-style thinking consumes the completion budget while reasoning.
  // A fixed max_tokens value can therefore terminate the response before the
  // final JSON channel is produced. Thinking-enabled calls are intentionally
  // unbounded; bounded role budgets remain available when thinking is off.
  const effectiveMaxTokens = thinking === "on" ? undefined : maxTokens;
  return {
    timeoutMs,
    // Preserve the caller's low-temperature setting even when thinking mode
    // deliberately suppresses its max_tokens cap.
    ...(maxTokens === undefined ? {} : { temperature: 0.2 }),
    // JSON mode is a provider capability, not a side effect of choosing a
    // bounded output budget.  Opening generation deliberately has no token
    // cap, so it must still receive response_format when the verified mode is
    // enabled; otherwise an opening silently takes a different protocol from
    // every later narrative turn.
    extraBody: {
      thinking: { type: thinking === "on" ? "enabled" : "disabled" },
      ...(effectiveMaxTokens === undefined ? {} : { max_tokens: effectiveMaxTokens }),
      ...(jsonMode === "json_object" ? { response_format: { type: "json_object" } } : {}),
    },
  };
}
