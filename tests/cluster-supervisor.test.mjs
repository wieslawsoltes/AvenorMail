import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('process supervisor starts two independent workers sharing one bootstrap and shuts both down', {timeout:20000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'avenor-supervisor-'));
 const child=spawn(process.execPath,['backend/cluster-main.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,DATA_DIR:directory,DATABASE_URL:'',S3_BUCKET:'',DATA_KEY:randomBytes(32).toString('base64'),ADMIN_EMAIL:'supervisor@example.test',ADMIN_PASSWORD:'Supervisor test password only!',WEB_CONCURRENCY:'2',CLUSTER_NODE_ID:'supervisor-test',PORT:'0',PUBLIC_URL:'http://localhost:3000'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
 const exited=once(child,'exit');let db;
 try{
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
   if(existsSync(join(directory,'avenor.sqlite'))){
    db||=new DatabaseSync(join(directory,'avenor.sqlite'));
    try{const nodes=db.prepare('SELECT * FROM cluster_nodes WHERE expires>?').all(Date.now());if(nodes.length===2&&output.split('Avenor server listening').length===3)break;}catch{}
   }
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(db?.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get().n,1,output);
  assert.equal(db?.prepare('SELECT COUNT(*) AS n FROM cluster_nodes WHERE expires>?').get(Date.now()).n,2,output);
  child.kill('SIGTERM');const [code]=await exited;assert.equal(code,0,output);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cluster_nodes WHERE expires>?').get(Date.now()).n,0);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await exited;}db?.close();rmSync(directory,{recursive:true,force:true});}
});
