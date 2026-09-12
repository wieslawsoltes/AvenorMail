import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { checkServerIdentity } from 'node:tls';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { isImapFolder, validateMessagePatch } from './mutations.js';

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) privateAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) privateAddresses.addSubnet(address, prefix, 'ipv6');
const globalV6Addresses = new BlockList();
globalV6Addresses.addSubnet('2000::', 3, 'ipv6');

class MailProtocolError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'MailProtocolError';
    this.code = code;
    this.status = status;
  }
}

function configError(message) {
  return new MailProtocolError('MAIL_CONFIG_INVALID', message, 400);
}

function blockedHost() {
  return new MailProtocolError('MAIL_HOST_BLOCKED', 'Mail servers must use a public internet address.', 403);
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, 'ipv4');
  // IPv4-mapped, translation, local, multicast, and reserved IPv6 ranges are
  // deliberately excluded. Only ordinary global-unicast destinations qualify.
  return family === 6 && globalV6Addresses.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6');
}

function normalizeHost(value, allowPrivate) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) {
    throw configError('Enter a valid mail server hostname.');
  }
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (isIP(host)) {
    if (!allowPrivate && !isPublicAddress(host)) throw blockedHost();
    return host;
  }
  if (/[\s/:@\\%?#]/.test(host)) throw configError('Use a hostname without a URL, path, or port.');
  host = domainToASCII(host.replace(/\.$/, ''));
  const labels = host.split('.');
  if (!host || host.length > 253 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw configError('Enter a valid mail server hostname.');
  }
  if (!allowPrivate && (labels.length < 2 || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) || host.endsWith('.home.arpa'))) {
    throw blockedHost();
  }
  return host;
}

function normalizeProtocol(input, protocol, email, allowPrivate) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw configError(`Enter ${protocol.toUpperCase()} server settings.`);
  }
  const defaultPort = protocol === 'smtp' ? 465 : 993;
  const port = input.port === undefined || input.port === '' ? defaultPort : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError('Mail server ports must be between 1 and 65535.');
  if (input.secure !== undefined && typeof input.secure !== 'boolean') throw configError('The secure setting must be true or false.');
  const secure = input.secure ?? port === defaultPort;
  if (port === defaultPort && !secure) throw configError(`Port ${defaultPort} requires implicit TLS.`);
  const user = input.user === undefined || input.user === '' ? email : input.user;
  if (typeof user !== 'string' || !user.trim() || user.length > 320 || /[\r\n\0]/.test(user)) throw configError('Enter a valid mail server username.');
  if (typeof input.password !== 'string' || !input.password || input.password.length > 4096 || /[\r\n\0]/.test(input.password)) {
    throw configError(`Enter a ${protocol.toUpperCase()} password or app password.`);
  }
  return { host: normalizeHost(input.host, allowPrivate), port, secure, user: user.trim(), password: input.password };
}

/** Validate configuration without making a network connection or retaining extra options. */
export function validateMailConfig(input, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw configError('Enter mail account settings.');
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 320 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email) || /[\r\n\0]/.test(email)) {
    throw configError('Enter a valid account email address.');
  }
  const displayName = input.displayName ?? '';
  if (typeof displayName !== 'string' || displayName.length > 200 || /[\r\n\0]/.test(displayName)) throw configError('Enter a valid display name.');
  const allowPrivate = env.ALLOW_PRIVATE_MAIL_HOSTS === 'true';
  return {
    email,
    displayName: displayName.trim(),
    smtp: normalizeProtocol(input.smtp, 'smtp', email, allowPrivate),
    imap: normalizeProtocol(input.imap, 'imap', email, allowPrivate),
  };
}

async function resolveDestination(host, env) {
  let timer;
  try {
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new MailProtocolError('MAIL_DNS_FAILED', 'The mail server hostname could not be resolved.')), 10000);
        timer.unref?.();
      }),
    ]);
    if (!addresses.length) throw new MailProtocolError('MAIL_DNS_FAILED', 'The mail server hostname could not be resolved.');
    if (env.ALLOW_PRIVATE_MAIL_HOSTS !== 'true' && addresses.some(({ address }) => !isPublicAddress(address))) throw blockedHost();
    // Pass only this literal address to the transport. It cannot resolve the
    // original name again between the security check and the TCP connection.
    return addresses.find(({ family }) => family === 4)?.address || addresses[0].address;
  } catch (error) {
    if (error instanceof MailProtocolError) throw error;
    throw new MailProtocolError('MAIL_DNS_FAILED', 'The mail server hostname could not be resolved.');
  } finally {
    clearTimeout(timer);
  }
}

function tlsOptions(host) {
  return {
    servername: isIP(host) ? undefined : host,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    // Preserve certificate validation against the configured host even though
    // the connection itself uses the vetted IP address.
    checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate),
  };
}

function safeProviderError(error, protocol) {
  if (error instanceof MailProtocolError) return error;
  if (error?.code === 'EAUTH' || error?.authenticationFailed || error?.code === 'AuthenticationFailed') {
    return new MailProtocolError('MAIL_AUTH_FAILED', 'The mail server rejected the login. Check the username and app password.', 401);
  }
  if (error?.tlsFailed || error?.code === 'ETLS' || error?.code === 'UPGRADEFAILED' || /(?:CERT|TLS|SSL|STARTTLS)/i.test(String(error?.code || ''))) {
    return new MailProtocolError('MAIL_TLS_FAILED', 'A verified encrypted connection to the mail server could not be established.');
  }
  if (protocol === 'smtp' && error?.code === 'EENVELOPE') {
    return new MailProtocolError('MAIL_RECIPIENTS_REJECTED', 'The mail server rejected the sender or all recipients.', 422);
  }
  if (protocol === 'smtp' && !['ECONNECTION', 'EDNS'].includes(error?.code)) {
    return new MailProtocolError('MAIL_SEND_UNCONFIRMED', 'The mail server did not confirm delivery. Check your sent mail before retrying.');
  }
  return new MailProtocolError('MAIL_CONNECTION_FAILED', 'The mail server connection failed. Check the server settings and try again.');
}

function envLimit(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

function addressList(field) {
  const fields = Array.isArray(field) ? field : [field];
  const flatten = (entry) => entry?.group ? entry.group.flatMap(flatten) : entry?.address ? [entry] : [];
  return fields.flatMap((entry) => (entry?.value || []).flatMap(flatten));
}

/** Parse provider MIME with a text fallback for HTML-only multipart messages. */
export async function parseMailSource(source, maxBytes = 25 * 1024 * 1024) {
  const parserOptions = { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, keepCidLinks: true, maxHtmlLengthToParse: maxBytes };
  const parsed = await simpleParser(source, parserOptions);
  if (!parsed.text && typeof parsed.html === 'string' && parsed.html) {
    // MailParser can omit generated text for HTML-only content inside a
    // multipart/mixed tree. Parsing that HTML as a root part exercises its
    // supported HTML-to-text conversion without displaying provider HTML.
    const htmlPart = Buffer.from(`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(parsed.html).toString('base64')}`);
    parsed.text = (await simpleParser(htmlPart, parserOptions)).text || '';
  }
  return parsed;
}

function normalizedMessage(parsed, source, uidValidity, mailbox = 'INBOX', folder = 'inbox') {
  const from = addressList(parsed.from)[0];
  const date = [parsed.date, source.internalDate].find((value) => value && Number.isFinite(new Date(value).getTime()));
  return {
    providerId: imapProviderId(mailbox, uidValidity, source.uid),
    internetMessageId: parsed.messageId || null,
    providerMailbox: mailbox,
    calendarParts: calendarParts(parsed),
    from: from?.address || '',
    name: from?.name || from?.address || '',
    to: addressList(parsed.to).map((entry) => entry.address).join(', '),
    cc: addressList(parsed.cc).map((entry) => entry.address).join(', '),
    bcc: addressList(parsed.bcc).map((entry) => entry.address).join(', '),
    subject: parsed.subject || '',
    // MailParser generates text from HTML-only mail. Never expose unsanitized
    // provider HTML as the application's display body.
    body: parsed.text || '',
    date: new Date(date || Date.now()).toISOString(),
    folder,
    read: source.flags?.has('\\Seen') || false,
    flagged: source.flags?.has('\\Flagged') || false,
    answered: source.flags?.has('\\Answered') || false,
    providerFlags: [...(source.flags || [])].sort(),
    attachments: (parsed.attachments || []).map((attachment, index) => ({
      name: attachment.filename || `attachment-${index + 1}`,
      type: attachment.contentType || 'application/octet-stream',
      bytes: new Uint8Array(attachment.content),
    })),
  };
}

/** Preserve scheduling MIME for a separate validation and consent pipeline. */
export function calendarParts(parsed) {
  return (parsed.attachments || []).filter(a => a.contentType?.toLowerCase() === 'text/calendar').map(a => ({
    content: Buffer.from(a.content).toString('utf8'),
    method: a.headers?.get('content-type')?.params?.method || null,
  }));
}

export function imapProviderId(mailbox, validity, uid) {
  return mailbox.toUpperCase() === 'INBOX' ? `imap:INBOX:${validity}:${uid}` :
    `imap:v2:${Buffer.from(mailbox).toString('base64url')}:${validity}:${uid}`;
}

const imapFolder = box => {
  if (box.path.toUpperCase() === 'INBOX') return 'inbox';
  for (const [flag, folder] of [['\\Sent','sent'],['\\Drafts','drafts'],['\\Trash','deleted'],['\\Junk','junk'],['\\Archive','archive']]) {
    if (box.flags?.has(flag)) return folder;
  }
  return `imap:${Buffer.from(box.path).toString('base64url')}`;
};
const goodUid = uid => Number.isInteger(uid) && uid > 0 && uid <= 0xffffffff;
const safeMailbox = path => typeof path === 'string' && path && path.length <= 1024 && ![...path].some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127);

/**
 * Bounded, restartable reconciliation across every selectable mailbox.
 * The snapshot is a membership list, never a sequence-number checkpoint. Source
 * removals are emitted only after the complete pass so a verified unique move
 * can retain the original local record identity before the old UID disappears.
 */
export async function reconcileImap(client, previous = null, env = {}) {
  const cursor = previous?.schemaVersion === 3 ? structuredClone(previous) : { schemaVersion: 3, entries: {}, cycle: null };
  cursor.entries ||= {};
  const limit = envLimit(env.PROVIDER_SYNC_LIMIT, 100, 500);
  const maxBytes = envLimit(env.PROVIDER_MESSAGE_MAX_BYTES, 25 * 1024 * 1024, 100 * 1024 * 1024);
  const batchMaxBytes = envLimit(env.PROVIDER_SYNC_MAX_BYTES, 50 * 1024 * 1024, 200 * 1024 * 1024);
  const maximumUids = envLimit(env.PROVIDER_IMAP_MAX_UIDS, 250000, 2000000);
  const messages = [];
  let examined = 0, batchBytes = 0;
  const boxes = (await client.list()).filter(box => safeMailbox(box.path) && !box.flags?.has('\\Noselect') && !box.flags?.has('\\NonExistent'));
  if (!boxes.length && Object.keys(cursor.entries).length) throw new MailProtocolError('MAIL_SYNC_FAILED','No selectable mailboxes were returned; existing mail is preserved.');
  if (boxes.length > 1000) throw new MailProtocolError('MAIL_FOLDER_LIMIT', 'The mailbox has more than 1,000 selectable folders.', 413);
  boxes.sort((a,b)=>(a.path.toUpperCase()==='INBOX'?-1:b.path.toUpperCase()==='INBOX'?1:a.path.localeCompare(b.path)));
  const directory = boxes.map(box=>({path:box.path,folder:imapFolder(box)}));
  const sameDirectory = items => JSON.stringify(directory) === JSON.stringify(items.map(({path,folder})=>({path,folder})));
  if (cursor.cycle && !sameDirectory(cursor.cycle.folders)) cursor.cycle=null;
  if (cursor.building && !sameDirectory(cursor.building.directory)) cursor.building=null;
  if (!cursor.cycle) {
    cursor.building ||= {directory,folders:[],index:0,total:0};
    const building=cursor.building, folderLimit=envLimit(env.PROVIDER_IMAP_FOLDER_BATCH_LIMIT,25,1000);
    let selected=0;
    // Folder membership itself is paginated and durable. No partial directory
    // snapshot can produce tombstones before every folder has been checked.
    while (building.index < directory.length && selected++ < folderLimit) {
      const box=directory[building.index];
      const lock=await client.getMailboxLock(box.path,{readOnly:true});
      try {
        const validity=String(client.mailbox.uidValidity);
        if (!/^\d+$/.test(validity)) throw new MailProtocolError('MAIL_SYNC_FAILED','The mail server did not provide a stable mailbox identifier.');
        const found=client.mailbox.exists?await client.search({all:true},{uid:true}):[];
        if (!Array.isArray(found)) throw new MailProtocolError('MAIL_SYNC_FAILED','The mail server did not return a complete UID membership list.');
        const uids=[...new Set(found.filter(goodUid))].sort((a,b)=>a-b);
        if (found.some(uid=>!goodUid(uid))) throw new MailProtocolError('MAIL_SYNC_FAILED','The mail server returned an invalid UID.');
        building.total+=uids.length;
        if (building.total>maximumUids) throw new MailProtocolError('MAIL_UID_LIMIT','The mailbox exceeds the configured reconciliation membership limit.',413);
        building.folders.push({...box,validity,uids});building.index++;
      } finally {lock.release();}
    }
    if (building.index<directory.length) return {messages,cursor,folders:directory,more:true};
    const folders=building.folders;
    const present=new Set(folders.flatMap(box=>box.uids.map(uid=>imapProviderId(box.path,box.validity,uid))));
    cursor.cycle={folders,folderIndex:0,uidIndex:0,deletions:Object.keys(cursor.entries).filter(id=>!present.has(id)),deleteIndex:0};
    delete cursor.building;
  }
  const cycle = cursor.cycle;
  const retire = new Set(cycle.deletions);
  while (cycle.folderIndex < cycle.folders.length && examined < limit) {
    const box = cycle.folders[cycle.folderIndex];
    const lock = await client.getMailboxLock(box.path, { readOnly: true });
    try {
      if (String(client.mailbox.uidValidity) !== box.validity) {
        cursor.cycle = null;
        return { messages, cursor, folders: cycle.folders.map(({ path, folder }) => ({ path, folder })), more: true };
      }
      while (cycle.uidIndex < box.uids.length && examined < limit) {
        const uid = box.uids[cycle.uidIndex], providerId = imapProviderId(box.path, box.validity, uid);
        const known = cursor.entries[providerId];
        const query = { uid: true, flags: true, emailId: true, ...(known?.digest ? {} : { internalDate: true, size: true, source: { start: 0, maxLength: maxBytes + 1 } }) };
        const source = await client.fetchOne(uid, query, { uid: true });
        examined++;
        if (!source) {
          if (known && !retire.has(providerId)) { cycle.deletions.push(providerId); retire.add(providerId); }
          cycle.uidIndex++; continue;
        }
        if (source.uid !== uid || !(source.flags instanceof Set)) throw new MailProtocolError('MAIL_SYNC_FAILED', 'A mail message could not be retrieved consistently.');
        const read = source.flags.has('\\Seen'), flagged = source.flags.has('\\Flagged'), markedDeleted = source.flags.has('\\Deleted');
        const providerFlags=[...source.flags].sort(),answered=source.flags.has('\\Answered');
        if (known?.digest) {
          if (known.read !== read || known.flagged !== flagged || known.markedDeleted !== markedDeleted || known.folder !== box.folder || JSON.stringify(known.providerFlags)!==JSON.stringify(providerFlags)) {
            messages.push({ providerId, metadataOnly: true, folder: box.folder, providerMailbox: box.path, read, flagged, markedDeleted, answered, providerFlags });
          }
          Object.assign(known, { read, flagged, markedDeleted, folder: box.folder, providerFlags });
        } else {
          if (!source.source) throw new MailProtocolError('MAIL_SYNC_FAILED', 'The mail server omitted message content.');
          if (source.size > maxBytes || source.source.length > maxBytes) {
            if (messages.length) return { messages, cursor, more: true };
            throw new MailProtocolError('MAIL_MESSAGE_TOO_LARGE', 'A message exceeds the configured import size limit.', 413);
          }
          if (batchBytes + source.source.length > batchMaxBytes) {
            if (messages.length) return {messages,cursor,more:true};
            throw new MailProtocolError('MAIL_MESSAGE_TOO_LARGE','A message exceeds the configured batch size limit.',413);
          }
          const digest = createHash('sha256').update(source.source).digest('hex');
          const parsed = await parseMailSource(source.source, maxBytes);
          const message = normalizedMessage(parsed, source, box.validity, box.path, box.folder);
          message.markedDeleted = markedDeleted;
          // Raw content is compared only against locations proven absent from
          // this complete membership snapshot. Identical live copies remain
          // separate records. Ambiguous matches are never merged.
          const candidates = cycle.deletions.filter(id => cursor.entries[id]?.digest === digest);
          if (candidates.length === 1) {
            const oldId = candidates[0];
            message.previousProviderId = oldId;
            delete cursor.entries[oldId];
          }
          cursor.entries[providerId] = { mailbox: box.path, validity: box.validity, uid, digest,
            emailId: source.emailId || null, read, flagged, markedDeleted, folder: box.folder, providerFlags };
          messages.push(message); batchBytes += source.source.length;
        }
        cycle.uidIndex++;
      }
    } finally { lock.release(); }
    if (cycle.uidIndex >= box.uids.length) { cycle.folderIndex++; cycle.uidIndex = 0; }
  }
  if (cycle.folderIndex >= cycle.folders.length) {
    while (cycle.deleteIndex < cycle.deletions.length && messages.length < limit) {
      const id = cycle.deletions[cycle.deleteIndex++], entry = cursor.entries[id];
      if (!entry) continue;
      messages.push({ providerId: id, deleted: true, folder: entry.folder, providerMailbox: entry.mailbox });
      delete cursor.entries[id];
    }
    if (cycle.deleteIndex >= cycle.deletions.length) {
      cursor.folders = cycle.folders.map(({ path, folder }) => ({ path, folder }));
      cursor.cycle = null; cursor.completedAt = Date.now();
    }
  }
  return { messages, cursor, folders: cursor.folders || cycle.folders.map(({ path, folder }) => ({ path, folder })), more: Boolean(cursor.cycle) };
}

/** Open a TLS-enforced connection and produce an unacknowledged sync batch. */
export async function syncImap(input, cursor = null, env = process.env) {
  const config = validateMailConfig(input, env);
  const host = await resolveDestination(config.imap.host, env);
  const client = new ImapFlow({ host, port: config.imap.port, secure: config.imap.secure,
    ...(config.imap.secure ? {} : { doSTARTTLS: true }), servername: isIP(config.imap.host) ? undefined : config.imap.host,
    tls: tlsOptions(config.imap.host), auth: { user: config.imap.user, pass: config.imap.password },
    logger: false, logRaw: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  client.on('error', () => {});
  try {
    await client.connect();
    if (!client.secureConnection) throw new MailProtocolError('MAIL_TLS_FAILED', 'The mail server did not establish an encrypted connection.');
    return await reconcileImap(client, cursor, env);
  } catch (error) { throw safeProviderError(error, 'imap'); }
  finally { client.close(); }
}

/** Submit prebuilt MIME once. Acceptance is SMTP server acceptance, not receipt. */
export async function sendSmtp(input, { mime, envelope }, env = process.env) {
  const config = validateMailConfig(input, env);
  if (!(typeof mime === 'string' || mime instanceof Uint8Array) || !mime.length) throw configError('A complete MIME message is required.');
  if (!envelope || typeof envelope.from !== 'string' || !Array.isArray(envelope.to) || !envelope.to.length ||
      [envelope.from, ...envelope.to].some((address) => typeof address !== 'string' || !address || /[\r\n\0]/.test(address))) {
    throw configError('A sender and recipient envelope are required.');
  }
  const host = await resolveDestination(config.smtp.host, env);
  const transport = nodemailer.createTransport({
    host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: true,
    ignoreTLS: false,
    opportunisticTLS: false,
    tls: tlsOptions(config.smtp.host),
    auth: { user: config.smtp.user, pass: config.smtp.password },
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  try {
    const result = await transport.sendMail({ raw: typeof mime === 'string' ? mime : Buffer.from(mime), envelope });
    if (!Array.isArray(result.accepted) || result.accepted.length === 0) {
      throw new MailProtocolError('MAIL_RECIPIENTS_REJECTED', 'The mail server did not accept any recipients.', 422);
    }
    return {
      status: 'accepted',
      ...(result.messageId ? { providerId: String(result.messageId) } : {}),
      accepted: result.accepted.map(String),
      rejected: (result.rejected || []).map(String),
    };
  } catch (error) {
    throw safeProviderError(error, 'smtp');
  } finally {
    transport.close();
  }
}

function imapMessageLocation(providerId) {
  const old = /^imap:INBOX:(\d+):(\d+)$/.exec(providerId);
  const modern = /^imap:v2:([A-Za-z0-9_-]+):(\d+):(\d+)$/.exec(providerId);
  if (!old && !modern) throw new MailProtocolError('MAIL_MESSAGE_ID_INVALID', 'This IMAP message identifier is invalid.', 400);
  const mailbox = old ? 'INBOX' : Buffer.from(modern[1], 'base64url').toString('utf8');
  const validity = old ? old[1] : modern[2], uid = Number(old ? old[2] : modern[3]);
  if (!mailbox || mailbox.length > 1024 || [...mailbox].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || !Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff) {
    throw new MailProtocolError('MAIL_MESSAGE_ID_INVALID', 'This IMAP message identifier is invalid.', 400);
  }
  return { mailbox, validity, uid };
}

/** Mutate flags and move a single identified message. Never falls back to EXPUNGE. */
export async function updateImap(input, providerId, inputPatch, env = process.env) {
  const patch = validateMessagePatch(inputPatch);
  const location = imapMessageLocation(providerId);
  const config = validateMailConfig(input, env);
  const host = await resolveDestination(config.imap.host, env);
  const client = new ImapFlow({ host, port: config.imap.port, secure: config.imap.secure,
    ...(config.imap.secure ? {} : { doSTARTTLS: true }), servername: isIP(config.imap.host) ? undefined : config.imap.host,
    tls: tlsOptions(config.imap.host), auth: { user: config.imap.user, pass: config.imap.password },
    logger: false, logRaw: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  client.on('error', () => {});
  let lock, writeStarted = false;
  try {
    await client.connect();
    if (!client.secureConnection) throw new MailProtocolError('MAIL_TLS_FAILED', 'The mail server did not establish an encrypted connection.');
    let destination;
    if (patch.folder) {
      const special = { archive: '\\Archive', deleted: '\\Trash', junk: '\\Junk', drafts: '\\Drafts', sent: '\\Sent' };
      const mailboxes = await client.list();
      const explicitPath = isImapFolder(patch.folder) ? Buffer.from(patch.folder.slice(5),'base64url').toString('utf8') : null;
      const candidates = mailboxes.filter(box => !box.flags?.has('\\Noselect') && !box.flags?.has('\\NonExistent') &&
        (explicitPath ? box.path === explicitPath : patch.folder === 'inbox' ? box.path?.toUpperCase() === 'INBOX' : box.flags?.has(special[patch.folder])));
      // Do not guess localized names or accept ImapFlow's name heuristics for
      // a destructive-looking action. Require an unambiguous server flag.
      if (candidates.length !== 1) throw new MailProtocolError('MAIL_FOLDER_UNSUPPORTED', 'The IMAP server did not advertise one unambiguous destination for this folder.', 409);
      destination = candidates[0].path;
      if (destination !== location.mailbox && (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS'))) {
        throw new MailProtocolError('MAIL_MOVE_UNSUPPORTED', 'This IMAP server must support MOVE and UIDPLUS for safe synchronized moves.', 409);
      }
    }
    lock = await client.getMailboxLock(location.mailbox, { readOnly: false });
    if (String(client.mailbox.uidValidity) !== location.validity) throw new MailProtocolError('MAIL_MESSAGE_STALE', 'The IMAP mailbox identifier changed. Synchronize before updating this message.', 409);
    const current = await client.fetchOne(location.uid, { uid: true, flags: true }, { uid: true });
    if (!current || current.uid !== location.uid) throw new MailProtocolError('MAIL_MESSAGE_MISSING', 'The IMAP message is no longer in its original mailbox. Synchronize before updating it.', 404);
    const add = [], remove = [];
    for (const [key, flag] of [['read','\\Seen'],['flagged','\\Flagged']]) {
      if (patch[key] === undefined || current.flags?.has(flag) === patch[key]) continue;
      (patch[key] ? add : remove).push(flag);
    }
    if (add.length) {
      writeStarted = true;
      if (!await client.messageFlagsAdd([location.uid], add, { uid: true })) throw new Error('Unconfirmed STORE');
    }
    if (remove.length) {
      writeStarted = true;
      if (!await client.messageFlagsRemove([location.uid], remove, { uid: true })) throw new Error('Unconfirmed STORE');
    }
    let nextId = providerId;
    if (destination && destination !== location.mailbox) {
      writeStarted = true;
      const result = await client.messageMove([location.uid], destination, { uid: true });
      const nextUid = result?.uidMap?.get(location.uid), nextValidity = String(result?.uidValidity || '');
      if (!Number.isSafeInteger(nextUid) || nextUid < 1 || !/^\d+$/.test(nextValidity)) throw new Error('Unconfirmed MOVE destination');
      nextId = destination.toUpperCase() === 'INBOX' ? `imap:INBOX:${nextValidity}:${nextUid}` :
        `imap:v2:${Buffer.from(destination).toString('base64url')}:${nextValidity}:${nextUid}`;
    }
    return { status: 'applied', providerId: nextId, ...patch };
  } catch (error) {
    if (writeStarted) throw Object.assign(new MailProtocolError('MAIL_MUTATION_UNCONFIRMED', 'The IMAP server did not confirm the complete update. Synchronize before attempting another change.'), { unknown: true, uncertain: true, retryable: false });
    const safe = safeProviderError(error, 'imap'); safe.retryable = false; throw safe;
  } finally {
    lock?.release(); client.close();
  }
}
