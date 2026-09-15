import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installTsHooks } from './narrativeP1Journey.mjs';
import { freezeP2CodeIdentity } from './narrativeP2Journey.mjs';
import { readAiEnv } from './aiEnv.mjs';
import { createNarrativeP2StageRunner } from './narrativeP2Stage.mjs';
import { replayP2Stage } from './narrativeP2Quality.mjs';

// Narrow v3 diagnostic entry; existing v2 CLI and admission remain unchanged.
const [mode, runId, reviewPath] = process.argv.slice(2);
if (!['register', 'live', 'resume', 'replay'].includes(mode) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId ?? '')) throw Error('P2_MEMORY_ARGUMENTS');
installTsHooks();
const { createNarrativeP2MemoryProtocol, canonicalP2 } = await import('../src/game/application/testing/narrativeP2Journey.ts');
const directory = resolve('artifacts/narrative-p2', runId);
const path = resolve(directory, 'protocol.json');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const frozen = mode === 'register' ? null : read(path);
const local = mode === 'replay' ? new Map() : readAiEnv(resolve('.env.local'));
const env = { ...process.env };
for (const key of ['AI_MODEL', 'AI_API_BASE_URL', 'AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS', 'AI_API_KEY']) env[key] = process.env[key] ?? local.get(key)?.decoded;
const environment = mode === 'replay' ? frozen.environment : { model: env.AI_MODEL?.trim(), apiBaseUrl: env.AI_API_BASE_URL?.trim(), inputMaxEstimatedTokens: Number(env.AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS ?? 64000) };
const protocol = createNarrativeP2MemoryProtocol(runId, { environment, codeFingerprint: freezeP2CodeIdentity() });
if (environment.model !== 'ai-slg-game-model' || environment.inputMaxEstimatedTokens !== 64000) throw Error('P2_MEMORY_CONFIGURATION');
if (mode === 'register') {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(protocol, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ registered: true, runId, protocolVersion: protocol.protocolVersion, overallP2Passed: false }));
} else {
  if (canonicalP2(protocol) !== canonicalP2(frozen)) throw Error('P2_MEMORY_FROZEN_MISMATCH');
  if (mode === 'replay') {
    const result = await replayP2Stage(protocol, 'B', directory, `${directory}-replay`);
    writeFileSync(resolve(directory, 'memory-replay.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ strictReplayPassed: result.strictReplayPassed, segments: result.segments.length, overallP2Passed: false }));
  } else {
    if (mode === 'resume' && !reviewPath) throw Error('P2_MEMORY_REVIEW_REQUIRED');
    const run = await createNarrativeP2StageRunner(env);
    const result = await run({ protocol, stage: 'B', directory, resume: mode === 'resume', ...(reviewPath ? { review: read(resolve(reviewPath)) } : {}) });
    writeFileSync(resolve(directory, `memory-result-${result.segment}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ segment: result.segment, completed: result.completed, coveragePassed: result.coveragePassed,
      pauseReason: result.pauseReason, counters: result.counters, identity: result.identity,
      lastTopic: result.steps.at(-1)?.topic, overallP2Passed: false }));
  }
}
