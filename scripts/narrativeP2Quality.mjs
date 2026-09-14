import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonical, hashReplayValue } from './narrativeP1Replay.mjs';
import { hasCompletedCoreStory } from './narrativeP1Journey.mjs';
import { openP2RouteManifest, p2ManifestGuard } from './narrativeP2Manifest.mjs';
import { inspectP2StageArtifacts, createNarrativeP2StageRunner } from './narrativeP2Stage.mjs';
import { hashP2Snapshot, readP2MemoryState } from './narrativeP2Production.mjs';

const fail = code => { throw Error(`P2_QUALITY_${code}`); };
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const text = value => typeof value === 'string' && value.trim().length > 0;
const exact = (value, keys) => value && !Array.isArray(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const write = (path, value) => { const fd = openSync(path, 'wx'); try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); } };
export function p2StageManifest(protocol, stage, directory) {
  const binding = { protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, codeFingerprint: protocol.codeFingerprint,
    inputHash: protocol.inputHash, sourceHash: hashReplayValue({ stage, input: protocol.input }) };
  return openP2RouteManifest({ directory, stage, binding, budget: protocol.routes.find(r => r.routeId === protocol.stages.routeByStage[stage]).budget });
}

/** Reads the actual same-path database and every closed artifact. No caller's passed bit is consumed. */
export async function inspectP2Quality(protocol, stage, directory) {
  const { createNarrativeP2Protocol } = await import('../src/game/application/testing/narrativeP2Journey.ts');
  if (!['A', 'B'].includes(stage) || canonical(protocol) !== canonical(createNarrativeP2Protocol(protocol.runId, { environment: protocol.environment, codeFingerprint: protocol.codeFingerprint }))) fail('PROTOCOL_MISMATCH');
  const manifest = p2StageManifest(protocol, stage, directory), head = manifest.read();
  if (manifest.interrupted) fail('INTERRUPTED');
  const artifacts = inspectP2StageArtifacts(directory, head), last = artifacts.evidence.at(-1);
  if (!last || !existsSync(resolve(directory, `${stage}.sqlite`))) fail('TERMINAL_MISSING');
  const { createSqliteClient } = await import('../src/game/application/server/persistence/sqliteClient.ts');
  const { createSqliteGameRepository } = await import('../src/game/application/server/persistence/sqliteGameRepository.ts');
  const { isStoryDeliveryComplete } = await import('../src/game/gameplay/rpg/storyDelivery/index.ts');
  const client = createSqliteClient(resolve(directory, `${stage}.sqlite`));
  const repository = createSqliteGameRepository({ clientFactory: () => createSqliteClient(resolve(directory, `${stage}.sqlite`)) });
  let snapshot;
  try { snapshot = { game: await repository.getCurrentGame(), memory: await readP2MemoryState(client) }; }
  finally { await repository.close(); client.close(); }
  if (!snapshot.game.ok || snapshot.game.status !== 'active') fail('DATABASE_UNAVAILABLE');
  const record = snapshot.game.record, history = record.storyState.history.entries;
  if (record.revision !== head.gameRevision || hashP2Snapshot(snapshot) !== head.sourceHash || artifacts.tapeCursor !== head.tapeCursor
    || hashP2Snapshot(snapshot) !== hashP2Snapshot(last.terminal) || canonical(history) !== canonical(last.history)) fail('CHECKPOINT_MISMATCH');
  const tapes = Array.from({ length: artifacts.segment }, (_, n) => read(resolve(directory, `${stage}.segment-${n}.json`)));
  const calls = tapes.flatMap(t => t.tape.calls).filter(c => c.request.context.purpose === 'narrative_bundle_generation');
  // A transport-successful draft is citable only when it is the last author result of
  // this committed job and contains the exact experienced History text.
  const candidates = calls.map(c => {
    let texts = []; try { if (c.output.ok) texts = strings(JSON.parse(c.output.content)); } catch { /* not a published candidate */ }
    const accepted = calls.filter(x => x.request.context.jobId === c.request.context.jobId && x.output.ok).at(-1) === c;
    return { callId: c.request.callId, jobId: c.request.context.jobId, outputHash: hashReplayValue(c.output),
      historyIds: accepted ? history.filter(h => h.jobId === c.request.context.jobId && texts.includes(h.text)).map(h => h.id) : [] };
  });
  const completed = hasCompletedCoreStory(snapshot.game, isStoryDeliveryComplete)
    && record.worldState.eventLedger.filter(e => e.payload.type === 'item_given' && e.payload.itemId === record.storyState.delivery?.itemId && e.payload.npcId === record.storyState.delivery?.recipientNpcId).length === 1;
  const machinePassed = completed && last.pauseReason === 'terminal_quality' && last.qualityFailures.length === 0
    && head.pendingAction === null && head.reservations.every(r => r.status === 'settled')
    && head.counters.actions <= head.budget.actions && head.counters.transport <= head.budget.http
    // Task2 must replace this explicit fail-closed handoff with actual recall/UI coverage.
    && stage === 'A';
  const identity = { routeAttemptId: head.routeAttemptId, ...head.binding, terminalHash: hashReplayValue(snapshot),
    historyHash: hashReplayValue(history), tapeHash: hashReplayValue(tapes.map(t => t.hash)), candidateHash: hashReplayValue(candidates) };
  return { manifest, head, artifacts, identity, history, candidates, completed, machinePassed };
}

/** Fixed controller-authored semantic review. Rejected drafts cannot stand in for played story. */
export function validateP2TerminalReview(review, inspection, protocol) {
  if (!exact(review, ['schema', 'identity', 'reviewer', 'reviewedAt', 'dimensions', 'hardErrors', 'verdict']) || review.schema !== 'narrative-p2-quality/v2'
    || canonical(review.identity) !== canonical(inspection.identity) || !text(review.reviewer) || !text(review.reviewedAt) || !Number.isFinite(Date.parse(review.reviewedAt))
    || !['pass', 'fail'].includes(review.verdict) || !Array.isArray(review.hardErrors)
    || !exact(review.dimensions, protocol.stages.qualityDimensions)) fail('SCHEMA');
  const citations = quotes => {
    if (!Array.isArray(quotes) || !quotes.length) fail('CITATION');
    for (const q of quotes) {
      if (!exact(q, ['historyId', 'quote', 'candidateCallId']) || !text(q.quote)) fail('CITATION');
      const h = inspection.history.find(h => h.id === q.historyId && h.audienceIds.includes('player_0'));
      const c = inspection.candidates.find(c => c.callId === q.candidateCallId);
      if (!h || !h.text.includes(q.quote) || !c || c.jobId !== h.jobId || !c.historyIds.includes(h.id)) fail('CITATION');
    }
  };
  for (const d of Object.values(review.dimensions)) {
    if (!exact(d, ['score', 'reason', 'historyQuotes']) || !Number.isInteger(d.score) || d.score < 1 || d.score > 5 || !text(d.reason)) fail('DIMENSION');
    citations(d.historyQuotes);
  }
  for (const error of review.hardErrors) {
    if (!exact(error, ['kind', 'reason', 'historyQuotes']) || !['fact', 'permission', 'action'].includes(error.kind) || !text(error.reason)) fail('HARD_ERROR');
    citations(error.historyQuotes);
  }
  const scores = Object.values(review.dimensions).map(d => d.score);
  return { qualityPassed: review.verdict === 'pass' && review.hardErrors.length === 0 && Math.min(...scores) >= 3 && scores.reduce((a, b) => a + b, 0) / scores.length >= 4 };
}

/** All segments replay in order into ONE fresh SQLite database, always offline. */
export async function replayP2Stage(protocol, stage, sourceDirectory, directory) {
  if (resolve(sourceDirectory) === resolve(directory) || (existsSync(directory) && readdirSync(directory).length)) fail('REPLAY_OUTPUT_NOT_EMPTY');
  const inspection = await inspectP2Quality(protocol, stage, sourceDirectory);
  const env = { AI_MODEL: protocol.environment.model, AI_API_BASE_URL: protocol.environment.apiBaseUrl,
    AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: String(protocol.environment.inputMaxEstimatedTokens), AI_API_KEY: 'offline-replay-no-network' };
  const run = await createNarrativeP2StageRunner(env);
  const results = [];
  for (let replaySegment = 0; replaySegment < inspection.artifacts.segment; replaySegment++) {
    const result = await run({ protocol, stage, mode: 'replay', directory, sourceDirectory, replaySegment });
    if (result.strictReplayPassed !== true) fail('REPLAY_FAILED');
    results.push({ segment: replaySegment, replay: result.replay });
  }
  const after = await inspectP2Quality(protocol, stage, sourceDirectory);
  if (canonical(after.identity) !== canonical(inspection.identity) || canonical(p2ManifestGuard(after.head)) !== canonical(p2ManifestGuard(inspection.head))) fail('CHECKPOINT_CHANGED');
  return { inspection: after, strictReplayPassed: results.length > 0, segments: results };
}
const replayDirectory = directory => { mkdirSync(resolve(directory, 'quality-replays'), { recursive: true }); return mkdtempSync(resolve(directory, 'quality-replays', 'check-')); };

export async function reviewP2Stage(protocol, stage, directory, review) {
  const initial = await inspectP2Quality(protocol, stage, directory);
  if (initial.head.status !== 'awaiting_review' || initial.head.pause?.reason !== 'terminal_quality') fail('NOT_TERMINAL_REVIEW');
  if (Date.now() >= initial.head.deadline) {
    initial.manifest.advance(p2ManifestGuard(initial.head), { type: 'seal_fail', reason: 'P2_DEADLINE_EXPIRED' });
    fail('DEADLINE_EXPIRED');
  }
  const quality = validateP2TerminalReview(review, initial, protocol);
  // Exclusive intent makes an interrupted or failed review irrevocable; no replacement unlocks B.
  write(resolve(directory, `${stage}.quality-review.json`), review);
  try {
    const replay = await replayP2Stage(protocol, stage, directory, replayDirectory(directory));
    const passed = quality.qualityPassed && replay.inspection.machinePassed && Date.now() < initial.head.deadline;
    const result = { identity: initial.identity, reviewHash: hashReplayValue(review), machinePassed: replay.inspection.machinePassed,
      qualityPassed: quality.qualityPassed, strictReplayPassed: replay.strictReplayPassed, segments: replay.segments, passed };
    write(resolve(directory, `${stage}.quality-result.json`), result);
    initial.manifest.advance(p2ManifestGuard(initial.head), passed
      ? { type: 'seal_pass', artifacts: { 'terminal-review': hashReplayValue(review), 'terminal-quality': hashReplayValue(result) } }
      : { type: 'seal_fail', reason: 'P2_TERMINAL_QUALITY_FAILED', artifacts: { 'terminal-review': hashReplayValue(review), 'terminal-quality': hashReplayValue(result) } });
    return result;
  } catch (error) {
    const head = initial.manifest.read();
    if (!head.status.startsWith('sealed_')) initial.manifest.advance(p2ManifestGuard(head), { type: 'seal_fail', reason: error.message, artifacts: { 'terminal-review': hashReplayValue(review) } });
    throw error;
  }
}

export async function admitP2StageB(protocol, directory) {
  const initial = await inspectP2Quality(protocol, 'A', directory);
  if (initial.head.status !== 'sealed_pass' || initial.head.lastMutationAt >= initial.head.deadline) fail('A_NOT_SEALED_PASS');
  const review = read(resolve(directory, 'A.quality-review.json')), result = read(resolve(directory, 'A.quality-result.json'));
  if (hashReplayValue(review) !== initial.head.artifacts['terminal-review'] || hashReplayValue(result) !== initial.head.artifacts['terminal-quality']
    || canonical(result.identity) !== canonical(initial.identity) || result.reviewHash !== hashReplayValue(review)) fail('SEALED_ARTIFACT_CHANGED');
  if (!validateP2TerminalReview(review, initial, protocol).qualityPassed) fail('A_QUALITY_FAILED');
  const replay = await replayP2Stage(protocol, 'A', directory, replayDirectory(directory));
  if (!replay.inspection.machinePassed || !replay.strictReplayPassed) fail('A_MACHINE_FAILED');
  return { routeAttemptId: initial.head.routeAttemptId, reviewHash: hashReplayValue(review), identity: initial.identity };
}

export function p2BatchStatus(directory) {
  const stages = Object.fromEntries(['A', 'B'].map(stage => [stage, existsSync(resolve(directory, `${stage}.route-manifest.json`))
    ? read(resolve(directory, `${stage}.route-manifest.json`)).state.status : 'not_executed']));
  return { plannedRoutes: 2, stages, sealedPassRoutes: Object.values(stages).filter(s => s === 'sealed_pass').length,
    passed: stages.A === 'sealed_pass' && stages.B === 'sealed_pass' };
}
