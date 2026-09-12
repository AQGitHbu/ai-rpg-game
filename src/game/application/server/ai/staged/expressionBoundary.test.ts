import { expect, it } from "vitest";
import { expressionBoundary } from "./expressionBoundary";

it.each(["目击细节", "历史比较", "设备运行状态", "玩家动作", "未来承诺", "事实 ID"])(
  "真实失败类别必须纳入共同表达边界：%s", category => {
    expect(expressionBoundary()).toContain(category);
  });

it("风格与极短衔接不授予天气、行动或进展的补写权限", () => {
  const boundary = expressionBoundary();
  expect(boundary).toContain("主角性格与角色说话方式都只约束表达");
  expect(boundary).toContain("不把意愿写成已执行动作");
  expect(boundary).toContain("不从地名和题材猜天气、声响或痕迹");
  expect(boundary).toContain("facts=[] 或氛围节拍均不授予新增信息权限");
});
