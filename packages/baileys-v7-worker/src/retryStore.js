// One worker owns one account. No disk persistence or logging of message bodies.
// Only accept a retry for an original recipient (including verified aliases).
function normalizeJid(value) {
  const match = /^([0-9]+)(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/.exec(String(value || ""));
  return match ? match[1] + "@" + match[2] : null;
}
function recipients(key) {
  return [key?.remoteJid, key?.remoteJidAlt].map(normalizeJid).filter(Boolean);
}
export function createRetryStore({maxEntries=256, ttlMs=15*60_000, otpTtlMs=4*60_000, now=Date.now}={}) {
  const entries=new Map();
  let hits=0, misses=0, evictions=0;
  function sweep() {
    for(const [id, entry] of entries) if(entry.expiresAt<=now()) {entries.delete(id);evictions++;}
  }
  function put(key,message,originalJid) {
    sweep();
    const id=String(key?.id||"");
    const text=message?.conversation ?? message?.extendedTextMessage?.text;
    if(!id || key?.fromMe!==true || typeof text!=="string" || !text || text.length>16000) return false;
    const address=new Set([...recipients(key),normalizeJid(originalJid)].filter(Boolean));
    if(!address.size) return false;
    // OTP retry window is shorter than the provider's five-minute code lifetime.
    const otp=/رمز التحقق الخاص بك في /u.test(text);
    entries.delete(id);
    entries.set(id,{message,address,expiresAt:now()+(otp?otpTtlMs:ttlMs)});
    while(entries.size>maxEntries){entries.delete(entries.keys().next().value);evictions++;}
    return true;
  }
  async function getMessage(key) {
    sweep();
    const entry=entries.get(String(key?.id||""));
    const target=normalizeJid(key?.remoteJid);
    if(!entry || key?.fromMe!==true || !target || !entry.address.has(target)) {misses++;return undefined;}
    hits++;return entry.message;
  }
  return {put,getMessage,sweep,clear:()=>entries.clear(),stats:()=>{sweep();return {size:entries.size,hits,misses,evictions};}};
}
