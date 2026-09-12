/** Calendar mail review controls. All mutations follow an explicit user action. */
export function createInboundUI({ api, S, runtime, e, btn, field, select, modal, advancedModal, notify, load, render: renderApp, closeModal }) {
  let accountKey = '', loaded = false, loading = null, messages = [], failure = '', filter = 'review';
  const key = () => `${runtime.server || ''}:${S.user?.userId || S.user?.id || S.user?.email || ''}`;
  const readableDate = value => { const date = new Date(value); return Number.isFinite(+date) ? date.toLocaleString() : String(value || 'Not supplied'); };
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  function reset() { const current = key(); if (current !== accountKey) { accountKey = current; loaded = false; loading = null; messages = []; failure = ''; } }
  async function refresh() {
    reset();
    if (!runtime.connected) return;
    if (loading) return loading;
    const requestedKey = accountKey;
    failure = '';
    loading = (async () => {
      try {
        const result = await api('calendar/inbound?status=all');
        if (key() !== requestedKey) return;
        messages = result.messages || []; S.inboundCalendar = messages; loaded = true;
      } catch (error) { if (key() === requestedKey) { failure = error.message; loaded = true; } }
      finally { if (key() === requestedKey) { loading = null; renderApp(); } }
    })();
    return loading;
  }
  function render() {
    reset();
    if (!runtime.connected) return '';
    if (!loaded && !loading) void refresh();
    const rows = messages.filter(row => filter === 'all' || row.status === 'review'), pending = messages.filter(row => row.status === 'review').length;
    return `<div class="settings-card"><h3>Calendar invitations &amp; responses${pending ? ` <span class="count">${pending}</span>` : ''}</h3><p>Review calendar messages from your connected mailboxes, then choose whether to apply a change or send a response.</p><div class="team-tools">${btn('inbound-filter:review', 'Needs review', null, filter === 'review' ? 'primary' : 'secondary')}${btn('inbound-filter:all', 'All messages', null, filter === 'all' ? 'primary' : 'secondary')}${btn('inbound-refresh', 'Refresh calendar mail', 'refresh', 'secondary')}</div>${failure ? `<p class="form-error" role="alert">${e(failure)}</p>` : ''}${loading ? '<p class="form-hint" role="status">Loading calendar mail…</p>' : ''}${rows.map(row => `<div class="rule-row"><div><h4>${e(row.event?.title || 'Calendar message')}</h4><p>${e(row.mailboxEmail)} · ${e(row.method || 'Invalid calendar')} · ${e(row.status)}</p><p class="form-hint">${e(row.reason || (row.event?.start ? readableDate(row.event.start) : readableDate(row.created)))}</p></div>${btn('inbound-detail:' + row.id, row.status === 'review' ? 'Review' : 'Details', null, 'secondary')}</div>`).join('') || (!loading && !failure ? `<p class="form-hint">${filter === 'review' ? 'No calendar messages need review.' : 'Calendar mail will appear after a connected mailbox synchronizes.'}</p>` : '')}</div>`;
  }
  async function find(id) {
    reset();
    if (!loaded || !messages.some(row => row.id === id)) await refresh();
    const row = messages.find(row => row.id === id);
    if (!row) throw new Error('This calendar message is unavailable. Refresh the mailbox and try again.');
    return row;
  }
  function details(row) {
    const event = row.event || {}, evidence = row.evidence || {};
    const info = (label, value) => `<dt>${e(label)}</dt><dd>${e(value || 'Not supplied')}</dd>`;
    const verified = evidence.authenticated ? `Sender verified by ${e(evidence.provider || evidence.method || 'the mail service')}.` : 'The sender has not been independently verified. Check the organizer and attendee before applying this change.';
    const source = event.component || event.raw || JSON.stringify(event, null, 2);
    const controls = row.status === 'review' ? `${btn('inbound-reject:' + row.id, 'Reject change', null, 'secondary')}${btn('inbound-apply:' + row.id, 'Apply calendar change', null, 'primary')}` : ['applied', 'duplicate'].includes(row.status) && row.method === 'REQUEST' ? btn('inbound-respond:' + row.id, 'Respond to invitation', 'send', 'primary') : '';
    modal('Calendar message', `<h3>${e(event.title || 'Calendar message')}</h3><p class="form-hint">${verified}</p>${row.reason ? `<p>${e(row.reason)}</p>` : ''}<dl class="calendar-mail-details">${info('Mailbox', row.mailboxEmail)}${info('Method', row.method)}${info('Organizer', event.organizer)}${info('Start', event.start ? readableDate(event.start) : '')}${info('End', event.end ? readableDate(event.end) : '')}${info('Location', event.location)}${info('Attendees', (event.attendees || []).map(a => `${a.email} (${a.partstat})`).join(', '))}${info('Sequence', String(event.sequence ?? ''))}${info('Status', row.status)}${event.recurrenceId ? info('Original occurrence', event.recurrenceId) : ''}</dl>${event.notes ? `<p style="white-space:pre-wrap">${e(event.notes)}</p>` : ''}<details><summary>Calendar source</summary><pre style="max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere">${e(source)}</pre></details>`, `${btn('close-modal', 'Close', null, 'secondary')}${controls}`);
  }
  async function action(name, value) {
    if (!name.startsWith('inbound-')) return false;
    if (!runtime.connected) throw new Error('Connect a server to review calendar mail.');
    if (name === 'inbound-refresh') { loaded = false; await refresh(); return true; }
    if (name === 'inbound-filter') { filter = value === 'all' ? 'all' : 'review'; renderApp(); return true; }
    const row = await find(value);
    if (name === 'inbound-detail') { details(row); return true; }
    if (name === 'inbound-apply' || name === 'inbound-reject') {
      const result = await post(`calendar/inbound/${encodeURIComponent(row.id)}/review`, { decision: name === 'inbound-apply' ? 'accept' : 'reject' });
      await closeModal(); await load(); await refresh();
      notify(result.status === 'applied' ? 'Calendar change applied' : result.status === 'rejected' ? result.reason || 'Calendar change rejected' : result.reason || `Calendar message: ${result.status}`);
      return true;
    }
    if (name === 'inbound-respond') {
      if (!['applied', 'duplicate'].includes(row.status) || row.method !== 'REQUEST') throw new Error('Apply the current invitation before responding.');
      advancedModal('Respond to invitation', 'inbound-response', field('', 'inboundId', row.id, 'hidden') + `<p><strong>${e(row.event.title)}</strong></p><p>Send your response from ${e(row.mailboxEmail)} to ${e(row.event.organizer)}.</p>` + select('Your response', 'response', [['accepted', 'Accept'], ['tentative', 'Tentative'], ['declined', 'Decline']], 'accepted') + '<p class="form-hint">Submitting queues a calendar response on your server. You can close Avenor while the server delivers it.</p>', 'Send response');
      return true;
    }
    return false;
  }
  async function submit(form, values) {
    if (form.dataset.advanced !== 'inbound-response') return false;
    const row = await find(values.inboundId);
    const result = await post(`calendar/inbound/${encodeURIComponent(row.id)}/respond`, { response: values.response });
    await closeModal(); await load(); await refresh();
    notify(result.duplicate ? 'This response is already recorded' : 'Calendar response queued for delivery');
    return true;
  }
  return { render, action, submit, refresh };
}
