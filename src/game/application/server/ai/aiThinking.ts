export const AI_THINKING_ROLES = ["scenario", "director", "writer", "npc"] as const;

export type AiThinkingRole = (typeof AI_THINKING_ROLES)[number];

/**
 * Resolve the opt-in provider reasoning roles without exposing the raw env value.
 * Unknown names and duplicates are ignored; the result always follows the
 * canonical role order so manifests remain stable across equivalent settings.
 */
export function resolveAiThinkingRoles(
  env: Readonly<Record<string, string | undefined>>
): readonly AiThinkingRole[] {
  const requested = new Set(
    (env.AI_THINKING_ROLES ?? "")
      .split(",")
      .map((role) => role.trim().toLowerCase())
      .filter((role) => role.length > 0)
  );
  return AI_THINKING_ROLES.filter((role) => requested.has(role));
}
