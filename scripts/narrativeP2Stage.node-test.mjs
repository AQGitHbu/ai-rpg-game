import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installTsHooks } from './narrativeP1Journey.mjs';
import { createNarrativeP2StageRunner } from './narrativeP2Stage.mjs';
installTsHooks();
const { createNarrativeP2Protocol } = await import('../src/game/application/testing/narrativeP2Journey.ts');
const { buildOfflineP2Opening, buildOfflineP2Draft } = await import('../src/game/application/testing/narrativeP2Journey.testutil.ts');
const { fixtureNarrativeReviewPass } = await import('../src/game/application/server/ai/testing/narrativeReviewFixture.testutil.ts');
const env = { AI_MODEL: 'offline-fixture', AI_API_BASE_URL: 'https://fixture.invalid', AI_API_KEY: 'offline-fixture', AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: '64000' };
const protocol = createNarrativeP2Protocol('stage-fixture', { environment: { model: env.AI_MODEL, apiBaseUrl: env.AI_API_BASE_URL, inputMaxEstimatedTokens: 64000 }, codeFingerprint: `fixture:${'a'.repeat(64)}` });
let sends = 0;
const offlineTransport = async (request, { reader, stage }) => {
  sends++;
  let response;
  switch (request.context.purpose) {
    case 'narrative_candidate_review': response = fixtureNarrativeReviewPass(request.messages); break;
    case 'npc_deliberation': {
      const context = JSON.parse(request.messages[1].content.split('\n\n只返回')[0]);
      response = { npcId: context.npc.npcId, goalIds: [], response: 'cooperate', evidenceEventIds: [], discloseFactIds: [], interactionProposals: [] }; break;
    }
    case 'narrative_memory_summary': {
      const sources = JSON.parse(request.messages[1].content);
      response = { historyIds: sources.history.slice(0, sources.kind === 'batch' ? 4 : 8).map(h => h.id), eventIds: [] }; break;
    }
    case 'narrative_bundle_generation': {
      if (request.context.trigger === 'initialization') response = await buildOfflineP2Opening({ kind: 'opening', jobId: request.context.jobId, input: { gameType: 'wuxia', gameLength: stage === 'A' ? 'short' : 'medium' } });
      else { const { worldState, storyState } = (await reader.getCurrentGame()).record; response = buildOfflineP2Draft({ kind: 'decision', worldState, storyState, job: storyState.narrative.job }); }
      break;
    }
    default: assert.fail(request.context.purpose);
  }
  return { ok: true, content: JSON.stringify(response), latencyMs: 0 };
};
const reviewFor = (result, verdict = 'grounded') => {
  const step = result.steps.at(-1);
  const candidate = step.acceptedCandidates.find(c => c.historyIds.some(id => step.historyDelta.some(h => h.id === id && h.kind === 'npc_line')));
  const h = step.historyDelta.find(h => h.kind === 'npc_line' && candidate.historyIds.includes(h.id));
  return { identity: result.identity, topicId: step.topic.topicId, actionId: step.command.actionId, reviewer: 'offline test reviewer', reviewedAt: '2026-09-14T00:00:00Z',
    reason: 'Fixture judgment exercises citation authority only.', verdict, historyQuotes: [{ historyId: h.id, quote: h.text }], candidateIds: [candidate.callId] };
};
test('actual stage A completes formal policy and strictly replays terminal evidence', { timeout: 600000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p2-stage-a-'));
  const run = await createNarrativeP2StageRunner(env, { offlineTransport, pollIntervalMs: 1 });
  const result = await run({ protocol, stage: 'A', directory: join(root, 'live') });
  assert.equal(result.completed, true); assert.equal(result.pauseReason, 'terminal_quality'); assert.ok(result.steps.length <= 24);
  assert.ok(result.steps.every(s => !s.topic));
  const count = sends;
  const replay = await run({ protocol, stage: 'A', mode: 'replay', directory: join(root, 'replay'), sourceDirectory: join(root, 'live') });
  assert.equal(replay.strictReplayPassed, true); assert.equal(sends, count);
});
test('actual B pauses each topic and resumes bounded policy with real citations', { timeout: 600000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p2-stage-b-')); const directory = join(root, 'live');
  const run = await createNarrativeP2StageRunner(env, { offlineTransport, pollIntervalMs: 1 });
  let result = await run({ protocol, stage: 'B', directory });
  const results = [result];
  const firstReview = reviewFor(result);
  const originalManifest = readFileSync(join(directory, 'B.route-manifest.json'), 'utf8');
  const oldLine = result.history.find(h => h.kind === 'npc_line' && !result.steps.at(-1).historyDelta.some(n => n.id === h.id));
  const mutations = [
    { ...firstReview, identity: { ...firstReview.identity, tapeHash: 'b'.repeat(64) } },
    { ...firstReview, historyQuotes: [{ historyId: oldLine.id, quote: oldLine.text }] },
    { ...firstReview, historyQuotes: [{ historyId: firstReview.historyQuotes[0].historyId, quote: 'invented quote' }] },
    { ...firstReview, candidateIds: ['rejected-or-unrelated-candidate'] },
    { ...firstReview, actionId: 'other-action' },
  ];
  const before = sends;
  for (const review of mutations) {
    await assert.rejects(run({ protocol, stage: 'B', directory, resume: true, review }), /P2_STAGE_TOPIC_REVIEW/);
    assert.equal(readFileSync(join(directory, 'B.route-manifest.json'), 'utf8'), originalManifest);
  }
  assert.equal(sends, before);
  for (let i = 0; result.pauseReason === 'topic' && i < 16; i++) {
    result = await run({ protocol, stage: 'B', directory, resume: true, review: reviewFor(result, i === 1 ? 'repeated' : 'grounded') });
    results.push(result);
  }
  assert.equal(result.completed, false); assert.equal(result.pauseReason, 'recall_integration');
  const topics = results.flatMap(r => r.steps.filter(s => s.topic).map(s => s.topic.topicId));
  assert.deepEqual(topics, ['1-reason', '1-cost', ...protocol.topics.filter(t => t.act > 1).map(t => t.topicId)]);
  assert.ok(result.topicState.stoppedActs.includes(1));
  assert.ok(result.qualityFailures.some(f => f.act === 1 && f.code === 'repeated'));
  assert.equal(result.coveragePassed, false);
  for (const step of results.flatMap(r => r.steps).filter(s => s.topic)) {
    assert.equal(step.after.act, step.before.act);
    assert.equal(step.after.dialogueSession.turnCount, 0);
    assert.equal(step.after.dialogueSession.completed, false);
    assert.ok(step.acceptedCandidates.length > 0);
  }
  assert.ok(results.flatMap(r => r.steps).every(s => s.action?.type !== 'give_item'));
  const manifest = JSON.parse(readFileSync(join(directory, 'B.route-manifest.json'), 'utf8'));
  assert.equal(manifest.state.status, 'awaiting_review');
  const count = sends;
  for (let replaySegment = 0; replaySegment < results.length; replaySegment++) {
    await run({ protocol, stage: 'B', mode: 'replay', directory: join(root, 'replay'), sourceDirectory: directory, replaySegment });
  }
  assert.equal(sends, count);
});

test('resume independently rejects changed SQLite, and public production remains blocked', { timeout: 120000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'p2-stage-tamper-'));
  const run = await createNarrativeP2StageRunner(env, { offlineTransport, pollIntervalMs: 1 });
  const result = await run({ protocol, stage: 'B', directory });
  const { createSqliteClient } = await import('../src/game/application/server/persistence/sqliteClient.ts');
  const client = createSqliteClient(join(directory, 'B.sqlite'));
  await client.execute('UPDATE game_records SET revision = revision + 1'); client.close();
  const before = readFileSync(join(directory, 'B.route-manifest.json'), 'utf8'); const count = sends;
  await assert.rejects(run({ protocol, stage: 'B', directory, resume: true, review: reviewFor(result) }), /P2_STAGE_CHECKPOINT_MISMATCH/);
  assert.equal(sends, count); assert.equal(readFileSync(join(directory, 'B.route-manifest.json'), 'utf8'), before);
  await assert.rejects(run({ protocol, stage: 'B', directory }), /P2_ROUTE_ALREADY_INITIALIZED/);
  const blocked = await createNarrativeP2StageRunner(env);
  await assert.rejects(blocked({ protocol, stage: 'A', directory: join(directory, 'blocked') }), /ADMISSION_NOT_IMPLEMENTED/);
});
