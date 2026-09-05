import { parseArgs } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSanitizer, costReport, efficiency, summary, jsonObjects, number } from './diagnostics-format.mjs';
const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../',import.meta.url));
const API = 'https://api.cloudflare.com/client/v4';
const MAX_EVENTS=50000, MAX_BYTES=8*1024*1024;
const failure = code => Object.assign(new Error(code), { safeCode:code });
const safeCode = error => error?.safeCode ?? 'collection_failed';
export const wranglerEnv = () => {
  const env={...process.env,WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'error',WRANGLER_LOG_SANITIZE:'true',CI:'true',NO_COLOR:'1'};
  delete env.WRANGLER_OUTPUT_FILE_PATH; delete env.WRANGLER_OUTPUT_FILE_DIRECTORY;
  return env;
};
async function wranglerPath() {
  const pkg=JSON.parse(await readFile(join(ROOT,'node_modules/wrangler/package.json'),'utf8'));
  // This installed release was inspected for supported auth JSON and WRITE_LOGS=false.
  if (Number(pkg.version.split('.')[0])!==4 || Number(pkg.version.split('.')[1])<127) throw failure('requires_wrangler_4_127_or_newer');
  return join(ROOT,'node_modules/wrangler/bin/wrangler.js');
}
export async function credentials() {
  try {
    const bin=await wranglerPath();
    // `log` level is required for the JSON token result; disk output stays disabled.
    const {stdout}=await exec(process.execPath,[bin,'auth','token','--json'],{cwd:ROOT,env:{...wranglerEnv(),WRANGLER_LOG:'log'},timeout:30000,maxBuffer:65536});
    const value=JSON.parse(stdout);
    if (['oauth','api_token'].includes(value.type) && typeof value.token==='string' && value.token.length<16384) return {authorization:`Bearer ${value.token}`};
    if(value.type==='api_key' && typeof value.key==='string' && value.key.length<16384 && typeof value.email==='string' && value.email.length<1024) return {'X-Auth-Key':value.key,'X-Auth-Email':value.email};
    throw failure('unsupported_credentials');
  } catch(error) { throw failure(error.safeCode ?? 'wrangler_auth_failed_run_wrangler_login'); }
}
export function apiClient(headers, fetcher=fetch) {
  let calls=0;
  const deadline=Date.now()+10*60*1000;
  return async (path,body) => {
    for(let attempt=0;attempt<3;attempt++) {
      if(++calls>250 || Date.now()>=deadline)throw failure('collection_request_or_time_limit');
      let response;
      try { response=await fetcher(`${API}${path}`,{method:body?'POST':'GET',headers:{...headers,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)}); }
      catch { if(attempt<2) {await new Promise(r=>setTimeout(r,250*2**attempt));continue;} throw failure('network_failed'); }
      if(response.status===401 || response.status===403) {await response.body?.cancel();throw failure('permission_denied');}
      if((response.status===429 || response.status>=500) && attempt<2) {await response.body?.cancel();await new Promise(r=>setTimeout(r,250*2**attempt));continue;}
      if(!response.ok) {await response.body?.cancel();throw failure(`api_http_${response.status}`);}
      let text='',size=0; const decoder=new TextDecoder();
      try {for await(const chunk of response.body) {size+=chunk.byteLength;if(size>MAX_BYTES) throw failure('response_limit');text+=decoder.decode(chunk,{stream:true});}text+=decoder.decode();}
      catch(error) {throw failure(error.safeCode??'response_interrupted');}
      let json;try{json=JSON.parse(text)}catch{throw failure('invalid_api_json')}
      if(json.success===false || json.errors?.length) throw failure('api_query_failed_check_permissions_and_window');
      return path==='/graphql'?json.data:json.result;
    }
  };
}
export function options(args, now=Date.now()) {
  let parsed;try{parsed=parseArgs({args,allowPositionals:true,options:Object.fromEntries(['storage-worker','mcp-worker','account-id','namespace-id','out','since','from','to','plan','duration'].map(k=>[k,{type:'string'}]).concat([['help',{type:'boolean'}]]))})}catch{throw failure('invalid_arguments')}
  const v=parsed.values, command=parsed.positionals[0];
  if(v.help) return {help:true};
  if(!['report','capture'].includes(command) || parsed.positionals.length!==1) throw failure('use_report_or_capture');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(v['storage-worker']??'')) throw failure('storage_worker_required');
  if(v['mcp-worker'] && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(v['mcp-worker'])) throw failure('invalid_mcp_worker');
  if(v['mcp-worker']===v['storage-worker'])throw failure('worker_names_must_differ');
  for(const k of ['account-id','namespace-id']) if(v[k] && !/^[a-f0-9]{32}$/i.test(v[k])) throw failure('invalid_resource_id');
  if(v.plan && !['free','paid'].includes(v.plan)) throw failure('plan_must_be_free_or_paid');
  if(v.since && (v.from||v.to) || Boolean(v.from)!==Boolean(v.to)) throw failure('use_since_or_from_and_to');
  if(command==='capture'&&(v.from||v.to||v.since)) throw failure('capture_uses_current_time');
  if(command==='report'&&v.duration) throw failure('duration_is_for_capture');
  let end=now,start;
  if(v.from) {
    if(![v.from,v.to].every(s=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s))) throw failure('use_utc_iso_dates');
    start=Date.parse(v.from);end=Date.parse(v.to);
    if(![v.from,v.to].every(value=>{const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value.replace(/(?<=:\d{2})Z$/,'.000Z')}))throw failure('invalid_calendar_date');
  } else {const match=/^(\d+)(m|h|d)$/.exec(v.since??'24h');if(!match) throw failure('invalid_since');start=end-Number(match[1])*{m:60000,h:3600000,d:86400000}[match[2]];}
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>now||end-start>31*86400000) throw failure('window_must_be_past_and_at_most_31_days');
  const duration=Number(v.duration??120);if(!Number.isInteger(duration)||duration<1||duration>3600)throw failure('duration_must_be_1_to_3600_seconds');
  return {command,start:command==='capture'?now:start,end, duration,plan:v.plan,account:v['account-id']??process.env.CLOUDFLARE_ACCOUNT_ID,namespace:v['namespace-id'],out:resolve(v.out??`diagnostics-${new Date(now).toISOString().replaceAll(':','-')}`),workers:[{role:'storage',name:v['storage-worker']},...(v['mcp-worker']?[{role:'mcp',name:v['mcp-worker']}]:[])]};
}
export async function resolveAccount(api, supplied) {
  if(supplied) {if(!/^[a-f0-9]{32}$/i.test(supplied))throw failure('invalid_account_id');return supplied;}
  const accounts=await api('/accounts?per_page=2');
  if(!Array.isArray(accounts)||accounts.length!==1) throw failure('specify_account_id');
  if(!/^[a-f0-9]{32}$/i.test(accounts[0].id))throw failure('invalid_account_response');
  return accounts[0].id;
}
async function namespaceFor(api,account,worker,supplied) {
  const settings=await api(`/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/settings`);
  const bindings=(settings?.bindings??[]).filter(b=>b.type==='durable_object_namespace');
  const ids=[...new Set(bindings.filter(b=>b.name==='POUCH_DATABASES'||b.class_name==='PouchDatabase').map(b=>b.namespace_id).filter(x=>/^[a-f0-9]{32}$/i.test(x)))];
  if(supplied) {if(!bindings.some(b=>b.namespace_id===supplied))throw failure('namespace_not_bound_to_storage_worker');return supplied;}
  if(ids.length!==1)throw failure('specify_namespace_id');return ids[0];
}
const SPECS=[
  {dataset:'durableObjectsPeriodicGroups',type:'AccountDurableObjectsPeriodicGroups',role:'namespace',filter:'namespaceId',fields:[['doDurationGbSeconds','duration','GB-s',1],['doCpuMs','cpuTime','ms',.001],['rowsRead','rowsRead','rows',1],['rowsWritten','rowsWritten','rows',1]]},
  {dataset:'durableObjectsInvocationsAdaptiveGroups',type:'AccountDurableObjectsInvocationsAdaptiveGroups',role:'namespace',filter:'namespaceId',fields:[['doRequests','requests','requests',1]]},
  {dataset:'workersInvocationsAdaptive',type:'AccountWorkersInvocationsAdaptive',filter:'scriptName',fields:[['workerRequests','requests','requests',1],['workerCpuMs','cpuTimeUs','ms',.001]]},
];
export async function collectMetrics(api,account,namespace,workers,start,end) {
  const metrics=[],sources={};
  for(const spec of SPECS) for(const target of spec.role?[{role:spec.role,name:namespace}]:workers) {
    const statusKey=`metrics_${target.role}_${spec.dataset}`;
    const entries=spec.fields.map(([key,field,unit,scale])=>({key,field,unit,scale,role:target.role,source:spec.dataset,status:'unavailable',buckets:[]}));
    metrics.push(...entries);
    try {
      if(!target.name)throw failure('namespace_unavailable');
      const schema=await api('/graphql',{query:`{fields:__type(name:"${spec.type}Sum"){fields{name description}} filters:__type(name:"${spec.type}Filter_InputObject"){inputFields{name}}}`});
      const fields=schema?.fields?.fields??[], filters=schema?.filters?.inputFields?.map(f=>f.name)??[];
      if(![spec.filter,'datetime_geq','datetime_lt'].every(f=>filters.includes(f)))throw failure('unsupported_metric_filter');
      const supported=entries.filter(e=>fields.some(f=>f.name===e.field));
      if(!supported.length)throw failure('unsupported_metric_fields');
      // Hour groups bound 31-day reports to at most 745 rows per dataset.
      const filter=`${spec.filter}:${JSON.stringify(target.name)},datetime_geq:${JSON.stringify(new Date(start).toISOString())},datetime_lt:${JSON.stringify(new Date(end).toISOString())}`;
      const result=await api('/graphql',{query:`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){rows:${spec.dataset}(limit:1000,filter:{${filter}}){dimensions{datetimeHour} sum{${supported.map(e=>e.field).join(' ')}}}}}}`});
      const rows=result?.viewer?.accounts?.[0]?.rows;
      if(!Array.isArray(rows)||rows.length>=1000)throw failure('invalid_or_truncated_metric_response');
      for(const row of rows) {
        const hour=Date.parse(row.dimensions?.datetimeHour);
        if(!Number.isFinite(hour)||hour+3600000<=start||hour>=end)throw failure('invalid_metric_bucket');
        for(const entry of supported) {
          const raw=row.sum?.[entry.field];
          if(!number(raw))throw failure('invalid_metric_value');
          entry.buckets.push({offsetMs:Math.max(hour,start)-start,durationMs:Math.min(hour+3600000,end)-Math.max(hour,start),value:raw*entry.scale});
        }
      }
      for(const e of supported)e.buckets.sort((a,b)=>a.offsetMs-b.offsetMs);
      for(const e of supported){e.status='available';e.value=e.buckets.reduce((s,b)=>s+b.value,0);e.sourceUnit=e.scale===.001?'microseconds':e.unit;}
      sources[statusKey]={status:supported.length===entries.length?'collected':'partial',reason:'platform_sampling_and_recent_ingestion_may_apply'};
    } catch(error){sources[statusKey]={status:'unavailable',reason:safeCode(error)};for(const e of entries)e.buckets=[];}
    for(const e of entries){delete e.field;delete e.scale;}
  }
  // SQL storage is a namespace gauge, not additive rows or legacy KV usage.
  const storage={key:'storedBytes',role:'namespace',source:'durableObjectsSqlStorageGroups',unit:'bytes',status:'unavailable',buckets:[]};metrics.push(storage);
  try {
    if(!namespace)throw failure('namespace_unavailable');
    const schema=await api('/graphql',{query:'{g:__type(name:"AccountDurableObjectsSqlStorageGroupsMax"){fields{name}}}'});
    if(!schema?.g?.fields?.some(f=>f.name==='storedBytes'))throw failure('unsupported_storage_gauge');
    const result=await api('/graphql',{query:`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){rows:durableObjectsSqlStorageGroups(limit:10000,filter:{namespaceId:${JSON.stringify(namespace)},datetime_geq:${JSON.stringify(new Date(start).toISOString())},datetime_lt:${JSON.stringify(new Date(end).toISOString())}}){dimensions{datetimeHour} max{storedBytes}}}}}`});
    const rows=result?.viewer?.accounts?.[0]?.rows;if(!Array.isArray(rows)||rows.length>=10000)throw failure('storage_gauge_incomplete');
    const buckets=new Map();
    for(const row of rows){const ts=Date.parse(row.dimensions?.datetimeHour),n=row.max?.storedBytes;if(!number(n)||!Number.isFinite(ts))throw failure('invalid_storage_gauge');buckets.set(ts,(buckets.get(ts)??0)+n);}
    storage.buckets=[...buckets].sort((a,b)=>a[0]-b[0]).map(([ts,value])=>({offsetMs:ts-start,value}));
    if(storage.buckets.length){storage.status='available';storage.value=storage.buckets.at(-1).value;storage.peakBytes=Math.max(...storage.buckets.map(b=>b.value));}
    sources.storage_gauge={status:storage.status==='available'?'collected':'unavailable',reason:'namespace_hourly_maxima_not_instantaneous_storage'};
  }catch(error){sources.storage_gauge={status:'unavailable',reason:safeCode(error)};}
  return {metrics,sources};
}
export async function collectLogs(api,account,worker,start,end,sanitize,events) {
  let offset;const seen=new Set();let pages=0,abr=1;
  while(pages++<100 && events.length<MAX_EVENTS) {
    const result=await api(`/accounts/${account}/workers/observability/telemetry/query`,{queryId:'livesync-diagnostics-v1',dry:true,view:'events',limit:500,timeframe:{from:start,to:end},parameters:{filters:[{key:'$workers.scriptName',operation:'eq',type:'string',value:worker.name}],filterCombination:'and',orderBy:{value:'timestamp',order:'asc'}},...(offset?{offset,offsetDirection:'next'}:{})});
    if(result?.run?.status && result.run.status!=='COMPLETED')throw failure('log_query_incomplete');
    const rows=Array.isArray(result?.events)?result.events:result?.events?.events;
    if(!Array.isArray(rows))throw failure('invalid_log_response');
    abr=Math.max(abr,number(result.statistics?.abr_level)?result.statistics.abr_level:1);
    for(const row of rows) {
      const id=row.$metadata?.id;
      if(typeof id==='string' && seen.has(id))continue;
      if(typeof id==='string')seen.add(id);
      const service=row.$workers?.scriptName ?? row.$metadata?.service;
      if(service && service!==worker.name)continue;
      const sanitized=sanitize(row,worker.role);
      for(const event of sanitized){if(events.length===MAX_EVENTS)break;events.push(event);}
    }
    if(events.length>=MAX_EVENTS)return {status:'partial',reason:'event_limit',abrLevel:abr};
    if(rows.length<500) return {status:'collected',reason:'retention_sampling_and_ingestion_limit_coverage',abrLevel:abr};
    const next=rows.at(-1)?.$metadata?.id;
    if(typeof next!=='string'||next===offset)throw failure('log_pagination_incomplete');offset=next;
  }
  return {status:'partial',reason:'event_or_page_limit',abrLevel:abr};
}
export async function capture(workers,account,duration,sanitize,events,spawnChild=spawn) {
  const bin=await wranglerPath(), children=[],sources={};let interrupted=false, stopCause, killTimer;
  const terminate=cause=>{stopCause??=cause;for(const child of children)child.kill('SIGTERM');killTimer??=setTimeout(()=>{for(const child of children)child.kill('SIGKILL')},5000)};
  const stop=()=>{interrupted=true;terminate('interrupted')};process.once('SIGINT',stop);
  const timer=setTimeout(()=>terminate('duration'),duration*1000);
  try {
    await Promise.all(workers.map(worker=>new Promise(resolveChild=>{
      let ended=false,received=false;const key=`logs_${worker.role}`;sources[key]={status:'collected',reason:'live_tail_may_be_sampled'};
      const child=spawnChild(process.execPath,[bin,'tail',worker.name,'--format','json'],{cwd:ROOT,env:{...wranglerEnv(),CLOUDFLARE_ACCOUNT_ID:account},stdio:['ignore','pipe','pipe']});children.push(child);
      const parser=jsonObjects(raw=>{if(!received){received=true;console.log('Live event received; capture connection confirmed.')}if(raw?.type && raw?.message && !raw?.event){sources[key]={status:'partial',reason:'tail_platform_notice'};}for(const event of sanitize(raw,worker.role)){if(events.length>=MAX_EVENTS)throw failure('event_limit');events.push(event)}});
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{try{parser.push(chunk)}catch{sources[key]={status:'partial',reason:'tail_json_or_event_limit'};terminate('tail_json_or_event_limit')}});
      child.stderr.resume();
      const finish=(code,signal)=>{if(ended)return;ended=true;if(sources[key].status==='collected'){try{parser.end()}catch{sources[key]={status:'partial',reason:'incomplete_tail_json'}}if(stopCause && stopCause!=='duration')sources[key]={status:'partial',reason:stopCause};if(!stopCause || (code!==0&&!signal))sources[key]={status:'partial',reason:'tail_failed_check_worker_and_permissions'};if(!received && sources[key].status==='collected')sources[key]={status:'partial',reason:'no_events_connection_unconfirmed'};}resolveChild()};
      child.on('error',()=>{sources[key]={status:'unavailable',reason:'tail_start_failed'};finish(1)});child.on('close',finish);
    })));
  } finally {clearTimeout(timer);clearTimeout(killTimer);process.removeListener('SIGINT',stop);}
  if(interrupted)for(const value of Object.values(sources)){value.status='partial';value.reason='interrupted';}
  return sources;
}
export async function main(args=process.argv.slice(2), {authenticate=credentials, captureTail=capture}={}) {
  const config=options(args);
  if(config.help){console.log('Usage: npm run diagnostics -- report|capture --storage-worker NAME [--mcp-worker NAME] [--since 24h | --from UTC --to UTC] [--plan free|paid] [--account-id ID] [--namespace-id ID] [--duration 120] [--out NEW_DIRECTORY]');return;}
  await mkdir(config.out,{recursive:false,mode:0o700});
  const events=[],sanitize=createSanitizer(config.start);let metrics=[];const sources={};
  try {
    const api=apiClient(await authenticate());
    const account=await resolveAccount(api,config.account);
    if(config.command==='capture') { console.log('Starting live capture. Connection is confirmed when the first event arrives; reproduce the problem during the capture window.'); config.start=Date.now(); Object.assign(sources,await captureTail(config.workers,account,config.duration,createSanitizer(config.start),events)); }
    else {
      let namespace;try{namespace=await namespaceFor(api,account,config.workers[0].name,config.namespace);sources.namespace={status:'resolved'}}catch(error){sources.namespace={status:'unavailable',reason:safeCode(error)}}
      console.log('Collecting project metrics and retained diagnostic events…');
      const validWorkers=[];
      for(const worker of config.workers){try{await api(`/accounts/${account}/workers/scripts/${encodeURIComponent(worker.name)}/settings`);validWorkers.push(worker)}catch(error){sources[`worker_${worker.role}`]={status:'unavailable',reason:safeCode(error)}}}
      const collected=await collectMetrics(api,account,namespace,validWorkers,config.start,config.end);metrics=collected.metrics;Object.assign(sources,collected.sources);
      for(const worker of config.workers){try{sources[`logs_${worker.role}`]=await collectLogs(api,account,worker,config.start,config.end,sanitize,events)}catch(error){sources[`logs_${worker.role}`]={status:'partial',reason:safeCode(error)}}}
    }
  } catch(error){sources.authentication={status:'unavailable',reason:safeCode(error)};}
  if(config.command==='capture')config.end=Date.now();
  events.sort((a,b)=>(a.offsetMs??0)-(b.offsetMs??0));
  const manifest={schemaVersion:1,toolVersion:'1',command:config.command,from:new Date(config.start).toISOString(),to:new Date(config.end).toISOString(),sources,eventCount:events.length};
  const usage={schemaVersion:1,metrics,cost:costReport(metrics,config.start,config.end,config.plan),efficiency:efficiency(events,metrics,(config.end-config.start)/3600000)};
  for(const [name,content] of [['manifest.json',JSON.stringify(manifest,null,2)],['usage.json',JSON.stringify(usage,null,2)],['events.jsonl',events.map(e=>JSON.stringify(e)).join('\n')+(events.length?'\n':'')],['summary.md',summary(manifest,usage,events)]])await writeFile(join(config.out,name),content,{flag:'wx',mode:0o600});
  const partial=Object.values(sources).some(s=>['partial','unavailable'].includes(s.status));
  console.log(partial?'Partial diagnostic bundle written. Read summary.md for coverage and authentication guidance.':'Diagnostic bundle written. Review summary.md before sharing.');
  if(partial)process.exitCode=2;
  return {manifest,usage,events};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(`Diagnostics failed: ${safeCode(error)}. Use --help for options.`);process.exitCode=1});
