import { describe, expect, it } from "vitest";
import { resolveAiThinkingRoles } from "./aiThinking";

describe("resolveAiThinkingRoles", () => {
  it("未配置或只含非法角色时默认关闭", () => {
    expect(resolveAiThinkingRoles({})).toEqual([]);
    expect(resolveAiThinkingRoles({ AI_THINKING_ROLES: "unknown, ,invalid" })).toEqual([]);
  });

  it("只接受合法角色、去重并按稳定顺序返回", () => {
    expect(resolveAiThinkingRoles({ AI_THINKING_ROLES: "writer,director,writer,unknown" })).toEqual([
      "director",
      "writer"
    ]);
  });
});
