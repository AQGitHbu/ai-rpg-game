import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(process.cwd(), "src");
const LOGGING_ROOT = resolve(SOURCE_ROOT, "game/logging");
const SERVER_CONSOLE_LOGGER = "game/logging/serverConsoleLogger.ts";
const FORBIDDEN_LOGGING_IMPORT = /["'](?:@\/game\/(?:domain|core|gameplay|application)|@\/components|@\/store|@\/app|@ai-game\/)/;
const DIRECT_CONSOLE = /\bconsole\.(?:log|warn|error)\s*\(/;

function productionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const file = resolve(directory, entry);
    if (statSync(file).isDirectory()) return productionFiles(file);
    if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) return [];
    return [file];
  });
}

function relativeToSource(file: string): string {
  return file.slice(SOURCE_ROOT.length + 1).replaceAll("\\", "/");
}

describe("logging dependency boundaries", () => {
  it("logging stays independent from product and shared game layers", () => {
    const violations = productionFiles(LOGGING_ROOT)
      .filter((file) => FORBIDDEN_LOGGING_IMPORT.test(readFileSync(file, "utf8")))
      .map(relativeToSource);
    expect(violations).toEqual([]);
  });

  it("permits direct console output only at the server sink boundary", () => {
    const violations = productionFiles(SOURCE_ROOT)
      .filter((file) => relativeToSource(file) !== SERVER_CONSOLE_LOGGER)
      .filter((file) => DIRECT_CONSOLE.test(readFileSync(file, "utf8")))
      .map(relativeToSource);
    expect(violations).toEqual([]);
  });

  it("keeps the console exception non-vacuous", () => {
    const source = readFileSync(resolve(SOURCE_ROOT, SERVER_CONSOLE_LOGGER), "utf8");
    expect(DIRECT_CONSOLE.test(source)).toBe(true);
  });
});
