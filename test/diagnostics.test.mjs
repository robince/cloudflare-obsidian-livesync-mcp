import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSanitizer,costReport,efficiency,jsonObjects,summary} from '../scripts/diagnostics-format.mjs';
import {options,apiClient,collectLogs,collectMetrics,wranglerEnv} from '../scripts/diagnostics.mjs';
const secret='PRIVATE_SENTINEL_notes_token.md';
test('privacy allowlist rejects private values including allowed field injection',()=>{
 const sanitize=createSanitizer(1000);
 const raw={timestamp:1200,$metadata:{id:secret,error:secret,level:'error'},$workers:{scriptName:secret,requestId:secret,event:{request:{url:secret,headers:{authorization:secret}},response:{status:500}},outcome:'exception'},message:{schemaVersion:1,event:'mcp_tool_end',tool:secret,requestId:secret,outcome:'error',durationMs:4,errorCodes:['internal',secret],error:secret},logs:[{level:'error',message:[secret,{schemaVersion:1,event:'changes_wait',operation:'changes',reason:secret,outcome:secret,waitMs:secret}]}],exceptions:[{message:secret,stack:secret}]};
 const events=sanitize(raw,'storage');assert.ok(events.length>=2);assert.ok(events.some(e=>e.event==='platform_error'));assert.ok(events.some(e=>e.operation==='unknown'));
 assert.ok(!JSON.stringify(events).includes(secret));assert.equal(events[0].offsetMs,200);assert.equal(events[0].request,'r1');
 const version=sanitize({message:{schemaVersion:99,event:'changes_end',operation:'changes'}},'storage');assert.equal(version.length,0);
 const report=summary({from:'test',to:'test',sources:{}},{metrics:[],cost:{},efficiency:{}},events);assert.ok(!report.includes(secret));
});
test('tail parser accepts fragmented multiline JSON and rejects oversized or malformed streams',()=>{
 const values=[];const parser=jsonObjects(v=>values.push(v));
 const text=JSON.stringify({message:'quotes " { } \\',nested:[{x:1}]},null,2)+'\n'+JSON.stringify({b:2});
 for(const c of text)parser.push(c);parser.end();assert.equal(values.length,2);
 assert.throws(()=>jsonObjects(()=>{},8).push('{"long":1234567}'));
 assert.throws(()=>jsonObjects(()=>{}).push(secret));
 const partial=jsonObjects(()=>{});partial.push('{');assert.throws(()=>partial.end());
});
test('arguments enforce bounded historical UTC windows',()=>{
 const now=Date.parse('2026-09-05T10:00:00Z');
 assert.equal(options(['report','--storage-worker','sync'],now).start,now-86400000);
 assert.throws(()=>options(['report','--storage-worker','sync','--since','32d'],now));
 assert.throws(()=>options(['report','--storage-worker','sync','--since','1h','--from','2026-09-05T00:00:00Z'],now));
 assert.throws(()=>options(['report','--storage-worker',secret],now));
 assert.throws(()=>options(['capture','--storage-worker','sync','--duration','0'],now));
 assert.equal(wranglerEnv().WRANGLER_WRITE_LOGS,'false');
});
test('API errors never include raw text or credentials; permissions are not retried',async()=>{
 let calls=0;const api=apiClient({authorization:secret},async()=>{calls++;return new Response(secret,{status:403})});
 await assert.rejects(api('/graphql',{}),e=>!e.message.includes(secret)&&e.safeCode==='permission_denied');assert.equal(calls,1);
 await assert.rejects(apiClient({},async()=>new Response(JSON.stringify({errors:[{message:secret}]})))('/graphql',{}),e=>!e.message.includes(secret));
});
test('historical logs paginate, deduplicate and preserve safe context',async()=>{
 const events=[];let calls=0;
 const first=Array.from({length:500},(_,i)=>({timestamp:1001,$metadata:{id:`${i}`},message:{event:'mcp_tool_end',tool:'read_file',outcome:'error'}}));
 const api=async(_path,body)=>{calls++;assert.equal(body.parameters.filters[0].value,'sync');if(calls===2)assert.equal(body.offset,'499');return {run:{status:'COMPLETED'},events:{events:calls===1?first:[first[0],{timestamp:1002,$metadata:{id:'last',level:'error'},message:secret}]}}};
 const result=await collectLogs(api,'account',{name:'sync',role:'storage'},1000,2000,createSanitizer(1000),events);
 assert.equal(calls,2);assert.equal(events.length,501);assert.equal(result.status,'collected');assert.ok(!JSON.stringify(events).includes(secret));
});
test('log pagination cannot silently loop on a repeated cursor',async()=>{
 const rows=Array.from({length:500},()=>({$metadata:{id:'same'}}));
 await assert.rejects(collectLogs(async()=>({events:{events:rows}}),'a',{name:'s',role:'storage'},0,1000,createSanitizer(0),[]),/pagination/);
});
test('costs use source units and omit unavailable dimensions; quotas split by UTC day',()=>{
 const metric=(key,value,role='namespace')=>({key,value,role,status:'available',buckets:[{offsetMs:0,value}]});
 const metrics=[metric('doDurationGbSeconds',400000),metric('rowsWritten',1e6),metric('rowsRead',1e6),metric('workerCpuMs',1e6,'storage')];
 const cost=costReport(metrics,0,86400000,'paid');assert.ok(Math.abs(cost.subtotalUsd-6.021)<1e-9);assert.ok(Math.abs(cost.projection30DaysUsd-180.63)<1e-9);
 assert.equal(costReport([],0,1000).status,'plan_unspecified');
 const quota=costReport([metric('rowsRead',100)],0,3600000,'free');assert.equal(quota.days[0].completeUtcDay,false);
 const combined=costReport([metric('workerRequests',100,'storage'),metric('workerRequests',200,'mcp')],0,86400000,'free');assert.equal(combined.days[0].observed,300);
});
test('awake time derives only from platform duration, never overlapping requests',()=>{
 const events=[{event:'changes_end',longpoll:true,outcome:'success',durationMs:3600000,empty:true},{event:'changes_end',longpoll:true,outcome:'success',durationMs:3600000,empty:false}];
 const e=efficiency(events,[{key:'doDurationGbSeconds',status:'available',value:460.8}],1);
 assert.ok(Math.abs(e.equivalentActiveObjectHours-1)<1e-9);assert.equal(e.emptyPollFraction,.5);assert.equal(e.occupancyPercent,undefined);
 assert.equal(efficiency(events,[],1).equivalentActiveObjectHours,null);
});
test('metric collection converts CPU units and keeps unavailable sources explicit',async()=>{
 const api=async(_path,{query})=>{
  if(query.includes('__type')) return {fields:{fields:['duration','cpuTime','rowsRead','rowsWritten','requests','cpuTimeUs'].map(name=>({name}))},filters:{inputFields:['namespaceId','scriptName','datetime_geq','datetime_lt'].map(name=>({name}))}};
  return {viewer:{accounts:[{rows:[{dimensions:{datetimeHour:'1970-01-01T00:00:00Z'},sum:{duration:128,cpuTime:1000,rowsRead:10,rowsWritten:2,requests:3,cpuTimeUs:2000}}]}]}};
 };
 const result=await collectMetrics(api,'a','n',[{role:'storage',name:'w'}],0,3600000);
 assert.equal(result.metrics.find(m=>m.key==='doCpuMs').value,1);assert.equal(result.metrics.find(m=>m.key==='workerCpuMs').value,2);
 assert.equal(result.metrics.find(m=>m.key==='storedBytes').status,'unavailable');
});

test('generated GraphQL queries have balanced selection sets', async()=>{
 const queries=[];
 await collectMetrics(async(_path,{query})=>{queries.push(query);if(query.includes('__type'))return {fields:{fields:[{name:'requests'},{name:'duration'}]},filters:{inputFields:['namespaceId','scriptName','datetime_geq','datetime_lt'].map(name=>({name}))}};return {viewer:{accounts:[{rows:[]}]}}},'a','n',[{role:'storage',name:'w'}],0,1000);
 for(const query of queries) {const structural=query.replace(/"(?:[^"\\]|\\.)*"/g,'');assert.equal([...structural].filter(c=>c==='{').length,[...structural].filter(c=>c==='}').length);}
});

test('historical metadata-only errors remain visible without their message',()=>{
 const events=createSanitizer(0)({timestamp:100,source:secret,$metadata:{error:secret}},'storage');
 assert.equal(events.length,1);assert.equal(events[0].category,'application');assert.ok(!JSON.stringify(events).includes(secret));
});

test('live capture terminates children and sanitizes fragmented events',async()=>{
 const {capture}=await import('../scripts/diagnostics.mjs');
 const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
 const events=[];let killed=false;
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 child.kill=signal=>{killed=true;child.stdout.end();queueMicrotask(()=>child.emit('close',null,signal));return true};
 const spawn=()=>{setTimeout(()=>{const raw=JSON.stringify({timestamp:100,message:{event:'mcp_tool_end',tool:'read_file',outcome:'error',message:secret}});child.stdout.write(raw.slice(0,10));child.stdout.write(raw.slice(10));},10);return child};
 const sources=await capture([{name:'sync',role:'storage'}],'a',.03,createSanitizer(0),events,spawn);
 assert.equal(killed,true);assert.equal(events.length,1);assert.equal(sources.logs_storage.status,'collected');assert.ok(!JSON.stringify(events).includes(secret));
});
