import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonical, hashReplayValue, createNarrativeP1ReplayRuntime } from './narrativeP1Replay.mjs';
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
/** Reads bytes only: the historical SQLite is never opened by this loader. */
export function loadNarrativeP1Seed(sourceDirectory, expectedManifest) {
  try {
    const directory = resolve(sourceDirectory);
    const protocol = JSON.parse(readFileSync(resolve(directory, 'protocol.json'), 'utf8'));
    const { protocolHash, ...protocolBody } = protocol;
    if (protocolHash !== hashReplayValue(protocolBody)) throw new Error('PROTOCOL');
    const envelope = JSON.parse(readFileSync(resolve(directory, 'S1-opening.runtime.json'), 'utf8'));
    const tape = envelope.tape;
    const binding = { protocolHash, codeFingerprint: protocol.code.fingerprint, inputHash: protocol.inputHash };
    // Reuse strict envelope/binding/audit validation without replaying historical requests.
    createNarrativeP1ReplayRuntime({mode:'replay', directory, sourceDirectory:directory, stream:'S1-opening', binding});
    const opening = tape.states.filter(state => state.key === 'opening');
    if (opening.length !== 1) throw new Error('OPENING');
    const state = opening[0].semantic;
    const story = state?.record?.storyState;
    if (!state?.ok || state.status !== 'active' || story?.turnNumber !== 0 || story.narrative?.status !== 'ready' || story.evolution?.status !== 'stable' || story.endingProposed || state.record.worldState.ending != null) throw new Error('NOT_APPROVED_ZERO_TURN');
    const databasePath = resolve(directory, 'S1-opening.sqlite');
    const manifest = { sourceDirectory:directory, sourceProtocolHash:protocolHash, sourceCodeFingerprint:protocol.code.fingerprint, sourceInputHash:protocol.inputHash, protocolFileHash:fileHash(resolve(directory,'protocol.json')), runtimeFileHash:fileHash(resolve(directory,'S1-opening.runtime.json')), audit:tape.audit, databaseHash:fileHash(databasePath), openingSemanticHash:hashReplayValue(state) };
    if (expectedManifest && canonical(expectedManifest) !== canonical(manifest)) throw new Error('MANIFEST_MISMATCH');
    return { directory, databasePath, manifest, expectedOpening:state };
  } catch (error) { throw new Error(`SEED_${error.message}`, {cause:error}); }
}
export function validateNarrativeP1SeedState(seed, state) {
  if (hashReplayValue(state) !== seed.manifest.openingSemanticHash) throw new Error('SEED_STATE_MISMATCH');
}
