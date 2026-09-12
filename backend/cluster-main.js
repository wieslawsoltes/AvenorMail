import cluster from 'node:cluster';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { createApplication } from './server.js';

const requested=process.env.WEB_CONCURRENCY||'1';
const workers=requested==='auto'?availableParallelism():Number(requested);
if(!Number.isInteger(workers)||workers<1||workers>128)throw Error('WEB_CONCURRENCY must be 1–128 or auto');

if(cluster.isPrimary&&workers>1){
 const prefix=process.env.CLUSTER_NODE_ID||randomUUID();let stopping=false,failures=0;
 const children=new Set(),timers=new Set();
 const fork=()=>{const worker=cluster.fork({CLUSTER_NODE_ID:prefix+':'+randomUUID()});children.add(worker);worker.once('listening',()=>{failures=0;});};
 for(let i=0;i<workers;i++)fork();
 cluster.on('exit',worker=>{
  children.delete(worker);if(stopping){if(!children.size)process.exit(0);return;}
  const timer=setTimeout(()=>{timers.delete(timer);if(!stopping)fork();},Math.min(30000,1000*2**Math.min(5,failures++)));timers.add(timer);
 });
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  stopping=true;for(const timer of timers)clearTimeout(timer);for(const child of children)child.process.kill('SIGTERM');
  const deadline=setTimeout(()=>{for(const child of children)child.process.kill('SIGKILL');process.exit(1);},30000);deadline.unref();if(!children.size)process.exit(0);
 });
}else{
 const app=await createApplication();app.startWorkers();
 app.server.listen(Number(process.env.PORT)||3000,process.env.HOST||'0.0.0.0',()=>console.log('Avenor server listening on '+app.env.PUBLIC_URL));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);}));
}
