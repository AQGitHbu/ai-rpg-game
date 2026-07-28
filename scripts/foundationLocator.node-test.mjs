import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertFoundationRoot, projectRoot, resolveFoundationRoot } from "./foundationLocator.mjs";

test("resolves the sibling foundation from a primary checkout", (t) => {
  const fixture = createFixture(t);
  assert.equal(
    resolveFoundationRoot({
      root: fixture.gameMain,
      env: {},
      gitCommonDir: join(fixture.gameMain, ".git"),
    }),
    fixture.foundationMain,
  );
});

test("selects a matching foundation worktree", (t) => {
  const fixture = createFixture(t);
  const gameWorktree = join(fixture.gameMain, ".worktrees", "shared-ui-phase-0");
  const foundationWorktree = join(fixture.foundationMain, ".worktrees", "shared-ui-phase-0");
  mkdirSync(gameWorktree, { recursive: true });
  writeManifest(gameWorktree);
  writeFoundationContract(foundationWorktree);

  assert.equal(
    resolveFoundationRoot({
      root: gameWorktree,
      env: {},
      gitCommonDir: join(fixture.gameMain, ".git"),
    }),
    foundationWorktree,
  );
});

test("environment override takes priority", (t) => {
  const fixture = createFixture(t);
  const override = join(fixture.root, "custom-foundation");
  assert.equal(
    resolveFoundationRoot({
      root: fixture.gameMain,
      env: { AI_GAME_FOUNDATION_DIR: override },
      gitCommonDir: join(fixture.gameMain, ".git"),
    }),
    resolve(override),
  );
});

test("rejects a partial foundation directory instead of silently accepting packages", (t) => {
  const fixture = createFixture(t);
  const partial = join(fixture.root, "partial-foundation");
  mkdirSync(join(partial, "packages", "standards"), { recursive: true });

  assert.throws(
    () => assertFoundationRoot(partial),
    /缺失或不完整/,
  );
});

test("local package lock does not write dependencies through the foundation junction", () => {
  const lock = readFileSync(join(projectRoot, "package-lock.json"), "utf8");
  assert.match(lock, /"\.foundation\/packages\/ui"/);
  assert.doesNotMatch(lock, /\.foundation\/packages\/ui\/node_modules\//);
  assert.doesNotMatch(lock, /"[A-Za-z]:[\\/]/);
});

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "foundation-locator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gameMain = join(root, "ai-rpg-game");
  const foundationMain = join(root, "ai-game-foundation");
  mkdirSync(join(gameMain, ".git"), { recursive: true });
  writeFoundationContract(foundationMain);
  writeManifest(gameMain);
  return { root, gameMain, foundationMain };
}

function writeFoundationContract(root) {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "packages", "standards"), { recursive: true });
  mkdirSync(join(root, "packages", "ui"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "project-family.json"), "{}\n");
  writeFileSync(join(root, "packages", "standards", "package.json"), "{}\n");
  writeFileSync(join(root, "packages", "ui", "package.json"), "{}\n");
}

function writeManifest(root) {
  writeFileSync(
    join(root, ".ai-game-foundation.json"),
    `${JSON.stringify({
      localPath: "../ai-game-foundation",
      coordinatedWorktreeDirectory: ".worktrees",
      pathOverrideEnvironmentVariable: "AI_GAME_FOUNDATION_DIR",
    })}\n`,
  );
}
