import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

function worker({failPath, networkDown = false} = {}) {
  const listeners = new Map(), stores = new Map(), deleted = [], fetched = [];
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const values = stores.get(name);
      return {async put(request, response) { values.set(String(request.url || request), response); }, async match(request) { return values.get(String(request.url || request)); }};
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); }
  };
  const context = {
    URL, Response, Error, Set, Promise, caches,
    self: {location: {href: 'https://example.test/AvenorMail/sw.js'}, clients: {claim: async () => {}}, skipWaiting() {}, addEventListener(name, callback) { listeners.set(name, callback); }},
    fetch: async request => {
      const url = new URL(request.url || request); fetched.push(url.href);
      if (networkDown || failPath && url.pathname.endsWith('/' + failPath)) throw new TypeError('Offline');
      return new Response(url.pathname, {status: 200});
    }
  };
  vm.runInNewContext(source, context);
  return {listeners, stores, deleted, fetched, caches};
}

test('service worker fails incomplete required-shell installation without removing the old shell', async () => {
  const runtime = worker({failPath: 'app.js'});
  runtime.stores.set('avenor-shell-%2FAvenorMail%2F-previous', new Map([['old-app', 'working']]));
  let install;
  runtime.listeners.get('install')({waitUntil(promise) { install = promise; }});
  await assert.rejects(install, /Offline/);
  assert.equal(runtime.deleted.length, 0);
  assert.equal(runtime.stores.get('avenor-shell-%2FAvenorMail%2F-previous').get('old-app'), 'working');
});

test('shell precache uses the GitHub Pages project base and excludes API endpoints', async () => {
  const runtime = worker();
  let install;
  runtime.listeners.get('install')({waitUntil(promise) { install = promise; }});
  await install;
  assert.ok(runtime.fetched.includes('https://example.test/AvenorMail/index.html'));
  assert.ok(runtime.fetched.includes('https://example.test/AvenorMail/offline.js'));
  assert.ok(runtime.fetched.every(url => url.startsWith('https://example.test/AvenorMail/')));
  for (const url of ['https://example.test/AvenorMail/api/data', 'https://example.test/AvenorMail/auth/login', 'https://example.test/AvenorMail/signin-with-chatgpt', 'https://other.test/AvenorMail/app.js']) {
    let intercepted = false;
    runtime.listeners.get('fetch')({request: {url, method: 'GET', mode: 'cors'}, respondWith() { intercepted = true; }});
    assert.equal(intercepted, false, url);
  }
});

test('offline navigation loads the scoped index shell', async () => {
  const runtime = worker({networkDown: true});
  // Read the cache version selected by this worker through its installation setup.
  let install;
  runtime.listeners.get('install')({waitUntil(promise) { install = promise; }});
  await install.catch(() => {});
  const current = [...runtime.stores.keys()][0];
  await (await runtime.caches.open(current)).put('https://example.test/AvenorMail/index.html', new Response('local workspace shell'));
  let navigation;
  runtime.listeners.get('fetch')({request: {url: 'https://example.test/AvenorMail/', method: 'GET', mode: 'navigate'}, respondWith(promise) { navigation = promise; }});
  assert.equal(await (await navigation).text(), 'local workspace shell');
});
