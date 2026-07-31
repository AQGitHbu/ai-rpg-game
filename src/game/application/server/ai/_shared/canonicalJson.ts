import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// AI source 共享基础设施：稳定序列化 + 请求指纹。
// 三条 AI 管线（scenario / townPlan / runtimeNarrative）的录制/回放都需要把
// 请求语义压成确定性指纹以做 drift 检测。各管线的 volatile 字段策略不同
// （traceId、sceneId、choiceToken 等运行时易变字段不参与指纹），因此把
// volatileKeys 作为参数传入，而非在模块内硬编码。
//
// 语义与原 townPlanRecording / runtimeNarrativeRecording 中的局部实现逐字等价：
//   * 命中 volatileKeys 的字段（按 parentKey 判定）整值替换为 "<volatile>"
//     占位，不递归进入被占位的子树；
//   * 对象 key 升序排序后序列化，保证同语义请求得到同一 canonical 串。
// ---------------------------------------------------------------------------

const VOLATILE_PLACEHOLDER = JSON.stringify("<volatile>");

function serialize(
  value: unknown,
  volatileKeys: ReadonlySet<string>,
  parentKey: string | undefined
): string {
  if (parentKey !== undefined && volatileKeys.has(parentKey)) {
    return VOLATILE_PLACEHOLDER;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry, volatileKeys, undefined)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key], volatileKeys, key)}`)
    .join(",")}}`;
}

/** 稳定序列化：对象 key 排序；命中 volatileKeys 的字段值替换为 "<volatile>" 占位。 */
export function canonicalJson(value: unknown, volatileKeys: ReadonlySet<string>): string {
  return serialize(value, volatileKeys, undefined);
}

/** canonical JSON + sha256 十六进制指纹。 */
export function fingerprint(value: unknown, volatileKeys: ReadonlySet<string>): string {
  return createHash("sha256").update(canonicalJson(value, volatileKeys)).digest("hex");
}
