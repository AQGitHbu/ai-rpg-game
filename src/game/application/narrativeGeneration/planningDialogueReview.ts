import { isLegacyStoredDialogueReview as isStoredDialogueReview } from "./legacyDialogueReview";
export function isStoredPlanningDialogueReviews(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).length <= 48 && Object.entries(value).every(([key, receipt]) =>
      /^[a-zA-Z0-9_:-]{1,128}$/.test(key) && receipt !== undefined && isStoredDialogueReview(receipt)));
}
