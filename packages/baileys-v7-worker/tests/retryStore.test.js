import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryStore } from '../src/retryStore.js';

const key={id:'example',remoteJid:'123@s.whatsapp.net',remoteJidAlt:'456@lid',fromMe:true};
const msg={conversation:'test text'};
test('only the original recipient or known alias can recover content',async()=>{
  const a=createRetryStore(), b=createRetryStore();
  assert.equal(a.put(key,msg,'123@s.whatsapp.net'),true);
  assert.deepEqual(await a.getMessage(key),msg);
  assert.deepEqual(await a.getMessage({...key,remoteJid:'456:2@lid'}),msg);
  assert.equal(await a.getMessage({...key,remoteJid:'999@s.whatsapp.net'}),undefined);
  assert.equal(await a.getMessage({...key,fromMe:false}),undefined);
  assert.equal(await a.getMessage({...key,id:'missing'}),undefined);
  assert.equal(await b.getMessage(key),undefined);
  assert.equal(a.stats().hits,2);
});
test('bounded and expires OTP sooner, does not restore expired message',async()=>{
  let now=0; const a=createRetryStore({maxEntries:2,ttlMs:1000,otpTtlMs:100,now:()=>now});
  a.put(key,{conversation:'رمز التحقق الخاص بك في حسابك: *000000*'});
  a.put({...key,id:'normal'},msg);
  now=100;
  assert.equal(await a.getMessage(key),undefined);
  assert.deepEqual(await a.getMessage({...key,id:'normal'}),msg);
  a.put({...key,id:'two'},msg);
  a.put({...key,id:'three'},msg);
  assert.equal(await a.getMessage({...key,id:'normal'}),undefined);
  now=1200;
  assert.equal(a.stats().size,0);
});
test('invalid or non-outbound content is not cached',async()=>{
  const a=createRetryStore();
  assert.equal(a.put({...key,fromMe:false},msg),false);
  assert.equal(a.put({...key,remoteJid:'group@g.us',remoteJidAlt:null},msg),false);
  assert.equal(a.put(key,{imageMessage:{}}),false);
  assert.equal(await a.getMessage(key),undefined);
});
