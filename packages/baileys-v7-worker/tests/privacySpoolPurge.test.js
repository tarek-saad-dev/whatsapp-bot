import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDurableMirrorSpool } from '../src/durableMirrorSpool.js';
import { createHistoryPrivacyPolicy } from '../src/historyPrivacy.js';
const require=createRequire(import.meta.url);
const {createInboxSpool}=require('../../../services/inbox/inboxSpool.js');
test('mirror purge rewrites durable records, including delivered data',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'privacy-purge-'));
 try{
  const journalFile=path.join(dir,'mirror.ndjson');
  const s=createDurableMirrorSpool({journalFile});
  s.capture({providerMessageId:'one',payload:{text:'private synthetic content'}});
  s.capture({providerMessageId:'two',payload:{text:'keep'}});
  s.markDelivered('one');
  assert.equal(s.purgeMatching(r=>r.providerMessageId==='one'),1);
  assert.equal(fs.readFileSync(journalFile,'utf8').includes('private synthetic content'),false);
  const replay=createDurableMirrorSpool({journalFile});
  assert.equal(replay.hasProviderMessageId('one'),false);
  assert.equal(replay.hasProviderMessageId('two'),true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('inbound purge removes DTO payload from disk and preserves unrelated records',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'privacy-inbound-'));
 try{
  const spoolFile=path.join(dir,'inbound.json');
  const s=createInboxSpool({spoolFile});
  s.capture({providerMessageId:'one',content:'private synthetic content'},{drvowaDto:{content:'private synthetic content'}});
  s.capture({providerMessageId:'two',content:'keep'});
  assert.equal(s.purgeMatching(r=>r.providerMessageId==='one'),1);
  assert.equal(fs.readFileSync(spoolFile,'utf8').includes('private synthetic content'),false);
  assert.equal(createInboxSpool({spoolFile}).hasProviderMessageId('two'),true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('only fresh explicit block is an erasure instruction',async()=>{
 let clock=1;
 const policy=createHistoryPrivacyPolicy({accountKey:'a',token:'test',baseUrl:'http://localhost',now:()=>clock,ttlMs:10,
  fetchFn:async()=>({ok:true,json:async()=>({historyImportEnabled:false,privateContactPhones:['201001234567'],mode:'BUSINESS_ONLY',approvedContactPhones:[]})})});
 assert.equal(policy.explicitlyBlocked('201001234567'),false);
 await policy.get();
 assert.equal(policy.explicitlyBlocked('201001234567@s.whatsapp.net'),true);
 assert.equal(policy.explicitlyBlocked('201001234568'),false);
 assert.equal(policy.explicitlyBlocked('123456789@lid'),false);
 clock+=11;
 assert.equal(policy.explicitlyBlocked('201001234567'),false);
});
