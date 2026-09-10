// 纯对白 label 的格式审批（Plan 2026-09-09 / Task 6 Step 1）。
//
// 边界：只证明已列出的格式与结构违规，不宣称理解任意语义；
// 隐喻/意图细节由人工验收兜底。

import { describe, expect, it } from "vitest";
import { checkDialogueLabel } from "./dialogueLabel";

describe("checkDialogueLabel", () => {
  it("拒绝句首说话标签式冒号前缀", () => {
    expect(checkDialogueLabel("盯着她问：你到底是谁？").ok).toBe(false);
  });

  it("拒绝括号舞台说明", () => {
    expect(checkDialogueLabel("（握紧剑）我不答应。").ok).toBe(false);
    expect(checkDialogueLabel("我不答应。(转身就走)").ok).toBe(false);
  });

  it("允许句中条件冒号", () => {
    expect(checkDialogueLabel("我只有一个条件：先放人。").ok).toBe(true);
  });

  it("允许普通陈述句", () => {
    expect(checkDialogueLabel("我不替你送信，我要当面问清楚。").ok).toBe(true);
  });

  it("只允许外部空白 trim，不修改正文", () => {
    const result = checkDialogueLabel("  我答应你。  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("我答应你。");
  });

  it("trim 后为空拒绝", () => {
    expect(checkDialogueLabel("   ").ok).toBe(false);
  });

  it("拒绝外层引号包裹", () => {
    expect(checkDialogueLabel("“我不答应。”").ok).toBe(false);
    expect(checkDialogueLabel("「我不答应。」").ok).toBe(false);
    expect(checkDialogueLabel("\"我不答应。\"").ok).toBe(false);
  });

  it("拒绝序号前缀", () => {
    expect(checkDialogueLabel("1、答应他").ok).toBe(false);
    expect(checkDialogueLabel("2. 答应他").ok).toBe(false);
    expect(checkDialogueLabel("一、答应他").ok).toBe(false);
  });

  it("拒绝装饰性前缀", () => {
    expect(checkDialogueLabel("> 我答应你。").ok).toBe(false);
    expect(checkDialogueLabel("＞我答应你。").ok).toBe(false);
  });

  it("拒绝姓名标签式冒号（无标点短前缀）", () => {
    expect(checkDialogueLabel("沈砚：你到底是谁？").ok).toBe(false);
  });

  it("超过 label 长度上限拒绝", () => {
    expect(checkDialogueLabel("长".repeat(81)).ok).toBe(false);
  });
});
