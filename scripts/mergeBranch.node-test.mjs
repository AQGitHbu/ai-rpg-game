import assert from "node:assert/strict";
import test from "node:test";
import { parseMergeArgs } from "./mergeBranch.mjs";

test("分支合并参数与 branch:finish 保持一致", () => {
  assert.deepEqual(parseMergeArgs(["codex/dynamic-story-materialization", "--dry-run"]), {
    branch: "codex/dynamic-story-materialization",
    worktreeName: "dynamic-story-materialization",
    dryRun: true,
  });
});

test("分支合并拒绝 main 和非法参数", () => {
  assert.throws(() => parseMergeArgs(["main"]), /非 main 分支/);
  assert.throws(() => parseMergeArgs(["codex/../escape"]), /合法 worktree 名称/);
  assert.throws(() => parseMergeArgs(["codex/foo", "--force"]), /用法/);
});
