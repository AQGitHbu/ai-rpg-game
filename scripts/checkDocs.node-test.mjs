import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkDocs } from "./checkDocs.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rpg-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write("package.json", JSON.stringify({ scripts: { "check:docs": "node scripts/checkDocs.mjs" } }));
  write("AGENTS.md", "# 入口\n[索引](docs/Agent文档索引.md)\n");
  write("README.md", "# RPG\n[入口](AGENTS.md)\n");
  write("docs/Agent文档索引.md", "# 索引\n[系统](agent/系统.md)\n[阶段](agent/当前开发阶段.md)\n");
  write("docs/agent/系统.md", "# 系统\n当前契约。\n");
  write("docs/agent/当前开发阶段.md", "# 阶段入口\n[状态来源](current-phase.json)\n");
  write("docs/superpowers/plans/plan.md", "# 待执行计划\n新建 future.md\n");
  write("docs/agent/current-phase.json", JSON.stringify({
    phase: "example-phase", status: "planned", implementationStatus: "not_started",
    targetBranch: "codex/example", worktreeName: "example",
    plan: "docs/superpowers/plans/plan.md", entryDocs: ["AGENTS.md"],
  }));
  return { root, write };
}

test("valid Chinese, encoded, anchor, title and reference links pass; history is not scanned", t => {
  const { root, write } = fixture(t);
  write("docs/operations/含 空格.md", "# 运维\n");
  write("docs/agent/系统.md", '# 系统\n[入口](../../AGENTS.md#入口)\n[运维](<../operations/含 空格.md>)\n[编码](../operations/%E5%90%AB%20%E7%A9%BA%E6%A0%BC.md "标题")\n[说明][guide]\n\n[guide]: ../../README.md\n[网站](https://example.com/missing.md)\n');
  write("docs/archive/old.md", "[历史失效链接](missing.md)\n");
  write("docs/superpowers/reports/old.md", "[历史失效链接](missing.md)\n");
  assert.deepEqual(checkDocs(root).errors, []);
});

test("broken inline and reference links fail, code samples are not links", t => {
  const { root, write } = fixture(t);
  write("docs/agent/系统.md", '# 系统\n[坏](missing.md)\n[引用][bad]\n[bad]: absent.md\n```md\n[示例](example.md)\n```\n');
  const { errors } = checkDocs(root);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(e => /missing.md|absent.md/.test(e)));
});

test("missing backtick document references and undefined explicit references fail", t => {
  const { root, write } = fixture(t);
  write("docs/agent/系统.md", "# 系统\n`docs/agent/消失.md`\n[引用][undefined]\n");
  const { errors } = checkDocs(root);
  assert.ok(errors.some(e => e.includes("消失.md")));
  assert.ok(errors.some(e => e.includes("undefined")));
});

test("index cannot route to retired content or archives as an active system", t => {
  const { root, write } = fixture(t);
  write("docs/archive/old.md", "# 历史\n");
  write("docs/agent/系统.md", "# 系统\n> RETIRED\n");
  write("docs/Agent文档索引.md", "[系统](agent/系统.md)\n[阶段](agent/当前开发阶段.md)\n[旧系统](archive/old.md)\n");
  const { errors } = checkDocs(root);
  assert.ok(errors.some(e => e.includes("退役")));
  assert.ok(errors.some(e => e.includes("历史资料")));
});

test("new system must be indexed; template and maintenance README need no system row", t => {
  const { root, write } = fixture(t);
  write("docs/agent/新系统.md", "# 新系统\n");
  write("docs/agent/template.md", "# 模板\n");
  write("docs/agent/README.md", "# 维护规则\n");
  assert.deepEqual(checkDocs(root).errors, ["docs/agent/新系统.md: 系统文档未登记到 Agent 文档索引"]);
});

test("phase config links must exist and phase page cannot duplicate mutable state", t => {
  const { root, write } = fixture(t);
  write("docs/agent/当前开发阶段.md", "# 阶段\n[配置](current-phase.json)\n状态：planned / not_started\n");
  write("docs/agent/current-phase.json", JSON.stringify({ phase: "example-phase", status: "planned", implementationStatus: "not_started", plan: "missing.md", entryDocs: ["gone.md"] }));
  const { errors } = checkDocs(root);
  assert.ok(errors.some(e => e.includes("missing.md")));
  assert.ok(errors.some(e => e.includes("gone.md")));
  assert.ok(errors.some(e => e.includes("重复阶段状态")));
});

test("phase JSON malformed or missing config link returns clear errors", t => {
  const { root, write } = fixture(t);
  write("docs/agent/current-phase.json", "{");
  assert.ok(checkDocs(root).errors.some(e => e.includes("JSON")));
  write("docs/agent/当前开发阶段.md", "# 阶段\n");
  assert.ok(checkDocs(root).errors.some(e => e.includes("必须链接")));
});

test("history headings, large files, duplicate paragraphs and stale code are warnings", t => {
  const { root, write } = fixture(t);
  const paragraph = "结构化世界与剧情的权威状态应该通过规则审批保存，界面通过安全视图消费。".repeat(9);
  write("docs/agent/系统.md", `# 系统\n## 2026-09-08 修复补充\n\n${paragraph}\n\n\`src/missing.ts\`\n`);
  write("docs/operations/手册.md", `# 手册\n\n${paragraph}\n\n${"更多必要说明".repeat(2000)}\n`);
  const { errors, warnings } = checkDocs(root);
  assert.deepEqual(errors, []);
  for (const fragment of ["历史", "篇幅", "重复长段落", "源码"]) {
    assert.ok(warnings.some(w => w.includes(fragment)), fragment);
  }
});

test("local references outside repository and malformed URL encoding fail safely", t => {
  const { root, write } = fixture(t);
  write("docs/agent/系统.md", "# 系统\n[越界](../../../../private.md)\n[坏编码](%ZZ.md)\n");
  const { errors } = checkDocs(root);
  assert.ok(errors.some(e => e.includes("越出仓库")));
  assert.ok(errors.some(e => e.includes("编码")));
});


test("balanced destinations and valid Chinese/duplicate anchors pass; broken anchors fail", t => {
  const { root, write } = fixture(t);
  write("docs/operations/a(b(c)).md", "# 中文标题\n## 重复\n## 重复\n");
  write("docs/agent/系统.md", "# 系统\n[x](../operations/a(b(c)).md#中文标题)\n[x](../operations/a(b(c)).md#重复-1)\n[x](#系统)\n");
  assert.deepEqual(checkDocs(root).errors, []);
  write("docs/agent/系统.md", "# 系统\n[x](../operations/a(b(c)).md#不存在)\n[x](#不存在)\n");
  assert.equal(checkDocs(root).errors.filter(e => e.includes("锚点不存在")).length, 2);
});

test("current run commands are checked even in fenced recipes", t => {
  const { root, write } = fixture(t);
  write("docs/agent/系统.md", "# 系统\n```sh\nnpm run check:docs\nnpm run journey:removed\n```\n");
  assert.deepEqual(checkDocs(root).errors, ["docs/agent/系统.md: npm 命令不存在：journey:removed"]);
});

test("phase page rejects relative execution pointers and obsolete status copies", t => {
  const { root, write } = fixture(t);
  write("docs/agent/当前开发阶段.md", "# 阶段\n[配置](current-phase.json)\n[执行](../superpowers/plans/plan.md)\n");
  assert.ok(checkDocs(root).errors.some(e => e.includes("重复阶段状态")));
  write("docs/agent/当前开发阶段.md", "# 阶段\n[配置](current-phase.json)\n状态：completed / merged\n");
  assert.ok(checkDocs(root).errors.some(e => e.includes("重复阶段状态")));
});


test("CLI exits nonzero for broken navigation and zero for advisory-only findings", t => {
  const { root, write } = fixture(t);
  write("scripts/checkDocs.mjs", readFileSync(new URL("./checkDocs.mjs", import.meta.url), "utf8"));
  write("docs/agent/系统.md", "# 系统\n## 最近维护\n");
  const warning = spawnSync(process.execPath, [join(root, "scripts/checkDocs.mjs")], { encoding: "utf8" });
  assert.equal(warning.status, 0);
  assert.match(warning.stderr, /历史更新标题/);
  write("docs/agent/系统.md", "# 系统\n[坏入口](missing.md)\n");
  const broken = spawnSync(process.execPath, [join(root, "scripts/checkDocs.mjs")], { encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /本地链接不存在/);
});
