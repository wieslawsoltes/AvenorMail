import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { checkServerIdentity } from 'node:tls';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { validateMessagePatch } from './mutations.js';

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

function normalizedMessage(parsed, source, uidValidity) {
  const from = addressList(parsed.from)[0];
  const date = [parsed.date, source.internalDate].find((value) => value && Number.isFinite(new Date(value).getTime()));
  return {
    providerId: `imap:INBOX:${uidValidity}:${source.uid}`,
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
    folder: 'inbox',
    read: source.flags?.has('\\Seen') || false,
    flagged: source.flags?.has('\\Flagged') || false,
    attachments: (parsed.attachments || []).map((attachment, index) => ({
      name: attachment.filename || `attachment-${index + 1}`,
      type: attachment.contentType || 'application/octet-stream',
      bytes: new Uint8Array(attachment.content),
    })),
  };
}

/** Import new INBOX messages in ascending UID order without skipping batch overflow. */
export async function syncImap(input, cursor = null, env = process.env) {
  const config = validateMailConfig(input, env);
  const host = await resolveDestination(config.imap.host, env);
  const client = new ImapFlow({
    host,
    port: config.imap.port,
    secure: config.imap.secure,
    ...(config.imap.secure ? {} : { doSTARTTLS: true }),
    servername: isIP(config.imap.host) ? undefined : config.imap.host,
    tls: tlsOptions(config.imap.host),
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
    logRaw: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  // ImapFlow also emits connection failures; consume these so they do not
  // become unhandled process errors. Awaited commands still reject safely.
  client.on('error', () => {});
  let lock;
  try {
    await client.connect();
    if (!client.secureConnection) throw new MailProtocolError('MAIL_TLS_FAILED', 'The mail server did not establish an encrypted connection.');
    lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const uidValidity = String(client.mailbox.uidValidity);
    if (!/^\d+$/.test(uidValidity)) throw new MailProtocolError('MAIL_SYNC_FAILED', 'The mail server did not provide a stable mailbox identifier.');
    const previousUid = cursor && String(cursor.uidValidity) === uidValidity && Number.isSafeInteger(cursor.lastUid) && cursor.lastUid >= 0 ? cursor.lastUid : 0;
    let lastUid = previousUid;
    const messages = [];
    const limit = envLimit(env.PROVIDER_SYNC_LIMIT, 100, 500);
    const maxBytes = envLimit(env.PROVIDER_MESSAGE_MAX_BYTES, 25 * 1024 * 1024, 100 * 1024 * 1024);
    const batchMaxBytes = envLimit(env.PROVIDER_SYNC_MAX_BYTES, 50 * 1024 * 1024, 200 * 1024 * 1024);
    let batchBytes = 0;
    if (client.mailbox.exists && previousUid < 0xffffffff) {
      const matches = await client.search({ uid: `${previousUid + 1}:*` }, { uid: true });
      // IMAP's n:* range may also return the last message when n exceeds its
      // UID. Filter explicitly before selecting the next bounded batch.
      const uids = [...new Set(Array.isArray(matches) ? matches : [])]
        .filter((uid) => Number.isSafeInteger(uid) && uid > previousUid)
        .sort((a, b) => a - b).slice(0, limit);
      for (const uid of uids) {
        const source = await client.fetchOne(uid, {
          uid: true,
          flags: true,
          internalDate: true,
          size: true,
          source: { start: 0, maxLength: maxBytes + 1 },
        }, { uid: true });
        if (!source) { lastUid = uid; continue; } // Expunged after the search.
        if (!source.source || source.uid !== uid) throw new MailProtocolError('MAIL_SYNC_FAILED', 'A mail message could not be retrieved.');
        if (source.size > maxBytes || source.source.length > maxBytes) {
          // Return earlier completed messages first. Never silently skip the
          // oversized message or advance the cursor past unimported content.
          if (messages.length) break;
          throw new MailProtocolError('MAIL_MESSAGE_TOO_LARGE', 'A message exceeds the configured import size limit.', 413);
        }
        if (messages.length && batchBytes + source.source.length > batchMaxBytes) break;
        const parsed = await parseMailSource(source.source, maxBytes);
        messages.push(normalizedMessage(parsed, source, uidValidity));
        batchBytes += source.source.length;
        lastUid = uid;
      }
    }
    return { messages, cursor: { uidValidity, lastUid } };
  } catch (error) {
    throw safeProviderError(error, 'imap');
  } finally {
    lock?.release();
    // This is a short-lived read-only connection; close avoids an additional
    // unbounded LOGOUT wait after a failed command or successful import.
    client.close();
  }
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
      const candidates = mailboxes.filter(box => !box.flags?.has('\\Noselect') && !box.flags?.has('\\NonExistent') &&
        (patch.folder === 'inbox' ? box.path?.toUpperCase() === 'INBOX' : box.flags?.has(special[patch.folder])));
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
