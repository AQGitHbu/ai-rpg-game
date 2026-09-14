import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashReplayValue } from './narrativeP1Replay.mjs';
import { freezeP2OpeningOracle, inspectP2RecallCoverage, isP2RecallWindow, validateP2RecallReview } from './narrativeP2Recall.mjs';
import { createP2RouteManifest, p2ManifestGuard } from './narrativeP2Manifest.mjs';

const fixture = () => {
  const history = { id: 'opening', sequence: 1, turnNumber: 0, text: '交给他之前先听取他的意见。', kind: 'npc_line', speakerId: 'npc_0', audienceIds: ['player_0'] };
  const snapshot = { game: { record: { storyState: { currentAct: 1, history: { entries: [history] }, delivery: { itemId: 'letter', recipientNpcId: 'recipient' } }, worldState: { eventLedger: [] } } }, memory: { summaries: [] } };
  const oracle = freezeP2OpeningOracle(snapshot);
  const batches = [0, 1].map(i => ({ id: `batch-${i}`, fromSequence: i * 10, throughSequence: i * 10 + 9, sourceFingerprint: `batch-source-${i}`, sourceHistoryIds: i ? ['later'] : ['opening'] }));
  const events = batches.map((batch, i) => ({ kind: 'settlement', value: { kind: 'summary_batch', metadata: { observerId: 'player_0', jobId: `job-${i}`, epoch: 0 }, value: {
    published: true, state: { summaryRevision: i + 1, coveredThroughSequence: batch.throughSequence, coveredSourceFingerprint: `source-${i}`, batches: batches.slice(0, i + 1) } } } }));
  const publications = events.map((event, i) => ({ jobId: `job-${i}`, epoch: 0, observerId: 'player_0', artifactHash: hashReplayValue(event),
    summaryRevision: i + 1, coveredThroughSequence: i * 10 + 9, sourceFingerprint: `source-${i}`, reservationId: `reservation-${i}` }));
  snapshot.memory.summaries = [{ observer_id: 'player_0', state: { batches, coveredThroughSequence: 19, overview: { historyIds: [] } } }];
  return { snapshot, oracle, tapes: [{ events }], publications };
};

test('coverage requires two real distinct player publication jobs, current matching batches and fixed oracle', () => {
  const f = fixture();
  assert.equal(inspectP2RecallCoverage(f).eligible, true);
  assert.equal(inspectP2RecallCoverage(f).oracleOmittedFromOverview, true);
  for (const mutate of [
    x => { x.publications = []; },
    x => { x.tapes[0].events[1].value.metadata.jobId = 'job-0'; x.publications[1].jobId = 'job-0'; x.publications[1].artifactHash = hashReplayValue(x.tapes[0].events[1]); },
    x => { x.publications[1].observerId = 'npc_0'; },
    x => { x.tapes[0].events[1].value.value.published = false; },
    x => { x.snapshot.memory.summaries[0].state.batches.pop(); },
    x => { x.snapshot.memory.summaries[0].state.coveredThroughSequence = 0; },
    x => { x.publications[1].sourceFingerprint = 'unrelated'; },
  ]) { const bad = structuredClone(f); mutate(bad); assert.equal(inspectP2RecallCoverage(bad).eligible, false); }
  f.snapshot.game.record.storyState.history.entries[0].text = 'changed';
  assert.throws(() => inspectP2RecallCoverage(f), /ORACLE_CHANGED/);
});

test('first legal recall window requires this act topics, free input and all remaining budgets before physical delivery', () => {
  const f = fixture(); f.snapshot.game.record.storyState.currentAct = 3;
  const input = { ...f, coverage: inspectP2RecallCoverage(f), topicState: { committed: [1, 2, 3].map(i => ({ act: 3, topicId: `3-${i}` })), stoppedActs: [] },
    focus: { freeInputEnabled: true }, actionCount: 7, budget: { actions: 48, http: 500 }, transportCount: 50, deadline: 100, now: 99 };
  assert.equal(isP2RecallWindow(input), true); // act separation independently suffices
  for (const mutate of [x => { x.now = 100; }, x => { x.actionCount = 48; }, x => { x.transportCount = 500; },
    x => { x.focus.freeInputEnabled = false; }, x => { x.topicState.committed.pop(); },
    x => { x.topicState.stoppedActs = [3]; }, x => { x.snapshot.game.record.storyState.currentAct = 2; },
    x => { x.snapshot.game.record.worldState.eventLedger = [{ payload: { type: 'item_given', itemId: 'letter', npcId: 'recipient' } }]; }]) {
    const bad = structuredClone(input); mutate(bad); assert.equal(isP2RecallWindow(bad), false);
  }
});

test('human answer review validates exact claim/source citations without inferring fidelity from text hits', () => {
  const evidence = { answers: [{ history: { id: 'answer', text: '我没在场；先问他的意见。' }, candidateCallId: 'author' }],
    sources: [{ id: 'opening', callId: 'author', inAuthorRequest: true }] };
  const judgment = { verdict: 'faithful', reason: 'The cited answer preserves the condition.', claimHistoryIds: ['answer'] };
  const review = { schema: 'narrative-p2-recall-review/v2', identity: { sourceHash: 'fixed' }, reviewer: 'Human fixture reviewer', reviewedAt: '2026-09-14T00:00:00Z',
    oracleAssessment: 'evaluable', motivation: judgment, conditions: judgment, permissionErrors: [],
    claims: [{ historyId: 'answer', quote: '先问他的意见', candidateCallId: 'author', evidenceIds: ['opening'], reason: 'Source linked claim.' }] };
  assert.equal(validateP2RecallReview(review, evidence, review.identity).fidelityPassed, true);
  const damaged = structuredClone(review); damaged.conditions.verdict = 'damaged';
  assert.equal(validateP2RecallReview(damaged, evidence, review.identity).fidelityPassed, false);
  for (const mutate of [x => { x.passed = true; }, x => { x.claims[0].quote = 'invented'; }, x => { x.claims[0].candidateCallId = 'unrelated'; },
    x => { x.claims[0].evidenceIds = ['secret']; }, x => { x.motivation.reason = ''; }]) {
    const bad = structuredClone(review); mutate(bad); assert.throws(() => validateP2RecallReview(bad, evidence, review.identity), /P2_RECALL_REVIEW/);
  }
  evidence.sources[0].inAuthorRequest = false;
  assert.throws(() => validateP2RecallReview(review, evidence, review.identity), /CITATION/);
});

test('paired diagnostics cannot change main identity behavior or exceed one job and registered quotas', () => {
  const hash = 'a'.repeat(64), actionId = randomUUID();
  const input = { directory: mkdtempSync(join(tmpdir(), 'p2-pair-')), stage: 'B',
    binding: { protocolVersion: 'narrative-p2/v2', protocolHash: hash, inputHash: hash, codeFingerprint: 'fixture', sourceHash: hash },
    budget: { actions: 1, http: 50, wallClockMs: 2700000 }, diagnostic: { parentCheckpointHash: hash, pairHash: hash, summaryMode: 'enabled', actionId } };
  for (const change of [{ stage: 'A' }, { budget: { ...input.budget, actions: 2 } }, { diagnostic: { ...input.diagnostic, actionId: 'not-uuid' } }])
    assert.throws(() => createP2RouteManifest({ ...input, ...change }), /DIAGNOSTIC_CONFIGURATION/);
  const store = createP2RouteManifest(input), advance = op => store.advance(p2ManifestGuard(store.read()), op);
  advance({ type: 'start' });
  const reserved = advance({ type: 'reserve_action', interaction: { kind: 'free_text', text: 'recall', targetNpcId: 'npc' } });
  assert.equal(reserved.pendingAction.actionId, actionId);
  advance({ type: 'reserve', kind: 'logical', reservationId: 'one', purpose: 'narrative_bundle_generation', jobId: 'job-1', epoch: 0 });
  assert.throws(() => advance({ type: 'reserve', kind: 'logical', reservationId: 'two', purpose: 'narrative_bundle_generation', jobId: 'job-2', epoch: 0 }), /DIAGNOSTIC_JOB_BUDGET/);
  assert.equal(store.read().counters.actions, 1);
});
