// 当前兼容的 Qwen3/SGLang provider 会在未关闭 reasoning 时长时间不返回
// JSON 正文。必须只使用 nested 的 chat_template_kwargs；顶层
// enable_thinking 同样会让请求卡在超时，不能补发。
const REASONING_DISABLED_BODY = {
  chat_template_kwargs: { enable_thinking: false },
} as const;

/** 只启用已实测兼容的 OpenAI JSON object 模式；strict schema 仍由各角色另行定义。 */
export type ProviderJsonMode = "json_object" | "prompt_only";

/** 为所有 RPG live source 统一构建 provider 兼容的非推理请求参数。 */
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
      ...REASONING_DISABLED_BODY,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(jsonMode === "json_object" ? { response_format: { type: "json_object" } } : {}),
    },
  };
}
