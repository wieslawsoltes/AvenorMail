import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'), out=resolve(root,'pages');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
await cp(resolve(root,'public'),out,{recursive:true});
await build({entryPoints:[resolve(root,'public/app.js'),resolve(root,'public/benchmark.js')],outdir:out,bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked',sourcemap:true});
const hash=createHash('sha256');hash.update(await readFile(new URL(import.meta.url)));for(const name of (await readdir(out)).sort())if(name!=='sw.js')hash.update(name).update(await readFile(resolve(out,name)));
const version=hash.digest('hex').slice(0,16);
// Unique entry URLs let a fresh HTML shell bypass an older worker's asset cache.
const entry=`app-${version}.js`,style=`style-${version}.css`;
await rename(resolve(out,'app.js'),resolve(out,entry));await rename(resolve(out,'style.css'),resolve(out,style));
const html=await readFile(resolve(out,'index.html'),'utf8');await writeFile(resolve(out,'index.html'),html.replace('./app.js','./'+entry).replace('./style.css','./'+style));
const sw=await readFile(resolve(out,'sw.js'),'utf8');await writeFile(resolve(out,'sw.js'),sw.replace("PREFIX + 'v4'",`PREFIX + '${version}'`).replace("'app.js'",`'${entry}'`).replace("'style.css'",`'${style}'`));
await writeFile(resolve(out,'.nojekyll'),'');
await writeFile(resolve(out,'build.json'),JSON.stringify({version,commit:process.env.GITHUB_SHA||null}));
console.log(`Built portable Avenor frontend: pages/ (${version})`);
