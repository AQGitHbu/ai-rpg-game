import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, hashReplayValue } from './narrativeP1Replay.mjs';
import { createP2RouteManifest, openP2RouteManifest, p2ManifestGuard } from './narrativeP2Manifest.mjs';
import { createNarrativeP2SegmentRuntime } from './narrativeP2SegmentRuntime.mjs';
import { hashP2Snapshot, readP2MemoryState } from './narrativeP2Production.mjs';
import { projectNarrativeP1GameSetup, waitForNarrativeP1Generation, hasCompletedCoreStory } from './narrativeP1Journey.mjs';
import { selectProductionChoice, currentStoryInteractions } from './narrativeP1Choices.mjs';
const fail = code => { throw Error(`P2_STAGE_${code}`); };
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => { const fd = openSync(path, 'wx'); try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); } return hashReplayValue(value); };
const bytesHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const active = snapshot => { if (!snapshot.game.ok || snapshot.game.status !== 'active') fail('DATABASE_UNAVAILABLE'); return snapshot.game.record; };
const historyOf = snapshot => active(snapshot).storyState.history.entries;
const dialogue = record => record.storyState.narrative.dialogueSession ?? null;
const topicGuard = record => ({ act: record.storyState.currentAct, reveal: record.storyState.reveal ?? null, quests: record.worldState.quests, dialogueSession: dialogue(record) });
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

/** Validate against the new committed NPC response and the final successful author
 * candidate of its actual job. A rejected earlier candidate or old History cannot pass. */
export function validateP2TopicReview(review, evidence, identity) {
  if (canonical(review?.identity) !== canonical(identity) || review.topicId !== evidence.topic.topicId || review.actionId !== evidence.command.actionId
    || !review.reviewer?.trim() || !review.reason?.trim() || !Number.isFinite(Date.parse(review.reviewedAt))
    || !['grounded', 'repeated', 'ungrounded', 'not_applicable'].includes(review.verdict)
    || !Array.isArray(review.historyQuotes) || !review.historyQuotes.length || !Array.isArray(review.candidateIds) || !review.candidateIds.length) fail('TOPIC_REVIEW_INVALID');
  const responses = evidence.historyDelta.filter(h => h.kind === 'npc_line' && h.speakerId === evidence.topic.npcId && h.audienceIds.includes('player_0'));
  for (const citation of review.historyQuotes) {
    const h = responses.find(h => h.id === citation.historyId);
    if (!h || !citation.quote?.trim() || !h.text.includes(citation.quote) || !evidence.acceptedCandidates.some(c => c.jobId === h.jobId && c.historyIds.includes(h.id) && review.candidateIds.includes(c.callId))) fail('TOPIC_REVIEW_CITATION');
  }
  if (review.candidateIds.some(id => !evidence.acceptedCandidates.some(c => c.callId === id))) fail('TOPIC_REVIEW_CANDIDATE');
  return review;
}

/** Verify closed tape bytes and audit bytes independently of manifest guard fields. */
export function inspectP2StageArtifacts(directory, state) {
  let previous = null, segment = 0;
  const evidence = [];
  while (state.artifacts[`tape-segment-${segment}`]) {
    const envelope = read(resolve(directory, `${state.stage}.segment-${segment}.json`));
    const tape = envelope.tape;
    if (envelope.hash !== hashReplayValue(tape) || envelope.hash !== state.artifacts[`tape-segment-${segment}`]
      || !tape.closed || tape.stage !== state.stage || tape.routeAttemptId !== state.routeAttemptId || canonical(tape.binding) !== canonical(state.binding)
      || tape.previousHash !== (previous?.hash ?? null) || tape.startCursor !== (previous?.tape.endCursor ?? 0)) fail('TAPE_MISMATCH');
    for (const item of tape.audit) if (bytesHash(resolve(directory, item.file)) !== item.hash) fail('AUDIT_MISMATCH');
    const item = read(resolve(directory, `${state.stage}.evidence-${segment}.json`));
    if (hashReplayValue(item) !== state.artifacts[`stage-evidence-${segment}`]) fail('EVIDENCE_MISMATCH');
    if (segment > 0) {
      const review = read(resolve(directory, `${state.stage}.topic-review-${segment - 1}.json`));
      if (hashReplayValue(review) !== state.artifacts[`topic-review-${segment - 1}`] || canonical(review) !== canonical(item.review)) fail('REVIEW_MISMATCH');
      validateP2TopicReview(review, evidence.at(-1).steps.at(-1), { routeAttemptId: state.routeAttemptId, ...state.binding,
        evidenceHash: state.artifacts[`stage-evidence-${segment - 1}`], tapeHash: state.artifacts[`tape-segment-${segment - 1}`] });
    }
    evidence.push(item); previous = envelope; segment++;
  }
  return { segment, tapeCursor: previous?.tape.endCursor ?? 0, evidence };
}

/** Bounded stage composition. Real live requires frozen code/configuration and
 * explicit process authorization, with independently replayed sealed A before B.
 * Each invocation creates or resumes exactly one ready-to-ready segment. */
export async function createNarrativeP2StageRunner(runtimeEnv, options = {}) {
  const { createServerGameEntryPoints } = await import('../src/game/application/server/compositionRoot.ts');
  const { createSqliteGameRepository } = await import('../src/game/application/server/persistence/sqliteGameRepository.ts');
  const { createSqliteClient } = await import('../src/game/application/server/persistence/sqliteClient.ts');
  const { buildChoiceMap } = await import('../src/game/application/buildChoiceMap.ts');
  const { isStoryDeliveryComplete } = await import('../src/game/gameplay/rpg/storyDelivery/index.ts');
  const { createNarrativeP2Protocol } = await import('../src/game/application/testing/narrativeP2Journey.ts');
  const { selectNarrativeP2Topic, commitNarrativeP2Topic, stopNarrativeP2Topics } = await import('../src/game/application/testing/narrativeP2Topics.ts');
  return async function run({ protocol, stage, directory, resume = false, review, mode = 'live', sourceDirectory = directory, replaySegment = 0 }) {
    if (protocol.protocolVersion !== 'narrative-p2/v2' || !['A', 'B'].includes(stage)) fail('CONFIGURATION');
    if (canonical(protocol) !== canonical(createNarrativeP2Protocol(protocol.runId, { environment: protocol.environment, codeFingerprint: protocol.codeFingerprint }))) fail('FROZEN_CONFIGURATION_MISMATCH');
    if (mode === 'live' && !options.offlineTransport) {
      if (process.env.RUN_REAL_AI_JOURNEY !== '1') fail('LIVE_REQUIRES_RUN_REAL_AI_JOURNEY');
      const { freezeP2CodeIdentity } = await import('./narrativeP2Journey.mjs');
      if (protocol.codeFingerprint !== freezeP2CodeIdentity() || protocol.environment.model !== 'ai-slg-game-model'
        || protocol.environment.inputMaxEstimatedTokens !== 64000 || runtimeEnv.AI_MODEL?.trim() !== protocol.environment.model
        || runtimeEnv.AI_API_BASE_URL?.trim() !== protocol.environment.apiBaseUrl
        || Number(runtimeEnv.AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS ?? '64000') !== 64000) fail('FROZEN_CONFIGURATION_MISMATCH');
      if (stage === 'B') await (await import('./narrativeP2Quality.mjs')).admitP2StageB(protocol, directory);
    }
    if (!['live', 'replay'].includes(mode)) fail('CONFIGURATION');
    const route = protocol.routes.find(r => r.routeId === protocol.stages.routeByStage[stage]);
    const binding = { protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, codeFingerprint: protocol.codeFingerprint,
      inputHash: protocol.inputHash, sourceHash: hashReplayValue({ stage, input: protocol.input }) };
    const config = { directory: mode === 'replay' ? sourceDirectory : directory, stage, binding, budget: route.budget };
    const manifest = mode === 'live' && !resume ? createP2RouteManifest(config) : openP2RouteManifest(config);
    const change = op => manifest.advance(p2ManifestGuard(manifest.read()), op);
    let head = manifest.read();
    const prior = resume || mode === 'replay' ? inspectP2StageArtifacts(config.directory, head) : { segment: 0, tapeCursor: 0, evidence: [] };
    const segment = mode === 'replay' ? replaySegment : prior.segment;
    const expected = mode === 'replay' ? prior.evidence[segment] : undefined;
    if (mode === 'replay' && !expected) fail('REPLAY_SEGMENT_MISSING');
    const prefix = prior.evidence.slice(0, segment);
    let topicState = { committed: [], stoppedActs: [] };
    const failures = [];
    for (const evidence of prefix) {
      for (const step of evidence.steps) if (step.topic) topicState = commitNarrativeP2Topic(topicState, { ...step.topic, actionId: step.command.actionId }, true);
      for (const failure of evidence.topicFailures) { failures.push(failure); if (!topicState.stoppedActs.includes(failure.act)) topicState = { ...topicState, stoppedActs: [...topicState.stoppedActs, failure.act] }; }
      if (evidence.review) topicState = stopNarrativeP2Topics(topicState, evidence.review);
    }
    mkdirSync(directory, { recursive: true });
    const database = resolve(directory, `${stage}.sqlite`);
    if (!resume && mode === 'live' && existsSync(database)) fail('DATABASE_ALREADY_EXISTS');
    if ((resume || (mode === 'replay' && segment > 0)) && !existsSync(database)) fail('DATABASE_MISSING');
    const reader = createSqliteGameRepository({ clientFactory: () => createSqliteClient(database) });
    const client = createSqliteClient(database);
    const snapshot = async () => ({ game: await reader.getCurrentGame(), memory: await readP2MemoryState(client) });
    let runtime, entry, timer, signal;
    let reviewForSegment = null;
    const steps = [], topicFailures = [];
    try {
      if (mode === 'live' && resume) {
        if (head.status !== 'awaiting_review' || head.pause.reason !== 'topic') fail('RESUME_NOT_TOPIC');
        const actual = await snapshot();
        const guard = { ...p2ManifestGuard(head), gameRevision: active(actual).revision, sourceHash: hashP2Snapshot(actual), tapeCursor: prior.tapeCursor };
        if (canonical(guard) !== canonical(p2ManifestGuard(head))) fail('CHECKPOINT_MISMATCH');
        const last = prefix.at(-1).steps.at(-1);
        const identity = { routeAttemptId: head.routeAttemptId, ...binding, evidenceHash: head.artifacts[`stage-evidence-${segment - 1}`], tapeHash: head.artifacts[`tape-segment-${segment - 1}`] };
        reviewForSegment = validateP2TopicReview(review, last, identity);
        topicState = stopNarrativeP2Topics(topicState, reviewForSegment);
        // Immutable review is written before resume; interrupted ingestion cannot retry.
        const reviewHash = write(resolve(directory, `${stage}.topic-review-${segment - 1}.json`), reviewForSegment);
        manifest.advance(guard, { type: 'resume' });
        change({ type: 'checkpoint', gameRevision: guard.gameRevision, sourceHash: guard.sourceHash, artifacts: { [`topic-review-${segment - 1}`]: reviewHash } });
      } else if (mode === 'live') change({ type: 'start' });
      else if (expected.review) { reviewForSegment = expected.review; topicState = stopNarrativeP2Topics(topicState, expected.review); }
      head = manifest.read();
      const controller = new AbortController(); signal = controller.signal;
      timer = setTimeout(() => controller.abort(), mode === 'live' ? Math.max(1, head.deadline - Date.now()) : route.budget.wallClockMs);
      let openingJobId;
      const resolveAttempt = async context => {
        if (context.trigger === 'initialization') openingJobId = context.jobId;
        if (context.jobId === openingJobId) return { jobId: context.jobId, epoch: 0 };
        const job = active(await snapshot()).storyState.narrative.job;
        if (job?.jobId !== context.jobId) fail('JOB_MISMATCH');
        return { jobId: job.jobId, epoch: job.attempt.epoch };
      };
      const auditId = mode === 'live' ? change({ type: 'open_audit' }).auditStreams.at(-1) : read(resolve(sourceDirectory, `${stage}.segment-${segment}.json`)).tape.auditStreamIds[0];
      const auditPath = `audit/${auditId}/events.jsonl`;
      mkdirSync(resolve(directory, 'audit', auditId), { recursive: true });
      const auditFd = openSync(resolve(directory, auditPath), 'wx'); closeSync(auditFd);
      runtime = (options.segmentRuntimeFactory ?? createNarrativeP2SegmentRuntime)({ mode, directory, sourceDirectory, stage, segment, binding, manifest: mode === 'live' ? manifest : undefined,
        routeAttemptId: head.routeAttemptId, checkpoint: mode === 'live' ? p2ManifestGuard(manifest.read()) : undefined, resolveAttempt, auditFiles: () => [auditPath] });
      if (mode === 'live' && options.offlineTransport) {
        const attempt = runtime.options.aiRuntime.attempt;
        runtime.options.aiRuntime = { ...runtime.options.aiRuntime, offline: true, attempt: request => attempt(request, () => options.offlineTransport(request, { reader, client, stage, protocol })) };
      }
      entry = createServerGameEntryPoints({ ...runtimeEnv, NODE_ENV: 'test', GAME_DB_PATH: database, AI_OUTPUT_FORMAT: 'prompt_only', AI_TEXT_AUDIT: 'full', AI_TEXT_AUDIT_DIR: resolve(directory, 'audit'), AI_TEXT_AUDIT_RUN_ID: auditId }, undefined, undefined,
        { ...runtime.options, memoryPolicy: protocol.policy, memorySummaries: 'enabled', narrativeAbortSignal: signal });
      if (segment === 0) {
        const created = await entry.createGame({ gameType: protocol.input.gameType, gameLength: route.gameLength, setup: projectNarrativeP1GameSetup(protocol.input) }, `${stage}-create`);
        if (!created.ok) fail(`CREATE_${created.code}`);
        await entry.ackPrologue(`${stage}-ack`);
      }
      let latest, current, pauseReason, completed = false;
      let actionCount = prefix.reduce((sum, e) => sum + e.steps.length, 0);
      const ready = async () => {
        current = await waitForNarrativeP1Generation(entry, `${stage}-wait-${actionCount}`, { pollIntervalMs: options.pollIntervalMs ?? 250, signal });
        if (runtime.failureCode) throw Error(runtime.failureCode);
        if (!current.ok || current.status !== 'active' || current.view.narrativeGeneration.status === 'failed') fail('GENERATION_FAILED');
        latest = await snapshot();
        if (active(latest).revision !== current.revision) fail('STATE_MISMATCH');
        runtime.state(`ready-${actionCount}`, latest);
      };
      await ready();
      while (true) {
        const record = active(latest);
        if (current.view.ending !== null) {
          completed = hasCompletedCoreStory(latest.game, isStoryDeliveryComplete) && record.worldState.eventLedger.filter(e => e.payload.type === 'item_given' && e.payload.itemId === record.storyState.delivery?.itemId && e.payload.npcId === record.storyState.delivery?.recipientNpcId).length === 1;
          if (!completed) fail('RULE_ENDING_FAILED');
          pauseReason = 'terminal_quality'; break;
        }
        const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
        const formal = selectProductionChoice(current.view, 'complete', map, currentStoryInteractions(record.worldState), new Set(), new Set(), record.storyState.delivery, actionCount);
        const focus = current.view.narrative.npcDialogues.find(npc => npc.freeInputEnabled);
        let choice = { kind: 'formal' };
        // Physical travel/handoff is not a dialogue window. The previous NPC's
        // completed session can persist until arrival at the new public focus.
        if (stage === 'B' && (focus || !formal || ['talk', 'give_item'].includes(map.get(formal.choiceToken)?.type))) {
          choice = selectNarrativeP2Topic({ currentAct: record.storyState.currentAct,
            formalResponseCount: dialogue(record)?.npcId === focus?.npcId ? dialogue(record).turnCount : 0,
            focus: current.view.narrative.npcDialogues }, topicState);
        }
        if (choice.kind === 'failure') {
          const failure = { act: record.storyState.currentAct, code: choice.code };
          topicFailures.push(failure); failures.push(failure);
          topicState = { ...topicState, stoppedActs: [...topicState.stoppedActs, failure.act] };
        }
        const selected = choice.kind === 'topic' ? null : formal;
        if (choice.kind !== 'topic' && !selected) fail('NO_LEGAL_POLICY_ACTION');
        const interaction = choice.kind === 'topic' ? { kind: 'free_text', targetNpcId: choice.npcId, text: choice.topic.text } : { kind: 'fixed_choice', choiceToken: selected.choiceToken };
        if (stage === 'B' && selected && map.get(selected.choiceToken)?.type === 'give_item') { pauseReason = 'recall_integration'; break; }
        if (actionCount >= route.budget.actions) fail('ACTION_BUDGET_EXHAUSTED');
        if (mode === 'live') change({ type: 'checkpoint', gameRevision: record.revision, sourceHash: hashP2Snapshot(latest), artifacts: { [`ready-${actionCount}`]: hashP2Snapshot(latest) } });
        const actionId = mode === 'live' ? change({ type: 'reserve_action', interaction }).pendingAction.actionId : expected.steps[steps.length]?.command.actionId;
        const command = { actionId, interaction, expectedRevision: current.revision };
        if (mode === 'replay' && canonical(command) !== canonical(expected.steps[steps.length]?.command)) fail('REPLAY_POLICY_MISMATCH');
        if (mode === 'live') change({ type: 'begin_action', actionId });
        const before = latest;
        const result = await entry.performTurn(command, `${stage}-turn-${actionCount}`);
        if (!result.ok) fail(`ACTION_${result.code}`);
        actionCount++; await ready();
        const after = active(latest);
        const historyDelta = historyOf(latest).filter(h => !historyOf(before).some(old => old.id === h.id));
        const topic = choice.kind === 'topic' ? { act: choice.topic.act, topicId: choice.topic.topicId, npcId: choice.npcId } : null;
        if (topic) {
          const a = topicGuard(record), b = topicGuard(after);
          if (a.act !== b.act || canonical(a.reveal) !== canonical(b.reveal) || canonical(a.quests) !== canonical(b.quests)
            || (b.dialogueSession?.turnCount ?? 0) !== (a.dialogueSession?.npcId === topic.npcId ? a.dialogueSession.turnCount : 0) || b.dialogueSession?.completed || b.dialogueSession?.npcId !== topic.npcId) fail('TOPIC_ADVANCED_RULES');
          topicState = commitNarrativeP2Topic(topicState, { ...topic, actionId }, true);
        }
        const evidence = { command, topic, action: selected ? map.get(selected.choiceToken) : null, before: topicGuard(record), after: topicGuard(after), historyDelta,
          historyHash: hashReplayValue(historyOf(latest)), effectiveHistoryDelta: historyDelta.filter(h => h.kind !== 'shown_choice').length,
          memoryWatermarks: latest.memory.summaries.map(row => ({ observerId: row.observer_id, summaryRevision: row.summary_revision, coveredThroughSequence: row.state.coveredThroughSequence })), acceptedCandidates: [], candidateCallIds: [], jobIds: [...new Set(historyDelta.map(h => h.jobId).filter(Boolean))] };
        // Full audit flush happens at segment close. Request call IDs are also durable in the tape.
        const calls = Array.from({ length: segment + 1 }, (_, index) => read(resolve(mode === 'live' ? directory : sourceDirectory, `${stage}.segment-${index}.json`)).tape.calls).flat();
        for (const jobId of evidence.jobIds) {
          const authored = calls.filter(c => c.request.context.jobId === jobId && c.request.context.purpose === 'narrative_bundle_generation');
          evidence.candidateCallIds.push(...authored.map(c => c.request.callId));
          const accepted = authored.filter(c => c.output.ok).at(-1);
          if (accepted) {
            let texts = []; try { texts = strings(JSON.parse(accepted.output.content)); } catch { /* invalid candidate cannot be cited */ }
            evidence.acceptedCandidates.push({ callId: accepted.request.callId, jobId, historyIds: historyDelta.filter(h => h.jobId === jobId && texts.includes(h.text)).map(h => h.id) });
          }
        }
        steps.push(evidence);
        if (mode === 'live') change({ type: 'commit_action', actionId, gameRevision: after.revision, sourceHash: hashP2Snapshot(latest), evidence: { historyHash: evidence.historyHash, historyIds: historyDelta.map(h => h.id), candidateCallIds: evidence.candidateCallIds, jobIds: evidence.jobIds, topic, effectiveHistoryDelta: evidence.effectiveHistoryDelta } });
        if (topic) {
          const answered = historyDelta.some(h => h.kind === 'npc_line' && h.speakerId === topic.npcId && h.audienceIds.includes('player_0')
            && evidence.acceptedCandidates.some(c => c.jobId === h.jobId && c.historyIds.includes(h.id)));
          if (!answered) {
            const failure = { act: topic.act, code: 'P2_TOPIC_RESPONSE_MISSING', topicId: topic.topicId, actionId };
            topicFailures.push(failure); failures.push(failure);
            topicState = { ...topicState, stoppedActs: [...topicState.stoppedActs, topic.act] };
          } else { pauseReason = 'topic'; break; }
        }
      }
      await entry.close(); entry = null;
      const finalSnapshot = await snapshot();
      if (hashP2Snapshot(finalSnapshot) !== hashP2Snapshot(latest)) fail('CLOSE_CHANGED_CHECKPOINT');
      runtime.state('terminal', finalSnapshot);
      const allCalls = Array.from({ length: segment + 1 }, (_, index) => read(resolve(mode === 'live' ? directory : sourceDirectory, `${stage}.segment-${index}.json`)).tape.calls).flat();
      const candidateIndex = allCalls.filter(c => c.request.context.purpose === 'narrative_bundle_generation').map(c => ({
        callId: c.request.callId, jobId: c.request.context.jobId, successfulTransport: c.output.ok, outputHash: hashReplayValue(c.output),
      }));
      const qualityFailures = [...failures, ...prefix.flatMap(e => e.review && e.review.verdict !== 'grounded' ? [{ act: Number(e.review.topicId.split('-')[0]), code: e.review.verdict }] : []), ...(reviewForSegment && reviewForSegment.verdict !== 'grounded' ? [{ act: Number(reviewForSegment.topicId.split('-')[0]), code: reviewForSegment.verdict }] : [])];
      const stageEvidence = { stage, segment, qualityFailures, candidateIndex, oracle: historyOf(finalSnapshot).find(h => h.kind === 'npc_line' && h.audienceIds.includes('player_0')), review: reviewForSegment, steps, topicFailures, topicState, pauseReason, completed,
        coveragePassed: stage === 'A' && completed, memoryIntegration: stage === 'B' ? 'recall_ui_not_implemented' : 'not_required', terminal: finalSnapshot, history: historyOf(finalSnapshot) };
      if (mode === 'replay') {
        if (hashP2Snapshot(stageEvidence) !== hashP2Snapshot(expected)) fail('REPLAY_EVIDENCE_MISMATCH');
        const replay = runtime.finish();
        return { ...stageEvidence, strictReplayPassed: true, replay };
      }
      const evidenceHash = write(resolve(directory, `${stage}.evidence-${segment}.json`), stageEvidence);
      change({ type: 'checkpoint', gameRevision: active(finalSnapshot).revision, sourceHash: hashP2Snapshot(finalSnapshot), artifacts: { [`stage-evidence-${segment}`]: evidenceHash } });
      const tape = runtime.finish(p2ManifestGuard(manifest.read()));
      change({ type: 'pause', status: 'awaiting_review', reason: pauseReason, artifacts: { [`stage-result-${segment}`]: evidenceHash } });
      return { ...stageEvidence, status: 'awaiting_review', strictReplayPassed: false, identity: { routeAttemptId: head.routeAttemptId, ...binding, evidenceHash, tapeHash: tape.hash }, counters: manifest.read().counters };
    } catch (error) {
      if (mode === 'live' && manifest.read().status === 'running') change({ type: 'seal_fail', reason: error.message });
      throw error;
    } finally { clearTimeout(timer); if (entry) await entry.close(); await reader.close(); client.close(); }
  };
}
