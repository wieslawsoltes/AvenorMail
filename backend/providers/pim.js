import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const operationLeases = new AsyncLocalStorage();
const databaseNow = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
import { fail, hash, seal, unseal } from './security.js';

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const PEOPLE = 'https://people.googleapis.com/v1';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,biographies,addresses,birthdays,urls,memberships,metadata';
const enc = encodeURIComponent;
const clone = value => JSON.parse(JSON.stringify(value));
const epoch = value => value ? new Date(value).getTime() : 0;
const graphHeaders = { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=250' };
const context = (account, type) => `pim:${account.owner}:${account.id}:${type}`;
const errorStatus = error => error.providerStatus || error.status;
const escapedText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const stringList = value => Array.isArray(value) ? value : [];
const emailValid = value => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
const recurrenceRepeat = value => {
  const type = value?.pattern?.type;
  return type === 'daily' ? 'daily' : type === 'weekly' ? 'weekly' : ['absoluteMonthly','relativeMonthly'].includes(type) ? 'monthly' : 'none';
};

export function pimRecordId(accountId, kind, collectionId, providerId) {
  return `pim:${accountId}:${hash(JSON.stringify([kind, kind === 'event' ? collectionId : '', providerId])).slice(0,32)}`;
}

function dateAtMidnight(date,zone='UTC') {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('The provider returned an invalid all-day date.',502);
  const base=Date.parse(date+'T00:00:00Z');let instant=base;
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<3;i++){
    const parts=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
    const wall=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
    const corrected=base-(wall-instant);if(corrected===instant)break;instant=corrected;
  }
  return new Date(instant).toISOString();
}

export function normalizeEvent(provider, value, collection = {}) {
  if (provider === 'microsoft') {
    const start = value.start?.dateTime;
    const end = value.end?.dateTime;
    const dateValue = input => input ? /(?:Z|[+-]\d{2}:\d{2})$/.test(input) ? input : input + 'Z' : null;
    const attendees = stringList(value.attendees).map(a => ({ email: a.emailAddress?.address || '', name: a.emailAddress?.name || '', type: a.type || 'required', response: a.status?.response || 'notResponded', respondedAt: a.status?.time || null }));
    return { kind: 'event', providerId: value.id, collectionId: collection.id, etag: value['@odata.etag'] || (value.changeKey ? `W/"${value.changeKey}"` : null),
      title: value.subject || '(Untitled event)', start: dateValue(start), end: dateValue(end), allDay: !!value.isAllDay,
      timezone: value.originalStartTimeZone || value.start?.timeZone || 'UTC', endTimezone: value.originalEndTimeZone || value.end?.timeZone || 'UTC',
      location: value.location?.displayName || '', locations: value.locations || [], notes: escapedText(value.body?.content), bodyHtml: value.body?.contentType?.toLowerCase() === 'html' ? value.body.content : null,
      attendees: attendees.map(a => a.email).filter(Boolean).join(', '), attendeeDetails: attendees, organizer: value.organizer?.emailAddress || null,
      responseStatus: value.responseStatus || null, recurrence: value.recurrence || null, repeat: recurrenceRepeat(value.recurrence), until: value.recurrence?.range?.endDate || '',
      occurrenceId: value.occurrenceId || null, cancelledOccurrences: value.cancelledOccurrences || [], exclusionDates: stringList(value.cancelledOccurrences).map(id=>String(id).match(/\.(\d{4}-\d{2}-\d{2})$/)?.[1]).filter(Boolean),
      iCalUID: value.iCalUId || null, seriesMasterId: value.seriesMasterId || null, eventType: value.type || 'singleInstance', originalStart: value.originalStart || null,
      availability: value.showAs || 'busy', sensitivity: value.sensitivity || 'normal', cancelled: !!value.isCancelled,
      reminder: value.isReminderOn ? value.reminderMinutesBeforeStart : null, meetingUrl: value.onlineMeeting?.joinUrl || value.onlineMeetingUrl || '',
      category: value.categories?.[0] || collection.name || 'Calendar', categories: value.categories || [], providerUpdatedAt: value.lastModifiedDateTime || null,
      providerRaw: value, sample: false };
  }
  const attendees = stringList(value.attendees).map(a => ({ email: a.email || '', name: a.displayName || '', type: a.optional ? 'optional' : a.resource ? 'resource' : 'required', response: a.responseStatus || 'needsAction', self: !!a.self, organizer: !!a.organizer, comment: a.comment || '' }));
  const rule = stringList(value.recurrence).find(r => r.startsWith('RRULE:')) || '';
  const frequency = /(?:^|;)FREQ=(DAILY|WEEKLY|MONTHLY)/.exec(rule.replace(/^RRULE:/,''))?.[1]?.toLowerCase() || 'none';
  return { kind: 'event', providerId: value.id, collectionId: collection.id, etag: value.etag || null,
    title: value.summary || '(Untitled event)', start: value.start?.dateTime || (value.start?.date ? dateAtMidnight(value.start.date,value.start?.timeZone || collection.timezone || 'UTC') : null),
    end: value.end?.dateTime || (value.end?.date ? dateAtMidnight(value.end.date,value.end?.timeZone || collection.timezone || 'UTC') : null), allDay: !!value.start?.date,
    startDate: value.start?.date || null, endDate: value.end?.date || null, timezone: value.start?.timeZone || collection.timezone || 'UTC', endTimezone: value.end?.timeZone || collection.timezone || 'UTC',
    location: value.location || '', notes: escapedText(value.description), bodyHtml: value.description || null,
    attendees: attendees.map(a => a.email).filter(Boolean).join(', '), attendeeDetails: attendees, organizer: value.organizer || null,
    responseStatus: attendees.find(a => a.self)?.response || null, recurrence: value.recurrence || [], repeat: frequency,
    until: /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rule)?.slice(1).join('-') || '', iCalUID: value.iCalUID || null,
    seriesMasterId: value.recurringEventId || null, eventType: value.recurringEventId ? 'exception' : value.recurrence?.length ? 'seriesMaster' : 'singleInstance', originalStart: value.originalStartTime || null,
    availability: value.transparency === 'transparent' ? 'free' : 'busy', sensitivity: value.visibility || 'default', cancelled: value.status === 'cancelled',
    reminders: value.reminders || null, reminder: value.reminders?.overrides?.find(r => r.method === 'popup')?.minutes ?? null,
    meetingUrl: value.hangoutLink || value.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri || '',
    category: collection.name || 'Calendar', providerUpdatedAt: value.updated || null, providerRaw: value, sample: false };
}

export function normalizeContact(provider, value, collection = {}) {
  if (provider === 'microsoft') return { kind: 'contact', providerId: value.id, collectionId: collection.id || 'default', etag: value['@odata.etag'] || (value.changeKey ? `W/"${value.changeKey}"` : null),
    name: value.displayName || [value.givenName,value.surname].filter(Boolean).join(' '), givenName: value.givenName || '', surname: value.surname || '',
    email: value.emailAddresses?.[0]?.address || '', emails: stringList(value.emailAddresses).map(e => ({ email: e.address, name: e.name || '', type: 'other' })),
    phone: value.mobilePhone || value.businessPhones?.[0] || value.homePhones?.[0] || '', phones: [...stringList(value.businessPhones).map(value => ({ value, type: 'work' })),...stringList(value.homePhones).map(value => ({ value, type: 'home' })),...(value.mobilePhone ? [{ value:value.mobilePhone,type:'mobile' }] : [])],
    company: value.companyName || '', role: value.jobTitle || '', department: value.department || '', notes: value.personalNotes || '', birthday: value.birthday || null,
    addresses: { work: value.businessAddress || {}, home: value.homeAddress || {}, other: value.otherAddress || {} }, website: value.businessHomePage || '',
    favorite: value.categories?.includes('Avenor favorite') || false, categories: value.categories || [], providerUpdatedAt: value.lastModifiedDateTime || null, providerRaw: value, sample: false };
  const name = value.names?.find(n => n.metadata?.primary) || value.names?.[0] || {};
  const company = value.organizations?.find(o => o.current) || value.organizations?.[0] || {};
  return { kind:'contact', providerId:value.resourceName, collectionId:'contacts', etag:value.etag || null, sourceEtags:stringList(value.metadata?.sources).filter(s => s.type === 'CONTACT'),
    name:name.displayName || [name.givenName,name.familyName].filter(Boolean).join(' '), givenName:name.givenName || '', surname:name.familyName || '',
    email:value.emailAddresses?.[0]?.value || '', emails:stringList(value.emailAddresses).map(e => ({email:e.value,type:e.type || 'other'})),
    phone:value.phoneNumbers?.[0]?.value || '', phones:stringList(value.phoneNumbers).map(p => ({value:p.value,type:p.type || 'other'})),
    company:company.name || '', role:company.title || '', department:company.department || '', notes:value.biographies?.[0]?.value || '', birthday:value.birthdays?.[0]?.date || null,
    addresses:value.addresses || [], website:value.urls?.[0]?.value || '', favorite:stringList(value.memberships).some(m => m.contactGroupMembership?.contactGroupResourceName === 'contactGroups/starred'),
    providerUpdatedAt:value.metadata?.sources?.[0]?.updateTime || null, providerRaw:value, sample:false };
}

function attendeesForWrite(record, provider) {
  const details = new Map(stringList(record.attendeeDetails).map(a => [a.email?.toLowerCase(),a]));
  const values = String(record.attendees || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  if (values.some(e => !emailValid(e))) fail('Every attendee must have a valid email address.');
  return [...new Set(values)].map(email => {
    const previous = details.get(email.toLowerCase()) || {};
    return provider === 'microsoft' ? { emailAddress:{address:email,name:previous.name || email},type:previous.type || 'required' } : { email, ...(previous.name ? {displayName:previous.name} : {}), ...(previous.type === 'optional' ? {optional:true} : {}) };
  });
}

function dateInZone(iso, zone, allDay = false) {
  if (!Number.isFinite(epoch(iso))) fail('The calendar date is invalid.');
  // Graph receives UTC for timed edits, retaining the actual instant. All-day
  // events must use a midnight wall clock in the chosen calendar timezone.
  if (!allDay) return new Date(iso).toISOString().replace(/Z$/,'');
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
  const part = key => parts.find(p => p.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T00:00:00`;
}

export function eventWriteBody(provider, record) {
  if (!String(record.title || '').trim() || !(epoch(record.end) > epoch(record.start))) fail('An event title and a valid start/end range are required.');
  const timezone = record.timezone || 'UTC';
  const old = record.providerRaw || {};
  const before=normalizeEvent(provider,old,{timezone});
  const unchangedRecurrence = record.repeat === before.repeat && (record.until || '') === before.until;
  let recurrence = record.recurrence ?? old.recurrence;
  if (!unchangedRecurrence) {
    if (provider === 'microsoft') {
      const start = dateInZone(record.start,timezone,true).slice(0,10);
      const weekday = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date(start + 'T12:00:00Z').getUTCDay()];
      recurrence = record.repeat === 'none' || !record.repeat ? null : { pattern:{type:record.repeat === 'monthly' ? 'absoluteMonthly' : record.repeat,interval:1,...(record.repeat === 'weekly' ? {daysOfWeek:[weekday],firstDayOfWeek:'monday'} : {}),...(record.repeat === 'monthly' ? {dayOfMonth:Number(start.slice(8,10))} : {})},range:{type:record.until ? 'endDate' : 'noEnd',startDate:start,...(record.until ? {endDate:record.until} : {}),recurrenceTimeZone:timezone} };
    } else recurrence = record.repeat === 'none' || !record.repeat ? [] : [`RRULE:FREQ=${record.repeat.toUpperCase()}${record.until ? ';UNTIL=' + record.until.replaceAll('-','') + 'T235959Z' : ''}`];
  }
  if (provider === 'microsoft') return { subject:record.title,body:record.notes===before.notes&&old.body?old.body:{contentType:'text',content:record.notes || ''},
    start:record.allDay&&record.start===before.start&&timezone===before.timezone?old.start:{dateTime:dateInZone(record.start,timezone,record.allDay),timeZone:record.allDay ? timezone : 'UTC'},end:record.allDay&&record.end===before.end&&timezone===before.timezone?old.end:{dateTime:dateInZone(record.end,timezone,record.allDay),timeZone:record.allDay ? timezone : 'UTC'},
    isAllDay:!!record.allDay,...(record.location===before.location&&old.location?{location:old.location,...(old.locations?{locations:old.locations}:{})}:{location:{displayName:record.location || ''}}),...(old.id&&record.attendees===before.attendees?{}:{attendees:attendeesForWrite(record,provider)}),
    recurrence:recurrence || null,showAs:record.availability || 'busy',categories:record.categories || [],
    ...(record.reminder === null ? {isReminderOn:false} : record.reminder !== undefined ? {isReminderOn:true,reminderMinutesBeforeStart:Number(record.reminder)} : {}) };
  return { summary:record.title,description:record.notes===before.notes&&old.description!==undefined?old.description:record.notes || '',location:record.location || '',
    start:record.allDay ? {date:dateInZone(record.start,timezone,true).slice(0,10)} : {dateTime:new Date(record.start).toISOString(),timeZone:timezone},
    end:record.allDay ? {date:dateInZone(record.end,timezone,true).slice(0,10)} : {dateTime:new Date(record.end).toISOString(),timeZone:record.endTimezone || timezone},
    recurrence:recurrence || [],...(old.id&&record.attendees===before.attendees?{}:{attendees:attendeesForWrite(record,provider)}),transparency:record.availability === 'free' ? 'transparent' : 'opaque',
    ...(record.reminders ? {reminders:record.reminders} : {}) };
}

export function contactWriteBody(provider, record) {
  if (!String(record.name || '').trim()) fail('A contact name is required.');
  if (record.email && !emailValid(record.email)) fail('The contact email address is invalid.');
  const old = record.providerRaw || {};
  const oldName = normalizeContact(provider,old).name;
  const names = record.name === oldName ? {givenName:record.givenName || '',familyName:record.surname || ''} : {givenName:record.name,familyName:''};
  const emails = [...stringList(record.emails)];
  if (record.email) emails[0] = {...emails[0],email:record.email}; else emails.shift();
  const phones = [...stringList(record.phones)];
  if (record.phone) phones[0] = {...phones[0],value:record.phone}; else phones.shift();
  if (provider === 'microsoft') return {displayName:record.name,givenName:names.givenName,surname:names.familyName,
    emailAddresses:emails.map(e => ({address:e.email,name:e.name || record.name})),mobilePhone:phones.find(p => p.type === 'mobile')?.value || (phones[0]?.type ? null : phones[0]?.value || null),
    businessPhones:phones.filter(p => p.type === 'work' || p.type === 'other').map(p => p.value),homePhones:phones.filter(p => p.type === 'home').map(p => p.value),
    companyName:record.company || '',jobTitle:record.role || '',department:record.department || '',personalNotes:record.notes || '',businessHomePage:record.website || '',
    categories:[...stringList(record.categories).filter(c => c !== 'Avenor favorite'),...(record.favorite ? ['Avenor favorite'] : [])],
    ...(record.birthday&&typeof record.birthday==='string'?{birthday:record.birthday}:{}),
    ...(record.addresses&&!Array.isArray(record.addresses)?{businessAddress:record.addresses.work || {},homeAddress:record.addresses.home || {},otherAddress:record.addresses.other || {}}:{})};
  return {names:[names],emailAddresses:emails.map(e => ({value:e.email,type:e.type || 'other'})),phoneNumbers:phones.map(p => ({value:p.value,type:p.type || 'other'})),
    organizations:record.company || record.role ? [{name:record.company || '',title:record.role || '',department:record.department || '',current:true}] : [],
    biographies:record.notes ? [{value:record.notes,contentType:'TEXT_PLAIN'}] : [],urls:record.website ? [{value:record.website}] : [],
    ...(record.birthday && typeof record.birthday==='object'?{birthdays:[{date:record.birthday}]}:{}),
    ...(Array.isArray(record.addresses)?{addresses:record.addresses.map(address=>Object.fromEntries(Object.entries(address).filter(([key])=>['type','formattedValue','streetAddress','extendedAddress','city','region','postalCode','country','countryCode','poBox'].includes(key))))}:{}),
    memberships:[...stringList(old.memberships).filter(m=>m.contactGroupMembership&&m.contactGroupMembership.contactGroupResourceName!=='contactGroups/starred'),...(record.favorite?[{contactGroupMembership:{contactGroupResourceName:'contactGroups/starred'}}]:[])].concat(stringList(old.memberships).some(m=>m.contactGroupMembership?.contactGroupResourceName!=='contactGroups/starred')?[]:[{contactGroupMembership:{contactGroupResourceName:'contactGroups/myContacts'}}]),
    ...(record.sourceEtags?.length ? {metadata:{sources:record.sourceEtags}} : {})};
}

/** Durable provider PIM engine. A sync cursor is never advanced until its
 * encrypted batch has been durably applied by the caller and acknowledged. */
export class PimService {
  constructor({db,providers,env={},emit=()=>{},now=Date.now}) { this.db=db; this.providers=providers; this.env=env; this.emit=emit; this.now=now; this.instance=randomUUID(); this.manualLeases=new Map(); }
  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_pim_state (account_id TEXT PRIMARY KEY,owner TEXT NOT NULL,encrypted_state TEXT NOT NULL,last_sync INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_pim_batches (account_id TEXT PRIMARY KEY,owner TEXT NOT NULL,id TEXT NOT NULL,encrypted_batch TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_pim_locks (account_id TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_pim_resolutions (account_id TEXT NOT NULL,owner TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,encrypted_value TEXT NOT NULL,PRIMARY KEY(account_id,owner,idempotency_key));
      CREATE TABLE IF NOT EXISTS provider_pim_writes (account_id TEXT NOT NULL,owner TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,encrypted_result TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(account_id,owner,idempotency_key));`);
  }
  account(user,id) { const account=this.providers.account(user,id); if (!['microsoft','google'].includes(account.provider)) fail('Calendar and contact synchronization require a Microsoft or Google account.',422,'pim_provider_unsupported'); return account; }
  readState(account) { const row=this.db.prepare('SELECT * FROM provider_pim_state WHERE account_id=? AND owner=?').get(account.id,account.owner); return row ? unseal(row.encrypted_state,this.env,context(account,'state')) : {known:{},cursors:{},collections:[]}; }
  status(user,id) { const account=this.account(user,id), state=this.readState(account), row=this.db.prepare('SELECT last_sync FROM provider_pim_state WHERE account_id=? AND owner=?').get(id,account.owner); return {collections:state.collections,lastSync:row?.last_sync || null,pendingBatch:!!this.db.prepare('SELECT id FROM provider_pim_batches WHERE account_id=? AND owner=?').get(id,account.owner),pendingWrites:Object.keys(state.writebacks || {}).length,conflicts:Object.entries(state.conflicts || {}).map(([id,value])=>({id,...value,remoteVersion:value.remote.etag || 'sha256:'+hash(JSON.stringify(value.remote))}))}; }
  lock(account) {
    // Every operation gets a fresh token: an old operation from this same
    // service instance must not inherit a successor's renewed ownership.
    const lease={service:this,accountId:account.id,token:this.instance+':'+randomUUID()};
    const result=this.db.prepare(`INSERT INTO provider_pim_locks(account_id,holder,expires_at) VALUES(?,?,${databaseNow}+180000) ON CONFLICT(account_id) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE provider_pim_locks.expires_at<=${databaseNow}`).run(account.id,lease.token);
    if (!result.changes) fail('This account is already synchronizing or saving a calendar/contact change.',409,'pim_busy');
    this.manualLeases.set(account.id,lease);return lease;
  }
  currentLease(account,lease=operationLeases.getStore() || this.manualLeases.get(account.id)) {
    if(!lease || lease.service!==this || lease.accountId!==account.id)fail('The synchronization lease expired. Start the operation again.',409,'pim_lease_lost');
    return lease;
  }
  assertLease(account,lease) {
    const current=this.currentLease(account,lease);
    if(!this.db.prepare(`SELECT 1 FROM provider_pim_locks WHERE account_id=? AND holder=? AND expires_at>${databaseNow}`).get(account.id,current.token))fail('The synchronization lease expired. Start the operation again.',409,'pim_lease_lost');
  }
  fenced(account,task,lease) {
    const current=this.currentLease(account,lease);this.db.exec('SAVEPOINT pim_fence');
    try{
      // This conditional write both checks ownership and holds SQLite's write
      // lock until the result is persisted; a successor cannot race the check.
      const held=this.db.prepare(`UPDATE provider_pim_locks SET expires_at=expires_at WHERE account_id=? AND holder=? AND expires_at>${databaseNow}`).run(account.id,current.token);
      if(!held.changes)fail('The synchronization lease expired. Start the operation again.',409,'pim_lease_lost');
      const result=task();this.assertLease(account,current);this.db.exec('RELEASE pim_fence');return result;
    }catch(error){this.db.exec('ROLLBACK TO pim_fence; RELEASE pim_fence');throw error;}
  }
  unlock(account,lease=this.manualLeases.get(account.id)) {
    if(!lease)return;
    this.db.prepare('DELETE FROM provider_pim_locks WHERE account_id=? AND holder=?').run(account.id,lease.token);
    if(this.manualLeases.get(account.id)?.token===lease.token)this.manualLeases.delete(account.id);
  }
  async withLease(account,task) {
    const lease=this.lock(account);
    try{return await operationLeases.run(lease,async()=>{this.assertLease(account,lease);const result=await task();try{this.assertLease(account,lease);}catch(error){error.uncertain=true;throw error;}return result;});}
    finally{this.unlock(account,lease);}
  }
  async request(user,account,url,init={}) {
    const lease=this.currentLease(account);
    const renewed=this.db.prepare(`UPDATE provider_pim_locks SET expires_at=${databaseNow}+180000 WHERE account_id=? AND holder=? AND expires_at>${databaseNow}`).run(account.id,lease.token);
    if(!renewed.changes)fail('The synchronization lease expired. Start the operation again.',409,'pim_lease_lost');
    let response;
    try{response=await this.providers.cloudRequest(user,account.id,url,{...init,headers:{...(account.provider === 'microsoft' ? graphHeaders : {}),...init.headers}});}
    catch(error){this.assertLease(account,lease);throw error;}
    this.assertLease(account,lease);return response;
  }
  async pages(user,account,url,{items='value',next='@odata.nextLink',delta='@odata.deltaLink',pageToken=false}={}) {
    const result=[]; let token=null; const visited=new Set();
    const maxPages=Math.max(1,Number(this.env.PIM_MAX_PAGES)||10000);
    for(let page=0;url;page++) {
      if(page>=maxPages || visited.has(url)) fail('Provider pagination did not finish; synchronization state was preserved.',502,'pim_pagination_limit');
      visited.add(url); const body=await this.request(user,account,url);
      if(!body || body[items] !== undefined && !Array.isArray(body[items])) fail('The provider returned an invalid collection.',502);
      result.push(...(body[items] || [])); token=body[delta] || token;
      const continuation=body[next];
      if(continuation && pageToken){const target=new URL(url);target.searchParams.set('pageToken',continuation);url=target.href;} else url=continuation || null;
    }
    return {items:result,token};
  }
  async syncAccount(user,id) {
    const account=this.account(user,id);
    return this.withLease(account,async()=>{
      const pending=this.db.prepare('SELECT * FROM provider_pim_batches WHERE account_id=? AND owner=?').get(id,account.owner);
      if(pending) return this.batchArray(account,pending);
      const state=this.readState(account), next=clone(state), output=new Map(); next.known ||= {}; next.cursors ||= {}; next.aliases ||= {}; next.writebacks ||= {}; next.conflicts ||= {};
      const idFor=(kind,collectionId,providerId)=>{const canonical=pimRecordId(id,kind,collectionId,providerId);return next.aliases[canonical] || canonical;};
      const add=(kind,collection,raw)=>{
        const providerId=kind==='contact' && account.provider==='google' ? raw.resourceName : raw.id;
        if(!providerId) fail('A calendar or contact record has no provider identifier.',502);
        const recordId=idFor(kind,collection.id,providerId);
        const deleted=!!raw['@removed'] || !!raw.metadata?.deleted || raw.status==='cancelled' && !raw.recurringEventId;
        const previous=next.known[recordId], pending=next.writebacks[recordId];
        if(deleted&&pending?.record.deleted){delete next.writebacks[recordId];delete next.conflicts[recordId];}
        if(deleted&&pending&&!pending.record.deleted){output.set(recordId,pending.record);if(this.now()-pending.acceptedAt>120000)next.conflicts[recordId]={local:pending.record,remote:{...pending.record,deleted:true},detectedAt:this.now()};return;}
        if(deleted) {if(previous&&previous.collectionId===collection.id&&previous.providerId===providerId){output.set(recordId,{...previous,id:recordId,deleted:true});delete next.known[recordId];}return;}
        const normalized={...(kind==='event' ? normalizeEvent(account.provider,raw,collection) : normalizeContact(account.provider,raw,collection)),id:recordId,accountId:id,provider:account.provider};
        if(pending){
          if(!pending.record.deleted&&normalized.etag===pending.record.etag){delete next.writebacks[recordId];delete next.conflicts[recordId];}
          else {output.set(recordId,pending.record);if(this.now()-pending.acceptedAt>120000)next.conflicts[recordId]={local:pending.record,remote:normalized,detectedAt:this.now()};return;}
        }
        const info={kind,collectionId:collection.id,providerId,accountId:id,provider:account.provider};
        next.known[recordId]=info; output.set(recordId,normalized);
      };
      const reconcile=(kind,collection,items)=>{
        const seen=new Set(items.filter(raw=>!raw['@removed']&&!raw.metadata?.deleted&&!(raw.status==='cancelled'&&!raw.recurringEventId)).map(raw=>idFor(kind,collection.id,kind==='contact'&&account.provider==='google'?raw.resourceName:raw.id)));
        for(const [recordId,old] of Object.entries(next.known)) if(old.kind===kind&&old.collectionId===collection.id&&!seen.has(recordId)){const pending=next.writebacks[recordId];if(pending&&!pending.record.deleted){output.set(recordId,pending.record);if(this.now()-pending.acceptedAt>120000)next.conflicts[recordId]={local:pending.record,remote:{...old,id:recordId,deleted:true},detectedAt:this.now()};continue;}output.set(recordId,{...old,id:recordId,deleted:true});delete next.known[recordId];}
        for(const [recordId,pending] of Object.entries(next.writebacks))if(pending.record.kind===kind&&pending.record.collectionId===collection.id&&pending.record.deleted&&!seen.has(recordId)){delete next.writebacks[recordId];delete next.conflicts[recordId];}
        for(const raw of items)add(kind,collection,raw);
      };
      next.collections=account.provider==='microsoft' ? await this.syncMicrosoft(user,account,state,next,add,reconcile) : await this.syncGoogle(user,account,state,next,add,reconcile);
      const existing=new Set(next.collections.map(c=>c.kind+':'+c.id));
      for(const [recordId,old] of Object.entries(next.known)) if(!existing.has(old.kind+':'+old.collectionId)){output.set(recordId,{...old,id:recordId,deleted:true});delete next.known[recordId];}
      const batch={id:randomUUID(),records:[...output.values()],state:next};
      const encrypted=seal(batch,this.env,context(account,'batch:'+batch.id));
      this.fenced(account,()=>this.db.prepare('INSERT INTO provider_pim_batches(account_id,owner,id,encrypted_batch,created_at) VALUES(?,?,?,?,?)').run(id,account.owner,batch.id,encrypted,this.now()));
      return this.batchArray(account,{id:batch.id,encrypted_batch:encrypted});
    });
  }
  batchArray(account,row) { const batch=unseal(row.encrypted_batch,this.env,context(account,'batch:'+row.id)); Object.defineProperties(batch.records,{batchId:{value:row.id},collections:{value:batch.state.collections}}); return batch.records; }
  acknowledgeSync(user,id,batchId) {
    const account=this.account(user,id),lease=this.lock(account);
    try{
      const row=this.db.prepare('SELECT * FROM provider_pim_batches WHERE account_id=? AND owner=?').get(id,account.owner);
      if(!row)return;
      if(!batchId || batchId!==row.id)fail('A different calendar/contact batch awaits persistence.',409,'pim_batch_mismatch');
      const batch=unseal(row.encrypted_batch,this.env,context(account,'batch:'+row.id)),encrypted=seal(batch.state,this.env,context(account,'state'));
      this.fenced(account,()=>{
        this.db.prepare('INSERT INTO provider_pim_state(account_id,owner,encrypted_state,last_sync) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET encrypted_state=excluded.encrypted_state,last_sync=excluded.last_sync').run(id,account.owner,encrypted,this.now());
        this.db.prepare('DELETE FROM provider_pim_batches WHERE account_id=? AND id=?').run(id,batchId);
      },lease);
      try{this.emit(account.owner,{type:'pim-synced',accountId:id});}catch{/* delivery is best effort */}
    }finally{this.unlock(account,lease);}
  }
  async syncMicrosoft(user,account,previous,next,add,reconcile) {
    const calendarResult=await this.pages(user,account,GRAPH+'/calendars?$top=250');
    const collections=calendarResult.items.map(c=>({id:c.id,kind:'event',name:c.name || 'Calendar',primary:!!c.isDefaultCalendar,writable:c.canEdit!==false,timezone:c.timeZone || 'UTC',color:c.hexColor || c.color || null}));
    const fullAfter=Math.max(60000,Number(this.env.PIM_FULL_RECONCILE_MS)||86400000);
    for(const calendar of collections){
      const key='calendar:'+calendar.id, prior=previous.cursors[key] || {};
      let delta=prior.delta, window=prior.window, changed=true;
      if(calendar.primary){
        const year=new Date(this.now()).getUTCFullYear();
        if(!window || window.year!==year){window={year,start:`${year-2}-01-01T00:00:00Z`,end:`${year+3}-01-01T00:00:00Z`};delta=null;}
        const initial=GRAPH+'/calendarView/delta?'+new URLSearchParams({startDateTime:window.start,endDateTime:window.end});
        let changes;
        try{changes=await this.pages(user,account,delta || initial);}
        catch(error){if(!delta || ![404,410].includes(errorStatus(error)))throw error;changes=await this.pages(user,account,initial);delta=null;}
        if(!changes.token)fail('Microsoft did not return a calendar delta token.',502);
        changed=!delta || changes.items.length>0; delta=changes.token;
      }
      if(changed || !prior.fullAt || this.now()-prior.fullAt>=fullAfter){
        // Graph v1.0 delta is limited to the primary calendar view. Enumerating
        // series masters across the complete calendar prevents truncating
        // old/future data and retains recurrence metadata outside that window.
        const events=await this.pages(user,account,GRAPH+'/calendars/'+enc(calendar.id)+'/events?$top=250');
        const expanded=[...events.items];
        for(const master of events.items.filter(event=>event.type==='seriesMaster'||event.recurrence)){
          const details=await this.request(user,account,GRAPH+'/events/'+enc(master.id)+'?'+new URLSearchParams({'$select':'id,subject,start,end,occurrenceId,exceptionOccurrences,cancelledOccurrences','$expand':'exceptionOccurrences'}));
          master.cancelledOccurrences=details.cancelledOccurrences || [];
          const exceptions=[...(details.exceptionOccurrences || [])];
          if(details['exceptionOccurrences@odata.nextLink'])exceptions.push(...(await this.pages(user,account,details['exceptionOccurrences@odata.nextLink'])).items);
          for(const exception of exceptions){const complete=await this.request(user,account,GRAPH+'/events/'+enc(exception.id));expanded.push({...complete,type:'exception',seriesMasterId:master.id,occurrenceId:complete.occurrenceId || exception.occurrenceId});}
        }
        reconcile('event',calendar,expanded);next.cursors[key]={delta,window,fullAt:this.now()};
      }else next.cursors[key]={...prior,delta,window};
    }
    const defaultContacts={id:'default',kind:'contact',name:'Contacts',primary:true,writable:true};
    const contacts=await this.pages(user,account,GRAPH+'/contacts?$top=250');reconcile('contact',defaultContacts,contacts.items);collections.push(defaultContacts);
    const folders=(await this.pages(user,account,GRAPH+'/contactFolders?$top=250')).items;
    const seen=new Set();
    for(let index=0;index<folders.length;index++){
      const folder=folders[index];if(seen.has(folder.id))continue;seen.add(folder.id);
      if(folders.length>10000)fail('The contact folder hierarchy exceeds the configured safe traversal limit.',502);
      const collection={id:folder.id,kind:'contact',name:folder.displayName || 'Contacts',parentId:folder.parentFolderId || null,writable:true};collections.push(collection);
      const key='contacts:'+folder.id, delta=previous.cursors[key]?.delta;
      const initial=GRAPH+'/contactFolders/'+enc(folder.id)+'/contacts/delta';
      let result,full=!delta;
      try{result=await this.pages(user,account,delta || initial);}
      catch(error){if(!delta || ![404,410].includes(errorStatus(error)))throw error;result=await this.pages(user,account,initial);full=true;}
      if(!result.token)fail('Microsoft did not return a contact delta token.',502);
      if(full)reconcile('contact',collection,result.items);else for(const contact of result.items)add('contact',collection,contact);
      next.cursors[key]={delta:result.token};
      if(folder.childFolderCount!==0){const children=await this.pages(user,account,GRAPH+'/contactFolders/'+enc(folder.id)+'/childFolders?$top=250');folders.push(...children.items);}
    }
    return collections;
  }
  async syncGoogle(user,account,previous,next,add,reconcile){
    const calendars=await this.pages(user,account,CALENDAR+'/users/me/calendarList?'+new URLSearchParams({maxResults:'250',showHidden:'true'}),{items:'items',next:'nextPageToken',delta:'nextSyncToken',pageToken:true});
    const collections=calendars.items.filter(c=>!c.deleted).map(c=>({id:c.id,kind:'event',name:c.summaryOverride || c.summary || c.id,primary:!!c.primary,writable:['owner','writer'].includes(c.accessRole),timezone:c.timeZone || 'UTC',color:c.backgroundColor || null,accessRole:c.accessRole}));
    for(const collection of collections){
      const key='calendar:'+collection.id,token=previous.cursors[key]?.token;
      const initial=CALENDAR+'/calendars/'+enc(collection.id)+'/events?'+new URLSearchParams({maxResults:'2500',showDeleted:'true',singleEvents:'false'});
      const options={items:'items',next:'nextPageToken',delta:'nextSyncToken',pageToken:true};
      let result,full=!token;
      try{result=await this.pages(user,account,initial+(token?'&syncToken='+enc(token):''),options);}
      catch(error){if(!token||errorStatus(error)!==410)throw error;result=await this.pages(user,account,initial,options);full=true;}
      if(!result.token)fail('Google did not return a calendar synchronization token.',502);
      if(full)reconcile('event',collection,result.items);else for(const event of result.items)add('event',collection,event);
      next.cursors[key]={token:result.token};
    }
    const contacts={id:'contacts',kind:'contact',name:'Google Contacts',primary:true,writable:true};collections.push(contacts);
    const initial=PEOPLE+'/people/me/connections?'+new URLSearchParams({personFields:PERSON_FIELDS,pageSize:'1000',requestSyncToken:'true',sources:'READ_SOURCE_TYPE_CONTACT'});
    const token=previous.cursors.contacts?.token, options={items:'connections',next:'nextPageToken',delta:'nextSyncToken',pageToken:true};
    let result,full=!token;
    try{result=await this.pages(user,account,initial+(token?'&syncToken='+enc(token):''),options);}
    catch(error){if(!token||errorStatus(error)!==410)throw error;result=await this.pages(user,account,initial,options);full=true;}
    if(!result.token)fail('Google did not return a contacts synchronization token.',502);
    if(full)reconcile('contact',contacts,result.items);else for(const contact of result.items)add('contact',contacts,contact);
    next.cursors.contacts={token:result.token};
    return collections;
  }
  async resolveConflict({user,accountId,recordId,resolution,idempotencyKey,expectedRemoteEtag}) {
    if(!['remote','local'].includes(resolution))fail('Choose the provider version or reapply the local version.');
    if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9:._-]{8,200}$/.test(idempotencyKey))fail('A stable idempotency key is required.');
    const account=this.account(user,accountId),signature=hash(JSON.stringify({recordId,resolution,expectedRemoteEtag})),ctx=context(account,'resolution:'+idempotencyKey);
    const lease=this.lock(account);
    let intent;
    try {
      const prior=this.db.prepare('SELECT * FROM provider_pim_resolutions WHERE account_id=? AND owner=? AND idempotency_key=?').get(accountId,account.owner,idempotencyKey);
      if(prior){
        if(prior.payload_hash!==signature)fail('This conflict resolution key was used for different data.',409,'pim_idempotency_mismatch');
        const stored=unseal(prior.encrypted_value,this.env,ctx);
        if(prior.status==='accepted')return stored;
        intent=stored;
      }else{
        if(this.db.prepare('SELECT id FROM provider_pim_batches WHERE account_id=? AND owner=?').get(accountId,account.owner))fail('Apply the pending synchronization batch first.',409,'pim_sync_pending');
        const state=this.readState(account),conflict=state.conflicts?.[recordId];
        if(!conflict)fail('Calendar/contact conflict not found.',404);
        if(expectedRemoteEtag!==(conflict.remote.etag || 'sha256:'+hash(JSON.stringify(conflict.remote))))fail('The provider conflict changed since review. Review the latest versions first.',409,'pim_review_changed');
        if(resolution==='remote'||conflict.remote.deleted&&conflict.local.deleted){
          const result={...conflict.remote,id:recordId};delete state.conflicts[recordId];delete state.writebacks[recordId];
          this.fenced(account,()=>{
            this.db.prepare('UPDATE provider_pim_state SET encrypted_state=? WHERE account_id=? AND owner=?').run(seal(state,this.env,context(account,'state')),accountId,account.owner);
            this.db.prepare("INSERT INTO provider_pim_resolutions(account_id,owner,idempotency_key,payload_hash,status,encrypted_value) VALUES(?,?,?,?,'accepted',?)").run(accountId,account.owner,idempotencyKey,signature,seal(result,this.env,ctx));
          },lease);
          return result;
        }
        const record={...conflict.local,etag:conflict.remote.etag,sourceEtags:conflict.remote.sourceEtags,providerRaw:conflict.remote.providerRaw};
        intent={record,kind:record.kind,method:conflict.local.deleted?'delete':conflict.remote.deleted?'create':'update'};
        const encryptedIntent=seal(intent,this.env,ctx);
        this.fenced(account,()=>this.db.prepare("INSERT INTO provider_pim_resolutions(account_id,owner,idempotency_key,payload_hash,status,encrypted_value) VALUES(?,?,?,?,'submitting',?)").run(accountId,account.owner,idempotencyKey,signature,encryptedIntent),lease);
      }
    }finally{this.unlock(account,lease);}
    const result=await this.writeRecord({user,accountId,...intent,idempotencyKey});
    try{return await this.withLease(account,async()=>{const encrypted=seal(result,this.env,ctx);this.fenced(account,()=>this.db.prepare("UPDATE provider_pim_resolutions SET status='accepted',encrypted_value=? WHERE account_id=? AND owner=? AND idempotency_key=?").run(encrypted,accountId,account.owner,idempotencyKey));return result;});}catch(error){error.uncertain=true;throw error;}
  }
  async writeRecord({user,accountId,kind,record,method='update',idempotencyKey}){
    if(!['event','contact'].includes(kind)||!['create','update','delete'].includes(method))fail('Unsupported calendar/contact operation.');
    if(!record||typeof record!=='object'||Array.isArray(record))fail('A calendar/contact record is required.');
    if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9:._-]{8,200}$/.test(idempotencyKey))fail('A stable idempotency key is required.');
    const account=this.account(user,accountId),signature=hash(JSON.stringify({kind,record,method}));
    return this.withLease(account,async()=>{
    let submitted=false;
    try{
      const prior=this.db.prepare('SELECT * FROM provider_pim_writes WHERE account_id=? AND owner=? AND idempotency_key=?').get(accountId,account.owner,idempotencyKey);
      if(prior){
        if(prior.payload_hash!==signature)fail('This operation key was already used for different data.',409,'pim_idempotency_mismatch');
        if(prior.status==='accepted')return unseal(prior.encrypted_result,this.env,context(account,'write:'+idempotencyKey));
        if(prior.status!=='rejected')fail('The provider has not confirmed the previous operation. Synchronize and review before making another change.',409,'pim_write_uncertain');
      }
      if(this.db.prepare('SELECT id FROM provider_pim_batches WHERE account_id=? AND owner=?').get(accountId,account.owner))fail('Apply the pending calendar/contact synchronization before editing.',409,'pim_sync_pending');
      if(method!=='create'&&!record.providerId)fail('The provider record identifier is required.');
      if(method!=='create'&&!record.etag)fail('Synchronize this record before editing; its provider version is missing.',409,'pim_version_missing');
      const state=this.readState(account);
      let collectionId=record.collectionId || state.collections.find(c=>c.kind===kind&&c.primary)?.id || (kind==='event'?'primary':account.provider==='google'?'contacts':'default');
      let collection=state.collections.find(c=>c.kind===kind&&c.id===collectionId) || {id:collectionId,kind,timezone:record.timezone || 'UTC'};
      if(collection.writable===false)fail('This provider calendar or address book is read-only.',403,'pim_read_only');
      if(kind==='event'&&account.provider==='microsoft'&&collectionId==='primary'){
        const primary=await this.request(user,account,GRAPH+'/calendar');collectionId=primary.id;collection={id:primary.id,kind,name:primary.name,primary:true,writable:primary.canEdit!==false};
        if(!collection.writable)fail('The provider calendar is read-only.',403);
      }
      let url,body,httpMethod;
      if(account.provider==='microsoft'){
        url=kind==='event'?GRAPH+'/calendars/'+enc(collectionId)+'/events':collectionId==='default'?GRAPH+'/contacts':GRAPH+'/contactFolders/'+enc(collectionId)+'/contacts';
        if(method!=='create')url+='/'+enc(record.providerId);
        httpMethod=method==='create'?'POST':method==='delete'?'DELETE':'PATCH';
        if(method!=='delete')body=kind==='event'?eventWriteBody(account.provider,record):contactWriteBody(account.provider,record);
        if(kind==='event'&&method==='create')body.transactionId=hash(accountId+':'+idempotencyKey).slice(0,32);
      }else if(kind==='event'){
        url=CALENDAR+'/calendars/'+enc(collectionId)+'/events'+(method==='create'?'':'/'+enc(record.providerId))+'?sendUpdates=all';
        httpMethod=method==='create'?'POST':method==='delete'?'DELETE':'PATCH';
        if(method!=='delete')body=eventWriteBody(account.provider,record);
        if(method==='create')body.id=hash(accountId+':'+idempotencyKey);
      }else{
        if(method!=='create'&&!/^people\/[A-Za-z0-9_-]+$/.test(record.providerId))fail('The Google contact resource identifier is invalid.');
        const resource=method==='create'?'people:createContact':record.providerId+(method==='delete'?':deleteContact':':updateContact');
        url=PEOPLE+'/'+resource;httpMethod=method==='create'?'POST':method==='delete'?'DELETE':'PATCH';
        if(method!=='delete'){
          body=contactWriteBody(account.provider,record);
          if(method==='update'){
            if(!body.metadata?.sources?.some(s=>s.type==='CONTACT'&&s.etag))fail('Synchronize this contact before editing; its contact-source version is missing.',409,'pim_version_missing');
            url+='?'+new URLSearchParams({updatePersonFields:Object.keys(body).filter(k=>k!=='metadata').join(','),personFields:PERSON_FIELDS});
          }else url+='?'+new URLSearchParams({personFields:PERSON_FIELDS});
        }
      }
      this.fenced(account,()=>this.db.prepare(`INSERT INTO provider_pim_writes(account_id,owner,idempotency_key,payload_hash,status,updated_at) VALUES(?,?,?,?,'submitting',?) ON CONFLICT(account_id,owner,idempotency_key) DO UPDATE SET status='submitting',updated_at=excluded.updated_at`).run(accountId,account.owner,idempotencyKey,signature,this.now()));
      submitted=true;
      const response=await this.request(user,account,url,{method:httpMethod,headers:{...(body?{'Content-Type':'application/json'}:{}),...(method!=='create'?{'If-Match':record.etag}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const normalized=method==='delete'?{...record,deleted:true}:{...(kind==='event'?normalizeEvent(account.provider,response,collection):normalizeContact(account.provider,response,collection)),accountId,provider:account.provider};
      normalized.id=record.id || pimRecordId(accountId,kind,collectionId,normalized.providerId);normalized.kind=kind;normalized.collectionId=collectionId;normalized.accountId=accountId;normalized.provider=account.provider;
      // Retain a known ID before the next full sweep so deletion and removed
      // calendars reconcile records created by this API too.
      state.aliases ||= {};state.writebacks ||= {};state.conflicts ||= {};
      state.aliases[pimRecordId(accountId,kind,collectionId,normalized.providerId)]=normalized.id;
      state.writebacks[normalized.id]={record:normalized,acceptedAt:this.now()};delete state.conflicts[normalized.id];
      if(method==='delete')delete state.known[normalized.id];else state.known[normalized.id]={kind,collectionId,providerId:normalized.providerId,accountId,provider:account.provider};
      if(!state.collections.some(c=>c.kind===kind&&c.id===collectionId))state.collections.push(collection);
      const encryptedResult=seal(normalized,this.env,context(account,'write:'+idempotencyKey)),encryptedState=seal(state,this.env,context(account,'state'));
      this.fenced(account,()=>{
        this.db.prepare("UPDATE provider_pim_writes SET status='accepted',encrypted_result=?,updated_at=? WHERE account_id=? AND owner=? AND idempotency_key=?").run(encryptedResult,this.now(),accountId,account.owner,idempotencyKey);
        this.db.prepare('INSERT INTO provider_pim_state(account_id,owner,encrypted_state,last_sync) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET encrypted_state=excluded.encrypted_state').run(accountId,account.owner,encryptedState,0);
      });
      return normalized;
    }catch(error){
      if(submitted){const status=errorStatus(error),rejected=status>=400&&status<500&&status!==408;
        try{this.fenced(account,()=>this.db.prepare('UPDATE provider_pim_writes SET status=?,updated_at=? WHERE account_id=? AND owner=? AND idempotency_key=?').run(rejected?'rejected':'unknown',this.now(),accountId,account.owner,idempotencyKey));}
        catch(leaseError){leaseError.uncertain=true;throw leaseError;}
        if(status===412 || account.provider==='google'&&kind==='contact'&&method==='update'&&status===400)throw Object.assign(new Error('The provider record changed or rejected the contact version. Synchronize and merge your changes.'),{status:409,code:'pim_version_conflict'});
        if(!rejected)error.uncertain=true;
      }
      throw error;
    }
    });
  }
}
