import assert from "node:assert/strict";
import test from "node:test";
import { collectReparsePoints, validateWorktreeName } from "./removeWorktree.mjs";

test("worktree 名称只接受小写字母、数字和连字符", () => {
  assert.equal(validateWorktreeName("mvp-phase-4a-ai-contract-simulation"), true);
  assert.equal(validateWorktreeName("phase-4-design"), true);
  assert.equal(validateWorktreeName(""), false);
  assert.equal(validateWorktreeName(undefined), false);
  assert.equal(validateWorktreeName("-leading"), false);
  assert.equal(validateWorktreeName("UPPER"), false);
  assert.equal(validateWorktreeName("has space"), false);
  assert.equal(validateWorktreeName("../escape"), false);
  assert.equal(validateWorktreeName("a\\b"), false);
});

test("collectReparsePoints 找到链接后不进入其内部", () => {
  // 虚拟目录树：root/{node_modules/{@ai-game/{ui->junction}}, src/{a.ts}}
  const tree = new Map([
    ["root", ["node_modules", "src"]],
    ["root/node_modules", ["@ai-game"]],
    ["root/node_modules/@ai-game", ["ui"]],
    ["root/src", ["a.ts"]],
  ]);
  const links = new Set(["root/node_modules/@ai-game/ui"]);
  const visited = [];
  const found = collectReparsePoints("root", {
    list: (directory) => {
      visited.push(directory);
      const entries = tree.get(directory.replaceAll("\\", "/"));
      if (entries === undefined) throw new Error(`不应进入：${directory}`);
      return entries;
    },
    stat: (path) => {
      const normalized = path.replaceAll("\\", "/");
      return {
        isSymbolicLink: () => links.has(normalized),
        isDirectory: () => tree.has(normalized),
      };
    },
  });
  assert.equal(found.length, 1);
  assert.match(found[0].replaceAll("\\", "/"), /@ai-game\/ui$/);
  // 绝不把链接目标当目录展开。
  assert.equal(
    visited.some((directory) => directory.replaceAll("\\", "/").endsWith("@ai-game/ui")),
    false,
  );
});

test("collectReparsePoints 干净目录返回空数组", () => {
  const found = collectReparsePoints("clean", {
    list: (directory) => (directory === "clean" ? ["a.txt"] : []),
    stat: () => ({ isSymbolicLink: () => false, isDirectory: () => false }),
  });
  assert.deepEqual(found, []);
});
