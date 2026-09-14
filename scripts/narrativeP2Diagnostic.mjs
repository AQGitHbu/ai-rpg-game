import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { canonical, hashReplayValue } from './narrativeP1Replay.mjs';
import { createP2RouteManifest, openP2RouteManifest, p2ManifestGuard } from './narrativeP2Manifest.mjs';
import { createNarrativeP2SegmentRuntime } from './narrativeP2SegmentRuntime.mjs';
import { hashP2Snapshot, readP2MemoryState } from './narrativeP2Production.mjs';
import { inspectP2StageArtifacts } from './narrativeP2Stage.mjs';
import { inspectP2RecallAnswer, inspectP2RecallCoverage, validateP2RecallReview, p2TextHash } from './narrativeP2Recall.mjs';
import { waitForNarrativeP1Generation } from './narrativeP1Journey.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const bytesHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = code => { throw Error(`P2_DIAGNOSTIC_${code}`); };
const write = (path, value) => { const fd = openSync(path, 'wx'); try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); } return hashReplayValue(value); };

/** Shared read-only handoff admission for diagnostics and the later actual UI adapter. */
export async function inspectP2UiCheckpoint(protocol, directory, { now = Date.now() } = {}) {
  const { createNarrativeP2Protocol } = await import('../src/game/application/testing/narrativeP2Journey.ts');
  if (canonical(protocol) !== canonical(createNarrativeP2Protocol(protocol.runId, { environment: protocol.environment, codeFingerprint: protocol.codeFingerprint }))) fail('PROTOCOL');
  const route = protocol.routes.find(r => r.routeId === protocol.stages.routeByStage.B);
  const binding = { protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, codeFingerprint: protocol.codeFingerprint,
    inputHash: protocol.inputHash, sourceHash: hashReplayValue({ stage: 'B', input: protocol.input }) };
  const manifest = openP2RouteManifest({ directory, stage: 'B', binding, budget: route.budget });
  const state = manifest.read(), checkpoint = read(resolve(directory, 'B.ui-checkpoint.json'));
  if (manifest.interrupted || state.status !== 'awaiting_ui' || state.pause.reason !== 'recall_ui'
    || state.artifacts['ui-checkpoint'] !== hashReplayValue(checkpoint) || checkpoint.schema !== 'narrative-p2-ui-checkpoint/v2'
    || checkpoint.protocolHash !== protocol.protocolHash || canonical(checkpoint.binding) !== canonical(binding)
    || state.routeAttemptId !== checkpoint.routeAttemptId || checkpoint.database !== resolve(directory, 'B.sqlite')
    || bytesHash(checkpoint.database) !== checkpoint.databaseHash || state.sourceHash !== checkpoint.sourceHash
    || state.gameRevision !== checkpoint.revision || state.tapeCursor !== checkpoint.tapeCursor
    || canonical(state.counters) !== canonical(checkpoint.counters) || state.deadline !== checkpoint.deadline
    || state.initializedAt !== checkpoint.initializedAt || now >= state.deadline
    || state.pendingAction?.status !== 'reserved' || canonical(state.pendingAction) !== canonical(checkpoint.pendingAction)
    || checkpoint.pendingAction.interaction.text !== protocol.recall || checkpoint.recallTextHash !== p2TextHash(protocol.recall)
    || state.reservations.some(r => r.status === 'reserved' || r.actionId === state.pendingAction.actionId)
    || state.steps.some(s => s.actionId === state.pendingAction.actionId)) fail('CHECKPOINT');
  const artifacts = inspectP2StageArtifacts(directory, state);
  if (artifacts.tapeCursor !== checkpoint.tapeCursor || state.artifacts[`tape-segment-${checkpoint.segment}`] !== checkpoint.tapeHash) fail('TAPE');
  const { createSqliteGameRepository } = await import('../src/game/application/server/persistence/sqliteGameRepository.ts');
  const { createSqliteClient } = await import('../src/game/application/server/persistence/sqliteClient.ts');
  const client = createSqliteClient(checkpoint.database), reader = createSqliteGameRepository({ clientFactory: () => createSqliteClient(checkpoint.database) });
  let snapshot;
  try { snapshot = { game: await reader.getCurrentGame(), memory: await readP2MemoryState(client) }; }
  finally { await reader.close(); client.close(); }
  if (!snapshot.game.ok || snapshot.game.status !== 'active' || snapshot.game.record.revision !== checkpoint.revision
    || hashP2Snapshot(snapshot) !== checkpoint.sourceHash || hashP2Snapshot(artifacts.evidence.at(-1).terminal) !== checkpoint.sourceHash) fail('SOURCE');
  const tapes = Array.from({ length: artifacts.segment }, (_, index) => read(resolve(directory, `B.segment-${index}.json`)).tape);
  const coverage = inspectP2RecallCoverage({ snapshot, oracle: checkpoint.oracle, tapes, publications: state.publications });
  if (!coverage.eligible || canonical(coverage) !== canonical(checkpoint.coverage)) fail('COVERAGE');
  return { manifest, state, checkpoint, snapshot };
}

/** Inspect persisted arm evidence to produce the exact human review identity. */
export function inspectP2DiagnosticArm(directory, summaryMode) {
  if (!['enabled', 'disabled'].includes(summaryMode)) fail('MODE');
  const root = resolve(directory, 'diagnostics'), armDirectory = resolve(root, summaryMode);
  const pair = read(resolve(root, 'pair.json')), checkpoint = read(resolve(directory, 'B.ui-checkpoint.json'));
  const diagnostic = { parentCheckpointHash: hashReplayValue(checkpoint), pairHash: hashReplayValue(pair), summaryMode, actionId: pair.actionId };
  const manifest = openP2RouteManifest({ directory: armDirectory, stage: 'B', binding: { ...checkpoint.binding, sourceHash: diagnostic.parentCheckpointHash },
    budget: { actions: 1, http: 50, wallClockMs: 2700000 }, diagnostic });
  const state = manifest.read(), evidence = read(resolve(armDirectory, 'answer.json')), envelope = read(resolve(armDirectory, 'B.segment-0.json'));
  if (manifest.interrupted || state.artifacts.answer !== hashReplayValue(evidence)
    || state.artifacts['tape-segment-0'] !== envelope.hash || envelope.hash !== hashReplayValue(envelope.tape)
    || !envelope.tape.closed || envelope.tape.routeAttemptId !== state.routeAttemptId
    || evidence.pairHash !== diagnostic.pairHash || evidence.parentCheckpointHash !== diagnostic.parentCheckpointHash
    || evidence.summaryMode !== summaryMode || evidence.routeAttemptId !== state.routeAttemptId
    || evidence.sourceHash !== checkpoint.sourceHash || evidence.sourceDatabaseHash !== checkpoint.databaseHash
    || hashP2Snapshot(evidence.before) !== checkpoint.sourceHash
    || canonical(evidence.answer.command) !== canonical({ actionId: pair.actionId, expectedRevision: checkpoint.revision, interaction: checkpoint.pendingAction.interaction })
    || envelope.tape.audit.some(a => bytesHash(resolve(armDirectory, a.file)) !== a.hash)) fail('ARM_EVIDENCE');
  const answer = inspectP2RecallAnswer({ before: evidence.before, after: evidence.after, command: evidence.answer.command, oracle: checkpoint.oracle, calls: envelope.tape.calls });
  if (canonical(answer) !== canonical(evidence.answer)) fail('ARM_ANSWER');
  const identity = { routeAttemptId: state.routeAttemptId, binding: state.binding, pairHash: diagnostic.pairHash,
    parentCheckpointHash: diagnostic.parentCheckpointHash, summaryMode, answerHash: state.artifacts.answer, tapeHash: envelope.hash };
  return { manifest, state, identity, evidence, armDirectory };
}

export function reviewP2DiagnosticArm(directory, summaryMode, review) {
  const inspection = inspectP2DiagnosticArm(directory, summaryMode);
  if (inspection.state.status !== 'awaiting_review' || inspection.state.pause.reason !== 'recall_fidelity') fail('ARM_NOT_REVIEWABLE');
  const quality = validateP2RecallReview(review, inspection.evidence.answer, inspection.identity);
  const recovered = inspection.evidence.answer.requests.some(r => r.oracleTextInRequest && r.oraclePaths.some(p => ['overview', 'recall', 'mandatory'].includes(p)));
  const passed = quality.permissionPassed && (summaryMode === 'disabled' || (quality.fidelityPassed && recovered));
  const reviewHash = write(resolve(inspection.armDirectory, 'review.json'), review);
  const expired = Date.now() >= inspection.state.deadline;
  const result = { identity: inspection.identity, ...quality, recovered, passed: passed && !expired };
  const resultHash = write(resolve(inspection.armDirectory, 'review-result.json'), result);
  inspection.manifest.advance(p2ManifestGuard(inspection.state), passed && !expired
    ? { type: 'seal_pass', artifacts: { 'recall-review': reviewHash, 'recall-result': resultHash } }
    : { type: 'seal_fail', reason: expired ? 'P2_DIAGNOSTIC_DEADLINE_EXPIRED' : 'P2_DIAGNOSTIC_QUALITY_FAILED', artifacts: { 'recall-review': reviewHash, 'recall-result': resultHash } });
  return { ...result, passed: passed && !expired };
}

/** Future B admission consumes this recomputation, never stored arm passed flags. */
export function inspectP2DiagnosticPair(directory) {
  const arms = ['enabled', 'disabled'].map(summaryMode => {
    const item = inspectP2DiagnosticArm(directory, summaryMode);
    if (!['sealed_pass', 'sealed_fail'].includes(item.state.status)) return { summaryMode, status: item.state.status, passed: false };
    if (item.state.status !== 'sealed_pass') return { summaryMode, status: item.state.status, passed: false };
    const review = read(resolve(item.armDirectory, 'review.json')), result = read(resolve(item.armDirectory, 'review-result.json'));
    if (hashReplayValue(review) !== item.state.artifacts['recall-review'] || hashReplayValue(result) !== item.state.artifacts['recall-result']
      || canonical(result.identity) !== canonical(item.identity) || item.state.lastMutationAt >= item.state.deadline) fail('ARM_REVIEW');
    const quality = validateP2RecallReview(review, item.evidence.answer, item.identity);
    const recovered = item.evidence.answer.requests.some(r => r.oracleTextInRequest && r.oraclePaths.some(p => ['overview', 'recall', 'mandatory'].includes(p)));
    const passed = quality.permissionPassed && (summaryMode === 'disabled' || (quality.fidelityPassed && recovered));
    return { summaryMode, status: item.state.status, passed, identity: item.identity };
  });
  return { arms, passed: arms.every(arm => arm.passed), completeRoutes: 0 };
}

/** Exactly two registered copies, each one actual production job. No main commands. */
export async function runP2DiagnosticArms(protocol, directory, runtimeEnv, options = {}) {
  const initial = await inspectP2UiCheckpoint(protocol, directory);
  if (!options.offlineTransport) {
    const { freezeP2CodeIdentity } = await import('./narrativeP2Journey.mjs');
    if (process.env.RUN_REAL_AI_JOURNEY !== '1' || protocol.codeFingerprint !== freezeP2CodeIdentity()
      || runtimeEnv.AI_MODEL !== protocol.environment.model || runtimeEnv.AI_API_BASE_URL !== protocol.environment.apiBaseUrl
      || Number(runtimeEnv.AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS ?? 64000) !== 64000) fail('LIVE_ADMISSION');
  }
  const checkpointHash = hashReplayValue(initial.checkpoint);
  const root = resolve(directory, 'diagnostics'); mkdirSync(root, { recursive: true });
  const pair = { schema: 'narrative-p2-diagnostic-pair/v2', parentCheckpointHash: checkpointHash,
    actionId: randomUUID(), identitySeed: randomUUID(), domainTime: new Date().toISOString() };
  const pairHash = write(resolve(root, 'pair.json'), pair);
  const { createServerGameEntryPoints } = await import('../src/game/application/server/compositionRoot.ts');
  const { createSqliteGameRepository } = await import('../src/game/application/server/persistence/sqliteGameRepository.ts');
  const { createSqliteClient } = await import('../src/game/application/server/persistence/sqliteClient.ts');
  const results = [];
  for (const summaryMode of ['enabled', 'disabled']) {
    const armDirectory = resolve(root, summaryMode); mkdirSync(armDirectory, { recursive: true });
    const binding = { ...initial.state.binding, sourceHash: checkpointHash };
    const manifest = createP2RouteManifest({ directory: armDirectory, stage: 'B', binding,
      budget: { actions: 1, http: 50, wallClockMs: 2700000 }, diagnostic: { parentCheckpointHash: checkpointHash, pairHash, summaryMode, actionId: pair.actionId } });
    const change = op => manifest.advance(p2ManifestGuard(manifest.read()), op);
    const database = resolve(armDirectory, 'B.sqlite');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, manifest.read().deadline - Date.now()));
    let client, reader, entry, runtime;
    try {
      change({ type: 'start' });
      // Recheck byte identity before each copy; never copy WAL or a live mutable DB.
      if (bytesHash(initial.checkpoint.database) !== initial.checkpoint.databaseHash) fail('SOURCE_CHANGED');
      copyFileSync(initial.checkpoint.database, database, constants.COPYFILE_EXCL);
      if (bytesHash(database) !== initial.checkpoint.databaseHash) fail('COPY_HASH');
      client = createSqliteClient(database); reader = createSqliteGameRepository({ clientFactory: () => createSqliteClient(database) });
      const snapshot = async () => ({ game: await reader.getCurrentGame(), memory: await readP2MemoryState(client) });
      const before = await snapshot();
      if (hashP2Snapshot(before) !== initial.checkpoint.sourceHash) fail('COPY_SOURCE');
      change({ type: 'checkpoint', gameRevision: before.game.record.revision, sourceHash: hashP2Snapshot(before), artifacts: { source: checkpointHash } });
      const auditId = change({ type: 'open_audit' }).auditStreams.at(-1), auditPath = `audit/${auditId}/events.jsonl`;
      mkdirSync(resolve(armDirectory, 'audit', auditId), { recursive: true }); closeSync(openSync(resolve(armDirectory, auditPath), 'wx'));
      runtime = createNarrativeP2SegmentRuntime({ mode: 'live', directory: armDirectory, stage: 'B', segment: 0, binding, manifest,
        checkpoint: p2ManifestGuard(manifest.read()), diagnosticPair: pair, resolveAttempt: async context => {
          const job = (await snapshot()).game.record.storyState.narrative.job;
          if (job?.jobId !== context.jobId) fail('JOB');
          return { jobId: job.jobId, epoch: job.attempt.epoch };
        }, auditFiles: () => [auditPath] });
      if (options.offlineTransport) { const attempt = runtime.options.aiRuntime.attempt; runtime.options.aiRuntime = {
        ...runtime.options.aiRuntime, offline: true, attempt: request => attempt(request, () => options.offlineTransport(request, { reader, client, stage: 'B', protocol })) }; }
      entry = createServerGameEntryPoints({ ...runtimeEnv, NODE_ENV: 'test', GAME_DB_PATH: database, AI_OUTPUT_FORMAT: 'prompt_only',
        AI_TEXT_AUDIT: 'full', AI_TEXT_AUDIT_DIR: resolve(armDirectory, 'audit'), AI_TEXT_AUDIT_RUN_ID: auditId }, undefined, undefined,
      { ...runtime.options, memoryPolicy: protocol.policy, memorySummaries: summaryMode, narrativeAbortSignal: controller.signal });
      const interaction = initial.checkpoint.pendingAction.interaction;
      const reserved = change({ type: 'reserve_action', interaction });
      const command = { actionId: reserved.pendingAction.actionId, expectedRevision: before.game.record.revision, interaction };
      runtime.state('source', before); change({ type: 'begin_action', actionId: command.actionId });
      const result = await entry.performTurn(command, 'B-diagnostic-recall');
      if (!result.ok) fail(`ACTION_${result.code}`);
      const current = await waitForNarrativeP1Generation(entry, 'B-diagnostic-ready', { signal: controller.signal, pollIntervalMs: options.pollIntervalMs ?? 250 });
      if (runtime.failureCode) throw Error(runtime.failureCode);
      if (!current.ok || current.status !== 'active' || current.view.narrativeGeneration.status !== 'idle') fail('GENERATION');
      await entry.close(); entry = null;
      const after = await snapshot(); runtime.state('answer', after);
      const calls = read(resolve(armDirectory, 'B.segment-0.json')).tape.calls;
      const answer = inspectP2RecallAnswer({ before, after, command, oracle: initial.checkpoint.oracle, calls });
      if (!answer.requests.length || !answer.answers.length || answer.requests.some(r => !r.recallTextInRequest)) fail('ANSWER_MISSING');
      change({ type: 'commit_action', actionId: command.actionId, gameRevision: after.game.record.revision, sourceHash: hashP2Snapshot(after),
        evidence: { historyHash: hashReplayValue(after.game.record.storyState.history), historyIds: answer.answers.map(a => a.history.id),
          candidateCallIds: answer.answers.map(a => a.candidateCallId), jobIds: [...new Set(answer.requests.map(r => r.jobId))] } });
      const evidence = { schema: 'narrative-p2-diagnostic/v2', summaryMode, parentCheckpointHash: checkpointHash, pairHash,
        routeAttemptId: manifest.read().routeAttemptId, sourceDatabaseHash: initial.checkpoint.databaseHash,
        sourceHash: hashP2Snapshot(before), answer, before, after, correct: 'awaiting_human_review' };
      const evidenceHash = write(resolve(armDirectory, 'answer.json'), evidence);
      const tape = runtime.finish(p2ManifestGuard(manifest.read()));
      change({ type: 'pause', status: 'awaiting_review', reason: 'recall_fidelity', artifacts: { answer: evidenceHash } });
      results.push({ summaryMode, status: 'awaiting_review', evidenceHash, tapeHash: tape.hash, counters: manifest.read().counters });
    } catch (error) {
      if (!manifest.read().status.startsWith('sealed_')) change({ type: 'seal_fail', reason: error.message });
      results.push({ summaryMode, status: 'sealed_fail', failure: error.message, counters: manifest.read().counters });
    } finally { clearTimeout(timer); if (entry) await entry.close(); if (reader) await reader.close(); if (client) client.close(); }
  }
  const current = await inspectP2UiCheckpoint(protocol, directory);
  if (canonical(current.state) !== canonical(initial.state)) fail('MAIN_CHANGED');
  const result = { schema: 'narrative-p2-diagnostic-result/v2', parentCheckpointHash: checkpointHash, pairHash, results,
    completeRoutes: 0, passed: false, reviewStatus: 'awaiting_human_review' };
  write(resolve(root, 'result.json'), result);
  return result;
}
