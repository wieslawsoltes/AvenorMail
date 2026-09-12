import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPlugin, ySyncPluginKey, yCursorPlugin, yUndoPlugin, undo, redo, prosemirrorToYDoc } from 'y-prosemirror';
import { Schema, DOMParser as PMParser, DOMSerializer } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes, wrapInList } from 'prosemirror-schema-list';
import { baseKeymap, toggleMark, wrapIn, setBlockType } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';

const safeHref = value => /^(https?:\/\/|mailto:)/i.test(value || '') ? value : null;
const marks = basicSchema.spec.marks.update('link', {
  ...basicSchema.spec.marks.get('link'),
  parseDOM: [{ tag: 'a[href]', getAttrs: node => safeHref(node.getAttribute('href')) ? { href: node.getAttribute('href'), title: node.getAttribute('title') } : false }],
  toDOM: mark => ['a', { href: safeHref(mark.attrs.href) || '#', title: mark.attrs.title, rel: 'noopener noreferrer' }, 0],
}).addToEnd('underline', { parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }], toDOM: () => ['u', 0] });
export const collaborationSchema = new Schema({ nodes: addListNodes(basicSchema.spec.nodes.remove('image'), 'paragraph block*', 'block'), marks });
const encode = bytes => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};
const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const REMOTE = 'avenor-remote';
const colorFor = value => ['#6467dc', '#b75285', '#26867c', '#b46c25', '#4279ba'][[...value].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5];
const peerNumber = value => [...value].reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 2166136261);

/** One authenticated socket carries scoped record changes, presence and rich text. */
export class LiveClient {
  constructor({ url, getToken, onChange = () => {}, onPresence = () => {}, onStatus = () => {} }) {
    this.url = url || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live`;
    this.getToken = getToken;
    this.onChange = onChange;
    this.onPresence = onPresence;
    this.onStatus = onStatus;
    this.scopes = new Set();
    this.editors = new Map();
    this.pending = new Map();
    this.sequence = 0;
    this.stopped = false;
    this.authenticated = false;
    this.attempt = 0;
  }

  connect() {
    if (this.authenticated) return Promise.resolve(this);
    if (this.connecting) return this.connecting;
    clearTimeout(this.retryTimer);
    this.stopped = false;
    this.onStatus('connecting');
    this.connecting = new Promise((resolve, reject) => { this.connectResolve = resolve; this.connectReject = reject; });
    // Attach a rejection observer for automatic reconnect callers.
    this.connecting.catch(() => {});
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('open', async () => {
      try {
        const token = await this.getToken();
        if (socket === this.socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'auth', token }));
      } catch (error) { this.onStatus('error', { message: error.message }); socket.close(); }
    });
    socket.addEventListener('message', event => {
      if (socket !== this.socket) return;
      try { this.receive(JSON.parse(event.data)); } catch (error) { this.onStatus('error', { message: error.message }); }
    });
    socket.addEventListener('close', event => {
      if (socket !== this.socket) return;
      this.authenticated = false;
      this.connectReject?.(new Error('Live connection closed.'));
      this.connecting = null;
      for (const editor of this.editors.values()) editor.connected = false;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Connection lost before the server confirmed this edit.')); }
      this.pending.clear();
      this.onStatus(event.code === 4401 ? 'expired' : 'offline');
      if (!this.stopped && event.code !== 4401) this.retryTimer = setTimeout(() => { if (!this.stopped) this.connect(); }, Math.min(15000, 500 * 2 ** this.attempt++) + Math.random() * 250);
    });
    socket.addEventListener('error', () => {});
    return this.connecting;
  }

  send(message) {
    if (!this.authenticated || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  subscribe(scope) {
    this.scopes.add(scope);
    this.send({ type: 'subscribe', scope });
    return () => {
      this.scopes.delete(scope);
      this.send({ type: 'unsubscribe', scope });
      for (const editor of this.editors.values()) if (editor.scope === scope) editor.cleanup();
    };
  }

  receive(message) {
    if (message.type === 'ready') {
      clearTimeout(this.retryTimer);
      this.authenticated = true;
      this.attempt = 0;
      this.user = message.user;
      this.clientId = message.clientId;
      this.connectResolve?.(this);
      this.onStatus('connected');
      for (const scope of this.scopes) this.send({ type: 'subscribe', scope });
      for (const editor of this.editors.values()) this.join(editor);
      return;
    }
    if (message.type === 'change') { this.onChange(message.event, message.scope); return; }
    const editor = this.editors.get(message.recordId);
    if (message.type === 'joined' && editor) {
      editor.readOnly = message.readOnly;
      editor.connected = true;
      Y.applyUpdate(editor.doc, decode(message.state), REMOTE);
      if (editor.unsynced && message.initialized) { editor.view?.destroy(); editor.view = null; }
      if (!editor.view) editor.mount(message.initialized);
      editor.view?.setProps({ editable: () => !editor.readOnly && !editor.locked });
      editor.awareness.setLocalStateField('user', { name: this.user.displayName, color: colorFor(this.user.userId) });
      editor.readyResolve(editor.cleanup);
      // Reconnect merges offline edits and sends only structures the server lacks.
      const difference = Y.encodeStateAsUpdate(editor.doc, decode(message.vector));
      if (!editor.readOnly && difference.length > 2) this.push(editor, difference);
      else if (difference.length <= 2) editor.lastError = null;
      this.onStatus('document-ready', { recordId: editor.recordId, readOnly: editor.readOnly });
      return;
    }
    if (message.type === 'update' && editor) {
      Y.applyUpdate(editor.doc, decode(message.update), REMOTE);
      if (editor.unsynced) { editor.view?.destroy(); editor.mount(true); }
      return;
    }
    if (message.type === 'ack') {
      const pending = this.pending.get(message.requestId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.resolve(message); }
      this.onStatus('saved', { recordId: message.recordId, revision: message.revision });
      return;
    }
    if (message.type === 'permission' && editor) {
      if (editor.unsynced && !message.readOnly) { this.join(editor); return; }
      if (editor.readOnly !== message.readOnly) {
        editor.readOnly = message.readOnly;
        editor.view?.setProps({ editable: () => !editor.readOnly && !editor.locked });
        this.onStatus('permission', { recordId: editor.recordId, readOnly: editor.readOnly });
      }
      return;
    }
    if (message.type === 'presence') {
      if (editor) this.setPresence(editor, message.participants);
      this.onPresence(message);
      return;
    }
    if (message.type === 'revoked') {
      if (!message.recordId) this.scopes.delete(message.scope);
      for (const binding of this.editors.values()) if (binding.scope === message.scope && (!message.recordId || message.recordId === binding.recordId)) {
        binding.readOnly = true;
        binding.connected = false;
        binding.view?.setProps({ editable: () => false });
        binding.readyReject(new Error('Document access was revoked.'));
      }
      this.onStatus('revoked', message);
      return;
    }
    if (message.type === 'error') {
      const pending = this.pending.get(message.requestId);
      const error = Object.assign(new Error(message.message), { code: message.code });
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.reject(error); }
      if (editor) {
        editor.lastError = error;
        editor.readyReject(error);
        if (['READ_ONLY', 'FORBIDDEN', 'SCOPE_MISMATCH'].includes(message.code)) { editor.readOnly = true; editor.view?.setProps({ editable: () => false }); }
      }
      this.onStatus('error', message);
    }
  }

  join(editor) {
    this.send({ type: 'join', scope: editor.scope, recordId: editor.recordId, initialUpdate: editor.initialUpdate });
  }

  push(editor, update) {
    if (!editor.connected || editor.readOnly || !this.authenticated) return;
    const requestId = `${this.clientId}:${++this.sequence}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The server has not confirmed this edit. Reconnect before sending.')); }, 15000);
      this.pending.set(requestId, { resolve, reject, timer, recordId: editor.recordId });
    });
    editor.writes.add(promise);
    promise.then(() => { editor.writes.delete(promise); editor.lastError = null; }, error => { editor.writes.delete(promise); editor.lastError = error; });
    this.send({ type: 'update', recordId: editor.recordId, scope: editor.scope, update: encode(update), requestId });
    this.onStatus('saving', { recordId: editor.recordId });
    return promise;
  }

  setPresence(editor, participants) {
    const awareness = editor.awareness;
    const previous = new Set([...awareness.states.keys()].filter(key => key !== awareness.clientID));
    const added = [], updated = [], removed = [];
    for (const participant of participants) {
      if (participant.clientId === this.clientId) continue;
      const key = peerNumber(participant.clientId);
      if (key === awareness.clientID) continue;
      (awareness.states.has(key) ? updated : added).push(key);
      previous.delete(key);
      awareness.states.set(key, { user: { name: participant.displayName, color: colorFor(participant.userId) }, cursor: participant.selection?.cursor || null });
      awareness.meta.set(key, { clock: (awareness.meta.get(key)?.clock || 0) + 1, lastUpdated: Date.now() });
    }
    for (const key of previous) { removed.push(key); awareness.states.delete(key); awareness.meta.delete(key); }
    awareness.emit('change', [{ added, updated, removed }, REMOTE]);
  }

  attachEditor({ element, recordId, scope, onChange = () => {} }) {
    if (!element || !recordId || !scope) throw new Error('An editor element, document and workspace are required.');
    this.editors.get(recordId)?.cleanup();
    const initialNode = PMParser.fromSchema(collaborationSchema).parse(element);
    const seed = prosemirrorToYDoc(initialNode, 'prosemirror');
    const initialUpdate = encode(Y.encodeStateAsUpdate(seed));
    seed.destroy();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const editor = { doc, awareness, recordId, scope, initialUpdate, element, view: null, connected: false, readOnly: true, locked: false, writes: new Set(), lastError: null };
    const originalEditable = element.getAttribute('contenteditable');
    element.contentEditable = 'false';
    element.dataset.collaborative = 'true';
    const ready = new Promise((resolve, reject) => { editor.readyResolve = resolve; editor.readyReject = reject; });
    ready.catch(() => {});
    const serialize = () => {
      if (!editor.view) return element.innerHTML;
      const container = document.createElement('div');
      container.appendChild(DOMSerializer.fromSchema(collaborationSchema).serializeFragment(editor.view.state.doc.content));
      return container.innerHTML;
    };
    editor.mount = initialized => {
      editor.unsynced = !initialized && editor.readOnly;
      element.replaceChildren();
      editor.view = null;
      editor.view = new EditorView(element, {
        state: EditorState.create({
          schema: collaborationSchema,
          // Readers can inspect the original HTML before a writer initializes the CRDT.
          doc: !initialized && editor.readOnly ? initialNode : undefined,
          plugins: editor.unsynced ? [] : [ySyncPlugin(doc.getXmlFragment('prosemirror')), yCursorPlugin(awareness), yUndoPlugin(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo, 'Mod-b': toggleMark(collaborationSchema.marks.strong), 'Mod-i': toggleMark(collaborationSchema.marks.em), 'Mod-u': toggleMark(collaborationSchema.marks.underline) }), keymap(baseKeymap)],
        }),
        editable: () => !editor.readOnly && !editor.locked,
        attributes: { role: 'textbox', 'aria-label': 'Shared message body', 'aria-multiline': 'true', style: 'min-height: 180px; outline: none; white-space: pre-wrap; overflow-wrap: break-word;' },
        dispatchTransaction(transaction) {
          // Awareness metadata can arrive on a timer after a view is removed or
          // replaced. Never resurrect that view or update its destroyed DOM tree.
          if (destroyed || this.isDestroyed || !element.isConnected || (editor.view && editor.view !== this)) return;
          // ProseMirror plugins may dispatch while EditorView is being constructed.
          editor.view = this;
          const next = this.state.apply(transaction);
          this.updateState(next);
          if (transaction.docChanged) onChange(serialize(), { recordId, scope, remote: Boolean(transaction.getMeta(ySyncPluginKey)?.isChangeOrigin), pending: editor.writes.size > 0 });
        },
      });
      onChange(serialize(), { recordId, scope, remote: true, pending: false });
    };
    const update = (bytes, origin) => {
      if (origin !== REMOTE) this.push(editor, bytes);
    };
    doc.on('update', update);
    const presence = (_changes, origin) => {
      if (origin === REMOTE || !editor.connected) return;
      this.send({ type: 'presence', scope, recordId, selection: { cursor: awareness.getLocalState()?.cursor || null } });
    };
    awareness.on('update', presence);
    let destroyed = false;
    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      const html = serialize();
      editor.connected = false;
      this.send({ type: 'leave', scope, recordId });
      this.editors.delete(recordId);
      editor.view?.destroy();
      editor.view = null;
      awareness.off('update', presence);
      awareness.destroy();
      doc.off('update', update);
      doc.destroy();
      element.innerHTML = html;
      if (originalEditable === null) element.removeAttribute('contenteditable'); else element.setAttribute('contenteditable', originalEditable);
      delete element.dataset.collaborative;
      delete element.collaboration;
    };
    cleanup.ready = ready;
    cleanup.getHTML = serialize;
    cleanup.isReadOnly = () => editor.readOnly;
    cleanup.setLocked = value => { if (destroyed) return; editor.locked = Boolean(value); if (editor.view && !editor.view.isDestroyed) editor.view.setProps({ editable: () => !editor.readOnly && !editor.locked }); };
    cleanup.flush = async () => {
      await ready;
      if (!this.authenticated || !editor.connected) throw new Error('Reconnect before saving or sending this shared draft.');
      if (editor.readOnly) throw new Error('This draft is read only or has already been sent.');
      while (editor.writes.size) await Promise.all([...editor.writes]);
      if (editor.lastError) throw editor.lastError;
      return serialize();
    };
    cleanup.format = (command, argument) => {
      const view = editor.view;
      if (destroyed || !view || view.isDestroyed || editor.readOnly || editor.locked) return false;
      const commands = {
        bold: toggleMark(collaborationSchema.marks.strong), italic: toggleMark(collaborationSchema.marks.em), underline: toggleMark(collaborationSchema.marks.underline),
        insertUnorderedList: wrapInList(collaborationSchema.nodes.bullet_list), insertOrderedList: wrapInList(collaborationSchema.nodes.ordered_list),
        formatBlock: wrapIn(collaborationSchema.nodes.blockquote), justifyLeft: setBlockType(collaborationSchema.nodes.paragraph),
        createLink: safeHref(argument) ? toggleMark(collaborationSchema.marks.link, { href: argument }) : () => false,
        undo, redo,
        removeFormat: (state, dispatch) => { if (dispatch) dispatch(state.tr.removeMark(state.selection.from, state.selection.to)); return true; },
      };
      view.focus();
      return commands[command]?.(view.state, view.dispatch, view) || false;
    };
    editor.cleanup = cleanup;
    element.collaboration = cleanup;
    this.editors.set(recordId, editor);
    this.scopes.add(scope);
    if (this.authenticated) this.join(editor); else this.connect();
    return cleanup;
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    for (const editor of [...this.editors.values()]) editor.cleanup();
    this.socket?.close(1000, 'Signed out');
    this.scopes.clear();
    this.authenticated = false;
  }
}

// y-prosemirror uses these classes for readable remote selection decorations.
if (typeof document !== 'undefined' && !document.getElementById('avenor-collaboration-css')) {
  const style = document.createElement('style');
  style.id = 'avenor-collaboration-css';
  style.textContent = '.ProseMirror p{margin:0 0 .65em}.ProseMirror ul,.ProseMirror ol{padding-left:1.7em}.ProseMirror-yjs-cursor{position:relative;border-left:2px solid;border-right:0;margin-left:-1px;margin-right:-1px;word-break:normal;pointer-events:none}.ProseMirror-yjs-cursor>div{position:absolute;left:-2px;bottom:100%;font-size:10px;line-height:1.3;padding:2px 4px;border-radius:3px 3px 3px 0;color:white;white-space:nowrap;user-select:none}.ProseMirror-yjs-selection{opacity:.35}';
  document.head.appendChild(style);
}
