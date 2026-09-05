/** Only fixed vocabulary and validated numbers cross the support-bundle boundary. */
export const OPERATIONS = ['unknown','request','auth','health','database','changes','bulk_docs','bulk_get','all_docs','revs_diff','find','index','purge','compact','document_read','document_write','attachment','backup','search_files','vault_status','list_files','read_file','read_files','get_file_outline','read_frontmatter','list_attachments','read_attachment','create_file','edit_file','append_file','patch_file','patch_frontmatter','delete_file'];
const EVENTS = ['operation_end','changes_wait','changes_end','backup_end','search_error','mcp_tool_start','mcp_tool_end','request_error'];
const OUTCOMES = ['unknown','success','error','partial','exception','cancelled','ok','canceled','exceededCpu','exceededMemory','internalError','scriptNotFound','responseStreamDisconnected'];
const CODES = ['cursor_expired','invalid_input','not_found','unsupported','too_large','unavailable','revision_conflict','conflict_reconciled','livesync_conflict','internal'];
export const number = (n, max = Number.MAX_SAFE_INTEGER) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
const member = (x, values) => values.includes(x) ? x : 'unknown';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) ? x : {};
const parsed = x => { if (typeof x !== 'string') return object(x); if (x.length > 65536) return {}; try { return object(JSON.parse(x)); } catch { return {}; } };

export function createSanitizer(start) {
  const aliases = new Map();
  const alias = id => {
    if (typeof id !== 'string' || !id || id.length > 256) return undefined;
    if (!aliases.has(id)) { if (aliases.size >= 50000) return undefined; aliases.set(id, `r${aliases.size + 1}`); }
    return aliases.get(id);
  };
  return (raw, role) => {
    raw = object(raw);
    const workers = object(raw.$workers), metadata = object(raw.$metadata);
    const timestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : raw.timestamp ?? raw.eventTimestamp;
    const base = { role: member(role, ['storage','mcp']), offsetMs: number(timestamp) ? Math.round(timestamp - start) : null };
    const request = alias(workers.requestId ?? metadata.requestId);
    if (request) base.request = request;
    const out = [];
    const add = (input, level) => {
      const value = parsed(input);
      if (!EVENTS.includes(value.event) || (value.schemaVersion !== undefined && value.schemaVersion !== 1)) return;
      const event = { ...base, event: value.event, operation: member(value.operation ?? value.tool, OPERATIONS), outcome: member(value.outcome, OUTCOMES) };
      const id = alias(value.requestId); if (id) event.request = id;
      for (const key of ['durationMs','waitMs','itemCount','failedItems','returnedChanges','concurrentWaits','bytes','pauseMs']) {
        if (number(value[key])) event[key] = value[key];
      }
      if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) event.status = value.status;
      if (typeof value.empty === 'boolean') event.empty = value.empty;
      if (typeof value.longpoll === 'boolean') event.longpoll = value.longpoll;
      if (value.reason !== undefined) event.reason = member(value.reason, ['change','timeout','cancelled','error','immediate']);
      if (Array.isArray(value.errorCodes)) event.errorCodes = [...new Set(value.errorCodes.slice(0,32).filter(c => CODES.includes(c)))];
      event.severity = ['error','exception','partial'].includes(event.outcome) || event.status >= 400 || level === 'error' ? 'error' : 'info';
      out.push(event);
    };
    add(raw, raw.level);
    add(raw.message, raw.level ?? metadata.level);
    // Some historical records expose structured console properties under `source`.
    add(raw.source, raw.level ?? metadata.level);
    add(parsed(raw.source).message, raw.level ?? metadata.level);
    for (const item of Array.isArray(raw.logs) ? raw.logs.slice(0,1000) : []) {
      const log=object(item);
      for (const value of Array.isArray(log.message) ? log.message.slice(0,32) : [log.message]) add(value, log.level);
    }
    const status = workers.event?.response?.status ?? raw.event?.response?.status ?? metadata.statusCode;
    const outcome = workers.outcome ?? raw.outcome;
    const exceptions = Array.isArray(raw.exceptions) && raw.exceptions.length > 0;
    const unknownLogError = typeof metadata.error === 'string' || (raw.level ?? metadata.level) === 'error' || (Array.isArray(raw.logs) && raw.logs.some(l => object(l).level === 'error'));
    if (exceptions || unknownLogError || (typeof outcome === 'string' && outcome !== 'ok') || (Number.isInteger(status) && status >= 400 && status <= 599)) {
      const event = { ...base, event:'platform_error', operation:'unknown', severity:'error', outcome:member(outcome,OUTCOMES), category: exceptions || (outcome && outcome !== 'ok') ? 'runtime' : status >= 400 ? 'http' : 'application' };
      if (Number.isInteger(status) && status >= 100 && status <= 599) event.status = status;
      out.push(event);
    }
    return out;
  };
}

// Checked 2026-09-05. Linear usage valuation, NOT invoice rounding or allowances.
export const RATES = {
  version:'2026-09-05', currency:'USD',
  sources:['https://developers.cloudflare.com/durable-objects/platform/pricing/','https://developers.cloudflare.com/workers/platform/pricing/'],
  perUnit: { workerRequests:0.30/1e6, workerCpuMs:0.02/1e6, doRequests:0.15/1e6, doDurationGbSeconds:12.50/1e6, rowsRead:0.001/1e6, rowsWritten:1/1e6 },
  freeDaily: { workerRequests:100000, doRequests:100000, doDurationGbSeconds:13000, rowsRead:5000000, rowsWritten:100000 },
  storageGbMonth:0.20,
};
export function costReport(metrics, start, end, plan) {
  if (!plan) return { status:'plan_unspecified' };
  if (plan === 'free') {
    const days = new Map();
    for (const metric of metrics) {
      if (metric.status !== 'available' || !RATES.freeDaily[metric.key]) continue;
      for (const bucket of metric.buckets) {
        const day = new Date(start + bucket.offsetMs).toISOString().slice(0,10);
        const id = `${day}:${metric.key}`;
        const item = days.get(id) ?? { date:day, metric:metric.key, observed:0, dailyAccountLimit:RATES.freeDaily[metric.key], completeUtcDay:start <= Date.parse(day) && end >= Date.parse(day)+86400000 };
        item.observed += bucket.value; days.set(id,item);
      }
    }
    return { status:'quota_comparison', reset:'00:00 UTC', scope:'project contribution to shared account limits', days:[...days.values()].map(x=>({...x,percent:x.observed/x.dailyAccountLimit*100})) };
  }
  const components = metrics.filter(m => m.status === 'available' && RATES.perUnit[m.key] !== undefined).map(m=>({metric:m.key,role:m.role,usd:m.value*RATES.perUnit[m.key]}));
  if(!components.length)return {status:'unavailable',reason:'no_priced_metrics_available'};
  const subtotalUsd = components.reduce((s,c)=>s+c.usd,0);
  return { status:'usage_valuation_subtotal', rates:RATES, components, subtotalUsd, projection30DaysUsd:subtotalUsd*2592000000/(end-start), assumptions:['Linear published overage rates; shared included allowances may reduce charges.','Invoice rounding, subscription, taxes, discounts, R2, logging and storage byte-time charges excluded.','Projection assumes unchanged workload; initial imports and short captures are not representative.'], excluded:['storage_byte_time','R2','logging','account_subscription'] };
}
export function efficiency(events, metrics, hours) {
  const polls = events.filter(e=>e.event==='changes_end' && e.longpoll && e.outcome==='success');
  const waits = events.filter(e=>e.event==='changes_wait');
  const duration = metrics.find(m=>m.key==='doDurationGbSeconds' && m.status==='available');
  return { observedCompletedPolls:polls.length, observedPollsPerHour:polls.length/hours, emptyPollFraction:polls.length ? polls.filter(e=>e.empty).length/polls.length : null,
    meanWaitMs:waits.length ? waits.reduce((s,e)=>s+(e.waitMs??0),0)/waits.length:null,
    peakObservedConcurrentWaits:waits.length?Math.max(...waits.map(e=>e.concurrentWaits??0)):null,
    waitReasons:Object.fromEntries(['change','timeout','cancelled','error'].map(r=>[r,waits.filter(e=>e.reason===r).length])),
    equivalentActiveObjectHours:duration ? duration.value/0.128/3600:null,
    rowsPerHour:Object.fromEntries(['rowsRead','rowsWritten'].map(k=>{const m=metrics.find(m=>m.key===k&&m.status==='available');return [k,m?m.value/hours:null]})),
    caveat:'Observed log ratios may be sampled/incomplete. Object-hours aggregate the namespace, not a wake/sleep trace. No occupancy percentage inferred.' };
}

/** Wrangler prints pretty JSON objects, not necessarily one JSON object per line. */
export function jsonObjects(onValue, maxBytes=1024*1024) {
  let buffer='', depth=0, quoted=false, escaped=false;
  return { push(chunk) {
    for (const c of chunk) {
      if (!depth) { if (/\s/.test(c)) continue; if (c !== '{') throw new Error('invalid_tail_json'); depth=1; buffer=c; continue; }
      buffer+=c;
      if (buffer.length > maxBytes) throw new Error('tail_record_limit');
      if (quoted) { if (escaped) escaped=false; else if(c==='\\') escaped=true; else if(c==='"') quoted=false; }
      else if(c==='"') quoted=true; else if(c==='{' || c==='[') depth++; else if(c==='}' || c===']') depth--;
      if(!depth) { onValue(JSON.parse(buffer)); buffer=''; }
    }
  }, end() { if(depth) throw new Error('incomplete_tail_json'); } };
}
export function summary(manifest, usage, events) {
  const lines=['# Cloudflare diagnostics', '', `${manifest.from} to ${manifest.to}`, '', 'Content-free metadata; activity patterns and timing remain visible.', '', '## Collection', ''];
  for(const [key,value] of Object.entries(manifest.sources)) lines.push(`- ${key}: ${value.status}${value.reason ? ` (${value.reason})`:''}`);
  if(Object.values(manifest.sources).some(s=>s.reason==='permission_denied'))lines.push('', 'Permission denied: refresh Wrangler login. Historical queries require Workers Observability Write; API tokens also need Account Analytics Read for metrics and Workers Scripts Read for target resolution. See docs/support-diagnostics.md.');
  lines.push('', 'Logs are limited by retention, sampling and ingestion lag. No errors found does not prove none occurred.', '', '## Usage', '', '| Metric | Role | Value | Unit |', '| --- | --- | ---: | --- |');
  for(const m of usage.metrics) lines.push(`| ${m.key} | ${m.role} | ${m.status==='available'?m.value:'unavailable'} | ${m.unit} |`);
  lines.push('', '## Cost / quotas', '', '```json', JSON.stringify(usage.cost,null,2), '```', '', '## Long-poll observations', '', '```json',JSON.stringify(usage.efficiency,null,2),'```','','## Errors','');
  const groups=new Map(); for(const e of events.filter(e=>e.severity==='error')) {const key=`${e.role}: ${e.operation} / ${e.outcome}${e.status?` / HTTP ${e.status}`:''}`;groups.set(key,(groups.get(key)??0)+1)}
  if(!groups.size) lines.push('No errors found in available records.');
  for(const [key,count] of groups) lines.push(`- ${key}: ${count} records`);
  lines.push('', 'Error records may describe the same invocation more than once. Events contain metadata only; exception messages and stacks are omitted.', '');
  return lines.join('\n');
}
