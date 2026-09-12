// Historical receipt validation only.
export const REVIEW_PROTOCOL_CODES = ["invalid_schema", "unknown_checkId", "foreign_inquiryId", "duplicate_plan_checkId", "invalid_type", "invalid_inquiryId", "invalid_json", "response_too_long"] as const;
export type ReviewProtocolIssue = Readonly<{ code: typeof REVIEW_PROTOCOL_CODES[number]; path: string }>;
export function isReviewProtocolIssue(value: unknown): value is ReviewProtocolIssue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 2 && REVIEW_PROTOCOL_CODES.includes(r.code as ReviewProtocolIssue["code"])
    && typeof r.path === "string" && /^(\$|\$\.violations\[[0-7]\](\.(checkId|inquiryId|type))?)$/.test(r.path);
}
