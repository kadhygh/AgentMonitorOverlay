import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../../src/api/taskLaunchClient.ts',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const api=await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
test('request failure preserves HTTP status for known rejection versus uncertain retry',async()=>{const original=globalThis.fetch;globalThis.fetch=async()=>({ok:false,status:409,json:async()=>({message:'operation conflict',code:'task_launch_operation_conflict'})});try{await assert.rejects(api.createTaskLaunch({operationId:'same-request'}),e=>e instanceof api.TaskLaunchError&&e.status===409&&e.code==='task_launch_operation_conflict'&&e.message==='operation conflict');}finally{globalThis.fetch=original;}});
test('receipt lookup reads escaped Card identity without POST',async()=>{const original=globalThis.fetch;const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({task:{cardId:'a/b',state:'unknown'}})}};try{await api.loadTaskLaunch('a/b');assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/task-launches/a%2Fb'));assert.equal(calls[0].options.method,undefined);}finally{globalThis.fetch=original;}});
test('first prompt remains data with exact multiline and shell characters',async()=>{const original=globalThis.fetch;let posted;globalThis.fetch=async(url,options)=>{posted=JSON.parse(options.body);return{ok:true,json:async()=>({task:{cardId:'card'}})}};const prompt='你好\n`$HOME; $(whoami) "quotes"';try{await api.createTaskLaunch({operationId:'one',prompt});assert.equal(posted.prompt,prompt);assert.equal(posted.operationId,'one');}finally{globalThis.fetch=original;}});


