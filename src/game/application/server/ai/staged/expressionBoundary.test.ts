import { expect, it } from "vitest";
import { expressionBoundary } from "./expressionBoundary";

it.each(["目击细节", "历史比较", "设备运行状态", "玩家动作", "未来承诺", "事实 ID"])(
  "真实失败类别必须纳入共同表达边界：%s", category => {
    expect(expressionBoundary()).toContain(category);
  });
