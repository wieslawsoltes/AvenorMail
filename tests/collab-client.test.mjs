import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { TextSelection } from 'prosemirror-state';
import { RealtimeHub, collaborationDocumentHTML } from '../backend/realtime.js';

// Exercise real ProseMirror/Yjs views and real WebSockets; jsdom supplies only DOM.
test('rich editor renders once, merges concurrent edits and formatting, reconnects and obeys revocation', async () => {
  const dom = new JSDOM('<html><head></head><body><div id="a" contenteditable="true"><p>Hello world</p></div><div id="b" contenteditable="true"><p>Hello world</p></div></body></html>', { url: 'http://localhost:3000', pretendToBeVisual: true });
  const previous = new Map();
  for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'DOMParser', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'navigator', 'WebSocket', 'indexedDB']) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'DOMParser', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = key === 'window' ? dom.window : ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class extends WebSocket { constructor(url) { super(url, { origin: 'http://localhost:3000' }); } } });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  const db = new DatabaseSync(':memory:');
  const revoked = new Set(), readers = new Set();
  const hub = new RealtimeHub({ db, allowedOrigins: ['http://localhost:3000'], authenticate: request => ({ userId: request.headers.authorization.slice(7), displayName: request.headers.authorization.slice(7) }), authorize: ({ user, action }) => !revoked.has(user.userId) && (action !== 'write' || !readers.has(user.userId)) }).migrate();
  const server = createServer();
  hub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { LiveClient } = await import('../public/collab.js');
  const errors = [], statuses = [];
  const make = token => new LiveClient({ url: `ws://127.0.0.1:${server.address().port}/api/live`, getToken: () => token, onStatus: (status, details) => { statuses.push({ token, status, details }); if (status === 'error') errors.push(details); } });
  let alice = make('alice');
  const bob = make('bob');
  const until = async predicate => {
    const deadline = Date.now() + 2500;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Client did not reach the expected state'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  try {
    await Promise.all([alice.connect(), bob.connect()]);
    let a = alice.attachEditor({ element: document.querySelector('#a'), recordId: 'draft', scope: 'team:a' });
    const b = bob.attachEditor({ element: document.querySelector('#b'), recordId: 'draft', scope: 'team:a' });
    await Promise.all([a.ready, b.ready]);
    assert.equal(a.getHTML(), '<p>Hello world</p>');
    assert.equal(b.getHTML(), a.getHTML());
    let av = alice.editors.get('draft').view;
    const bv = bob.editors.get('draft').view;

    // Mutate both views before either has received the other's network update.
    av.dispatch(av.state.tr.insertText(' Alice', 6));
    bv.dispatch(bv.state.tr.insertText('Bob', 7, 12));
    await Promise.all([a.flush(), b.flush()]);
    await until(() => a.getHTML() === b.getHTML());
    assert.equal(a.getHTML(), '<p>Hello Alice Bob</p>');

    av.dispatch(av.state.tr.setSelection(TextSelection.create(av.state.doc, 1, 6)));
    assert.equal(a.format('bold'), true);
    await a.flush();
    await until(() => a.getHTML() === b.getHTML());
    assert.equal(a.getHTML(), '<p><strong>Hello</strong> Alice Bob</p>');
    assert.equal(collaborationDocumentHTML(db, 'draft'), a.getHTML());

    // Relative selection follows a remote insert before the selected text.
    av.dispatch(av.state.tr.setSelection(TextSelection.create(av.state.doc, 7, 12)));
    bv.dispatch(bv.state.tr.insertText('Dear ', 1));
    await b.flush();
    await until(() => a.getHTML() === b.getHTML());
    assert.equal(av.state.selection.anchor, 12);
    assert.equal(av.state.selection.head, 17);

    // Neither a wire submission nor a saved status may outrun local durable IO.
    const append = alice.store.append.bind(alice.store);
    let releaseAppend;
    const appendGate = new Promise(resolve => { releaseAppend = resolve; });
    alice.store.append = async (...args) => { await appendGate; return append(...args); };
    av.dispatch(av.state.tr.insertText(' durable-gated', av.state.doc.content.size - 1));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.doesNotMatch(collaborationDocumentHTML(db, 'draft'), /durable-gated/);
    releaseAppend(); await a.flush();
    alice.store.append = append;
    assert.match(collaborationDocumentHTML(db, 'draft'), /durable-gated/);

    const acknowledge = alice.store.acknowledge.bind(alice.store);
    let releaseAck, ackStarted = false;
    const ackGate = new Promise(resolve => { releaseAck = resolve; });
    alice.store.acknowledge = async (...args) => { ackStarted = true; await ackGate; return acknowledge(...args); };
    const previousSaved = statuses.filter(value => value.token === 'alice' && value.status === 'saved').length;
    av.dispatch(av.state.tr.insertText(' checkpoint-gated', av.state.doc.content.size - 1));
    let flushed = false;
    const flushing = a.flush().then(() => { flushed = true; });
    await until(() => ackStarted);
    assert.equal(flushed, false);
    assert.equal(statuses.filter(value => value.token === 'alice' && value.status === 'saved').length, previousSaved);
    releaseAck(); await flushing;
    alice.store.acknowledge = acknowledge;

    // Preserve local changes in the open editor while disconnected, then merge.
    alice.socket.terminate();
    await until(() => !alice.authenticated);
    av.dispatch(av.state.tr.insertText(' offline', av.state.doc.content.size - 1));
    await assert.rejects(a.flush(), /Reconnect/);
    bv.dispatch(bv.state.tr.insertText(' online', bv.state.doc.content.size - 1));
    await b.flush();
    await alice.connect();
    await until(() => alice.editors.get('draft').connected);
    await a.flush();
    await until(() => a.getHTML() === b.getHTML());
    assert.match(a.getHTML(), /offline/);
    assert.match(a.getHTML(), /online/);
    assert.equal(collaborationDocumentHTML(db, 'draft'), a.getHTML());

    // Full editor/client teardown simulates a page reload. The only source of
    // the disconnected change is the committed IndexedDB CRDT journal.
    alice.socket.terminate();
    await until(() => !alice.authenticated);
    av.dispatch(av.state.tr.insertText(' reload-survivor', av.state.doc.content.size - 1));
    av.dispatch(av.state.tr.setSelection(TextSelection.create(av.state.doc, 1, 5)));
    assert.equal(a.format('italic'), true);
    const storageKey = alice.editors.get('draft').storageKey;
    // Detaching immediately must finish the queued IDB transaction even after
    // the Y.Doc and editor view have already been destroyed.
    await a();
    await a.closed;
    assert.ok((await alice.store.load(storageKey)).pending.length > 0);
    await alice.close();
    document.querySelector('#a').innerHTML = '<p>Stale HTML must not replace the server</p>';
    bv.dispatch(bv.state.tr.insertText(' remote-during-reload', bv.state.doc.content.size - 1));
    await b.flush();
    alice = make('alice');
    await alice.connect();
    a = alice.attachEditor({ element: document.querySelector('#a'), recordId: 'draft', scope: 'team:a' });
    await a.ready; await a.flush();
    av = alice.editors.get('draft').view;
    await until(() => a.getHTML() === b.getHTML());
    assert.match(a.getHTML(), /reload-survivor/);
    assert.match(a.getHTML(), /remote-during-reload/);
    assert.match(a.getHTML(), /<em>/);
    assert.doesNotMatch(a.getHTML(), /Stale HTML/);
    assert.equal((a.getHTML().match(/reload-survivor/g) || []).length, 1);
    assert.deepEqual((await alice.store.load(storageKey)).pending, []);
    assert.equal(collaborationDocumentHTML(db, 'draft'), a.getHTML());

    // An acknowledged-on-server edit must be recognized after its wire ACK is lost.
    const send = hub.send.bind(hub);
    let dropped = false;
    hub.send = (client, message) => {
      if (!dropped && client.user?.userId === 'alice' && message.type === 'ack') { dropped = true; client.ws.terminate(); return; }
      send(client, message);
    };
    av.dispatch(av.state.tr.insertText(' saved', av.state.doc.content.size - 1));
    await until(() => dropped && !alice.authenticated);
    hub.send = send;
    await a.persist();
    await alice.close();
    document.querySelector('#a').innerHTML = '<p>Stale body</p>';
    alice = make('alice');
    await alice.connect();
    a = alice.attachEditor({ element: document.querySelector('#a'), recordId: 'draft', scope: 'team:a' });
    await a.ready;
    av = alice.editors.get('draft').view;
    await until(() => alice.editors.get('draft').connected);
    await a.flush();
    await until(() => a.getHTML() === b.getHTML());
    assert.match(a.getHTML(), /saved/);
    assert.equal((a.getHTML().match(/ saved/g) || []).length, 1, 'ACK loss and reload cannot duplicate an accepted edit');

    // A viewer promoted before any writer opens a draft must initialize Yjs first.
    const extra = document.createElement('div'); extra.innerHTML = '<p>Reader seed</p>'; document.body.append(extra);
    readers.add('bob');
    const promoted = bob.attachEditor({ element: extra, recordId: 'promoted-draft', scope: 'team:a' });
    await promoted.ready;
    assert.equal(promoted.getHTML(), '<p>Reader seed</p>');
    assert.equal(bob.editors.get('promoted-draft').unsynced, true);
    readers.delete('bob');
    await hub.sweep();
    await until(() => !bob.editors.get('promoted-draft').unsynced && !promoted.isReadOnly());
    const promotedView = bob.editors.get('promoted-draft').view;
    promotedView.dispatch(promotedView.state.tr.insertText(' edited', promotedView.state.doc.content.size - 1));
    await promoted.flush();
    assert.equal(collaborationDocumentHTML(db, 'promoted-draft'), '<p>Reader seed edited</p>');
    promoted();

    // An uninitialized viewer reconnecting to a now-initialized room must remount.
    const readerElement = document.createElement('div'); readerElement.innerHTML = '<p>Before</p>'; document.body.append(readerElement);
    readers.add('bob');
    const reconnectReader = bob.attachEditor({ element: readerElement, recordId: 'reader-reconnect', scope: 'team:a' });
    await reconnectReader.ready;
    bob.socket.terminate(); await until(() => !bob.authenticated);
    const writerElement = document.createElement('div'); writerElement.innerHTML = '<p>After writer initialized</p>'; document.body.append(writerElement);
    const newWriter = alice.attachEditor({ element: writerElement, recordId: 'reader-reconnect', scope: 'team:a' });
    await newWriter.ready;
    await bob.connect();
    await until(() => bob.editors.get('reader-reconnect').connected);
    assert.equal(reconnectReader.getHTML(), '<p>After writer initialized</p>');
    assert.equal(bob.editors.get('reader-reconnect').unsynced, false);
    reconnectReader(); newWriter(); readers.delete('bob');

    // Closing before its async journal/join handshake settles must cancel
    // readiness, without leaving a dangling Promise or resurrecting its view.
    const cancelledElement = document.createElement('div'); cancelledElement.innerHTML = '<p>Cancel</p>'; document.body.append(cancelledElement);
    const cancelled = alice.attachEditor({ element: cancelledElement, recordId: 'cancel-before-ready', scope: 'team:a' });
    const cancelledReady = assert.rejects(cancelled.ready, /closed/);
    await cancelled();
    await cancelledReady;
    await assert.rejects(cancelled.flush(), /closed/);
    assert.equal(alice.editors.has('cancel-before-ready'), false);

    // Record-specific revocation keeps the otherwise-readable workspace subscribed.
    bob.receive({ type: 'revoked', scope: 'team:a', recordId: 'unrelated-document' });
    assert.equal(bob.scopes.has('team:a'), true);

    revoked.add('bob');
    await hub.sweep();
    await until(() => b.isReadOnly() && b.getHTML() === '');
    assert.equal(b.getHTML(), '', 'Revoked content is removed from the view and cleanup serializer');
    assert.equal(b.format('italic'), false);
    await assert.rejects(b.flush(), /Reconnect|read only/);
    assert.deepEqual(errors.filter(error => error.code !== 'FORBIDDEN'), [], 'No unexpected transport or storage errors');
    assert.ok(statuses.some(value => value.token === 'bob' && value.status === 'revoked'));

    const html = a.getHTML();
    const deferredTransaction = av.state.tr.setMeta('late-awareness', true);
    const delayedDispatch = new Promise((resolve, reject) => setTimeout(() => {
      try { av.dispatch(deferredTransaction); resolve(); } catch (error) { reject(error); }
    }, 0));
    a();
    await delayedDispatch;
    assert.doesNotThrow(() => a.setLocked(true), 'A late UI lock cannot update a destroyed editor');
    assert.equal(a.format('bold'), false);
    assert.equal(document.querySelector('#a').innerHTML, html);
    assert.equal(document.querySelector('#a').getAttribute('contenteditable'), 'true');
  } finally {
    await Promise.all([alice.close(), bob.close()]);
    await hub.close();
    await new Promise(resolve => server.close(resolve));
    db.close(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
