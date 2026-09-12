import { matches } from './core.js';
self.onmessage=({data})=>self.postMessage({id:data.id,ids:data.messages.filter(m=>matches(m,data.query)).map(m=>m.id)});
