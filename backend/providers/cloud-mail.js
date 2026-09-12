import nodemailer from 'nodemailer';
import { boundedResponse } from './oauth.js';
import { fail, hash } from './security.js';
import { calendarParts, parseMailSource } from './mail-protocols.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const FOLDERS = [['inbox', 'inbox'], ['sentitems', 'sent'], ['drafts', 'drafts'], ['deleteditems', 'deleted'], ['junkemail', 'junk'], ['archive', 'archive']];
const addresses = value => {
  const flatten = entry => entry?.group ? entry.group.flatMap(flatten) : entry?.address ? [entry.address] : [];
  return (Array.isArray(value) ? value : [value]).flatMap(item => (item?.value || []).flatMap(flatten)).join(', ');
};

export async function parseMessage(raw, metadata = {}) {
  if (raw.length > 25 * 1024 * 1024) fail('An incoming message exceeds the 25 MB mail limit.', 413, 'provider_message_too_large');
  const parsed = await parseMailSource(raw);
  return {
    providerId: metadata.providerId,
    internetMessageId: parsed.messageId || null, calendarParts: calendarParts(parsed),
    from: parsed.from?.value?.[0]?.address || '', name: parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || '',
    to: addresses(parsed.to), cc: addresses(parsed.cc), bcc: addresses(parsed.bcc),
    subject: parsed.subject || '', body: parsed.text || '',
    date: parsed.date && Number.isFinite(+parsed.date) ? parsed.date.toISOString() : metadata.date || new Date().toISOString(),
    folder: metadata.folder || 'inbox', read: Boolean(metadata.read), flagged: Boolean(metadata.flagged),
    attachments: (parsed.attachments || []).map(a => ({ name: (a.filename || 'attachment').replace(/[\r\n\\/]/g, '_').slice(0,255), type: a.contentType || 'application/octet-stream', bytes: new Uint8Array(a.content) })),
  };
}

function recipientList(value) {
  const list = Array.isArray(value) ? value.map(x => typeof x === 'string' ? x : x.address) : String(value || '').split(/[,;]+/);
  return list.map(x => String(x || '').trim()).filter(Boolean);
}

function calendarEvent(attachment) {
  const content = Buffer.from(attachment.content);
  const calendar = content.toString('utf8').replace(/\r?\n[ \t]/g, '');
  const methods = [...calendar.matchAll(/^METHOD:([A-Z-]+)\r?$/gmi)].map(match => match[1].toUpperCase());
  const declared = attachment.headers?.get('content-type')?.params?.method;
  if (!/^BEGIN:VCALENDAR\r?$/mi.test(calendar) || !/^END:VCALENDAR\r?$/mi.test(calendar) || methods.length !== 1 ||
      !['REQUEST','CANCEL','REPLY','PUBLISH'].includes(methods[0]) || declared && String(declared).toUpperCase() !== methods[0]) {
    fail('The calendar invitation has an invalid or conflicting METHOD.', 400, 'invalid_calendar_mime');
  }
  return { method: methods[0], filename: attachment.filename || 'invite.ics', content };
}

export async function canonicalMime(account, message, mime) {
  const to = recipientList(message?.to), cc = recipientList(message?.cc), bcc = recipientList(message?.bcc);
  const recipients = [...new Set([...to, ...cc, ...bcc])];
  if (!recipients.length || recipients.length > 100 || recipients.some(x => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(x))) fail('Enter valid recipient email addresses (maximum 100).');
  if (typeof message?.subject !== 'string' || /[\r\n]/.test(message.subject) || message.subject.length > 998) fail('The message subject is invalid.');
  let attachments, icalEvent, html, body = String(message.body || '');
  if (mime) {
    const raw = Buffer.from(mime);
    if (raw.length > 25 * 1024 * 1024) fail('Outgoing mail exceeds the 25 MB limit.', 413);
    const parsed = await parseMailSource(raw);
    const calendarParts = (parsed.attachments || []).filter(a => a.contentType?.toLowerCase() === 'text/calendar');
    if (calendarParts.length > 1) fail('Send one calendar invitation per message.', 400, 'invalid_calendar_mime');
    if (calendarParts.length) icalEvent = calendarEvent(calendarParts[0]);
    attachments = (parsed.attachments || []).filter(a => !calendarParts.includes(a)).map(a => ({ filename: a.filename || 'attachment', content: a.content, contentType: a.contentType, cid: a.cid }));
    if (typeof parsed.html === 'string' && parsed.html) {
      html = parsed.html;
      body = parsed.text || '';
    } else body = message.body === undefined ? parsed.text || '' : body;
  } else {
    attachments = (message.attachments || []).map(a => {
      const bytes = a.bytes ?? a.content;
      if (!(bytes instanceof Uint8Array) && typeof bytes !== 'string') fail('Resolve attachment content before sending mail.', 409);
      return { filename: a.name || a.filename || 'attachment', content: bytes instanceof Uint8Array ? Buffer.from(bytes) : bytes, contentType: a.type || a.contentType };
    });
  }
  if (attachments.length > 20) fail('Maximum 20 attachments per message.');
  // API providers obtain hidden recipients from MIME headers. SMTP uses its
  // explicit envelope, so the transmitted RFC 5322 data must omit Bcc.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const result = await transport.sendMail({ from: { name: account.display_name || account.displayName || '', address: account.email }, to, cc,
    ...(account.provider === 'smtp' ? {} : { bcc }),
    subject: message.subject, text: body, ...(html ? { html } : {}), ...(icalEvent ? { icalEvent } : {}),
    attachments, disableFileAccess: true, disableUrlAccess: true,
    ...(message.messageId && /^<[^\s<>]+@[^\s<>]+>$/.test(message.messageId) ? { messageId: message.messageId } : {}),
  });
  if (result.message.length > 25 * 1024 * 1024) fail('Outgoing mail exceeds the 25 MB limit.', 413);
  const fingerprint = hash(JSON.stringify({ from: account.email, to, cc, bcc, subject: message.subject, body, html,
    ...(icalEvent ? { calendar: { method: icalEvent.method, hash: hash(icalEvent.content) } } : {}),
    attachments: attachments.map(a => ({ name: a.filename, type: a.contentType, cid: a.cid, hash: hash(Buffer.from(a.content)) })) }));
  return { mime: result.message, envelope: { from: account.email, to: recipients }, fingerprint };
}

export async function cloudSend(provider, api, mime) {
  if (provider === 'microsoft') {
    await api(`${GRAPH}/me/sendMail`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: mime.toString('base64') });
    return { status: 'accepted' };
  }
  const response = await api(`${GMAIL}/messages/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: mime.toString('base64url') }) });
  if (!response?.id) fail('Google did not return a send receipt. Verify Sent mail before retrying.', 502, 'provider_send_unconfirmed');
  return { status: 'accepted', providerId: response.id };
}

export async function graphSync(api, rawApi, previous, limit, options = {}) {
  const cursor = structuredClone(previous || {});
  if (cursor.schemaVersion !== 2) { cursor.folders = {}; cursor.schemaVersion = 2; }
  cursor.folders ||= {};
  const messages = new Map();
  const allowedFolders = options.folders ? FOLDERS.filter(([remote]) => options.folders.includes(remote)) : FOLDERS;
  const perFolder = Math.max(1, Math.floor(limit / Math.max(1, allowedFolders.length)));
  for (const [remote, folder] of allowedFolders) {
    const initial = `${GRAPH}/me/mailFolders/${remote}/messages/delta?$select=id,isRead,flag,receivedDateTime&$top=${perFolder}`;
    let url = cursor.folders[remote] || initial;
    let page;
    try { page = await api(url, { headers: { Prefer: `IdType="ImmutableId", odata.maxpagesize=${perFolder}` } }); }
    catch (error) {
      if (error.providerStatus === 404 && !cursor.folders[remote]) continue;
      if (error.providerStatus !== 410) throw error;
      url = initial;
      page = await api(url, { headers: { Prefer: `IdType="ImmutableId", odata.maxpagesize=${perFolder}` } });
    }
    if (!Array.isArray(page?.value)) fail('Microsoft returned an invalid message page.', 502);
    for (const item of page.value) {
      if (!item?.id) continue;
      if (item['@removed']) {
        if (!messages.has(item.id)) messages.set(item.id, { providerId: item.id, folder, deleted: true });
        continue;
      }
      let raw;
      try { raw = await rawApi(`${GRAPH}/me/messages/${encodeURIComponent(item.id)}/$value`, { headers: { Prefer: 'IdType="ImmutableId"' } }); }
      catch (error) { if (error.providerStatus === 404) continue; throw error; }
      messages.set(item.id, await parseMessage(raw, { providerId: item.id, folder, read: item.isRead, flagged: item.flag?.flagStatus === 'flagged', date: item.receivedDateTime }));
    }
    const next = page['@odata.nextLink'] || page['@odata.deltaLink'];
    if (!next) fail('Microsoft omitted the synchronization cursor.', 502);
    cursor.folders[remote] = next;
  }
  return { messages: [...messages.values()], cursor };
}

const gmailFolder = labels => labels.includes('TRASH') ? 'deleted' : labels.includes('SPAM') ? 'junk' : labels.includes('DRAFT') ? 'drafts' : labels.includes('INBOX') ? 'inbox' : labels.includes('SENT') ? 'sent' : 'archive';
async function gmailMessage(api, id) {
  let item;
  try { item = await api(`${GMAIL}/messages/${encodeURIComponent(id)}?format=raw`); }
  catch (error) { if (error.providerStatus === 404) return { providerId: id, deleted: true }; throw error; }
  if (typeof item.raw !== 'string') fail('Google omitted the message content.', 502);
  const labels = item.labelIds || [];
  return parseMessage(Buffer.from(item.raw, 'base64url'), { providerId: item.id, folder: gmailFolder(labels), read: !labels.includes('UNREAD'), flagged: labels.includes('STARRED'), date: new Date(Number(item.internalDate) || Date.now()).toISOString() });
}

export async function gmailSync(api, previous, limit) {
  const cursor = structuredClone(previous || {});
  let changed = [];
  if (cursor.pendingIds?.length) {
    for (const id of cursor.pendingIds.slice(0, limit)) changed.push(await gmailMessage(api, id));
    cursor.pendingIds = cursor.pendingIds.slice(limit);
    if (!cursor.pendingIds.length) {
      cursor.historyId = cursor.afterPending.historyId;
      if (cursor.afterPending.historyPage) cursor.historyPage = cursor.afterPending.historyPage;
      else delete cursor.historyPage;
      delete cursor.pendingIds;
      delete cursor.afterPending;
    }
    return { messages: changed, cursor };
  }
  if (cursor.historyId && !cursor.fullPage) {
    const query = new URLSearchParams({ startHistoryId: cursor.historyId, maxResults: String(limit) });
    if (cursor.historyPage) query.set('pageToken', cursor.historyPage);
    let page;
    try { page = await api(`${GMAIL}/history?${query}`); }
    catch (error) {
      if (error.providerStatus !== 404) throw error;
      return gmailSync(api, {}, limit);
    }
    const ids = new Set();
    for (const h of page.history || []) {
      for (const entry of [...(h.messagesAdded || []), ...(h.messagesDeleted || []), ...(h.labelsAdded || []), ...(h.labelsRemoved || [])]) {
        if (entry.message?.id) ids.add(entry.message.id);
      }
      for (const item of h.messages || []) if (item.id) ids.add(item.id);
    }
    if (ids.size > limit) {
      cursor.pendingIds = [...ids];
      cursor.afterPending = { historyId: page.nextPageToken ? cursor.historyId : page.historyId || cursor.historyId, historyPage: page.nextPageToken || null };
      return gmailSync(api, cursor, limit);
    }
    for (const id of ids) changed.push(await gmailMessage(api, id));
    if (page.nextPageToken) cursor.historyPage = page.nextPageToken;
    else { cursor.historyId = page.historyId || cursor.historyId; delete cursor.historyPage; }
  } else {
    // Capture the history boundary before the first full page. Changes during the
    // paginated snapshot are then replayed after the snapshot finishes.
    if (!cursor.snapshotHistoryId) cursor.snapshotHistoryId = (await api(`${GMAIL}/profile`)).historyId;
    const query = new URLSearchParams({ maxResults: String(limit), includeSpamTrash: 'true' });
    if (cursor.fullPage) query.set('pageToken', cursor.fullPage);
    const page = await api(`${GMAIL}/messages?${query}`);
    for (const item of page.messages || []) changed.push(await gmailMessage(api, item.id));
    if (page.nextPageToken) cursor.fullPage = page.nextPageToken;
    else {
      cursor.historyId = cursor.snapshotHistoryId;
      delete cursor.snapshotHistoryId;
      delete cursor.fullPage;
    }
  }
  return { messages: changed, cursor };
}

export async function fetchRaw(fetchImpl, url, init) {
  let response;
  try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { fail('The mail provider could not be reached.', 502, 'provider_connection_error'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error('The provider could not return this message.'), { status: response.status === 401 ? 409 : 502, providerStatus: response.status, code: 'provider_request_failed' });
  }
  return boundedResponse(response, 25 * 1024 * 1024);
}
