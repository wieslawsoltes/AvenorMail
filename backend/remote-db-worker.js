import { parentPort,workerData } from 'node:worker_threads';
import { serialize,deserialize } from 'node:v8';
import { createClient } from '@libsql/client';

let client,transaction,pending;
let outerSavepoint=null;
const convert=value=>value instanceof ArrayBuffer?Buffer.from(value):value;
const resultOf=result=>({changes:Number(result.rowsAffected),lastInsertRowid:Number(result.lastInsertRowid||0)});
async function execute(request){
  client||=createClient({...workerData,intMode:'number'});
  if(request.op==='ping')return true;
  if(request.op==='close'){transaction?.close();transaction=null;outerSavepoint=null;client.close();return true;}
  if(request.op==='exec'){
    const sql=request.sql.trim().replace(/;\s*$/,'');
    if(/^BEGIN(?:\s+(?:IMMEDIATE|EXCLUSIVE|DEFERRED))?(?:\s+TRANSACTION)?$/i.test(sql)){
      if(transaction)throw Error('A transaction is already active');
      transaction=await client.transaction(/DEFERRED/i.test(sql)?'deferred':'write');return;
    }
    if(/^(COMMIT|END)(?:\s+TRANSACTION)?$/i.test(sql)){
      if(!transaction)throw Error('No transaction is active');
      const current=transaction;try{await current.commit();}finally{current.close();transaction=null;outerSavepoint=null;}return;
    }
    if(/^ROLLBACK(?:\s+TRANSACTION)?$/i.test(sql)){
      if(!transaction)return;
      const current=transaction;try{await current.rollback();}finally{current.close();transaction=null;outerSavepoint=null;}return;
    }
    const savepoint=sql.match(/^SAVEPOINT\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i);
    if(savepoint&&!transaction){transaction=await client.transaction('write');outerSavepoint=savepoint[1];}
    await (transaction||client).executeMultiple(request.sql);
    if(outerSavepoint&&new RegExp('(?:^|;)\\s*RELEASE(?:\\s+SAVEPOINT)?\\s+'+outerSavepoint+'\\s*;?$', 'i').test(sql)){
      const current=transaction;try{await current.commit();}finally{current.close();transaction=null;outerSavepoint=null;}
    }return;
  }
  if(request.op==='batch')return (await (transaction||client).batch(request.statements,'write')).map(resultOf);
  const result=await (transaction||client).execute({sql:request.sql,args:request.args});
  if(request.op==='run')return resultOf(result);
  const rows=result.rows.map(row=>Object.fromEntries(result.columns.map(column=>[column,convert(row[column])])));
  return request.op==='get'?rows[0]:rows;
}
parentPort.on('message',async ({request:bytes,shared})=>{
  const control=new Int32Array(shared,0,4),request=deserialize(bytes);
  let output;
  if(request.op==='collect')output=pending;
  else{
    try{output=serialize({result:await execute(request),inTransaction:!!transaction&&!transaction.closed});}
    catch(error){if(transaction?.closed)transaction=null;output=serialize({error:{message:error.message,code:error.code||'DATABASE_ERROR'},inTransaction:!!transaction});}
  }
  if(!output)output=serialize({error:{message:'No pending database result'},inTransaction:!!transaction});
  if(output.length<=shared.byteLength-16){new Uint8Array(shared,16,output.length).set(output);pending=null;}else pending=output;
  Atomics.store(control,1,output.length);Atomics.store(control,0,1);Atomics.notify(control,0);
});
