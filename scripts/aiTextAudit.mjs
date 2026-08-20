#!/usr/bin/env node
// @ts-check
//
// AI Text Audit CLI — list, query, verify and export audit runs.
//
// Audit logs are append-only JSONL files at <rootDir>/<runId>/events.jsonl.
// rootDir defaults to env AI_TEXT_AUDIT_DIR, then logs/ai-text-audit.
//
// This script only reads JSONL. It does not connect to game databases,
// does not output model keys, and does not auto-delete logs.

import { readdir, readFile, stat, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_ROOT_DIR = "logs/ai-text-audit";

function resolveRootDir(env) {
  const dir = env.AI_TEXT_AUDIT_DIR ?? DEFAULT_ROOT_DIR;
  return resolve(dir);
}

// Secret field names that must never appear in audit records.
const SECRET_FIELD_PATTERNS = ["apiKey", "authorization", "baseUrl", "cookie", "api_key"];

// Required context fields for each event kind.
const REQUIRED_CONTEXT_FIELDS = ["purpose", "trigger"];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(rootDir) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    console.log("No audit runs found.");
    return 0;
  }

  const runDirs = entries.filter((e) => e.isDirectory());
  if (runDirs.length === 0) {
    console.log("No audit runs found.");
    return 0;
  }

  // Sort by modification time descending
  const withStats = await Promise.all(
    runDirs.map(async (d) => {
      const dirPath = join(rootDir, d.name);
      const filePath = join(dirPath, "events.jsonl");
      let fileStat = null;
      try {
        fileStat = await stat(filePath);
      } catch {
        // no events file
      }
      return {
        name: d.name,
        mtime: fileStat?.mtime ?? new Date(0),
        hasEvents: fileStat !== null,
      };
    }),
  );
  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  for (const r of withStats) {
    const status = r.hasEvents ? r.mtime.toISOString() : "(no events.jsonl)";
    console.log(`${r.name}\t${status}`);
  }
  return 0;
}

async function readEvents(filePath) {
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      events.push({ entry, line: i + 1, raw: lines[i] });
    } catch {
      errors.push({ line: i + 1, raw: lines[i] });
    }
  }
  return { events, errors };
}

async function cmdQuery(rootDir, args) {
  const runId = args.run;
  if (!runId) {
    console.error("Error: --run <runId> is required");
    return 1;
  }

  const filePath = join(rootDir, runId, "events.jsonl");
  if (!existsSync(filePath)) {
    console.error(`Error: audit run "${runId}" not found at ${filePath}`);
    return 1;
  }

  const { events, errors } = await readEvents(filePath);

  // Report parse errors but still output valid events
  for (const err of errors) {
    console.error(`Warning: malformed JSON at line ${err.line}: ${err.raw.slice(0, 80)}`);
  }

  let filtered = events.map((e) => e.entry);

  if (args.kind) {
    filtered = filtered.filter((e) => e.kind === args.kind);
  }

  if (args.game) {
    filtered = filtered.filter((e) => e.context?.gameId === args.game);
  }

  for (const entry of filtered) {
    console.log(JSON.stringify(entry));
  }

  return errors.length > 0 ? 2 : 0;
}

async function cmdVerify(rootDir, args) {
  const runId = args.run;
  if (!runId) {
    console.error("Error: --run <runId> is required");
    return 1;
  }

  const filePath = join(rootDir, runId, "events.jsonl");
  if (!existsSync(filePath)) {
    console.error(`Error: audit run "${runId}" not found at ${filePath}`);
    return 1;
  }

  const { events, errors } = await readEvents(filePath);
  let hasErrors = false;

  // Check for malformed JSON
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`FAIL: malformed JSON at line ${err.line}: ${err.raw.slice(0, 100)}`);
    }
    hasErrors = true;
  }

  // Check contiguous sequence
  let expectedSeq = 1;
  for (const { entry, line } of events) {
    if (entry.sequence !== expectedSeq) {
      console.error(`FAIL: sequence gap at line ${line}: expected ${expectedSeq}, got ${entry.sequence}`);
      hasErrors = true;
    }
    if (entry.sequence >= expectedSeq) {
      expectedSeq = entry.sequence + 1;
    }
  }

  // Check required context fields
  for (const { entry, line } of events) {
    if (!entry.context || typeof entry.context !== "object") {
      console.error(`FAIL: missing context object at line ${line} (sequence ${entry.sequence})`);
      hasErrors = true;
      continue;
    }
    for (const field of REQUIRED_CONTEXT_FIELDS) {
      if (entry.context[field] === undefined || entry.context[field] === null) {
        console.error(`FAIL: missing context.${field} at line ${line} (sequence ${entry.sequence})`);
        hasErrors = true;
      }
    }
  }

  // Check for secret fields
  for (const { entry, line, raw } of events) {
    // Check the raw JSON string for secret field names
    const lowerRaw = raw.toLowerCase();
    for (const pattern of SECRET_FIELD_PATTERNS) {
      const lowerPattern = pattern.toLowerCase();
      // Match "fieldName" or "fieldName": pattern in JSON
      const regex = new RegExp(`"${lowerPattern}"\\s*:`, "i");
      if (regex.test(raw)) {
        console.error(`FAIL: secret field "${pattern}" found at line ${line} (sequence ${entry.sequence})`);
        hasErrors = true;
      }
    }
  }

  if (!hasErrors) {
    console.log(`OK: run "${runId}" verified — ${events.length} events, contiguous sequence, no secret fields.`);
    return 0;
  }

  return 1;
}

async function cmdExport(rootDir, args) {
  const runId = args.run;
  const outFile = args.out;
  if (!runId) {
    console.error("Error: --run <runId> is required");
    return 1;
  }
  if (!outFile) {
    console.error("Error: --out <file> is required");
    return 1;
  }

  const filePath = join(rootDir, runId, "events.jsonl");
  if (!existsSync(filePath)) {
    console.error(`Error: audit run "${runId}" not found at ${filePath}`);
    return 1;
  }

  // Copy without modifying the original
  await copyFile(filePath, outFile);
  const stat_ = await stat(filePath);
  console.log(`Exported ${runId} (${stat_.size} bytes) to ${outFile}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return { command, args };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  const rootDir = resolveRootDir(process.env);

  switch (command) {
    case "list":
      return cmdList(rootDir);
    case "query":
      return cmdQuery(rootDir, args);
    case "verify":
      return cmdVerify(rootDir, args);
    case "export":
      return cmdExport(rootDir, args);
    default:
      console.error(`Usage: aiTextAudit.mjs <list|query|verify|export> [options]`);
      console.error("");
      console.error("Commands:");
      console.error("  list                                List available audit runs");
      console.error("  query --run <runId>                Query events from a run");
      console.error("    [--kind ai_call|game_api|story_text]");
      console.error("    [--game <gameId>]");
      console.error("  verify --run <runId>               Verify run integrity");
      console.error("  export --run <runId> --out <file>  Export a run to a file");
      console.error("");
      console.error("Environment:");
      console.error("  AI_TEXT_AUDIT_DIR  Root directory for audit logs (default: logs/ai-text-audit)");
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
