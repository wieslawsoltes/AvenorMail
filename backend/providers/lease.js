import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const ownership = new AsyncLocalStorage();
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
function leaseError(code,message,uncertain=false) {return Object.assign(new Error(message),{status:409,code,uncertain,unknown:uncertain,retryable:!uncertain});}

/** Database-fenced account operations, shared by every backend process. */
export class ProviderLeases {
  constructor(db,env={}) {
    this.db=db;
    this.ttl=Math.max(30000,Math.min(300000,Number(env.PROVIDER_LEASE_MS)||90000));
    const wait=Number(env.PROVIDER_LEASE_WAIT_MS);
    this.wait=Number.isFinite(wait)?Math.max(0,Math.min(60000,wait)):10000;
  }
  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_leases (
      lease_key TEXT PRIMARY KEY, owner_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1
    )`);
  }
  held(){return (ownership.getStore()||[]).filter(item=>item.manager===this);}
  assertCurrent() {
    for(const item of this.held()) {
      const row=this.db.prepare('SELECT owner_token,expires_at FROM provider_leases WHERE lease_key=?').get(item.key);
      if(item.lost || row?.owner_token!==item.token || row.expires_at<=Date.now()) throw leaseError('provider_lease_lost','Mailbox operation ownership expired. Reconcile the mailbox before retrying.',true);
    }
  }
  async run(key,task) {
    if(this.held().some(item=>item.key===key)){this.assertCurrent();return task();}
    const token=randomUUID(),deadline=Date.now()+this.wait;
    let acquired;
    do {
      const now=Date.now();
      acquired=this.db.prepare(`INSERT INTO provider_leases(lease_key,owner_token,expires_at,generation) VALUES(?,?,?,1)
        ON CONFLICT(lease_key) DO UPDATE SET owner_token=excluded.owner_token,expires_at=excluded.expires_at,generation=provider_leases.generation+1
        WHERE provider_leases.expires_at<=? RETURNING generation`).get(key,token,now+this.ttl,now);
      if(acquired)break;
      if(Date.now()>=deadline)throw leaseError('provider_busy','Another server is updating this mailbox. Retry after its operation finishes.');
      await pause(Math.min(100,Math.max(1,deadline-Date.now())));
    }while(!acquired);
    const item={manager:this,key,token,lost:false,generation:acquired.generation};
    const heartbeat=setInterval(()=>{
      try {
        const now=Date.now();
        if(!this.db.prepare('UPDATE provider_leases SET expires_at=? WHERE lease_key=? AND owner_token=? AND expires_at>?').run(now+this.ttl,key,token,now).changes)item.lost=true;
      }catch{item.lost=true;}
    },Math.floor(this.ttl/3));
    heartbeat.unref?.();
    try {
      return await ownership.run([...(ownership.getStore()||[]),item],async()=>{this.assertCurrent();const result=await task();this.assertCurrent();return result;});
    }finally {
      clearInterval(heartbeat);
      // A former owner can never release or extend a successor's lease.
      this.db.prepare('UPDATE provider_leases SET expires_at=0 WHERE lease_key=? AND owner_token=?').run(key,token);
    }
  }
}
