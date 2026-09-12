import { Worker } from 'node:worker_threads';
import { serialize, deserialize } from 'node:v8';

/** SQLite-compatible synchronous facade. The worker owns the remote transaction
 * stream, so a BEGIN/read/conditional-write/COMMIT stays on one connection. */
export class RemoteDatabase {
  constructor({url,authToken,timeout=60000,responseBytes=1024*1024}={}) {
    if(!url)throw new TypeError('A database URL is required');
    this.timeout=timeout;this.responseBytes=responseBytes;this.isTransaction=false;this.closed=false;
    this.worker=new Worker(new URL('./remote-db-worker.js',import.meta.url),{workerData:{url,authToken},execArgv:[]});
    this.worker.on('error',()=>{this.closed=true;});this.worker.unref();
    this.call({op:'ping'});
  }
  call(request) {
    if(this.closed)throw new Error('Database is closed');
    let size=this.responseBytes;
    for(;;){
      const shared=new SharedArrayBuffer(size+16),control=new Int32Array(shared,0,4);
      this.worker.postMessage({request:serialize(request),shared});
      if(Atomics.wait(control,0,0,this.timeout)==='timed-out'){
        this.closed=true;this.worker.terminate();
        throw Object.assign(new Error('Database response timed out; the operation outcome must be reconciled before retrying'),{code:'DATABASE_OUTCOME_UNKNOWN',uncertain:true});
      }
      const length=Atomics.load(control,1);
      if(length>size){size=length;request={op:'collect'};continue;}
      const reply=deserialize(Buffer.from(new Uint8Array(shared,16,length)));
      this.isTransaction=reply.inTransaction;
      if(reply.error)throw Object.assign(new Error(reply.error.message),reply.error);
      return reply.result;
    }
  }
  exec(sql){this.call({op:'exec',sql});return this;}
  prepare(sql){return {get:(...args)=>this.call({op:'get',sql,args}),all:(...args)=>this.call({op:'all',sql,args}),run:(...args)=>this.call({op:'run',sql,args})};}
  batch(statements){return this.call({op:'batch',statements});}
  close(){if(this.closed)return;try{this.call({op:'close'});}finally{this.closed=true;this.worker.terminate();}}
}
