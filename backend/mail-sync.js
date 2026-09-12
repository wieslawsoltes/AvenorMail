import { randomUUID } from 'node:crypto';
import {error} from './security.js';
/** The trigger shares the record mutation's transaction, so a crash cannot lose writeback work. */
export function installMailWriteback({db,providers,auth,scheduler,emit}) {
 db.exec(`CREATE TRIGGER IF NOT EXISTS queue_provider_update AFTER UPDATE ON records
 WHEN OLD.kind='message' AND json_extract(OLD.data,'$.accountId') IS NOT NULL AND json_extract(OLD.data,'$.providerId') IS NOT NULL
 AND json_extract(OLD.data,'$.providerSyncStamp') IS json_extract(NEW.data,'$.providerSyncStamp')
 AND (json_extract(OLD.data,'$.read') IS NOT json_extract(NEW.data,'$.read') OR json_extract(OLD.data,'$.flagged') IS NOT json_extract(NEW.data,'$.flagged') OR json_extract(OLD.data,'$.folder') IS NOT json_extract(NEW.data,'$.folder') OR OLD.deleted<>NEW.deleted)
 BEGIN INSERT INTO jobs(id,type,payload,owner,scope,run_at,max_attempts,created,updated)
 VALUES('provider-update:'||lower(hex(randomblob(16))),'provider_mutation',json_object('recordId',NEW.id,'accountId',json_extract(OLD.data,'$.accountId'),'patch',json_patch(json_patch(
 CASE WHEN json_extract(OLD.data,'$.read') IS NOT json_extract(NEW.data,'$.read') THEN json_object('read',json(CASE WHEN json_extract(NEW.data,'$.read') THEN 'true' ELSE 'false' END)) ELSE '{}' END,
 CASE WHEN json_extract(OLD.data,'$.flagged') IS NOT json_extract(NEW.data,'$.flagged') THEN json_object('flagged',json(CASE WHEN json_extract(NEW.data,'$.flagged') THEN 'true' ELSE 'false' END)) ELSE '{}' END),
 CASE WHEN NEW.deleted=1 THEN json_object('folder','deleted') WHEN json_extract(OLD.data,'$.folder') IS NOT json_extract(NEW.data,'$.folder') THEN json_object('folder',json_extract(NEW.data,'$.folder')) ELSE '{}' END)),NEW.owner,NEW.scope,NEW.updated,5,NEW.updated,NEW.updated); END;`);
 scheduler.handlers.provider_mutation=async(payload,ctx)=>{
  const row=db.prepare('SELECT * FROM records WHERE id=?').get(payload.recordId);if(!row)throw error('Imported message no longer exists',404);
  const user=auth.user(row.owner);if(!user)throw error('Mailbox account is disabled',403);
  const previous=db.prepare("SELECT id,status FROM jobs WHERE type='provider_mutation' AND json_extract(payload,'$.recordId')=? AND rowid<(SELECT rowid FROM jobs WHERE id=?) AND status NOT IN ('completed','accepted','cancelled') ORDER BY rowid LIMIT 1").get(row.id,ctx.job.id);
  if(previous)throw Object.assign(error('An earlier update to this message needs resolution ('+previous.status+')',409),{retryable:true});
  const data=JSON.parse(row.data);
  const result=await providers.updateMessage(user,payload.accountId,data.providerId,payload.patch,{idempotencyKey:ctx.idempotencyKey});
  if(result.status!=='applied')throw Object.assign(error('Provider update outcome is unconfirmed',502),{uncertain:true});
  // A MOVE can return a different IMAP UID. Apply that identity to the current record,
  // keeping local edits that were queued while the provider was processing this operation.
  const current=db.prepare('SELECT data FROM records WHERE id=?').get(row.id);
  if(current&&result.providerId){const value=JSON.parse(current.data);value.providerId=result.providerId;value.providerSyncStamp=randomUUID();db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(value),Date.now(),row.id);}
  emit(row.scope,{type:'record-change',recordId:row.id});return {status:'completed'};
 };
 return {
  preservePending(id,data){const jobs=db.prepare("SELECT payload FROM jobs WHERE type='provider_mutation' AND json_extract(payload,'$.recordId')=? AND status NOT IN ('completed','accepted','cancelled') ORDER BY rowid").all(id);for(const job of jobs)Object.assign(data,JSON.parse(job.payload).patch);return data;},
  stamp(){return randomUUID();}
 };
}
