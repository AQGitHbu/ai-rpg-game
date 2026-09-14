import { createHash } from 'node:crypto';
import { canonical, hashReplayValue } from './narrativeP1Replay.mjs';

const fail = code => { throw Error(`P2_RECALL_${code}`); };
export const p2TextHash = text => createHash('sha256').update(text).digest('hex');

/** Called at the opening ready, before any player action. Never reselect later. */
export function freezeP2OpeningOracle(snapshot) {
  const record = snapshot.game.record;
  const history = record.storyState.history.entries.find(h => h.kind === 'npc_line' && h.audienceIds.includes('player_0'));
  if (!history) fail('OPENING_SOURCE_MISSING');
  return { history, textHash: p2TextHash(history.text), openingAct: record.storyState.currentAct,
    openingTurn: history.turnNumber, evaluation: 'awaiting_human_review' };
}

/** Successful SQLite publications are recorded by the production preparation hook.
 * Match their complete state to the current cache: a cache row alone is no proof. */
export function inspectP2RecallCoverage({ snapshot, oracle, tapes, publications }) {
  const row = snapshot.memory.summaries.find(r => r.observer_id === 'player_0');
  const state = row?.state;
  const history = snapshot.game.record.storyState.history.entries;
  if (!oracle || canonical(history.find(h => h.id === oracle.history.id)) !== canonical(oracle.history)
    || p2TextHash(oracle.history.text) !== oracle.textHash) fail('ORACLE_CHANGED');
  const proof = [];
  for (const tape of tapes) for (const event of tape.events) {
    const { kind, metadata, value } = event.value ?? {};
    if (event.kind !== 'settlement' || kind !== 'summary_batch' || metadata.observerId !== 'player_0' || !value.published) continue;
    const published = value.state;
    const publication = publications.find(p => p.jobId === metadata.jobId && p.epoch === metadata.epoch
      && p.observerId === 'player_0' && p.artifactHash === hashReplayValue(event)
      && p.summaryRevision === published.summaryRevision && p.coveredThroughSequence === published.coveredThroughSequence
      && p.sourceFingerprint === published.coveredSourceFingerprint);
    if (!publication || !state || published.coveredThroughSequence > state.coveredThroughSequence) continue;
    const batch = published.batches.at(-1);
    if (!batch || !state.batches.some(b => canonical(b) === canonical(batch))) continue;
    if (proof.some(p => p.jobId === metadata.jobId || p.batch.id === batch.id)) continue;
    proof.push({ jobId: metadata.jobId, epoch: metadata.epoch, reservationId: publication.reservationId,
      artifactHash: publication.artifactHash, summaryRevision: published.summaryRevision,
      coveredThroughSequence: published.coveredThroughSequence, sourceFingerprint: published.coveredSourceFingerprint, batch });
  }
  return { eligible: proof.length >= 2 && oracle.history.sequence <= (state?.coveredThroughSequence ?? -1)
      && state.batches.some(batch => batch.sourceHistoryIds.includes(oracle.history.id)),
    publications: proof, coveredThroughSequence: state?.coveredThroughSequence ?? -1,
    oracleOmittedFromOverview: state ? !state.overview.historyIds.includes(oracle.history.id) : null };
}

export function isP2RecallWindow({ snapshot, oracle, coverage, topicState, focus, actionCount, budget, deadline, now, transportCount = 0 }) {
  const record = snapshot.game.record, act = record.storyState.currentAct;
  const delivered = record.worldState.eventLedger.some(e => e.payload.type === 'item_given'
    && e.payload.itemId === record.storyState.delivery?.itemId && e.payload.npcId === record.storyState.delivery?.recipientNpcId);
  return act >= 3 && !delivered && coverage.eligible && !!focus?.freeInputEnabled
    && topicState.committed.filter(t => t.act === act).length === 3
    && !topicState.stoppedActs.includes(act)
    && (act - oracle.openingAct >= 2 || actionCount >= 8)
    && actionCount < budget.actions && transportCount < budget.http && now < deadline;
}

/** Machine measurements only. Fidelity and permission judgments require cited human review. */
export function inspectP2RecallAnswer({ before, after, command, oracle, calls }) {
  const delta = after.game.record.storyState.history.entries.filter(h => !before.game.record.storyState.history.entries.some(old => old.id === h.id));
  const jobIds = [...new Set(delta.map(h => h.jobId).filter(Boolean))];
  const sources = [], requests = [], answers = [];
  for (const call of calls.filter(c => c.request.context.purpose === 'narrative_bundle_generation' && jobIds.includes(c.request.context.jobId))) {
    const prepared = after.memory.attempts.find(a => a.job_id === call.request.context.jobId)?.prepared?.player;
    if (!prepared) fail('PREPARED_PACKAGE_MISSING');
    const requestText = call.request.messages.map(m => m.content).join('\n');
    const paths = [];
    for (const h of [...prepared.uncovered, ...prepared.recalled]) {
      const sourceKind = prepared.uncovered.some(x => x.id === h.id) ? 'raw'
        : prepared.overviewHistoryIds.includes(h.id) ? 'overview'
          : prepared.manifest.some(m => m.ref === h.id && m.mandatory) ? 'mandatory' : 'recall';
      const inAuthorRequest = requestText.includes(`historyId=${h.id}; sequence=${h.sequence}; turn=${h.turnNumber}; kind=${h.kind}; speaker=${h.speakerId === null ? '旁白' : h.speakerId}; audience=[${h.audienceIds.join(', ')}]; text=${h.text}`);
      sources.push({ callId: call.request.callId, id: h.id, sourceKind, history: h, inAuthorRequest });
      if (inAuthorRequest && h.id === oracle.history.id && h.text === oracle.history.text) paths.push(sourceKind);
    }
    for (const e of [...(prepared.overviewEvents ?? []), ...prepared.requiredEvents]) sources.push({ callId: call.request.callId,
      id: e.eventId, sourceKind: prepared.overviewEventIds.includes(e.eventId) ? 'overview' : 'mandatory', event: e,
      inAuthorRequest: requestText.includes(`eventId=${e.eventId}; sequence=${e.sequence}; turn=${e.turnNumber}; kind=${e.kind}; outcome=${e.outcome}; payload=${JSON.stringify(e.payload)}`) });
    requests.push({ callId: call.request.callId, jobId: call.request.context.jobId, requestHash: hashReplayValue(call.request),
      characters: requestText.length, oraclePaths: paths.length ? paths : ['absent'], oracleTextInRequest: requestText.includes(oracle.history.text),
      recallTextInRequest: requestText.includes(command.interaction.text) });
  }
  for (const jobId of jobIds) {
    const accepted = calls.filter(c => c.request.context.jobId === jobId && c.request.context.purpose === 'narrative_bundle_generation' && c.output.ok).at(-1);
    if (!accepted) continue;
    let output; try { output = JSON.parse(accepted.output.content); } catch { continue; }
    const strings = x => typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(strings) : [];
    for (const h of delta.filter(h => h.jobId === jobId && h.kind === 'npc_line' && h.speakerId === command.interaction.targetNpcId && h.audienceIds.includes('player_0') && strings(output).includes(h.text)))
      answers.push({ history: h, candidateCallId: accepted.request.callId });
  }
  return { command, oracle, sources, requests, answers, fidelity: 'awaiting_human_review', permission: 'awaiting_human_review' };
}

/** Claim/evidence links are entered by a human reading actual requests and answers.
 * A literal match is a citation check, never a judgment of motivation or conditions. */
export function validateP2RecallReview(review, evidence, identity) {
  const exact = (x, keys) => x && canonical(Object.keys(x).sort()) === canonical(keys.sort());
  const nonempty = x => typeof x === 'string' && x.trim().length > 0;
  if (!exact(review, ['schema', 'identity', 'reviewer', 'reviewedAt', 'oracleAssessment', 'motivation', 'conditions', 'permissionErrors', 'claims'])
    || review.schema !== 'narrative-p2-recall-review/v2' || canonical(review.identity) !== canonical(identity)
    || !nonempty(review.reviewer) || !Number.isFinite(Date.parse(review.reviewedAt))
    || !['evaluable', 'sample_limitation'].includes(review.oracleAssessment)
    || !Array.isArray(review.claims) || !review.claims.length || !Array.isArray(review.permissionErrors)) fail('REVIEW_INVALID');
  for (const claim of review.claims) {
    if (!exact(claim, ['historyId', 'quote', 'candidateCallId', 'evidenceIds', 'reason']) || !nonempty(claim.reason)
      || !nonempty(claim.quote) || !Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length) fail('REVIEW_CLAIM');
    const answer = evidence.answers.find(a => a.history.id === claim.historyId && a.candidateCallId === claim.candidateCallId);
    if (!answer || !answer.history.text.includes(claim.quote) || claim.evidenceIds.some(id => !evidence.sources.some(s => s.id === id && s.callId === claim.candidateCallId && s.inAuthorRequest))) fail('REVIEW_CITATION');
  }
  for (const key of ['motivation', 'conditions']) {
    const judgment = review[key];
    if (!exact(judgment, ['verdict', 'reason', 'claimHistoryIds']) || !['faithful', 'damaged', 'not_evaluable'].includes(judgment.verdict)
      || !nonempty(judgment.reason) || !Array.isArray(judgment.claimHistoryIds) || !judgment.claimHistoryIds.length
      || judgment.claimHistoryIds.some(id => !review.claims.some(c => c.historyId === id))) fail('REVIEW_JUDGMENT');
  }
  for (const error of review.permissionErrors) if (!exact(error, ['reason', 'historyId']) || !nonempty(error.reason)
    || !review.claims.some(c => c.historyId === error.historyId)) fail('REVIEW_PERMISSION');
  return { fidelityPassed: review.oracleAssessment === 'evaluable' && review.motivation.verdict === 'faithful'
    && review.conditions.verdict === 'faithful', permissionPassed: review.permissionErrors.length === 0 };
}
