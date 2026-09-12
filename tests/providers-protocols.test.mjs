import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { validateMailConfig, syncImap, sendSmtp, updateImap } from '../backend/providers/mail-protocols.js';

function config(overrides = {}) {
  return {
    email: 'me@example.com', displayName: 'My Name',
    smtp: { host: '8.8.8.8', password: 'smtp-secret', ...overrides.smtp },
    imap: { host: '8.8.8.8', password: 'imap-secret', ...overrides.imap },
  };
}
const submission = {
  envelope: { from: 'me@example.com', to: ['recipient@example.com'] },
  mime: 'From: me@example.com\r\nTo: recipient@example.com\r\nSubject: Test\r\n\r\nHello.',
};

test('normalizes safe account configuration and discards transport overrides', () => {
  const result = validateMailConfig(config({ smtp: { host: 'SMTP.Example.com.', tls: { rejectUnauthorized: false }, proxy: 'http://localhost' } }), {});
  assert.equal(result.smtp.host, 'smtp.example.com');
  assert.equal(result.smtp.port, 465);
  assert.equal(result.smtp.secure, true);
  assert.equal(result.smtp.user, 'me@example.com');
  assert.equal(result.imap.port, 993);
  assert.equal(result.imap.secure, true);
  assert.equal(result.smtp.tls, undefined);
  assert.equal(result.smtp.proxy, undefined);
  assert.equal(validateMailConfig({ ...config(), email: ' ME@Example.com ' }, {}).email, 'me@example.com');
  const explicit = validateMailConfig(config({ smtp: { port: 587 }, imap: { port: 143 } }), {});
  assert.equal(explicit.smtp.secure, false);
  assert.equal(explicit.imap.secure, false);
});

test('blocks private, internal, mapped, and reserved hosts by default', () => {
  for (const host of ['127.0.0.1', '10.0.0.4', '172.16.1.2', '192.168.2.2', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', '[fe80::1]', 'fc00::1', '2002:7f00:1::', 'localhost', 'smtp.local', 'metadata.google.internal', 'smtp.home.arpa']) {
    assert.throws(() => validateMailConfig(config({ smtp: { host } }), {}), { code: 'MAIL_HOST_BLOCKED' }, host);
  }
  assert.equal(validateMailConfig(config({ smtp: { host: 'localhost' } }), { ALLOW_PRIVATE_MAIL_HOSTS: 'true' }).smtp.host, 'localhost');
  assert.throws(() => validateMailConfig(config({ smtp: { host: 'localhost' } }), { ALLOW_PRIVATE_MAIL_HOSTS: true }), { code: 'MAIL_HOST_BLOCKED' });
});

test('rejects malformed hosts, header injection, and insecure implicit TLS settings', () => {
  for (const host of ['https://mail.example.com', 'mail.example.com:25', 'a/b', 'a@b.com', '-bad.example.com', 'x%00.example.com']) {
    assert.throws(() => validateMailConfig(config({ smtp: { host } }), {}), { code: 'MAIL_CONFIG_INVALID' });
  }
  assert.throws(() => validateMailConfig({ ...config(), email: 'me@example.com\r\nBcc: x@example.com' }, {}), { code: 'MAIL_CONFIG_INVALID' });
  assert.throws(() => validateMailConfig(config({ smtp: { secure: false } }), {}), { code: 'MAIL_CONFIG_INVALID' });
  assert.throws(() => validateMailConfig(config({ imap: { port: 0 } }), {}), { code: 'MAIL_CONFIG_INVALID' });
  assert.throws(() => validateMailConfig(config({ imap: { password: '' } }), {}), { code: 'MAIL_CONFIG_INVALID' });
});

test('blocks private destinations returned by the resolver', async () => {
  // This legacy numeric hostname is normalized by the OS resolver to loopback.
  // It is not accepted as an IP literal by net.isIP, so it exercises DNS checks.
  await assert.rejects(sendSmtp(config({ smtp: { host: '127.1' } }), submission, {}), { code: 'MAIL_HOST_BLOCKED' });
});

test('pins resolved SMTP IP while retaining certificate hostname and required TLS', async (t) => {
  let options;
  let sent;
  let closed = false;
  t.mock.method(nodemailer, 'createTransport', (value) => {
    options = value;
    return {
      async sendMail(value) { sent = value; return { accepted: ['recipient@example.com'], rejected: ['bad@example.com'], messageId: '<id@example.com>' }; },
      close() { closed = true; },
    };
  });
  const result = await sendSmtp(config({ smtp: { host: 'localhost', port: 587 } }), submission, { ALLOW_PRIVATE_MAIL_HOSTS: 'true' });
  assert.match(options.host, /^(127\.0\.0\.1|::1)$/);
  assert.equal(options.tls.servername, 'localhost');
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.requireTLS, true);
  assert.equal(options.opportunisticTLS, false);
  assert.equal(options.disableUrlAccess, true);
  assert.equal(options.disableFileAccess, true);
  assert.deepEqual(sent.envelope, submission.envelope);
  assert.equal(sent.raw, submission.mime);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.rejected, ['bad@example.com']);
  assert.equal(closed, true);
});

test('redacts SMTP provider errors and reports ambiguous acceptance', async (t) => {
  t.mock.method(nodemailer, 'createTransport', () => ({
    async sendMail() { throw Object.assign(new Error('password smtp-secret leaked by provider'), { code: 'ESOCKET' }); },
    close() {},
  }));
  await assert.rejects(sendSmtp(config(), submission, {}), (error) => {
    assert.equal(error.code, 'MAIL_SEND_UNCONFIRMED');
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /secret|leaked/);
    return true;
  });
});

function imapFixture(t, { uidValidity = 77n, uids = [1, 2, 3], source, size } = {}) {
  const calls = { sources: [] };
  t.mock.method(ImapFlow.prototype, 'connect', async function () {
    calls.options = this.options;
    this.secureConnection = true;
    this.mailbox = { exists: uids.length, uidValidity };
  });
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async (mailbox, options) => {
    calls.mailbox = mailbox; calls.lockOptions = options;
    return { release() { calls.released = true; } };
  });
  t.mock.method(ImapFlow.prototype, 'search', async (query) => { calls.query = query; return uids; });
  t.mock.method(ImapFlow.prototype, 'fetchOne', async (uid, query, options) => {
    calls.sources.push({ uid, query, options });
    return { uid, size: size ?? source?.length ?? 100, source: source || Buffer.from(`From: Sender <sender@example.com>\r\nTo: me@example.com\r\nSubject: Message ${uid}\r\n\r\nHello ${uid}`), flags: new Set(['\\Seen']), internalDate: new Date('2026-09-01T12:00:00Z') };
  });
  t.mock.method(ImapFlow.prototype, 'close', () => { calls.closed = true; });
  return calls;
}

function imapMutationFixture(t, { capabilities = ['MOVE','UIDPLUS'], validity = 77n, destination, moveResult, flags = ['\\Seen','\\Answered'] } = {}) {
  const calls = { writes: [] };
  t.mock.method(ImapFlow.prototype, 'connect', async function () {
    calls.options = this.options;
    this.secureConnection = true;
    this.capabilities = new Map(capabilities.map(name => [name,true]));
    this.mailbox = { uidValidity: validity };
  });
  t.mock.method(ImapFlow.prototype, 'list', async () => destination || [{ path:'INBOX', flags:new Set() },{ path:'Deleted Messages',flags:new Set(['\\Trash']) }]);
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async (path,options) => {
    calls.path = path; calls.lockOptions = options; return {release(){ calls.released = true; }};
  });
  t.mock.method(ImapFlow.prototype, 'fetchOne', async uid => ({uid,flags:new Set(flags)}));
  t.mock.method(ImapFlow.prototype, 'messageFlagsAdd', async (...args) => { calls.writes.push(['add',...args]); return true; });
  t.mock.method(ImapFlow.prototype, 'messageFlagsRemove', async (...args) => { calls.writes.push(['remove',...args]); return true; });
  t.mock.method(ImapFlow.prototype, 'messageMove', async (...args) => {
    calls.writes.push(['move',...args]);
    if (moveResult instanceof Error) throw moveResult;
    return moveResult || {uidValidity:88n,uidMap:new Map([[5,9]])};
  });
  t.mock.method(ImapFlow.prototype, 'messageDelete', async () => { assert.fail('Permanent delete/expunge must never be used'); });
  t.mock.method(ImapFlow.prototype, 'close', () => {calls.closed = true;});
  return calls;
}

test('IMAP writeback changes only requested flags and keeps UID scoping', async t => {
  const calls = imapMutationFixture(t);
  const result = await updateImap(config(),'imap:INBOX:77:5',{read:false,flagged:true},{});
  assert.equal(result.status,'applied');
  assert.equal(result.providerId,'imap:INBOX:77:5');
  assert.deepEqual(calls.writes,[['add',[5],['\\Flagged'],{uid:true}],['remove',[5],['\\Seen'],{uid:true}]]);
  assert.deepEqual(calls.lockOptions,{readOnly:false});
  assert.equal(calls.closed,true);
});

test('IMAP MOVE uses an advertised special-use mailbox and returns UIDPLUS identity', async t => {
  const calls = imapMutationFixture(t);
  const result = await updateImap(config(),'imap:INBOX:77:5',{folder:'deleted'},{});
  assert.equal(result.providerId,`imap:v2:${Buffer.from('Deleted Messages').toString('base64url')}:88:9`);
  assert.deepEqual(calls.writes,[['move',[5],'Deleted Messages',{uid:true}]]);
  assert.equal(result.folder,'deleted');
});

test('IMAP subsequent updates understand encoded destination mailbox identifiers', async t => {
  const calls = imapMutationFixture(t,{validity:88n,flags:[]});
  const id=`imap:v2:${Buffer.from('Deleted Messages').toString('base64url')}:88:9`;
  await updateImap(config(),id,{read:true},{});
  assert.equal(calls.path,'Deleted Messages');
  assert.deepEqual(calls.writes,[['add',[9],['\\Seen'],{uid:true}]]);
});

test('IMAP refuses MOVE fallback and folder guesses before changing flags', async t => {
  const calls = imapMutationFixture(t,{capabilities:['UIDPLUS']});
  await assert.rejects(updateImap(config(),'imap:INBOX:77:5',{read:false,folder:'deleted'},{}),{code:'MAIL_MOVE_UNSUPPORTED',retryable:false});
  assert.deepEqual(calls.writes,[]);
});

test('IMAP refuses unadvertised Trash heuristics and stale UIDVALIDITY', async t => {
  const calls = imapMutationFixture(t,{destination:[{path:'Trash',specialUse:'\\Trash',specialUseSource:'name',flags:new Set()}]});
  await assert.rejects(updateImap(config(),'imap:INBOX:77:5',{folder:'deleted'},{}),{code:'MAIL_FOLDER_UNSUPPORTED'});
  await assert.rejects(updateImap(config(),'imap:INBOX:76:5',{read:false},{}),{code:'MAIL_MESSAGE_STALE'});
  assert.deepEqual(calls.writes,[]);
});

test('IMAP does not retry an ambiguous MOVE or claim its target UID', async t => {
  const calls = imapMutationFixture(t,{moveResult:{destination:'Deleted Messages'}});
  await assert.rejects(updateImap(config(),'imap:INBOX:77:5',{folder:'deleted'},{}),{code:'MAIL_MUTATION_UNCONFIRMED',unknown:true,uncertain:true,retryable:false});
  assert.equal(calls.writes.length,1);
});

test('IMAP batches advance only imported UIDs and require read-only encrypted connection', async (t) => {
  const calls = imapFixture(t, { uids: [9, 1, 7, 2, 2] });
  const result = await syncImap(config({ imap: { port: 143 } }), { uidValidity: '77', lastUid: 1 }, { PROVIDER_SYNC_LIMIT: '2' });
  assert.deepEqual(result.cursor, { uidValidity: '77', lastUid: 7 });
  assert.deepEqual(result.messages.map((message) => message.providerId), ['imap:INBOX:77:2', 'imap:INBOX:77:7']);
  assert.equal(calls.query.uid, '2:*');
  assert.equal(calls.options.doSTARTTLS, true);
  assert.equal(calls.options.tls.rejectUnauthorized, true);
  assert.deepEqual(calls.lockOptions, { readOnly: true });
  assert.equal(calls.sources.length, 2);
  assert.equal(calls.closed, true);
  assert.equal(calls.released, true);
  assert.equal(result.messages[0].read, true);
  assert.equal(result.messages[0].from, 'sender@example.com');
});

test('IMAP UIDVALIDITY changes reset incremental position', async (t) => {
  const calls = imapFixture(t, { uidValidity: 88n, uids: [1] });
  const result = await syncImap(config(), { uidValidity: '77', lastUid: 900 }, {});
  assert.equal(calls.query.uid, '1:*');
  assert.deepEqual(result.cursor, { uidValidity: '88', lastUid: 1 });
});

test('IMAP n:* fallback never duplicates already imported messages', async (t) => {
  imapFixture(t, { uids: [9] });
  const result = await syncImap(config(), { uidValidity: '77', lastUid: 9 }, {});
  assert.deepEqual(result.messages, []);
  assert.equal(result.cursor.lastUid, 9);
});

test('IMAP parses MIME attachment bytes and plain text safely', async (t) => {
  const source = Buffer.from('From: Sender <sender@example.com>\r\nTo: me@example.com\r\nCc: cc@example.com\r\nSubject: Attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="note.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x--\r\n');
  imapFixture(t, { uids: [1], source });
  const { messages: [message] } = await syncImap(config(), null, {});
  assert.match(message.body, /Hello there/);
  assert.doesNotMatch(message.body, /<p>|<b>/);
  assert.equal(message.cc, 'cc@example.com');
  assert.equal(message.attachments[0].name, 'note.txt');
  assert.ok(message.attachments[0].bytes instanceof Uint8Array);
  assert.equal(Buffer.from(message.attachments[0].bytes).toString(), 'hello');
});

test('IMAP bounds source downloads and does not skip oversized content', async (t) => {
  const calls = imapFixture(t, { uids: [1], size: 1000 });
  await assert.rejects(syncImap(config(), null, { PROVIDER_MESSAGE_MAX_BYTES: '10' }), { code: 'MAIL_MESSAGE_TOO_LARGE', status: 413 });
  assert.deepEqual(calls.sources[0].query.source, { start: 0, maxLength: 11 });
  assert.equal(calls.closed, true);
});

async function plaintextServer(t, protocol) {
  const commands = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write(protocol === 'smtp' ? '220 fake.example ESMTP\r\n' : '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] fake.example ready\r\n');
    let input = '';
    socket.on('data', (data) => {
      input += data.toString();
      while (input.includes('\r\n')) {
        const index = input.indexOf('\r\n');
        const line = input.slice(0, index);
        input = input.slice(index + 2);
        commands.push(line);
        if (protocol === 'smtp') {
          if (/^EHLO/i.test(line)) socket.write('250-fake.example\r\n250 AUTH PLAIN LOGIN\r\n');
          else socket.write('454 TLS unavailable\r\n');
        } else {
          const [tag] = line.split(' ');
          if (/ CAPABILITY/i.test(line)) socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK complete\r\n`);
          else socket.write(`${tag} BAD unsupported\r\n`);
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, commands };
}

test('real SMTP client refuses downgrade before transmitting credentials or message', { timeout: 10000 }, async (t) => {
  const fixture = await plaintextServer(t, 'smtp');
  await assert.rejects(sendSmtp(config({ smtp: { host: '127.0.0.1', port: fixture.port, secure: false } }), submission, { ALLOW_PRIVATE_MAIL_HOSTS: 'true' }));
  assert.ok(fixture.commands.some((line) => /^EHLO/.test(line)));
  assert.ok(fixture.commands.some((line) => /^STARTTLS/.test(line)));
  assert.ok(fixture.commands.every((line) => !/^(AUTH|MAIL|RCPT|DATA)/.test(line)));
  assert.ok(fixture.commands.every((line) => !line.includes('smtp-secret')));
});

test('real IMAP client refuses downgrade before transmitting credentials', { timeout: 10000 }, async (t) => {
  const fixture = await plaintextServer(t, 'imap');
  await assert.rejects(syncImap(config({ imap: { host: '127.0.0.1', port: fixture.port, secure: false } }), null, { ALLOW_PRIVATE_MAIL_HOSTS: 'true' }), { code: 'MAIL_TLS_FAILED' });
  assert.ok(fixture.commands.every((line) => !/\b(LOGIN|AUTHENTICATE)\b/.test(line)));
  assert.ok(fixture.commands.every((line) => !line.includes('imap-secret')));
});
