/** Provider management UI. All reads/writes use the host app's authenticated API. */
export function createProviderUI({api,S,runtime,e,btn,field,select,modal,advancedModal,notify,load,loadAccounts,render,closeModal,upsert}) {
  const statusCache=new Map(),conflictCache=new Map(),sharedCache=new Map(),operationKeys=new Map(),busy=new Set();
  const cloudAccounts=()=> (S.accounts || []).filter(a=>a.provider==='microsoft'||a.provider==='google');
  const accountById=id=>cloudAccounts().find(a=>a.id===id);
  const hidden=(name,value)=>`<input type="hidden" name="${e(name)}" value="${e(value)}">`;
  const token=(...values)=>encodeURIComponent(JSON.stringify(values));
  const unpack=value=>JSON.parse(decodeURIComponent(value));
  const keyFor=value=>{if(!operationKeys.has(value))operationKeys.set(value,crypto.randomUUID());return operationKeys.get(value);};
  const status=async id=>{const result=await api('pim/'+encodeURIComponent(id));statusCache.set(id,result);return result;};
  const shortRecord=record=>Object.fromEntries(['title','name','start','end','timezone','allDay','attendees','location','email','phone','company','notes','deleted','etag'].filter(key=>record?.[key]!==undefined).map(key=>[key,record[key]]));
  const withBusy=async(id,work)=>{if(busy.has(id))return;busy.add(id);try{return await work();}finally{busy.delete(id);}};
  const collectionMarkup=data=>`<div>${(data.collections || []).map(c=>`<div class="rule-row"><div><strong>${e(c.name || c.id)}</strong><p>${c.kind==='event'?'Calendar':'Contacts'} · ${c.writable===false?'Read only':'Editable'}${c.timezone?' · '+e(c.timezone):''}${c.primary?' · Primary':''}</p></div></div>`).join('') || '<p class="form-hint">Synchronize this account to discover its calendars and contact folders.</p>'}</div>`;
  function renderProviders(){
    if(!runtime.connected)return '';
    return `<div class="settings-card"><h3>Calendars, contacts & shared mailboxes</h3><p>Keep your provider calendars and address books together in Avenor. Changes to connected records are saved back to their provider.</p>${cloudAccounts().map(a=>{
      const data=statusCache.get(a.id);
      return `<div class="rule-row" style="align-items:flex-start;flex-wrap:wrap"><div style="min-width:180px;flex:1"><strong>${e(a.displayName || a.email)}</strong><p>${e(a.email)}${a.parentAccountId?' · Shared mailbox':''}${data?.lastSync?' · Synced '+e(new Date(data.lastSync).toLocaleString()):''}</p>${data?.pendingWrites?`<p class="form-hint">${Number(data.pendingWrites)} accepted change${data.pendingWrites===1?' is':'s are'} waiting to appear in provider synchronization.</p>`:''}${data?.conflicts?.length?`<p class="error-inline">${data.conflicts.length} provider conflict${data.conflicts.length===1?'':'s'} need review.</p>`:''}</div><div class="team-tools">${btn('pim-sync:'+a.id,'Sync calendar & contacts','refresh','secondary')}${btn('pim-status:'+a.id,'Manage','settings','secondary')}${a.provider==='microsoft'&&!a.parentAccountId?btn('provider-shared:'+a.id,'Shared mailboxes','people','secondary'):''}</div></div>`;
    }).join('')||'<p class="form-hint">Connect Microsoft or Google above to start. SMTP/IMAP accounts provide email only.</p>'}</div>`;
  }
  async function showStatus(id){
    const account=accountById(id);if(!account)throw Error('Connected account not found.');
    const data=await status(id);
    const conflicts=(data.conflicts || []).map(c=>{const target=token(id,c.id);conflictCache.set(target,c);return `<div class="rule-row"><div><strong>${e(c.local?.title || c.local?.name || 'Provider change')}</strong><p>The provider version differs from the accepted local change.</p></div>${btn('pim-conflict:'+target,'Review versions','edit','secondary')}</div>`;}).join('');
    modal('Calendars & contacts',`<p>${e(account.email)}</p>${collectionMarkup(data)}${data.pendingWrites?`<p class="form-hint">${Number(data.pendingWrites)} accepted change${data.pendingWrites===1?' is':'s are'} waiting for provider synchronization. Your accepted edits remain visible until the provider confirms them.</p>`:''}${conflicts?'<h4>Changes to review</h4>'+conflicts:''}<div class="team-tools">${btn('pim-publish-event:'+id,'Publish a local event','calendar','secondary')}${btn('pim-publish-contact:'+id,'Publish a local contact','people','secondary')}</div>`,btn('close-modal','Close',null,'secondary')+btn('pim-sync:'+id,'Synchronize','refresh','primary'));
  }
  async function showPublish(id,kind){
    const account=accountById(id);if(!account)throw Error('Connected account not found.');
    const data=await status(id),collections=(data.collections || []).filter(c=>c.kind===kind&&c.writable!==false);
    const records=(S.records || []).filter(r=>r.kind===kind&&!r.accountId&&!r.sample&&!r.deleted);
    if(!records.length){modal('Publish '+(kind==='event'?'an event':'a contact'),'<p>Create a personal '+(kind==='event'?'event in Calendar':'contact in People')+' first, then return here to publish it to your provider.</p>');return;}
    advancedModal('Publish to '+account.email,'provider-publish',hidden('accountId',id)+hidden('kind',kind)+hidden('operationId',crypto.randomUUID())+
      select(kind==='event'?'Event':'Contact','recordId',records.map(r=>[r.id,r.title || r.name]),records[0].id)+
      select(kind==='event'?'Calendar':'Address book','collectionId',collections.length?collections.map(c=>[c.id,c.name || c.id]):[['',kind==='event'?'Primary calendar':'Default contacts']],collections.find(c=>c.primary)?.id || collections[0]?.id || '')+
      '<p class="form-hint">This creates the record on the connected provider and keeps future edits synchronized. '+(kind==='event'?'An event with attendees may cause the provider to send invitations.':'The original local record remains the same Avenor contact.')+'</p>','Publish');
  }
  function sharedForms(id,query=''){
    return `<form data-advanced="provider-shared-search" class="login-form">${hidden('accountId',id)}${field('Search directory','query',query,'search','required minlength="2" maxlength="80" placeholder="Name or email prefix"')}<button class="secondary" type="submit">Search accessible mailboxes</button><div class="form-error" role="alert"></div></form><h4>Attach a known mailbox</h4><form data-advanced="provider-shared-attach" class="login-form">${hidden('accountId',id)}${field('Mailbox email address','email','','email','required placeholder="team@example.com"')}<p class="form-hint">Microsoft checks the signed-in account’s Exchange folder permissions. Avenor does not grant new mailbox access.</p><button class="primary" type="submit">Verify and attach</button><div class="form-error" role="alert"></div></form>`;
  }
  function showSharedResults(id,result,query=''){
    sharedCache.set(id,result);
    const rows=(result?.mailboxes || []).map(m=>`<div class="rule-row"><div><strong>${e(m.displayName || m.email)}</strong><p>${e(m.email)} · Inbox access verified</p></div>${btn('provider-shared-attach:'+token(id,m.mailboxId,m.email),'Attach','plus','secondary')}</div>`).join('');
    modal('Shared Microsoft mailboxes',`<p>${e(accountById(id)?.email || '')}</p>${result?.reason?`<p class="note-box">${e(result.reason)}</p>`:''}${result?rows||'<p class="form-hint">No accessible mailbox matched this search. You can attach a known address below.</p>':''}${result?.attached?.length?`<p class="form-hint">Attached: ${result.attached.map(a=>e(a.email)).join(', ')}</p>`:''}${sharedForms(id,query)}`);
  }
  async function action(name,value){
    if(!name.startsWith('pim-')&&!name.startsWith('provider-shared'))return false;
    if(!runtime.connected)throw Error('Connect an Avenor server first.');
    switch(name){
      case 'pim-sync':await withBusy('sync:'+value,async()=>{notify('Synchronizing calendars and contacts…');const result=await api('pim/'+encodeURIComponent(value)+'/sync',{method:'POST',body:'{}'});await status(value);await load();if(document.querySelector('.modal[role=dialog]'))await showStatus(value);else render();notify((result.count || 0)+' calendar and contact changes synchronized');});break;
      case 'pim-status':await showStatus(value);break;
      case 'pim-publish-event':await showPublish(value,'event');break;
      case 'pim-publish-contact':await showPublish(value,'contact');break;
      case 'pim-conflict':{
        const [id,recordId]=unpack(value),data=await status(id),conflict=data.conflicts?.find(c=>c.id===recordId);if(!conflict)throw Error('This conflict has already been resolved.');conflictCache.set(value,conflict);
        modal('Review provider conflict',`<p>Compare your accepted change with the current provider version. Reapplying your version uses the provider’s reviewed version to detect another intervening change.</p><h4>Your accepted change</h4><pre class="pending-json">${e(JSON.stringify(shortRecord(conflict.local),null,2))}</pre><h4>Provider version</h4><pre class="pending-json">${e(JSON.stringify(shortRecord(conflict.remote),null,2))}</pre>`,btn('close-modal','Keep for review',null,'secondary')+btn('pim-resolve-remote:'+value,'Use provider version',null,'secondary')+btn('pim-resolve-local:'+value,'Reapply my version',null,'primary'));break;
      }
      case 'pim-resolve-local':case 'pim-resolve-remote':{
        const [id,recordId]=unpack(value);if(!conflictCache.has(value))throw Error('Review this conflict before resolving it.');
        const resolution=name==='pim-resolve-local'?'local':'remote',key=keyFor(name+':'+value);
        const result=await api('pim/'+encodeURIComponent(id)+'/conflicts',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({recordId,resolution,idempotencyKey:key,expectedRemoteEtag:conflictCache.get(value).remoteVersion || conflictCache.get(value).remote?.etag})});
        if(result.record || result.id)upsert(result.record || result);operationKeys.delete(name+':'+value);conflictCache.delete(value);await status(id);await closeModal();await load();notify('Provider conflict resolved');break;
      }
      case 'provider-shared':showSharedResults(value,null);break;
      case 'provider-shared-attach':{
        const [id,mailboxId,email]=unpack(value);await withBusy('attach:'+id+':'+mailboxId,async()=>{await api('accounts/'+encodeURIComponent(id)+'/shared-mailboxes',{method:'POST',body:JSON.stringify({mailboxId,email})});await loadAccounts();await closeModal();render();notify('Shared mailbox connected');});break;
      }
      default:return false;
    }return true;
  }
  async function submit(form,v){
    const kind=form.dataset.advanced;
    if(!['provider-publish','provider-shared-search','provider-shared-attach'].includes(kind))return false;
    if(kind==='provider-publish'){
      const record=(S.records || []).find(r=>r.id===v.recordId&&r.kind===v.kind);if(!record)throw Error('The selected record no longer exists.');
      const result=await api('pim/'+encodeURIComponent(v.accountId)+'/publish',{method:'POST',headers:{'Idempotency-Key':v.operationId},body:JSON.stringify({recordId:record.id,version:record.version,collectionId:v.collectionId || undefined})});
      if(result.record || result.id)upsert(result.record || result);await status(v.accountId);await closeModal();await load();notify('Record published and connected to its provider');
    }else if(kind==='provider-shared-search'){
      const result=await api('accounts/'+encodeURIComponent(v.accountId)+'/shared-mailboxes?q='+encodeURIComponent(v.query));showSharedResults(v.accountId,result,v.query);
    }else{
      await api('accounts/'+encodeURIComponent(v.accountId)+'/shared-mailboxes',{method:'POST',body:JSON.stringify({email:v.email})});await loadAccounts();await closeModal();render();notify('Shared mailbox connected');
    }return true;
  }
  return {render:renderProviders,action,submit};
}
