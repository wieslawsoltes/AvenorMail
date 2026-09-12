import { digest, error } from '../security.js';

export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sort(value[key])]));
  return value;
}

const classifications = ['public', 'internal', 'confidential', 'restricted'];
const detectors = ['credit-card', 'us-ssn', 'iban', 'secret-key', 'unscannable-attachment'];
const address = value => String(typeof value === 'string' ? value : value?.email || value?.address || '').trim().toLowerCase();
export function validatePolicy(value = {}) {
  if (!Array.isArray(value.rules) || value.rules.length > 100) throw error('Provide at most 100 DLP rules');
  const ids = new Set();
  const rules = value.rules.map(rule => {
    if (!rule || typeof rule !== 'object' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id || '') || ids.has(rule.id)) throw error('Each rule requires a unique identifier');
    ids.add(rule.id);
    if (!['block', 'warn'].includes(rule.action)) throw error('DLP rule action must be block or warn');
    const result = {id:rule.id, name:String(rule.name || rule.id).slice(0,160), action:rule.action, enabled:rule.enabled !== false};
    const match = rule.match || {};
    if (Object.keys(match).some(key => !['classifications','detectors','terms','externalOnly','recipientDomains','attachmentExtensions','maxAttachmentBytes'].includes(key))) throw error('Unknown DLP condition');
    result.match = {};
    for (const [key, allowed] of [['classifications',classifications], ['detectors',detectors]]) if (match[key] !== undefined) {
      if (!Array.isArray(match[key]) || !match[key].length || match[key].some(item => !allowed.includes(item))) throw error('Invalid ' + key);
      result.match[key] = [...new Set(match[key])].sort();
    }
    for (const key of ['terms','recipientDomains','attachmentExtensions']) if (match[key] !== undefined) {
      if (!Array.isArray(match[key]) || !match[key].length || match[key].length > 50 || match[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) throw error('Invalid ' + key);
      result.match[key] = [...new Set(match[key].map(item => item.trim().toLowerCase()))].sort();
      if (key === 'recipientDomains' && result.match[key].some(item => !/^[a-z0-9.-]+$/.test(item) || !item.includes('.') || item.startsWith('.') || item.endsWith('.'))) throw error('Use exact recipient domain names');
      if (key === 'attachmentExtensions' && result.match[key].some(item => !/^\.[a-z0-9]{1,15}$/.test(item))) throw error('Attachment extensions must include a dot');
    }
    if (match.externalOnly !== undefined) result.match.externalOnly = !!match.externalOnly;
    if (match.maxAttachmentBytes !== undefined) {
      if (!Number.isSafeInteger(match.maxAttachmentBytes) || match.maxAttachmentBytes < 0) throw error('Invalid attachment size limit');
      result.match.maxAttachmentBytes = match.maxAttachmentBytes;
    }
    if (!Object.keys(result.match).length) throw error('Each DLP rule must have at least one condition');
    return result;
  });
  const domains = value.internalDomains || [];
  if (!Array.isArray(domains) || domains.length > 100 || domains.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(item))) throw error('Invalid internal domain list');
  return {internalDomains:[...new Set(domains.map(item => item.toLowerCase()))].sort(), rules};
}

function luhn(value) {
  const digits = value.replace(/\D/g,'');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum=0, alternate=false;
  for (let i=digits.length-1;i>=0;i--) { let n=Number(digits[i]); if(alternate && (n*=2)>9)n-=9;sum+=n;alternate=!alternate; }
  return sum % 10 === 0;
}
function iban(value) {
  const text = value.replace(/\s/g,'').toUpperCase();
  const lengths={AL:28,AD:24,AT:20,AZ:28,BH:22,BE:16,BA:20,BR:29,BG:22,CR:22,HR:21,CY:28,CZ:24,DK:18,DO:28,EE:20,FO:18,FI:18,FR:27,GE:22,DE:22,GI:23,GR:27,GL:18,GT:28,HU:28,IS:26,IQ:23,IE:22,IL:23,IT:27,JO:30,KZ:20,XK:20,KW:30,LV:21,LB:28,LI:21,LT:20,LU:20,MK:19,MT:31,MR:27,MU:30,MD:24,MC:27,ME:22,NL:18,NO:15,PK:24,PS:29,PL:28,PT:25,QA:29,RO:24,SM:27,SA:24,RS:22,SK:24,SI:19,ES:24,SE:24,CH:21,TL:23,TN:24,TR:26,UA:29,AE:23,GB:22,VA:22,VG:24};
  if (text.length !== lengths[text.slice(0,2)]) return false;
  let remainder=0;
  for(const character of text.slice(4)+text.slice(0,4))for(const digit of (/\d/.test(character)?character:String(character.charCodeAt(0)-55)))remainder=(remainder*10+Number(digit))%97;
  return remainder===1;
}
export function detectSensitive(text) {
  const found=[];
  if ((text.match(/\b(?:\d[ -]?){12,18}\d\b/g)||[]).some(luhn)) found.push('credit-card');
  if (/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/.test(text)) found.push('us-ssn');
  // Restrict matches to a single line and bound candidates; terms are never executable regular expressions.
  const candidates = text.toUpperCase().match(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}\b/g)||[];
  if (candidates.some(candidate => { const compact=candidate.replace(/ /g,'');for(let n=15;n<=compact.length;n++)if(iban(compact.slice(0,n)))return true;return false; })) found.push('iban');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text)) found.push('secret-key');
  return found;
}

export function evaluatePolicy(policy, message) {
  const classification=message.classification || 'internal';
  if (!classifications.includes(classification)) throw error('Unknown message classification');
  const recipients=['to','cc','bcc'].flatMap(key => Array.isArray(message[key])?message[key]:String(message[key]||'').split(/[,;]/)).map(address).filter(Boolean);
  const domains=recipients.map(value=>value.slice(value.lastIndexOf('@')+1));
  const external=domains.some(domain=>!policy.internalDomains.includes(domain));
  const attachments=message.attachments||[];
  // MIME strings are decoded by the delivery adapter; this evaluates composed Unicode subject/body plus supplied text attachments.
  const html=String(message.body||'').replace(/<[^>]{0,10000}>/g,'').replace(/&#(x[0-9a-f]+|\d+);?/gi,(_,value)=>{const n=value[0].toLowerCase()==='x'?parseInt(value.slice(1),16):Number(value);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/&(nbsp|amp|lt|gt|quot|apos);/gi,(_,value)=>({nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[value.toLowerCase()]).replace(/[\u200b-\u200f\ufeff]/g,'').normalize('NFKC');
  const text=[message.subject||'',message.text||'',html,...attachments.map(file=>String(file.name||'')+'\n'+String(file.text||''))].join('\n').replace(/[\u200b-\u200f\ufeff]/g,'').normalize('NFKC');
  if(policy.rules.length&&text.length>2_000_000)throw error('Message text exceeds the 2 MB data protection inspection limit',413);
  const found=detectSensitive(text), lower=text.toLowerCase(), matches=[];
  if(attachments.some(file=>file.unscannable))found.push('unscannable-attachment');
  for(const rule of policy.rules){
    if(!rule.enabled)continue;
    const condition=rule.match, reasons=[];
    if(condition.externalOnly && !external)continue;
    if(condition.classifications){if(!condition.classifications.includes(classification))continue;reasons.push('classification:'+classification);}
    if(condition.detectors){const hits=condition.detectors.filter(value=>found.includes(value));if(!hits.length)continue;reasons.push(...hits.map(value=>'detector:'+value));}
    if(condition.terms){const hits=condition.terms.filter(value=>lower.includes(value));if(!hits.length)continue;reasons.push(...hits.map(value=>'term:'+value));}
    if(condition.recipientDomains){const hits=domains.filter(value=>condition.recipientDomains.includes(value));if(!hits.length)continue;reasons.push(...[...new Set(hits)].map(value=>'domain:'+value));}
    if(condition.attachmentExtensions){const hits=attachments.map(file=>String(file.name||'').toLowerCase().match(/\.[a-z0-9]{1,15}$/)?.[0]).filter(value=>condition.attachmentExtensions.includes(value));if(!hits.length)continue;reasons.push(...[...new Set(hits)].map(value=>'extension:'+value));}
    if(condition.maxAttachmentBytes!==undefined){const size=attachments.reduce((sum,file)=>sum+Number(file.size||0),0);if(size<=condition.maxAttachmentBytes)continue;reasons.push('attachment-bytes:'+size);}
    if(condition.externalOnly)reasons.push('external-recipient');
    matches.push({id:rule.id,name:rule.name,action:rule.action,reasons});
  }
  return {classification,detectors:found,matches,policyVersion:digest(canonical(policy)),contentVersion:digest(canonical({recipients,classification,text,attachments:attachments.map(file=>({id:file.id,name:file.name,size:file.size,contentHash:file.contentHash}))}))};
}
