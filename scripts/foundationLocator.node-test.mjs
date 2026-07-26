import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { projectRoot, resolveFoundationRoot } from "./foundationLocator.mjs";

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
  mkdirSync(join(foundationWorktree, "packages", "standards"), { recursive: true });

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
  mkdirSync(join(foundationMain, "packages", "standards"), { recursive: true });
  writeManifest(gameMain);
  return { root, gameMain, foundationMain };
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
