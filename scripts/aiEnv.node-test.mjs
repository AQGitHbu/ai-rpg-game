import assert from "node:assert/strict";
import test from "node:test";
import { AI_ENV_KEYS, parseEnvAssignments, validateAiEnv } from "./aiEnv.mjs";

test("parses only named assignments without exposing values", () => {
  const values = parseEnvAssignments(
    "AI_API_BASE_URL=https://example.test/v1\nAI_MODEL='model-a'\nAI_API_KEY=\"secret\"\n",
  );
  assert.deepEqual([...values.keys()], AI_ENV_KEYS);
  assert.equal(values.get("AI_MODEL").decoded, "model-a");
});

test("validates required AI environment contract", () => {
  const valid = parseEnvAssignments(
    "AI_API_BASE_URL=https://example.test/v1\nAI_MODEL=model-a\nAI_API_KEY=secret\n",
  );
  assert.deepEqual(validateAiEnv(valid), []);

  const invalid = parseEnvAssignments(
    "AI_API_BASE_URL=file:///tmp/model\nAI_MODEL=\nAI_API_KEY=change-me\n",
  );
  assert.ok(validateAiEnv(invalid).length >= 3);
});
