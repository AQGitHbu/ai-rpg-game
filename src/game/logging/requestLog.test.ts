import { describe, expect, it } from "vitest";
import { createRequestLogContext } from "./requestLog";

describe("createRequestLogContext", () => {
  it("保留合法 traceId，并规范化结果码", () => {
    const context = createRequestLogContext({
      method: "POST",
      route: "/api/game/actions",
      traceId: "client_trace-01",
      now: () => 1234
    });

    expect(context.traceId).toBe("client_trace-01");
    expect(context.startedAtMs).toBe(1234);
    context.markResultCode(" INVALID_INTENT ");
    expect(context.resultCode()).toBe("INVALID_INTENT");
  });

  it("拒绝过长或含敏感分隔符的外部 traceId，并忽略非法结果码", () => {
    const context = createRequestLogContext({
      method: "GET",
      route: "/api/game/current",
      traceId: "trace\nwith\tunsafe-content"
    });

    expect(context.traceId).not.toContain("\n");
    expect(context.traceId).not.toContain("\t");
    context.markResultCode("bad code with spaces");
    expect(context.resultCode()).toBeUndefined();
  });
});
