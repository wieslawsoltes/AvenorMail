import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createComplianceUI } from '../public/compliance-ui.js';

function fixture(){
  const dom=new JSDOM('<div id="overlay"></div>'),document=dom.window.document,calls=[],downloads=[],messages=[];
  const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const records={cases:[{id:'case-1',name:'Case <script>bad()</script>',reason:'Preserve <img onerror=bad()>',status:'open',scopes:['user:owner']}],holds:[],exports:[]};
  const api=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,...options,body});if(path==='compliance/cases')return {cases:records.cases};if(path.startsWith('compliance/holds?'))return {holds:records.holds};if(path.startsWith('compliance/exports?'))return {exports:records.exports};if(path==='compliance/exports/export-1')return {schema:'avenor.ediscovery.v1',entries:[],manifestHash:'abc123'};if(path==='compliance/search')return {entries:[{revision:{sequence:1,recordId:'record-1',scope:'user:owner',kind:'message',version:1,captured:Date.now(),operation:'insert'},data:{subject:'Subject <img src=x onerror=bad()>',body:'Sensitive <script>bad()</script>'},integrity:{hash:'verified'}}],next:null};if(path==='compliance/dlp?scope=user%3Aowner')return {policy:{rules:[],internalDomains:[]},version:3};return {ok:true};};
  const modal=(title,body,footer='')=>{document.querySelector('#overlay').innerHTML=`<section><h2>${e(title)}</h2>${body}<footer>${footer}</footer></section>`;};
  const ui=createComplianceUI({api,S:{scope:'user:owner'},runtime:{connected:true,user:{id:'owner',role:'admin'}},e,btn:(action,label,_icon,style)=>`<button class="${style}" data-action="${e(action)}">${e(label)}</button>`,field:(label,name,value='')=>`<label>${e(label)}<input name="${e(name)}" value="${e(value)}"></label>`,select:(label,name,values,current)=>`<label>${e(label)}<select name="${e(name)}">${values.map(value=>`<option value="${e(Array.isArray(value)?value[0]:value)}" ${(Array.isArray(value)?value[0]:value)===current?'selected':''}>${e(Array.isArray(value)?value[1]:value)}</option>`)}</select></label>`,modal,advancedModal:(title,kind,body)=>modal(title,`<form data-advanced="${kind}">${body}</form>`),notify:message=>messages.push(message),load:async()=>{},render:()=>{},closeModal:async()=>{document.querySelector('#overlay').innerHTML='';},download:async(...args)=>downloads.push(args)});
  return {ui,document,calls,records,downloads,messages};
}

test('compliance case and revision panels escape untrusted subject, reason and JSON data',async()=>{
  const f=fixture();await f.ui.action('compliance-open');assert.equal(f.document.querySelectorAll('script,img').length,0);assert.match(f.document.body.textContent,/<script>bad\(\)<\/script>/);
  await f.ui.action('compliance-case','case-1');assert.equal(f.document.querySelectorAll('script,img').length,0);assert.ok(f.document.querySelector('[data-action="compliance-add-hold:case-1"]'));
  await f.ui.submit({dataset:{advanced:'compliance-search'}},{caseId:'case-1',query:'needle'});assert.equal(f.document.querySelectorAll('script,img').length,0);await f.ui.action('compliance-revision','0');assert.equal(f.document.querySelectorAll('script,img').length,0);assert.match(f.document.body.textContent,/Sensitive/);
});

test('case hold creation and explicit release produce scoped authenticated API requests',async()=>{
  const f=fixture();await f.ui.action('compliance-open');await f.ui.action('compliance-case','case-1');await f.ui.action('compliance-add-hold','case-1');assert.equal(f.document.querySelector('form').dataset.advanced,'compliance-hold');
  await f.ui.submit({dataset:{advanced:'compliance-hold'}},{caseId:'case-1',scope:'user:owner',recordId:'record-1',reason:'Preserve evidence'});assert.ok(f.calls.some(call=>call.path==='compliance/holds'&&call.body.recordId==='record-1'));
  await f.ui.action('compliance-release-hold','hold-1');assert.equal(f.document.querySelector('form').dataset.advanced,'compliance-release');await f.ui.submit({dataset:{advanced:'compliance-release'}},{id:'hold-1',reason:'Approved release'});assert.ok(f.calls.some(call=>call.path==='compliance/holds/hold-1'&&call.method==='DELETE'&&call.body.reason==='Approved release'));
});

test('policy editor preserves server compare-and-swap version and evidence downloads preserve exported manifest',async()=>{
  const f=fixture();await f.ui.action('compliance-policy');assert.equal(f.document.querySelector('[name="version"]').value,'3');await f.ui.submit({dataset:{advanced:'compliance-policy'}},{scope:'user:owner',version:'3',policy:'{"internalDomains":[],"rules":[]}'});assert.ok(f.calls.some(call=>call.path==='compliance/dlp'&&call.body.version===3));
  await f.ui.action('compliance-download','export-1');assert.equal(f.downloads[0][0],'avenor-evidence-export-1.json');assert.equal(JSON.parse(f.downloads[0][1]).manifestHash,'abc123');
  assert.equal(await f.ui.action('unrelated'),false);assert.equal(await f.ui.submit({dataset:{advanced:'unrelated'}},{}),false);
});
