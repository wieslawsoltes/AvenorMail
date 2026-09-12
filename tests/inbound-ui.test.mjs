import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboundUI } from '../public/inbound-ui.js';
import { escapeHtml } from '../public/core.js';

function fixture() {
  const calls = [], dialogs = [], notices = [];
  const rows = [{ id: 'review-1', mailboxEmail: 'alice@example.com', status: 'review', method: 'REQUEST', event: { title: '<img src=x onerror=alert(1)>', organizer: 'bob@example.com', start: '2026-09-15T14:00:00Z', end: '2026-09-15T15:00:00Z', attendees: [{ email: 'alice@example.com', partstat: 'NEEDS-ACTION' }], sequence: 1, component: 'BEGIN:VEVENT\nSUMMARY:<script>x</script>\nEND:VEVENT' }, evidence: { authenticated: false } }];
  const S = { user: { userId: 'alice' } }, runtime = { connected: true, server: 'https://mail.example.com' };
  let renders = 0;
  const ui = createInboundUI({
    S, runtime, e: escapeHtml,
    api: async (path, options) => { calls.push({ path, options }); if (!options) return { messages: rows.map(row => structuredClone(row)) }; const body = JSON.parse(options.body); if (path.endsWith('/review')) { rows[0].status = body.decision === 'accept' ? 'applied' : 'rejected'; return { status: rows[0].status }; } return { status: 'queued' }; },
    btn: (action, label) => `<button data-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`,
    field: (_, name, value, type) => `<input name="${name}" type="${type}" value="${escapeHtml(value)}">`,
    select: (_, name, values) => `<select name="${name}">${values.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select>`,
    modal: (...args) => dialogs.push(args), advancedModal: (...args) => dialogs.push(args), notify: message => notices.push(message), load: async () => {}, render: () => renders++, closeModal: async () => true,
  });
  return { ui, calls, dialogs, notices, S, runtime, rows, renders: () => renders };
}

test('inbound UI loading is read-only and escapes untrusted calendar content', async () => {
  const f = fixture();
  f.ui.render(); await f.ui.refresh();
  const content = f.ui.render();
  assert.ok(content.includes('&lt;img'));
  assert.ok(!content.includes('<img'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, 'calendar/inbound?status=all');
  assert.equal(f.calls[0].options, undefined);
  await f.ui.action('inbound-detail', 'review-1');
  assert.ok(f.dialogs[0][1].includes('not been independently verified'));
  assert.ok(f.dialogs[0][1].includes('&lt;script&gt;'));
  assert.equal(f.calls.length, 1, 'opening details does not apply or respond');
});

test('applying an invitation and replying require separate explicit actions', async () => {
  const f = fixture(); await f.ui.refresh();
  await f.ui.action('inbound-apply', 'review-1');
  assert.equal(f.calls.filter(call => call.options).length, 1);
  assert.deepEqual(JSON.parse(f.calls.find(call => call.options).options.body), { decision: 'accept' });
  await f.ui.action('inbound-respond', 'review-1');
  assert.equal(f.dialogs.at(-1)[1], 'inbound-response');
  assert.equal(f.calls.filter(call => call.options).length, 1);
  assert.equal(await f.ui.submit({ dataset: { advanced: 'inbound-response' } }, { inboundId: 'review-1', response: 'accepted' }), true);
  assert.equal(f.calls.filter(call => call.options).length, 2);
  assert.ok(f.notices.includes('Calendar response queued for delivery'));
});

test('inbound UI rejects responses to unreviewed requests and separates signed-in users', async () => {
  const f = fixture(); await f.ui.refresh();
  await assert.rejects(f.ui.action('inbound-respond', 'review-1'), /Apply the current invitation/);
  assert.equal(f.calls.filter(call => call.options).length, 0);
  f.S.user = { userId: 'other' }; f.rows.splice(0);
  f.ui.render(); await f.ui.refresh();
  assert.ok(!f.ui.render().includes('review-1'));
  f.runtime.connected = false;
  assert.equal(f.ui.render(), '');
  assert.equal(await f.ui.action('another-action'), false);
});
