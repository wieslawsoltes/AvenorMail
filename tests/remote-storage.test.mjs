import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RemoteDatabase } from '../backend/remote-db.js';
import { openDatabase,asD1 } from '../backend/storage.js';
import { S3Bucket } from '../backend/s3-bucket.js';
import { AuditLog } from '../backend/security.js';
import { createApplication } from '../backend/server.js';

test('remote database facade preserves interactive transactions, nested savepoints and BLOBs',()=>{
 const db=new RemoteDatabase({url:'file::memory:',responseBytes:64});
 try{
  db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY,value BLOB); CREATE TABLE revisions(value BLOB); CREATE TRIGGER capture AFTER INSERT ON entries BEGIN INSERT INTO revisions VALUES(NEW.value); END;');
  db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO entries VALUES(?,?)').run(1,Buffer.from('retained'));
  db.exec('SAVEPOINT child');db.prepare('INSERT INTO entries VALUES(?,?)').run(2,Buffer.from('rollback'));db.exec('ROLLBACK TO child; RELEASE child');
  assert.equal(db.isTransaction,true);db.exec('COMMIT');
  assert.deepEqual(db.prepare('SELECT value FROM entries').get().value,Buffer.from('retained'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revisions').get().n,1);
  db.exec('SAVEPOINT standalone');db.prepare('INSERT INTO entries VALUES(?,?)').run(3,randomBytes(2048));db.exec('RELEASE standalone');
  assert.equal(db.isTransaction,false);assert.equal(db.prepare('SELECT value FROM entries WHERE id=3').get().value.length,2048);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n,2,'overflow result collection must not execute the INSERT twice');
  assert.throws(()=>db.prepare('INSERT INTO entries VALUES(?,?)').run(1,Buffer.alloc(0)),/UNIQUE/);
 }finally{db.close();}
});

test('two database clients observe committed state and audit heads stay linear inside and outside transactions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'avenor-remote-')),url='file:'+join(dir,'shared.sqlite');
 const a=openDatabase(':memory:',{DATABASE_URL:url}),b=openDatabase(':memory:',{DATABASE_URL:url});
 try{
  const first=new AuditLog(a),second=new AuditLog(b);first.append('a','one');second.append('b','two');
  a.exec('BEGIN IMMEDIATE');first.append('a','nested');a.exec('ROLLBACK');
  assert.equal(first.verify().valid,true);assert.equal(second.verify().head,first.verify().head);assert.equal(b.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,2);
  const d1=asD1(a);const result=await d1.batch([d1.prepare('INSERT INTO users VALUES(?,?,?,?)').bind('u','u@example.com','User',1),d1.prepare('INSERT INTO users VALUES(?,?,?,?)').bind('v','v@example.com','Other',2)]);
  assert.equal(result[0].meta.changes,1);assert.equal(b.prepare('SELECT COUNT(*) AS n FROM users').get().n,2);
  await assert.rejects(d1.batch([d1.prepare('INSERT INTO users VALUES(?,?,?,?)').bind('w','w@example.com','User',1),d1.prepare('INSERT INTO users VALUES(?,?,?,?)').bind('u','duplicate@example.com','Other',2)]));
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM users').get().n,2);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('shared S3 attachments encrypt bytes, authenticate object identity and reject tampering',async()=>{
 const objects=new Map();const client={async send(command){const input=command.input,key=input.Key;
  if(command.constructor.name==='PutObjectCommand'){objects.set(key,Buffer.from(input.Body));return {};}
  if(command.constructor.name==='DeleteObjectCommand'){objects.delete(key);return {};}
  if(!objects.has(key))throw Object.assign(Error('Missing'),{name:'NoSuchKey',$metadata:{httpStatusCode:404}});
  if(command.constructor.name==='HeadObjectCommand')return {ContentLength:objects.get(key).length};
  return {Body:{transformToByteArray:async()=>objects.get(key)}};
 }};
 const env={S3_BUCKET:'test',DATA_KEY:randomBytes(32).toString('base64')},first=new S3Bucket({env,client}),second=new S3Bucket({env,client});
 await first.put('attachment',Buffer.from('private document'));
 assert.equal(objects.get('avenor/attachment').includes(Buffer.from('private document')),false);
 assert.equal(Buffer.from(await (await second.get('attachment')).arrayBuffer()).toString(),'private document');
 assert.equal((await second.head('attachment')).size,16);
 objects.set('avenor/copied',objects.get('avenor/attachment'));await assert.rejects(second.get('copied'));
 objects.get('avenor/attachment')[18]^=1;await assert.rejects(second.get('attachment'));
 await second.delete('attachment');assert.equal(await first.get('attachment'),null);await assert.rejects(first.get('../escape'));
});

test('complete server schema and CRUD run through the remote transaction bridge',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'avenor-bridge-app-'));let app;
 try{
  app=await createApplication({env:{DATA_DIR:dir,DATABASE_URL:'file:'+join(dir,'app.sqlite'),DATA_KEY:randomBytes(32).toString('base64'),ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'a-valid-test-password'}});
  assert.ok(app.db instanceof RemoteDatabase);
  const user=app.auth.user(app.db.prepare('SELECT user_id FROM auth_accounts').get().user_id),session=app.auth.session(user);
  const request=await app.handle(new Request('http://localhost:3000/api/record',{method:'POST',headers:{authorization:'Bearer '+session.token,'content-type':'application/json','idempotency-key':'remote-record-test'},body:JSON.stringify({kind:'contact',data:{name:'Remote User',email:'remote@example.com'}})}));
  assert.equal(request.status,201);const record=await request.json();assert.equal(record.name,'Remote User');assert.equal(app.compliance.verifyRevisions().valid,true);assert.equal(app.audit.verify().valid,true);
 }finally{if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
});
