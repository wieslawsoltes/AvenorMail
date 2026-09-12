import { expandImportedCalendar, providerCalendar } from './calendar-recurrence.js';
export { calendarOccurrences } from './calendar-recurrence.js';
export const escapeHtml=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const textOnly=(v='')=>String(v).replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
export function matches(message,query){const tokens=String(query).match(/(?:[^\s"]+|"[^"]*")+/g)||[];return tokens.every(raw=>{let [k,...rest]=raw.split(':');let value=rest.join(':').replace(/^"|"$/g,'').toLowerCase();if(!rest.length)return `${message.from} ${message.to} ${message.subject} ${textOnly(message.body)}`.toLowerCase().includes(k.toLowerCase());if(k==='from'||k==='to'||k==='subject'||k==='category')return String(message[k]||'').toLowerCase().includes(value);if(k==='is')return value==='unread'?!message.read:value==='flagged'?!!message.flagged:value==='read'?!!message.read:false;if(k==='has')return value==='attachment'&&!!message.attachments?.length;if(k==='before')return new Date(message.date)<new Date(value);if(k==='after')return new Date(message.date)>new Date(value);return false;});}
const zoneFormatters=new Map();
function wallTime(date,zone){if(zone==='UTC')return new Date(date);let formatter=zoneFormatters.get(zone);if(!formatter){formatter=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});zoneFormatters.set(zone,formatter);}const parts=Object.fromEntries(formatter.formatToParts(date).map(p=>[p.type,p.value]));return new Date(Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second));}
function fromWall(wall,zone){if(zone==='UTC')return new Date(wall);let instant=+wall;for(let i=0;i<4;i++){const diff=+wall-+wallTime(new Date(instant),zone);if(!diff)break;instant+=diff;}return new Date(instant);}
export function occurrences(event,start,end){
 if(event.cancelled)return [];
 if(event.calendarComponent||event.provider)return expandImportedCalendar(providerCalendar(event),start,end);
 const out=[],base=new Date(event.start),finish=new Date(event.end),lower=new Date(start),upper=new Date(end),duration=+finish-+base,zone=event.timezone||'UTC';
 if(!Number.isFinite(+base)||!Number.isFinite(+finish)||!(upper>lower)||duration<=0)return out;
 const repeat=event.repeat||'none',until=event.until?new Date(event.until+'T23:59:59.999Z'):new Date(8640000000000000),baseWall=wallTime(base,zone),lowerWall=wallTime(lower,zone);
 let index=0;
 if(repeat==='daily'||repeat==='weekly')index=Math.max(0,Math.floor((+lowerWall-duration-baseWall)/(86400000*(repeat==='weekly'?7:1)))-2);
 if(repeat==='monthly')index=Math.max(0,(lowerWall.getUTCFullYear()-baseWall.getUTCFullYear())*12+lowerWall.getUTCMonth()-baseWall.getUTCMonth()-2-Math.ceil(duration/2419200000));
 for(let count=0;count<10000;count++,index++){
  const wall=new Date(baseWall);
  if(repeat==='daily'||repeat==='weekly')wall.setUTCDate(baseWall.getUTCDate()+index*(repeat==='weekly'?7:1));
  else if(repeat==='monthly'){wall.setUTCDate(1);wall.setUTCMonth(baseWall.getUTCMonth()+index);const month=wall.getUTCMonth();wall.setUTCDate(baseWall.getUTCDate());if(wall.getUTCMonth()!==month)continue;}
  else if(index>0)break;
  const date=index===0?base:fromWall(wall,zone);
  if(date>=upper||wall>until)break;
  if(+date+duration>+lower)out.push({...event,start:date.toISOString(),end:new Date(+date+duration).toISOString(),occurrence:index});
  if(repeat==='none')break;
 }
 return out;
}
export function toIcs(events){const esc=v=>String(v||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');const dt=d=>new Date(d).toISOString().replace(/[-:]/g,'').replace(/\.\d+Z/,'Z');return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Avenor//Mail//EN',...events.flatMap(e=>['BEGIN:VEVENT','UID:'+e.id+'@avenor','DTSTAMP:'+dt(new Date()),'DTSTART:'+dt(e.start),'DTEND:'+dt(e.end),'SUMMARY:'+esc(e.title),'DESCRIPTION:'+esc(e.notes),'LOCATION:'+esc(e.location),...(e.repeat&&e.repeat!=='none'?['RRULE:FREQ='+e.repeat.toUpperCase()+(e.until?';UNTIL='+e.until.replaceAll('-','')+'T235959Z':'')]:[]),'END:VEVENT']),'END:VCALENDAR'].join('\r\n');}
export function toEml(m){
 const clean=v=>String(v||'').replace(/[\r\n]/g,' '),base64=text=>{const bytes=new TextEncoder().encode(text);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);},fold=text=>String(text).match(/.{1,76}/g)?.join('\r\n')||'',encoded=v=>/[^\x20-\x7e]/.test(String(v))?'=?UTF-8?B?'+base64(clean(v))+'?=':clean(v);
 const boundary='avenor-'+crypto.randomUUID(),headers=['From: '+clean(m.from),'To: '+clean(m.to),...(m.cc?['Cc: '+clean(m.cc)]:[]),...(m.bcc?['Bcc: '+clean(m.bcc)]:[]),'Subject: '+encoded(m.subject),'Date: '+new Date(m.date).toUTCString(),'MIME-Version: 1.0'];
 const body=['Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',''+fold(base64(m.body||''))].join('\r\n');
 if(!m.attachments?.length)return headers.join('\r\n')+'\r\n'+body+'\r\n';
 for(const a of m.attachments)if(typeof a.base64!=='string')throw Error('Attachment bytes are required for MIME export');
 return [...headers,'Content-Type: multipart/mixed; boundary="'+boundary+'"','','--'+boundary,body,...m.attachments.flatMap(a=>['--'+boundary,'Content-Type: '+(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.type)?a.type:'application/octet-stream'),'Content-Disposition: attachment; filename*=UTF-8\'\''+encodeURIComponent(a.name),'Content-Transfer-Encoding: base64','',fold(a.base64)]),'--'+boundary+'--',''].join('\r\n');
}
