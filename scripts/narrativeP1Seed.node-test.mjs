import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {hashReplayValue} from './narrativeP1Replay.mjs';
import {loadNarrativeP1Seed,validateNarrativeP1SeedState} from './narrativeP1Seed.mjs';
function fixture(root,turn=0,status='ready') {
 const body={code:{fingerprint:'historical'},inputHash:'input'};
 const protocol={...body,protocolHash:hashReplayValue(body)};
 const state={ok:true,status:'active',record:{worldState:{ending:null},storyState:{turnNumber:turn,narrative:{status},evolution:{status:'stable'},endingProposed:false}}};
 mkdirSync(join(root,'audit'),{recursive:true});
 const audit='';writeFileSync(join(root,'audit/events.jsonl'),audit);
 const tape={version:1,stream:'S1-opening',binding:{protocolHash:protocol.protocolHash,codeFingerprint:'historical',inputHash:'input'},calls:[],states:[{key:'opening',semantic:state}],audit:[{file:'audit/events.jsonl',hash:createHash('sha256').update(audit).digest('hex')}]};
 writeFileSync(join(root,'protocol.json'),JSON.stringify(protocol));
 writeFileSync(join(root,'S1-opening.runtime.json'),JSON.stringify({hash:hashReplayValue(tape),tape}));
 writeFileSync(join(root,'S1-opening.sqlite'),'opaque database bytes');
 return state;
}
test('seed rejects tampering, nonzero actions, unapproved scenes and changed repository semantics',()=>{
 const root=mkdtempSync(join(tmpdir(),'p1-seed-'));
 try {
 const state=fixture(root);const seed=loadNarrativeP1Seed(root);
 validateNarrativeP1SeedState(seed,state);
 assert.throws(()=>validateNarrativeP1SeedState(seed,{...state,extra:true}),/SEED_STATE_MISMATCH/);
 writeFileSync(join(root,'S1-opening.sqlite'),'tampered');
 assert.throws(()=>loadNarrativeP1Seed(root,seed.manifest),/SEED_MANIFEST_MISMATCH/);
 fixture(root,1);assert.throws(()=>loadNarrativeP1Seed(root),/SEED_NOT_APPROVED_ZERO_TURN/);
 fixture(root,0,'failed');assert.throws(()=>loadNarrativeP1Seed(root),/SEED_NOT_APPROVED_ZERO_TURN/);
 fixture(root);writeFileSync(join(root,'audit/events.jsonl'),'tampered');assert.throws(()=>loadNarrativeP1Seed(root),/SEED_/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
