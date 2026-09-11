import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleTransport, type AiTransportConfig } from "@ai-game/ai-transport";
import { createDiagnosticFetch, drainRequestDiagnostics, type RequestDiagnostic } from "./requestDiagnostics";

const config: AiTransportConfig = { baseUrl: "https://provider.test/v1", apiKey: "authorization-secret", model: "model" };
const messages = [{ role: "user" as const, content: '{"stage":"choices"} return JSON' }];

async function completeWith(response: Response | Error) {
  const diagnostics: RequestDiagnostic[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  const transport = createOpenAiCompatibleTransport({ fetchImpl: createDiagnosticFetch(fetchImpl, value => diagnostics.push(value)) });
  const result = await transport.complete(config, messages, { timeoutMs: 100, temperature: 0.2, extraBody: { max_tokens: 600, response_format: { type: "json_object" } } });
  await drainRequestDiagnostics();
  return { result, diagnostics };
}

describe("request diagnostics", () => {
  it.each([400, 401, 429, 500])("retains HTTP %s and only whitelisted provider fields", async status => {
    const { diagnostics } = await completeWith(new Response(JSON.stringify({ error: {
      message: "secret-sentinel Authorization: Bearer leaked", code: "invalid_request_error", param: "max_tokens",
    } }), { status, headers: { "x-request-id": "req-safe_1" } }));
    expect(diagnostics).toEqual([expect.objectContaining({ status, stage: "choices", code: "invalid_request_error", param: "max_tokens", correlationId: expect.any(String) })]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-sentinel");
    expect(JSON.stringify(diagnostics)).not.toContain("authorization-secret");
  });

  it("keeps status for non-JSON errors and maps unknown strings", async () => {
    const nonJson = await completeWith(new Response("private upstream page", { status: 400 }));
    expect(nonJson.diagnostics[0]).toMatchObject({ status: 400, outcome: "http_error" });
    const unknown = await completeWith(new Response(JSON.stringify({ error: { code: "private-code", param: "private-param" } }), { status: 400 }));
    expect(unknown.diagnostics[0]).toMatchObject({ code: "unknown", param: "unknown" });
    expect(JSON.stringify(unknown.diagnostics)).not.toContain("private-");
  });

  it("bounds oversized error bodies and leaves the original response readable by transport", async () => {
    const { result, diagnostics } = await completeWith(new Response(JSON.stringify({ error: { code: "invalid_request_error", param: "messages", message: "x".repeat(20_000) } }), { status: 400 }));
    expect(result).toMatchObject({ ok: false, code: "http_error" });
    expect(diagnostics[0]).toMatchObject({ status: 400, truncated: true });
  });

  it("does not consume or diagnose a successful response", async () => {
    const response = new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    const { result, diagnostics } = await completeWith(response);
    expect(result).toMatchObject({ ok: true, content: "{}" });
    expect(diagnostics).toEqual([]);
  });

  it("diagnostic clone/read and sink failures cannot change the HTTP result", async () => {
    const response = new Response("private", { status: 500 });
    response.clone = () => { throw new Error("clone failed"); };
    const cloneFailureFetch = createDiagnosticFetch(async () => response, () => undefined);
    await expect(cloneFailureFetch("https://provider.test", { method: "POST", body: "{}" })).resolves.toBe(response);

    const sinkFailureFetch = createDiagnosticFetch(async () => new Response("private", { status: 500 }), () => {
      throw new Error("sink failed");
    });
    const sinkResponse = await sinkFailureFetch("https://provider.test", { method: "POST", body: "{}" });
    expect(sinkResponse.status).toBe(500);
    await drainRequestDiagnostics();
  });

  it("cancels a slow error clone within the bounded diagnostic window", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel });
    const original = new Response("provider body", { status: 500 });
    original.clone = () => new Response(body, { status: 500 });
    const wrapped = createDiagnosticFetch(async () => original, () => undefined);
    const response = await wrapped("https://provider.test", { method: "POST", body: "{}" });
    expect(response.status).toBe(500);
    await drainRequestDiagnostics();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rethrows network and abort errors so transport retains its stable mapping", async () => {
    const network = await completeWith(new Error("secret network detail"));
    expect(network.result).toMatchObject({ ok: false, code: "network_error" });
    expect(network.diagnostics).toEqual([expect.objectContaining({ outcome: "network_error" })]);

    const diagnostics: RequestDiagnostic[] = [];
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    const transport = createOpenAiCompatibleTransport({ fetchImpl: createDiagnosticFetch(fetchImpl, value => diagnostics.push(value)) });
    const pending = transport.complete(config, messages, { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "aborted" });
    expect(diagnostics.every(item => item.outcome === "aborted")).toBe(true);
    expect(diagnostics.some(item => item.outcome === "http_error")).toBe(false);
  });
});
