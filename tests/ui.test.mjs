import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { JSDOM, VirtualConsole } from 'jsdom';
import { WebSocket } from 'ws';
import { createApplication } from '../backend/server.js';
import { openDatabase } from '../backend/storage.js';
import { collaborationDocumentHTML } from '../backend/realtime.js';

// Bundle the production entry point, including its real runtime, IndexedDB store,
// seed data and editor imports. Only browser platform gaps are supplied below.
const root = fileURLToPath(new URL('../', import.meta.url));
const [appBuild, shell] = await Promise.all([
  build({ absWorkingDir: root, entryPoints: ['public/app.js'], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' }),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8')
]);
const appScript = appBuild.outputFiles[0].text;

async function openApp(t, { indexedDB = new IDBFactory(), preferences, hash = '', connected } = {}) {
  const errors = [], networkRequests = [], responses = [], sockets = [];
  const transactions = new Set();
  const fetches = new Set();
  let opening = 0;
  // Observe transaction lifetime so teardown waits for real storage callbacks
  // and their UI continuations before destroying the document.
  const browserIndexedDB = new Proxy(indexedDB, { get(target, property) {
    if (property !== 'open') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return (...args) => {
      opening++;
      const request = target.open(...args);
      request.addEventListener('error', () => opening--, { once: true });
      request.addEventListener('success', () => {
        opening--;
        const db = request.result, transaction = db.transaction.bind(db);
        db.transaction = (...transactionArgs) => {
          const tx = transaction(...transactionArgs);
          transactions.add(tx);
          tx.addEventListener('complete', () => transactions.delete(tx), { once: true });
          tx.addEventListener('abort', () => transactions.delete(tx), { once: true });
          return tx;
        };
      }, { once: true });
      return request;
    };
  } });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  virtualConsole.on('error', (...values) => errors.push(new Error(values.join(' '))));
  const dom = new JSDOM(shell, { url: 'https://avenor.test/' + hash, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom, { document } = window;
  Object.defineProperties(window, {
    crypto: { configurable: true, value: webcrypto },
    indexedDB: { configurable: true, value: browserIndexedDB },
    IDBKeyRange: { configurable: true, value: IDBKeyRange },
    structuredClone: { configurable: true, value: structuredClone },
    TextEncoder: { configurable: true, value: TextEncoder },
    TextDecoder: { configurable: true, value: TextDecoder },
    Response: { configurable: true, value: Response },
    Request: { configurable: true, value: Request },
    Headers: { configurable: true, value: Headers },
    innerWidth: { configurable: true, value: 1280 },
    ResizeObserver: { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } }
  });
  window.fetch = async (...args) => {
    networkRequests.push(args[0]);
    if (!connected) throw new Error('Device-local UI unexpectedly requested the network: ' + args[0]);
    const promise = (async () => {
      const response = await fetch(args[0], { ...args[1], headers: { ...args[1]?.headers, Origin: window.location.origin } });
      responses.push({ url: args[0], status: response.status });
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    })();
    fetches.add(promise);
    try { return await promise; } finally { fetches.delete(promise); }
  };
  if (connected) {
    window.localStorage.setItem('avenor-server', JSON.stringify({ url: connected.serverUrl }));
    window.sessionStorage.setItem('avenor-session', JSON.stringify({ ...connected.session, server: connected.serverUrl }));
    window.WebSocket = class extends WebSocket {
      constructor(url) { super(url, { origin: window.location.origin }); sockets.push(this); }
    };
    window.Range.prototype.getClientRects = () => [];
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  }
  // jsdom has no drawing surface. The calendar fallback still runs its actual
  // initialization/draw/teardown against this minimal Canvas 2D surface.
  window.HTMLCanvasElement.prototype.getContext = function (type) {
    return type === '2d' ? {
      scale() {}, setTransform() {}, clearRect() {}, fillRect() {},
      save() {}, restore() {}, beginPath() {}, rect() {}, roundRect() {}, clip() {}, fill() {},
      drawImage() {}, fillText() {}
    } : null;
  };
  window.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(event.reason));
  if (preferences) window.localStorage.setItem('avenor-preferences', JSON.stringify(preferences));

  let closed = false;
  const close = async () => {
    if (closed) return;
    const deadline = Date.now() + 5000;
    let settled = 0;
    while (settled < 3) {
      await new Promise(resolve => setImmediate(resolve));
      settled = !opening && !transactions.size && !fetches.size ? settled + 1 : 0;
      if (Date.now() >= deadline) assert.fail('App did not finish IndexedDB work before teardown');
    }
    closed = true;
    await Promise.all(sockets.filter(socket => socket.readyState !== WebSocket.CLOSED).map(socket => new Promise(resolve => {
      socket.once('close', resolve);
      socket.terminate();
    })));
    window.close();
  };
  t.after(async () => {
    await close();
    assert.deepEqual(errors.map(error => error?.stack || String(error)), [], 'No browser runtime errors');
    if (!connected) assert.deepEqual(networkRequests, [], 'Local workflows stay on the device');
    else assert.deepEqual(responses.filter(response => response.status >= 400), [], 'Connected UI requests succeed without metadata conflicts');
  });
  const until = async (predicate, description) => {
    const deadline = Date.now() + 5000;
    while (true) {
      assert.deepEqual(errors.map(error => error?.stack || String(error)), [], 'Browser runtime errors');
      const result = await predicate();
      if (result) return result;
      if (Date.now() >= deadline) assert.fail(description + '\nVisible error/status: ' + document.querySelector('#toast')?.textContent + ' ' + document.querySelector('#compose-error')?.textContent + '\nWorkspace: ' + document.querySelector('#app')?.textContent.slice(0, 1000));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const find = selector => {
    const element = document.querySelector(selector);
    assert.ok(element, 'Expected UI control: ' + selector);
    return element;
  };
  const click = selector => {
    const element = find(selector);
    assert.notEqual(element.disabled, true, 'UI control is enabled: ' + selector);
    element.click();
  };
  const action = value => click('[data-action="' + value + '"]');
  const input = (selector, value) => {
    const element = find(selector);
    if (element.hasAttribute('contenteditable')) element.innerHTML = value;
    else element.value = value;
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const submit = selector => find(selector).requestSubmit();
  const snapshot = async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('avenor-v1:device-local', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('snapshots').objectStore('snapshots').get('local-state');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  };
  window.eval(appScript);
  await until(() => document.querySelector('.app-shell'), 'Production app finishes startup');
  return { window, document, indexedDB, close, until, find, click, action, input, submit, snapshot, responses, sockets };
}

test('full local app starts and self-send reaches Sent and Inbox with the entered rich body', async t => {
  const app = await openApp(t);
  const { document, action, input, until, snapshot } = app;
  assert.equal(document.title, 'Avenor Mail');
  assert.equal(document.querySelector('#workspace h1').textContent, 'Inbox');
  assert.match(document.querySelector('#sync-label').textContent, /On this device/);
  assert.ok(document.querySelectorAll('.message-row').length > 0, 'Actual sample mailbox rendered');
  const initial = await snapshot();
  assert.ok(initial.user.email, 'Read recipient identity from the actual local store');

  action('new');
  await until(() => document.querySelector('#compose-editor'), 'Composer opens');
  action('send');
  await until(() => document.querySelector('#compose-error')?.textContent.includes('Add a recipient'), 'Missing recipient is reported inside the composer');
  assert.ok(document.querySelector('.compose'), 'Validation keeps the composer open');
  input('#compose-to', initial.user.email);
  input('#compose-subject', 'UI smoke self delivery');
  input('#compose-editor', '<p>Hello <strong>from the UI</strong>.</p><p>Second paragraph.</p>');
  action('send');
  await until(() => !document.querySelector('.compose') && document.querySelector('#workspace h1')?.textContent === 'Sent', 'Successful send closes the composer and opens Sent');
  assert.equal(document.querySelector('#reader h2').textContent, 'UI smoke self delivery');
  assert.equal(document.querySelector('#reader .body-copy strong').textContent, 'from the UI');
  assert.match(document.querySelector('#toast').textContent, /Saved to your device mailbox/);

  const sentState = await snapshot();
  const messages = sentState.records.filter(row => row.subject === 'UI smoke self delivery');
  assert.deepEqual(messages.map(row => row.folder).sort(), ['inbox', 'sent']);
  assert.ok(messages.every(row => row.body === '<p>Hello <strong>from the UI</strong>.</p><p>Second paragraph.</p>'));
  assert.equal(messages.find(row => row.folder === 'sent').delivery, 'device-local');
  const inbox = messages.find(row => row.folder === 'inbox');
  assert.equal(inbox.read, false);
  action('folder:inbox');
  await until(() => document.querySelector('[data-action="open:' + inbox.id + '"]'), 'Self-delivered message appears in Inbox');
  action('open:' + inbox.id);
  await until(async () => (await snapshot()).records.find(row => row.id === inbox.id).read, 'Opening the delivered message persists its read state');
  assert.equal(document.querySelector('#reader h2').textContent, 'UI smoke self delivery');
});

test('draft close, page reload, reopen and edit preserve rich text without creating duplicates', async t => {
  let app = await openApp(t);
  const initial = await app.snapshot();
  app.action('new');
  await app.until(() => app.document.querySelector('#compose-editor'), 'Composer opens');
  app.input('#compose-to', initial.user.email);
  app.input('#compose-subject', 'A draft to revisit');
  app.input('#compose-editor', '<p>Original <em>draft</em> text.</p>');
  app.action('close-modal');
  await app.until(() => !app.document.querySelector('.compose'), 'Save and close waits for the draft write');
  const draft = (await app.snapshot()).records.find(row => row.subject === 'A draft to revisit');
  assert.equal(draft.folder, 'drafts');
  assert.equal(draft.body, '<p>Original <em>draft</em> text.</p>');

  const indexedDB = app.indexedDB;
  await app.close();
  app = await openApp(t, { indexedDB });
  app.action('folder:drafts');
  await app.until(() => app.document.querySelector('[data-action="open:' + draft.id + '"]'), 'Saved draft survives a fresh app instance');
  app.action('open:' + draft.id);
  await app.until(() => app.document.querySelector('#compose-editor'), 'Draft reopens in the composer');
  assert.equal(app.find('#compose-to').value, initial.user.email);
  assert.equal(app.find('#compose-subject').value, draft.subject);
  assert.equal(app.find('#compose-editor').innerHTML, draft.body);
  app.input('#compose-subject', 'Updated after reopening');
  app.input('#compose-editor', '<p>Edited <strong>after reopening</strong>.</p><ul><li>Still rich text</li></ul>');
  await app.until(() => app.document.querySelector('#draft-status')?.textContent === 'Draft saved', 'Autosave acknowledges the reopened draft');
  // The status can initially be the previous saved status; persistence is the
  // authoritative signal that this specific edit, rather than the old one, saved.
  await app.until(async () => (await app.snapshot()).records.find(row => row.id === draft.id)?.subject === 'Updated after reopening', 'Autosave persists the new content');
  app.action('close-modal');
  await app.until(() => !app.document.querySelector('.compose'), 'Edited draft closes');
  const state = await app.snapshot();
  const updated = state.records.find(row => row.id === draft.id);
  assert.equal(state.records.filter(row => row.kind === 'message' && !row.sample && row.folder === 'drafts').length, 1);
  assert.ok(updated.version > draft.version);
  assert.equal(updated.body, '<p>Edited <strong>after reopening</strong>.</p><ul><li>Still rich text</li></ul>');
  app.action('open:' + draft.id);
  await app.until(() => app.document.querySelector('#compose-editor'), 'Edited draft reopens again');
  assert.equal(app.find('#compose-subject').value, updated.subject);
  assert.equal(app.find('#compose-editor').innerHTML, updated.body);
  app.action('close-modal');
  await app.until(() => !app.document.querySelector('.compose'), 'Final composer closes cleanly');
});

test('Settings, calendar and task navigation support real preference changes and form submissions', async t => {
  const app = await openApp(t);
  const { document, window, action, input, find, submit, until, snapshot } = app;
  action('view:settings');
  await until(() => document.querySelector('#workspace h1')?.textContent === 'Settings', 'Settings navigation completes');
  const theme = find('[data-pref="theme"]');
  theme.value = 'dark';
  theme.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(document.documentElement.classList.contains('dark'));
  assert.equal(JSON.parse(window.localStorage.getItem('avenor-preferences')).theme, 'dark');
  action('settings-tab:connections');
  await until(() => document.querySelector('[data-action="server-connect"]'), 'Local connection settings render');
  assert.match(document.querySelector('#workspace').textContent, /Connect a server/);

  action('view:calendar');
  await until(() => document.querySelector('.calendar-month'), 'Calendar month renders');
  assert.equal(document.querySelectorAll('.calendar-cell').length, 42);
  action('calendar-view:week');
  await until(() => document.querySelector('#calendar-canvas'), 'Calendar week and Canvas fallback render');
  action('calendar-view:month');
  action('new');
  await until(() => document.querySelector('#record-form[data-kind="event"]'), 'New event dialog opens');
  input('#record-form [name="title"]', 'UI smoke calendar meeting');
  submit('#record-form');
  await until(() => !document.querySelector('#record-form'), 'Event form saves and closes');
  const event = (await snapshot()).records.find(row => row.title === 'UI smoke calendar meeting');
  assert.equal(event.kind, 'event');
  assert.ok(new Date(event.end) > new Date(event.start));
  assert.ok(document.querySelector('[data-action="edit-event:' + event.id + '"]'), 'Created event is visible on the calendar');

  action('view:tasks');
  await until(() => document.querySelector('#quick-task'), 'To Do navigation completes');
  assert.equal(document.querySelector('#workspace h1').textContent, 'To Do');
  input('#quick-task [name="title"]', 'Complete the UI smoke task');
  submit('#quick-task');
  const task = await until(async () => (await snapshot()).records.find(row => row.title === 'Complete the UI smoke task'), 'Quick task form persists the task');
  await until(() => document.querySelector('[data-action="task-toggle:' + task.id + '"]'), 'Created task appears in My Day');
  action('task-toggle:' + task.id);
  await until(async () => (await snapshot()).records.find(row => row.id === task.id).done, 'Task completion control persists completion');
  action('task-filter:complete');
  await until(() => document.querySelector('#workspace').textContent.includes('Complete the UI smoke task'), 'Completed task is available in the Completed view');
  action('view:mail');
  await until(() => document.querySelector('#mail-list'), 'Mail navigation remains functional after settings and calendar/task edits');
});

test('connected app binds a saved draft to the live rich editor and sends the durable collaborative body', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'avenor-ui-test-'));
  const db = openDatabase(':memory:');
  const backend = await createApplication({ db, env: {
    PUBLIC_URL: 'http://127.0.0.1', FRONTEND_URL: 'https://avenor.test/',
    DATA_DIR: directory, DATA_KEY: Buffer.alloc(32, 9).toString('base64'),
    ADMIN_EMAIL: 'ui@example.com', ADMIN_NAME: 'UI Test', ADMIN_PASSWORD: 'Avenor UI integration password 2026!',
    SEED_SAMPLE_DATA: 'false', OIDC_ISSUER: ''
  } });
  let browser;
  t.after(async () => {
    await browser?.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const serverUrl = 'http://127.0.0.1:' + backend.server.address().port;
  const request = async (path, body, token) => {
    const response = await fetch(serverUrl + '/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://avenor.test', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  };
  const session = await request('auth/login', { email: 'ui@example.com', password: 'Avenor UI integration password 2026!' });
  const draft = await request('record', { kind: 'message', data: {
    folder: 'drafts', from: session.user.email, to: session.user.email, subject: 'Connected draft body',
    body: '<p>Saved before opening.</p>', date: new Date().toISOString(), attachments: [], focused: true, read: true
  } }, session.token);
  browser = await openApp(t, { connected: { serverUrl, session } });
  const { document, action, input, until, find } = browser;
  await until(() => document.querySelector('#sync-label')?.textContent.includes('Live'), 'Authenticated WebSocket starts from the full app');
  assert.equal(browser.sockets.length, 1, 'Workspace uses a single live connection');
  action('folder:drafts');
  action('open:' + draft.id);
  await until(() => document.querySelector('#compose-editor .ProseMirror'), 'Saved draft mounts the real ProseMirror editor');
  await until(() => collaborationDocumentHTML(db, draft.id)?.includes('Saved before opening.'), 'Draft initialization is durable on the backend');
  const richEditor = find('#compose-editor .ProseMirror');
  assert.equal(richEditor.textContent, 'Saved before opening.');
  richEditor.innerHTML = '<p>Sent with <strong>collaborative formatting</strong>.</p>';
  richEditor.dispatchEvent(new browser.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'collaborative formatting' }));
  input('#compose-subject', 'Connected draft updated in the UI');
  await until(() => collaborationDocumentHTML(db, draft.id) === '<p>Sent with <strong>collaborative formatting</strong>.</p>', 'Actual DOM editing synchronizes through ProseMirror/Yjs to durable server storage');
  await until(() => JSON.parse(db.prepare('SELECT data FROM records WHERE id=?').get(draft.id).data).subject === 'Connected draft updated in the UI', 'Metadata autosave succeeds alongside the collaborative body update');
  action('close-modal');
  await until(() => !document.querySelector('.compose'), 'Closing waits for durable collaborative edits');
  action('open:' + draft.id);
  await until(() => document.querySelector('#compose-editor .ProseMirror strong')?.textContent === 'collaborative formatting', 'Reopened editor preserves formatting from the CRDT');
  action('send');
  await until(() => !document.querySelector('.compose') && document.querySelector('#workspace h1')?.textContent === 'Sent', 'Connected send completes and displays Sent');
  assert.equal(document.querySelector('#reader .body-copy strong').textContent, 'collaborative formatting');
  const sent = JSON.parse(db.prepare('SELECT data FROM records WHERE id=?').get(draft.id).data);
  assert.equal(sent.folder, 'sent');
  assert.equal(sent.body, '<p>Sent with <strong>collaborative formatting</strong>.</p>');
  const delivered = db.prepare("SELECT data FROM records WHERE kind='message' AND id<>?").all(draft.id).map(row => JSON.parse(row.data)).find(row => row.subject === sent.subject && row.folder === 'inbox');
  assert.ok(delivered, 'Internal self-send creates a real delivered Inbox copy');
  assert.equal(delivered.body, sent.body, 'Delivered message contains the acknowledged collaborative body');
  await browser.close();
});
