import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createProviderUI } from '../public/provider-ui.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function setup(dispatch=async()=>({})){const dom=new JSDOM('<!doctype html><div id="app"></div><div id="modal"></div>');globalThis.document=dom.window.document;
 const S={accounts:[{id:'google',provider:'google',email:'owner@example.com',displayName:'Owner'},{id:'microsoft',provider:'microsoft',email:'work@example.com'}],records:[{id:'local-event',version:3,kind:'event',title:'Local meeting'}]};
 const requests=[],notices=[],views=[];
 const options={api:async(path,init)=>{requests.push({path,init});return dispatch(path,init);},S,runtime:{connected:true},e:escape,
 btn:(action,label)=>`<button data-action="${escape(action)}">${escape(label)}</button>`,field:(label,name,value='',type='text',attrs='')=>`<label>${escape(label)}<input name="${name}" value="${escape(value)}" type="${type}" ${attrs}></label>`,
 select:(label,name,values,selected)=>`<label>${escape(label)}<select name="${name}">${values.map(([v,text])=>`<option value="${escape(v)}" ${v===selected?'selected':''}>${escape(text)}</option>`).join('')}</select></label>`,
 modal:(title,body,footer='')=>{views.push({title,body,footer});document.querySelector('#modal').innerHTML=body+footer;},
 advancedModal:(title,kind,body)=>{views.push({title,kind,body});document.querySelector('#modal').innerHTML=`<form data-advanced="${kind}">${body}</form>`;},
 notify:message=>notices.push(message),load:async()=>{},loadAccounts:async()=>{},render:()=>{},closeModal:async()=>{document.querySelector('#modal').innerHTML='';},upsert:()=>{}};
 return {ui:createProviderUI(options),dom,S,requests,notices,views};}
test('provider UI renders management actions only for connected cloud accounts and escapes account names',()=>{
 const {ui,S,dom}=setup();S.accounts[0].displayName='<img src=x onerror=alert(1)>';const html=ui.render();assert.ok(html.includes('pim-sync:google'));assert.ok(html.includes('provider-shared:microsoft'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));dom.window.close();
});
test('PIM publish form submits reviewed local version and a stable operation header',async()=>{
 const {ui,requests,dom}=setup(async(path,init)=>path==='pim/google'?{collections:[{id:'calendar',kind:'event',name:'Work calendar',writable:true}]}:init?.method==='POST'?{record:{id:'local-event'}}:{});
 await ui.action('pim-publish-event','google');const form=document.querySelector('form');assert.equal(form.dataset.advanced,'provider-publish');const values=Object.fromEntries(new dom.window.FormData(form));
 await ui.submit(form,values);const request=requests.find(r=>r.path.endsWith('/publish'));assert.equal(request.init.headers['Idempotency-Key'],values.operationId);assert.deepEqual(JSON.parse(request.init.body),{recordId:'local-event',version:3,collectionId:'calendar'});dom.window.close();
});
test('shared mailbox search and attach forms use the chosen parent account and explicit email',async()=>{
 const {ui,requests,dom}=setup(async()=>({mailboxes:[],directorySearchAvailable:false,reason:'Use known address'}));await ui.action('provider-shared','microsoft');
 let form=document.querySelector('[data-advanced="provider-shared-search"]');assert.ok(form);await ui.submit(form,{accountId:'microsoft',query:'Team'});assert.equal(requests[0].path,'accounts/microsoft/shared-mailboxes?q=Team');
 form=document.querySelector('[data-advanced="provider-shared-attach"]');await ui.submit(form,{accountId:'microsoft',email:'team@example.com'});assert.deepEqual(JSON.parse(requests[1].init.body),{email:'team@example.com'});dom.window.close();
});
test('provider conflict resolution requires a reviewed version and maintains one key across retry',async()=>{
 const conflict={id:'local-event',version:7,local:{title:'My edit',etag:'local'},remote:{title:'External edit',etag:'remote'}};let fail=true;
 const {ui,requests,dom}=setup(async(path)=>{if(path.endsWith('/conflicts')&&fail)throw Error('Temporary failure');return {collections:[],conflicts:[conflict]};});
 const target=encodeURIComponent(JSON.stringify(['google','local-event']));await assert.rejects(ui.action('pim-resolve-local',target),/Review/);await ui.action('pim-conflict',target);
 assert.match(document.querySelector('#modal').textContent,/My edit/);assert.match(document.querySelector('#modal').textContent,/External edit/);
 await assert.rejects(ui.action('pim-resolve-local',target),/Temporary/);fail=false;await ui.action('pim-resolve-local',target);const submits=requests.filter(r=>r.path.endsWith('/conflicts'));assert.equal(submits[0].init.headers['Idempotency-Key'],submits[1].init.headers['Idempotency-Key']);assert.equal(JSON.parse(submits[0].init.body).resolution,'local');assert.equal(JSON.parse(submits[0].init.body).version,7);dom.window.close();
});
test('provider/local CAS recovery submits the reviewed local version and provider token',async()=>{
 const conflict={recordId:'local-event',version:12,status:'accepted_local_conflict',local:{title:'Local edit'},provider:{title:'Provider accepted edit',etag:'"accepted"'},expectedRemoteEtag:'"accepted"'};
 let fail=true;const {ui,requests,dom}=setup(async(path)=>{if(path.endsWith('/recover')&&fail)throw Error('Connection lost');return {collections:[],localConflicts:[conflict]};});
 const target=encodeURIComponent(JSON.stringify(['google','local-event']));await assert.rejects(ui.action('pim-recover-provider',target),/Review/);
 await ui.action('pim-status','google');assert.match(document.querySelector('#modal').textContent,/Provider results to reconcile/);
 await ui.action('pim-local-conflict',target);assert.match(document.querySelector('#modal').textContent,/Local edit/);assert.match(document.querySelector('#modal').textContent,/Provider accepted edit/);
 await assert.rejects(ui.action('pim-recover-provider',target),/Connection lost/);fail=false;await ui.action('pim-recover-provider',target);
 const recovery=requests.filter(r=>r.path.endsWith('/recover'));const payload=JSON.parse(recovery[0].init.body);assert.equal(payload.resolution,'provider');assert.equal(payload.version,12);assert.equal(payload.expectedRemoteEtag,'"accepted"');assert.equal(recovery[0].init.headers['Idempotency-Key'],recovery[1].init.headers['Idempotency-Key']);dom.window.close();
});
