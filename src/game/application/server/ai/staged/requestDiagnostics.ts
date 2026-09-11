const MAX_ERROR_BYTES = 8 * 1024;

const ALLOWED_ERROR_CODES = new Set([
  "invalid_request_error",
  "invalid_api_key",
  "rate_limit_exceeded",
  "model_not_found",
  "context_length_exceeded",
]);

const ALLOWED_ERROR_PARAMS = new Set([
  "max_tokens",
  "messages",
  "model",
  "response_format",
]);

const ERROR_READ_TIMEOUT_MS = 100;

export type RequestDiagnostic = Readonly<{
  stage: "planning" | "narration" | "character" | "choices" | "unknown";
  requestFingerprint: string;
  outcome: "http_error" | "network_error" | "aborted";
  status?: number;
  code?: string;
  param?: string;
  truncated?: boolean;
  correlationId?: string;
}>;

export type RequestDiagnosticSink = (diagnostic: RequestDiagnostic) => void;

function safeLabel(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return allowed.has(value) ? value : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> | undefined {
  if (typeof init?.body !== "string") return undefined;
  try { return asRecord(JSON.parse(init.body)); } catch { return undefined; }
}

function inferStage(body: Record<string, unknown> | undefined): RequestDiagnostic["stage"] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const joined = messages.map(message => {
    const record = asRecord(message);
    return typeof record?.content === "string" ? record.content : "";
  }).join("\n");
  for (const stage of ["planning", "narration", "character", "choices"] as const) {
    if (joined.includes(`\"stage\":\"${stage}\"`) || joined.includes(`stage=${stage}`)) return stage;
  }
  return "unknown";
}

function hashFingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function fingerprint(body: Record<string, unknown> | undefined): string {
  const responseFormat = asRecord(body?.response_format);
  return hashFingerprint(JSON.stringify({
    model: typeof body?.model === "string" ? body.model : "unknown",
    max_tokens: typeof body?.max_tokens === "number" ? body.max_tokens : null,
    temperature: typeof body?.temperature === "number" ? body.temperature : null,
    response_format: typeof responseFormat?.type === "string" ? responseFormat.type : null,
    stream: body?.stream === true,
  }));
}

async function readBoundedError(response: Response): Promise<{ value?: unknown; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<"timeout">(resolve => {
      timeout = setTimeout(() => resolve("timeout"), ERROR_READ_TIMEOUT_MS);
    });
    while (true) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === "timeout") { truncated = true; break; }
      if (next.done) break;
      const remaining = MAX_ERROR_BYTES - size;
      if (remaining <= 0) { truncated = true; break; }
      const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength || size >= MAX_ERROR_BYTES) { truncated = true; break; }
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (truncated) void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { value: JSON.parse(new TextDecoder().decode(bytes)), truncated }; }
  catch { return { truncated }; }
}

function localCorrelationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function observeError(response: Response, base: Pick<RequestDiagnostic, "stage" | "requestFingerprint" | "correlationId">, sink: RequestDiagnosticSink): Promise<void> {
  let parsed: { value?: unknown; truncated: boolean } = { truncated: false };
  try {
    parsed = await readBoundedError(response);
  } catch {
    parsed = { truncated: true };
  }
  const envelope = asRecord(parsed.value);
  const error = asRecord(envelope?.error) ?? envelope;
  try {
    sink({
      ...base,
      outcome: "http_error",
      status: response.status,
      ...(safeLabel(error?.code ?? error?.type, ALLOWED_ERROR_CODES) === undefined ? {} : { code: safeLabel(error?.code ?? error?.type, ALLOWED_ERROR_CODES) }),
      ...(safeLabel(error?.param, ALLOWED_ERROR_PARAMS) === undefined ? {} : { param: safeLabel(error?.param, ALLOWED_ERROR_PARAMS) }),
      ...(parsed.truncated ? { truncated: true } : {}),
    });
  } catch {
    // Diagnostics are best-effort and must never alter transport behavior.
  }
}

const pendingDiagnostics = new Set<Promise<void>>();

export async function drainRequestDiagnostics(): Promise<void> {
  await Promise.allSettled([...pendingDiagnostics]);
}

/** Observe provider failures without changing transport request, retry, timeout, or response handling. */
export function createDiagnosticFetch(fetchImpl: typeof fetch, sink: RequestDiagnosticSink): typeof fetch {
  return async (input, init) => {
    const body = requestBody(init);
    const base = { stage: inferStage(body), requestFingerprint: fingerprint(body), correlationId: localCorrelationId() } as const;
    try {
      const response = await fetchImpl(input, init);
      if (response.ok) return response;
      try {
        const pending = observeError(response.clone(), base, sink);
        pendingDiagnostics.add(pending);
        void pending.finally(() => pendingDiagnostics.delete(pending));
      } catch {
        try { sink({ ...base, outcome: "http_error", status: response.status, truncated: true }); } catch { /* best effort */ }
      }
      return response;
    } catch (error) {
      const aborted = init?.signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
      try { sink({ ...base, outcome: aborted ? "aborted" : "network_error" }); } catch { /* best effort */ }
      throw error;
    }
  };
}
