import assert from "node:assert/strict";
import test from "node:test";
import { parseFinishArgs, parseWorktreeList } from "./finishBranch.mjs";

test("分支参数映射到 worktree 名称并支持 refs/heads 前缀", () => {
  assert.deepEqual(parseFinishArgs(["codex/real-playtest-20-turns"]), {
    branch: "codex/real-playtest-20-turns",
    worktreeName: "real-playtest-20-turns",
    dryRun: false,
  });
  assert.deepEqual(parseFinishArgs(["refs/heads/feat/ai-story-quality-eval", "--dry-run"]), {
    branch: "feat/ai-story-quality-eval",
    worktreeName: "ai-story-quality-eval",
    dryRun: true,
  });
});

test("分支参数拒绝 main、路径穿越和非法 worktree 名称", () => {
  assert.throws(() => parseFinishArgs(["main"]), /非 main 分支/);
  assert.throws(() => parseFinishArgs(["codex/../escape"]), /合法 worktree 名称/);
  assert.throws(() => parseFinishArgs(["codex/UPPER"]), /合法 worktree 名称/);
  assert.throws(() => parseFinishArgs(["codex/foo", "extra"]), /用法/);
});

test("解析 git worktree list 的登记块", () => {
  const blocks = parseWorktreeList([
    "worktree F:/repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree F:/repo/.worktrees/demo",
    "HEAD def",
    "branch refs/heads/codex/demo",
    "",
  ].join("\n"));
  assert.deepEqual(blocks, [
    { path: "F:/repo", branch: "refs/heads/main" },
    { path: "F:/repo/.worktrees/demo", branch: "refs/heads/codex/demo" },
  ]);
});
