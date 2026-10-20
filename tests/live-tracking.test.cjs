const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const tracking = html.slice(html.indexOf('function haversine('), html.indexOf('/* ===== Compact fleet GPS sync:'));

function harness(plugin = null) {
  const calls = [], events = {}, storage = new Map([['smou-gps-outbox-v1', '[{"old":"route"}]']]);
  let timer = 0, watch = 0;
  const intervals = new Map(), watches = new Map(), pendingEnd = new Set();
  const state = {token:'session-1', driverId:'driver-1', screen:'driver', shifts:[{id:'shift-1', status:'ACTIVE'}]};
  const context = vm.createContext({
    SGT: plugin, SUPABASE_URL:'https://example.test', SUPABASE_ANON_KEY:'anon', state,
    navigator: {onLine:true, geolocation:{
      watchPosition(success, error) { watches.set(++watch, {success,error}); return watch; },
      clearWatch(id) { watches.delete(id); }, getCurrentPosition() {}
    }},
    localStorage:{removeItem(key) { storage.delete(key); }},
    sb:{async rpc(name, args) { calls.push({name,args}); return {error:null}; }},
    window:{addEventListener(name, fn) { events[name] = fn; }},
    setInterval(fn, ms) { intervals.set(++timer,{fn,ms}); return timer; },
    clearInterval(id) { intervals.delete(id); },
    acquireWake(){}, releaseWake(){}, updateDriverGps(){}, toast(){}, L10:k=>k, friendly:k=>k,
    dgPaint(){}, gpsNotificationNotice(){}, forceDriverLogout() { state.token=null; }, async loadDriver(){}, render(){},
    activeShift() { return state.shifts.find(s=>s.status==='ACTIVE'); },
    dqHasEnd:sid=>pendingEnd.has(String(sid)),
    console
  });
  vm.runInContext(tracking + '\nthis.api={live,startLiveWatch,stopLiveWatch,onFix,gpsCheckNativeStatus,gpsResumeLive,op:()=>gpsNativeOp};', context);
  return {api:context.api, calls, events, storage, intervals, watches, state, pendingEnd};
}
async function flush(h) { await h.api.op(); await Promise.resolve(); await Promise.resolve(); }
function fix(h) { h.api.onFix(29.3759,47.9774,12,0,5,Date.now()); }

test('all inline scripts parse in driver and any adjacent ERP checkout', () => {
  const filenames = [path.join(__dirname, '../index.html')];
  const adjacentErp = path.join(__dirname, '../../erp/index.html');
  if (fs.existsSync(adjacentErp)) filenames.push(adjacentErp);
  for (const filename of filenames) {
    const file = fs.readFileSync(filename,'utf8');
    let count=0;
    for (const match of file.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1].trim()) { new vm.Script(match[1], {filename:`${filename}:inline-${++count}`}); }
    }
    assert.ok(count > 0);
  }
});

test('legacy route outbox is removed and foreground fallback uploads latest positions only', async () => {
  const h=harness();
  assert.equal(h.storage.has('smou-gps-outbox-v1'),false);
  assert.doesNotMatch(tracking,/driver_add_points|shift_points|queuePoint/);
  h.api.startLiveWatch('shift-1');fix(h);await flush(h);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].name,'driver_update_live');
  assert.equal(h.calls[0].args.p_point,false);
  assert.equal(h.api.live.queue,undefined);
});

test('web fallback uploads while native start awaits confirmation, then hands over', async () => {
  let ready;
  const h=harness({stop:async()=>{}, start:()=>new Promise(resolve=>{ready=resolve;})});
  h.api.startLiveWatch('shift-1');
  await new Promise(setImmediate);
  assert.equal(h.api.live.starting,true);
  assert.equal(h.api.live.native,false);
  fix(h);await Promise.resolve();assert.equal(h.calls.length,1);
  ready({running:true,shiftId:'shift-1'});await flush(h);
  assert.equal(h.api.live.native,true);
  assert.equal(h.api.live.starting,false);
  assert.equal(h.intervals.size,0);
});

test('native denied permission cannot silently disable uploads or claim active tracking', async () => {
  let starts=0;
  const h=harness({stop:async()=>{},start:async()=>{starts++;return {running:false,shiftId:'shift-1',reason:'LOCATION_PERMISSION_DENIED'};}});
  h.api.startLiveWatch('shift-1');await flush(h);
  assert.equal(h.api.live.native,false);
  assert.equal(h.api.live.nativeError,'LOCATION_PERMISSION_DENIED');
  fix(h);await Promise.resolve();assert.equal(h.calls.length,1);
  h.api.startLiveWatch('shift-1');await flush(h);
  assert.equal(starts,1,'renders must not continuously prompt or restart the failed service');
  h.api.live.nativeRetryAt=0;h.api.gpsCheckNativeStatus();await flush(h);assert.equal(starts,2);
});

test('old APK start without result requires isRunning confirmation', async () => {
  const h=harness({stop:async()=>{},start:async()=>{},isRunning:async()=>({running:false,shiftId:'shift-1'})});
  h.api.startLiveWatch('shift-1');await flush(h);
  assert.equal(h.api.live.native,false);
  assert.equal(h.api.live.nativeError,'START_FAILED');
});
test('old APK can hand over uploads only after its native service confirms running', async () => {
  const h=harness({stop:async()=>{},start:async()=>{},isRunning:async()=>({running:true})});
  h.api.startLiveWatch('shift-1');await flush(h);
  assert.equal(h.api.live.native,true);
  assert.equal(h.api.live.nativeError,null);
  assert.equal(h.intervals.size,0);
});

test('a late native start cannot reactivate a clocked-out shift and stop keeps shift guard', async () => {
  let ready;
  const stops=[];
  const h=harness({stop:async options=>{stops.push(options);},start:()=>new Promise(resolve=>{ready=resolve;})});
  h.api.startLiveWatch('shift-1');
  await new Promise(setImmediate);
  h.api.stopLiveWatch();
  ready({running:true,shiftId:'shift-1'});await flush(h);
  assert.equal(h.api.live.shiftId,null);
  assert.equal(h.api.live.native,false);
  assert.equal(h.watches.size,0);
  assert.equal(h.intervals.size,0);
  assert.equal(stops.at(-1).shiftId,'shift-1');
  assert.equal(stops.at(-1).token,'session-1');
});

test('pending clock-out prevents tracking restart after a render', async () => {
  const h=harness();h.api.startLiveWatch('shift-1');
  h.pendingEnd.add('shift-1');h.api.startLiveWatch('shift-1');await flush(h);
  assert.equal(h.api.live.shiftId,null);assert.equal(h.watches.size,0);
  fix(h);await Promise.resolve();assert.equal(h.calls.length,0);
});

test('delayed location callback cannot replace a newer position or fake its capture time', async () => {
  const h=harness();h.api.startLiveWatch('shift-1');
  const at=Date.now()-60000;
  h.api.onFix(29.37,47.97,10,null,0,at);await flush(h);
  h.api.onFix(29.36,47.96,10,null,0,at-1000);await flush(h);
  assert.equal(h.api.live.last.lat,29.37);
  assert.equal(h.calls[0].args.p.at,new Date(at).toISOString());
});

const preflight = html.slice(html.indexOf('var gpsNotificationWarned=false;'), html.indexOf('async function doStartDuty(){'));
function permissionsHarness(plugin, native=true) {
  const messages=[];
  const ctx=vm.createContext({SGT:plugin,isNativeApp:native,toast:m=>messages.push(m),L10:k=>k,d3T:k=>k});
  vm.runInContext(preflight+'\nthis.prepare=gpsPrepareClockIn;',ctx);
  return {prepare:ctx.prepare,messages};
}
test('native clock-in preflight blocks missing plugin, unsupported native API, denied permission and disabled location', async () => {
  for (const plugin of [null,{}, {preparePermissions:async()=>({ready:false,reason:'LOCATION_PERMISSION_DENIED'})}, {preparePermissions:async()=>({ready:false,reason:'LOCATION_DISABLED'})}]) {
    const h=permissionsHarness(plugin);
    assert.equal(await h.prepare(),false);assert.equal(h.messages.length,1);
  }
});
test('legacy APK without preflight can clock in after native API probe, with one upgrade hint', async () => {
  let probes=0;
  const h=permissionsHarness({start:async()=>{},isRunning:async()=>{probes++;return {running:false};}});
  assert.equal(await h.prepare(),true);
  assert.deepEqual(h.messages,['background_legacy']);
  assert.equal(await h.prepare(),true);
  assert.equal(probes,2);assert.equal(h.messages.length,1);
});
test('Capacitor missing-method rejection uses legacy flow; operational preflight failures do not', async () => {
  let probes=0;
  const old={start:async()=>{},isRunning:async()=>{probes++;return {running:false};},preparePermissions:async()=>{throw Object.assign(new Error('not implemented'),{code:'UNIMPLEMENTED'});}};
  assert.equal(await permissionsHarness(old).prepare(),true);assert.equal(probes,1);
  const failure={...old,preparePermissions:async()=>{throw new Error('permission check failed');}};
  const h=permissionsHarness(failure);
  assert.equal(await h.prepare(),false);assert.equal(probes,1);
  assert.deepEqual(h.messages,['background_update']);
});
test('legacy fallback does not accept unavailable plugin or malformed service status', async () => {
  for(const isRunning of [async()=>{},async()=>({}),async()=>{throw Object.assign(new Error('plugin unavailable'),{code:'UNIMPLEMENTED'});}]){
    const h=permissionsHarness({start:async()=>{},isRunning});
    assert.equal(await h.prepare(),false);assert.deepEqual(h.messages,['background_update']);
  }
});
test('legacy probe completion cannot permit clock-in after identity changes', async () => {
  let resume,current=true;
  const h=permissionsHarness({start:async()=>{},isRunning:()=>new Promise(resolve=>{resume=resolve;})});
  const prepared=h.prepare(()=>current);await Promise.resolve();current=false;
  resume({running:false});assert.equal(await prepared,false);assert.equal(h.messages.length,0);
});
test('native clock-in preflight accepts granted location; browser flow still works', async () => {
  const h=permissionsHarness({preparePermissions:async()=>({ready:true,preciseLocation:false,notificationsEnabled:false})});
  assert.equal(await h.prepare(),true);assert.equal(h.messages.length,1);
  assert.equal(await h.prepare(),true);assert.equal(h.messages.length,1,'notification hint appears once per app launch');
  assert.equal(await permissionsHarness(null,false).prepare(),true);
});
test('a different native shift never claims current shift tracking is active', async () => {
  const h=harness({stop:async()=>{},start:async()=>({running:true,shiftId:'shift-1'}),isRunning:async()=>({running:true,shiftId:'shift-2'})});
  h.api.startLiveWatch('shift-1');await flush(h);assert.equal(h.api.live.native,true);
  h.api.gpsCheckNativeStatus();await new Promise(setImmediate);
  assert.equal(h.api.live.native,false);assert.equal(h.api.live.nativeError,'SHIFT_MISMATCH');
});

test('restored WebView adopts its shift without stopping the inherited native service', async () => {
  let stops=0,starts=0;
  const h=harness({stop:async()=>{stops++;},start:async()=>{starts++;return {running:true,shiftId:'shift-1'};}});
  h.api.startLiveWatch('shift-1');await flush(h);
  assert.equal(stops,0);assert.equal(starts,1);assert.equal(h.api.live.native,true);
});

test('completed older clock-out submission cannot stop tracking a newer shift', async () => {
  const done=html.slice(html.indexOf('async function dqDone('),html.indexOf('async function dqRun('));
  let stops=0;
  const ctx=vm.createContext({
    live:{shiftId:'new-shift'},DQ:{rows:[{id:'old-action'},{id:'new-action'}]},
    async dqRemove(){},dqIdentity:()=>true,toast(){},dqText:k=>k,
    stopLiveWatch(){stops++;},localStorage:{removeItem(){}}
  });
  vm.runInContext(done+'\nthis.done=dqDone;',ctx);
  await ctx.done({kind:'end',shiftId:'old-shift',id:'old-action'},'driver-1','session-1',1);
  assert.equal(stops,0);
  await ctx.done({kind:'end',shiftId:'new-shift',id:'new-action'},'driver-1','session-1',1);
  assert.equal(stops,1);
});

const clockInSource=html.slice(html.indexOf('async function doStartDuty(){'),html.indexOf('async function doEndDuty(){'));
function clockInHarness(stage) {
  const calls=[],messages=[];
  let resume;
  const state={token:'old-token',driverId:'old-driver',screen:'driver',gps:{login:{lat:29.3,lng:47.9,acc:12,at:'2026-10-20T10:00:00.000Z',src:'gps'}},shifts:[]};
  const deferred=new Promise(resolve=>{resume=resolve;});
  const ctx=vm.createContext({
    state,driverCacheEpoch:1,photoBuf:{odoin:'original-photo'},gpsBusy:{},gpsWait:{},geoPend:{},PLATFORMS:['Talabat'],
    driverById:()=>({id:'old-driver',platforms:['Talabat']}),$:(selector)=>selector==='#sdOdo'?{value:'1234'}:{disabled:false},
    toast:m=>messages.push(m),L10:k=>k,d2btn:()=>'',friendly:k=>k,
    gpsPrepareClockIn:async()=>{calls.push('permissions');return stage==='permissions'?deferred:true;},
    uploadPhoto:async(blob,path,token)=>{calls.push({upload:true,blob,path,token});return stage==='upload'?deferred:'https://photos.test/old.jpg';},
    rpc:async(name,args)=>{calls.push({name,args});return stage==='rpc'?deferred:{id:'created-shift',driverId:'old-driver'};},
    mapShift:d=>d,startLiveWatch:id=>calls.push({track:id}),gpsNativeOp:Promise.resolve(),
    closeModal:()=>calls.push('close'),render:()=>calls.push('render')
  });
  if(stage==='gps') { state.gps.login=null;ctx.gpsBusy.login=true;ctx.gpsWait.login=deferred; }
  vm.runInContext(clockInSource+'\nthis.clockIn=doStartDuty;',ctx);
  return {ctx,state,calls,messages,resume};
}
for (const stage of ['gps','permissions','upload','rpc']) {
  test(`clock-in ignores ${stage} completion after account or cache identity changes`,async()=>{
    const h=clockInHarness(stage),running=h.ctx.clockIn();await new Promise(setImmediate);
    const callCount=h.calls.length;
    h.state.token='new-token';h.state.driverId='new-driver';h.ctx.driverCacheEpoch=2;
    h.state.gps.login={lat:1,lng:2};h.ctx.photoBuf.odoin='new-photo';
    h.resume(stage==='permissions'?true:stage==='rpc'?{id:'old-created-shift'}:stage==='upload'?'https://photos.test/old.jpg':undefined);
    await running;
    assert.equal(h.calls.length,callCount,'old continuation must not upload, create, track, render or close the new account');
    assert.equal(h.state.shifts.length,0);assert.equal(h.ctx.photoBuf.odoin,'new-photo');assert.equal(h.state.gps.login.lat,1);
  });
}
test('clock-in uses the snapshotted token and original photo for upload and shift request', async()=>{
  const h=clockInHarness();await h.ctx.clockIn();
  const upload=h.calls.find(x=>x&&x.upload),request=h.calls.find(x=>x&&x.name==='driver_start_shift');
  assert.equal(upload.token,'old-token');assert.equal(upload.blob,'original-photo');
  assert.equal(request.args.p_token,'old-token');assert.equal(request.args.p.at,'2026-10-20T10:00:00.000Z');
  assert.equal(h.state.shifts.length,1);assert.ok(h.calls.some(x=>x&&x.track==='created-shift'));
});
