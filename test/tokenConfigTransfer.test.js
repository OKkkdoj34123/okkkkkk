import { BIN_ARCHIVE, exportBinArchive, importBinArchive, restoreBinArchive } from "../src/utils/binConfigArchive.js";
import { removeRetiredTasks } from "../src/utils/batch/retiredActivities.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {createTokenBinAccess,exportTokenRecords,importTokenRecords,resolveTokenRefreshSource,remapTokenIds,encodeConfigBin} from '../src/utils/tokenRefreshSource.js';
const buffer = () => Uint8Array.from([0,1,2,127,128,255]).buffer;
function database() {
 const rows=new Map(), access={read:async id=>rows.get(id)||null,write:async(id,data)=>{rows.set(id,data)},remove:async id=>{rows.delete(id)}};
 return {rows,access};
}
const token=(id='a',importMethod='bin')=>({id,name:'账号'+id,token:'fixture-'+id,importMethod});
test('BIN export/import on a fresh device restores bytes, source and repeat import keeps IDs',async()=>{
 const original=database();original.rows.set('a',buffer());
 const exported=await exportTokenRecords([token()],original.access,true);assert.equal(exported.included,1);
 const target=database();const r=await importTokenRecords(exported.records,[],target.access);
 assert.equal(r.tokens[0].importMethod,'bin');assert.deepEqual(target.rows.get('a'),buffer());
 assert.equal((await resolveTokenRefreshSource(r.tokens[0],target.access.read,r.tokens)).method,'bin');
 const repeat=await importTokenRecords(exported.records,r.tokens,target.access);assert.equal(repeat.added,0);assert.equal(repeat.repaired,0);assert.equal(repeat.restoredBins,0);
 const noBin=await exportTokenRecords([token()],original.access,false);assert.equal(noBin.records[0].binBase64,undefined);
});
test('old 1.1 configs repair existing import source, retain current credentials and report missing BIN',async()=>{
 const db=database(),original={...token('a','import'),token:'current',remark:'keep'};
 const r=await importTokenRecords([{...token(),binBase64:encodeConfigBin(buffer())}],[original],db.access);
 assert.equal(r.repaired,1);assert.equal(r.tokens[0].id,'a');assert.equal(r.tokens[0].token,'current');assert.equal(r.tokens[0].remark,'keep');assert.equal(original.importMethod,'import');
 const missing=await importTokenRecords([token('b')],[],db.access);assert.equal(missing.missing,1);
 const url=await importTokenRecords([{...token('u','url'),sourceUrl:'https://example.invalid/token'}],[token('u','import')],{read:()=>assert.fail('URL does not require BIN')});
 assert.equal(url.tokens[0].importMethod,'url');
});
test('token matches with different IDs remap task/group/settings references; conflicting identities reject',async()=>{
 const db=database(),existing={...token('local'),token:'same'};
 const r=await importTokenRecords([{...token('incoming'),token:'same',binBase64:encodeConfigBin(buffer())}],[existing],db.access);
 assert.deepEqual(remapTokenIds(['incoming','local'],r.idMap),['local']);assert.equal(r.tokens[0].id,'local');assert.ok(db.rows.has('local'));assert.ok(!db.rows.has('incoming'));
 await assert.rejects(importTokenRecords([{...token('x'),token:'same'}],[existing,token('x')],db.access),/冲突/);
});
test('malformed later BIN is rejected before writes; storage failure rolls back newly inserted BIN',async()=>{
 const db=database(),a={...token('a'),binBase64:encodeConfigBin(buffer())},b={...token('b'),binBase64:'not base64'};
 await assert.rejects(importTokenRecords([a,b],[],db.access),/编码/);assert.equal(db.rows.size,0);
 b.binBase64=a.binBase64;const oldWrite=db.access.write;db.access.write=async(id,data)=>{await oldWrite(id,data);if(id==='b')throw new Error('disk full')};
 await assert.rejects(importTokenRecords([a,b],[],db.access),/已撤回/);assert.equal(db.rows.size,0);
});
test('ambiguous name-based originals are never reused; existing BIN is not overwritten by old backup',async()=>{
 const db=database();db.rows.set('same name',buffer());const records=[{...token('a','import'),name:'same name'},{...token('b','import'),name:'same name'}];
 assert.equal((await resolveTokenRefreshSource(records[0],db.access.read,records)).method,null);
 const r=await importTokenRecords(records,[],db.access);assert.equal(r.missing,2);assert.equal(r.restoredBins,0);
 const current=buffer();db.rows.set('a',current);
 await importTokenRecords([{...token(),binBase64:encodeConfigBin(Uint8Array.of(9).buffer)}],[token()],db.access);assert.deepEqual(db.rows.get('a'),current);
});
test('storage adapter waits for initialization and reports failed writes',async()=>{
 const db={isReady:{value:false},error:{value:null},getArrayBuffer:async()=>buffer(),storeArrayBuffer:async()=>false};
 setTimeout(()=>{db.isReady.value=true},1);const access=createTokenBinAccess(db);assert.deepEqual(await access.read('a'),buffer());await assert.rejects(access.write('a',buffer()),/读写失败/);
});

test('actual Vue import/export handlers round trip BIN and preserve existing bindings',async()=>{
 const source=readFileSync(new URL('../src/views/BatchDailyTasks.vue',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('const showConfigExport ='),source.indexOf('// Scheduled Tasks Countdown'));
 const db=database();db.rows.set('a',buffer());let blob,readFinished;
 const logs=[],savedSettings=new Map();
 const gameTokens={value:[token()]},scheduledTasks={value:[{id:'task',selectedTokens:['a']}]},groups={value:[{id:'group',name:'G',tokenIds:['a']}]};
 const settings=new Proxy({dreamPurchaseList:[],dreamPurchaseManualEnabled:false,dreamPurchaseBlackMarketEnabled:false},{get:(t,k)=>t[k]});
 const api={removeRetiredTasks,ref:v=>({value:v}),tokens:gameTokens,gameTokens,scheduledTasks,tokenGroups:groups,batchSettings:settings,autoConfig:{value:{batches:{A:{groupId:'group'}}}},
  createTokenBinAccess:()=>db.access,useIndexedDB:()=>({}),exportTokenRecords,importTokenRecords,remapTokenIds,
  localStorage:{getItem:key=>key==='daily-settings:a'?'{}':null,setItem:(k,v)=>savedSettings.set(k,v)},
  message:Object.fromEntries(['success','warning','error'].map(k=>[k,s=>logs.push([k,s])])),
  Blob,URL:{createObjectURL:b=>{blob=b;return 'blob:fixture'},revokeObjectURL(){}},document:{createElement:()=>({click(){}}),body:{appendChild(){},removeChild(){}}},
  FileReader:class{readAsText(s){readFinished=this.onload({target:{result:s}})}},saveScheduledTasks(){},saveAutoConfig(){},normalizeExtrasSettings(){},saveBatchSettings(){}};
 const handlers=new Function(...Object.keys(api),code+';return {exportConfig,importConfig};')(...Object.values(api));
 await handlers.exportConfig();const exported=JSON.parse(await blob.text());assert.equal(exported.version,'1.2');assert.ok(exported.tokens[0].binBase64);
 // Existing account has different ID but identical token: imported references must use local ID.
 gameTokens.value=[{...token('local','import'),token:'fixture-a'}];scheduledTasks.value=[];groups.value=[];db.rows.clear();
 await handlers.importConfig({file:{file:JSON.stringify(exported)}});await readFinished;
 assert.equal(gameTokens.value[0].id,'local');assert.equal(gameTokens.value[0].importMethod,'bin');assert.ok(db.rows.has('local'));
 assert.deepEqual(scheduledTasks.value[0].selectedTokens,['local']);assert.deepEqual(groups.value[0].tokenIds,['local']);assert.ok(savedSettings.has('daily-settings:local'));
 // Repair old imported references without replacing user-edited task or group settings.
 scheduledTasks.value[0].selectedTokens=['a'];scheduledTasks.value[0].name='keep';groups.value[0].tokenIds=['a'];groups.value[0].name='keep group';
 await handlers.importConfig({file:{file:JSON.stringify(exported)}});await readFinished;
 assert.deepEqual(scheduledTasks.value[0].selectedTokens,['local']);assert.equal(scheduledTasks.value[0].name,'keep');
 assert.deepEqual(groups.value[0].tokenIds,['local']);assert.equal(groups.value[0].name,'keep group');
 assert.ok(!logs.some(([type])=>type==='error'),JSON.stringify(logs));
});

test('pure BIN exports only selected files and group metadata; missing or ambiguous originals block the download', async () => {
  const db = database();
  db.rows.set('a', buffer());
  const accounts = [token(), { ...token('b'), name: 'old' }, { ...token('c'), name: 'old' }];
  db.rows.set('old', buffer());
  const groups = [{ id:'A', name:'甲', color:'#123456', tokenIds:['a','b','a'], privateNote:'omit' },
    { id:'B', name:'乙', tokenIds:['a','c'] }, { id:'C', name:'空组', tokenIds:[] }];
  const archive = await exportBinArchive([accounts[0]], accounts, db.access, groups);
  assert.equal(archive.version, 2);
  assert.deepEqual(Object.keys(archive).sort(), ['files', 'format', 'tokenGroups', 'version']);
  assert.deepEqual(archive.files, [{ id: 'a', name: '账号a', binBase64: encodeConfigBin(buffer()) }]);
  assert.deepEqual(archive.tokenGroups, [{ id:'A', name:'甲', color:'#123456', tokenIds:['a'] },
    { id:'B', name:'乙', color:'#1677ff', tokenIds:['a'] }]);
  const all = await exportBinArchive([accounts[0]], [accounts[0]], db.access, groups);
  assert.deepEqual(all.tokenGroups[2], { id:'C', name:'空组', color:'#1677ff', tokenIds:[] });
  assert.deepEqual(groups[0].tokenIds, ['a','b','a']);
  await assert.rejects(exportBinArchive([accounts[0]], accounts, db.access, [groups[0],groups[0]]), /重复的分组/);
  await assert.rejects(exportBinArchive([accounts[1]], accounts, db.access), /缺少原始 BIN/);
  assert.equal((await exportTokenRecords([accounts[1]], db.access, true, accounts)).included, 0);
});

test('fresh device authenticates each unique BIN once, repeat and alias imports preserve local IDs and credentials', async () => {
  const db = database();
  const a = { id: 'a', name: 'one', binBase64: encodeConfigBin(buffer()) };
  const archive = { format: BIN_ARCHIVE, version: 1, files: [a, { ...a, id: 'other' }, a] };
  let calls = 0;
  const first = await importBinArchive(archive, [], db.access, async bytes => {
    calls++;
    assert.deepEqual(bytes, buffer());
    return 'fresh';
  });
  assert.equal(calls, 1);
  assert.equal(first.added, 1);
  assert.equal(first.duplicates, 2);
  assert.deepEqual(db.rows.get('a'), buffer());
  const repeat = await importBinArchive({ ...archive, files: [{ ...a, id: 'different' }] },
    first.tokens, db.access, () => assert.fail('repeat must not authenticate'));
  assert.equal(repeat.added, 0);
  assert.equal(repeat.restoredBins, 0);
  assert.equal(repeat.tokens[0].id, 'a');
  assert.equal(repeat.tokens[0].token, 'fresh');
});

test('damaged file, conflicting identity, failed authentication and concurrent account change do not write a batch', async () => {
  const a = { id: 'a', name: 'same', binBase64: encodeConfigBin(buffer()) };
  const b = { id: 'b', name: 'same', binBase64: 'Ag==' };
  const archive = files => ({ format: BIN_ARCHIVE, version: 1, files });
  const db = database();
  const noAuth = () => assert.fail('bad input must fail preflight');
  for (const [files, problem] of [[[a, { ...b, binBase64: 'bad' }], /编码/], [[a, { ...b, id: 'a' }], /不同 BIN/]]) {
    await assert.rejects(importBinArchive(archive(files), [], db.access, noAuth), problem);
    assert.equal(db.rows.size, 0);
  }
  let calls = 0;
  await assert.rejects(importBinArchive(archive([a,b]), [], db.access, async () => {
    if (++calls === 2) throw new Error('private details');
    return 'temporary';
  }), /认证失败/);
  assert.equal(db.rows.size, 0);
  await assert.rejects(importBinArchive(archive([a]), [], db.access, async () => 'new',
    () => { throw new Error('changed'); }), /changed/);
  assert.equal(db.rows.size, 0);
  db.rows.set('a', Uint8Array.of(4).buffer);
  await assert.rejects(importBinArchive(archive([a]), [token()], db.access, noAuth), /冲突/);
  assert.deepEqual(db.rows.get('a'), Uint8Array.of(4).buffer);
});

test('pure import can restore a missing BIN beside a valid URL without replacing the source', async () => {
  const current = { ...token('a', 'url'), sourceUrl: 'https://example.invalid/fixture' };
  const db = database();
  const result = await importBinArchive({ format: BIN_ARCHIVE, version: 1,
    files: [{ id: 'a', name: 'same', binBase64: encodeConfigBin(buffer()) }] }, [current], db.access,
    () => assert.fail('existing account must not authenticate'));
  assert.equal(result.tokens[0].sourceUrl, current.sourceUrl);
  assert.equal(result.tokens[0].importMethod, 'url');
  assert.deepEqual(db.rows.get('a'), buffer());
});

test('page handlers export only selected references, merge successive subsets and import raw BIN into an empty device', async () => {
  const vue = readFileSync(new URL('../src/views/BatchDailyTasks.vue', import.meta.url), 'utf8');
  const picker = vue.match(/<n-upload\b[^>]*class="config-upload"[^>]*>/)?.[0] || '';
  assert.match(picker, /@change="importConfig"/);
  assert.match(picker, /:default-upload="false"/);
  const source = vue.slice(vue.indexOf('const showConfigExport ='), vue.indexOf('// Scheduled Tasks Countdown'));
  const db = database(), storage = new Map(), errors = [], globals = [];
  const accounts = { value: [token('a'), token('b'), token('c')] };
  const groups = { value: [{ id:'G', name:'G', tokenIds:['a','b','c'] }] };
  const tasks = { value: [{ id:'T', name:'T', selectedTokens:['a','b','c'], connectedTokens:['a','b','c'], selectedTasks:['startBatch'] }] };
  for (const [index, item] of accounts.value.entries()) {
    db.rows.set(item.id, Uint8Array.of(index,255).buffer);
    storage.set(`daily-settings:${item.id}`, '{"enabled":true}');
  }
  let blob, read, auth = 0;
  const deps = { ref:value=>({value}), tokens:accounts, gameTokens:accounts, tokenGroups:groups, scheduledTasks:tasks,
    createTokenBinAccess:()=>db.access, useIndexedDB:()=>({}), batchSettings:{dreamPurchaseList:[]},
    autoConfig:{value:{enabled:false}}, remapTokenIds, exportBinArchive, restoreBinArchive, exportTokenRecords, importTokenRecords,
    removeRetiredTasks, transformToken:async () => `fixture-login-${++auth}`,
    URL:{createObjectURL:b=>{blob=b;return 'blob:fixture'}, revokeObjectURL(){}}, Blob,
    document:{createElement:()=>({click(){}}),body:{appendChild(){},removeChild(){}}},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    FileReader:class{readAsText(value){read=this.onload({target:{result:value}})}},
    message:{error:value=>errors.push(value),success(){},warning(){}}, saveScheduledTasks(){},
    normalizeExtrasSettings(){}, saveAutoConfig(){globals.push('week')}, saveBatchSettings(){globals.push('batch')},
  };
  const api = new Function(...Object.keys(deps), source+';return {exportConfig, importConfig};')(...Object.values(deps));
  async function download(options) { await api.exportConfig(options); return JSON.parse(await blob.text()); }
  async function upload(value) { await api.importConfig({file:{file:JSON.stringify(value)}}); await read; }
  const x = await download({ids:['a'],format:'config'});
  const y = await download({ids:['b'],format:'config'});
  const pure = await download({ids:['c'],format:'bin'});
  const nextPure = await download({ids:['a'],format:'bin'});
  assert.deepEqual(x.tokens.map(t=>t.id), ['a']);
  assert.deepEqual(x.tokenGroups[0].tokenIds, ['a']);
  assert.deepEqual(x.scheduledTasks[0].selectedTokens, ['a']);
  assert.equal(x.scheduledTasks[0].connectedTokens, undefined);
  assert.deepEqual(x.tokenSettings.map(i=>i.tokenId), ['a']);
  assert.equal(x.autoWeeklySchedule, undefined);
  assert.equal(x.batchSettings, undefined);
  accounts.value=[]; tasks.value=[]; groups.value=[]; db.rows.clear(); storage.clear();
  await upload(pure); await upload(pure);
  assert.deepEqual(errors, []);
  assert.equal(auth,1);
  assert.deepEqual(JSON.parse(storage.get('gameTokens')).map(t=>t.id), ['c']);
  assert.deepEqual([...storage.keys()], ['gameTokens','tokenGroups']);
  assert.deepEqual(JSON.parse(storage.get('tokenGroups')), groups.value);
  assert.deepEqual(groups.value, [{ id:'G', name:'G', color:'#1677ff', tokenIds:['c'] }]);
  assert.equal(tasks.value.length,0);
  assert.deepEqual(db.rows.get('c'), Uint8Array.of(2,255).buffer);
  await upload(nextPure);
  assert.equal(auth, 2);
  assert.deepEqual(groups.value[0].tokenIds, ['c','a']);
  await upload(x); await upload(y); await upload(x);
  assert.deepEqual(errors, []);
  assert.deepEqual(accounts.value.map(t=>t.id), ['c','a','b']);
  assert.deepEqual(groups.value[0].tokenIds,['c','a','b']);
  assert.deepEqual(tasks.value[0].selectedTokens,['a','b']);
  assert.deepEqual(globals,[]);
});

test('all archive aliases map to the final local ID; importing subsets merges only groups with the same ID', async () => {
  const db = database(), existing = [token('local'), token('untouched')];
  const original = { id:'g', name:'本地名称', color:'#123456', tokenIds:['untouched'], createdAt:'keep' };
  const source = { id:'src', name:'同名', binBase64:encodeConfigBin(buffer()) };
  const archive = { format:BIN_ARCHIVE, version:2, files:[source, { ...source, id:'alias' }],
    tokenGroups:[{ id:'g', name:'旧名称', color:'#abcdef', tokenIds:['alias','src'] },
      { id:'new', name:'本地名称', tokenIds:['alias'] }, { id:'empty', name:'空组', tokenIds:[] }] };
  let calls = 0;
  const authenticate = async () => { calls++; return existing[0].token; };
  const first = await importBinArchive(archive, existing, db.access, authenticate, undefined, { groups:[original] });
  assert.deepEqual([first.idMap.get('src'), first.idMap.get('alias')], ['local','local']);
  assert.equal(first.added, 0);
  assert.deepEqual(first.tokenGroups, [{ ...original, tokenIds:['untouched','local'] },
    { id:'new', name:'本地名称', color:'#1677ff', tokenIds:['local'] },
    { id:'empty', name:'空组', color:'#1677ff', tokenIds:[] }]);
  assert.deepEqual(original.tokenIds, ['untouched']);
  assert.deepEqual([...db.rows.keys()], ['local']);
  const second = await importBinArchive(archive, first.tokens, db.access, authenticate, undefined, { groups:first.tokenGroups });
  assert.equal(calls, 1);
  assert.equal(second.restoredBins, 0);
  assert.deepEqual(second.tokenGroups, first.tokenGroups);
});

test('v2 rejects broken groups and outside references before authentication or writes', async () => {
  const file = { id:'a', name:'甲', binBase64:encodeConfigBin(buffer()) };
  const group = { id:'g', name:'甲组', tokenIds:['a'] };
  for (const tokenGroups of [undefined, {}, [null], [group,group], [{...group, name:' '}],
    [{...group, tokenIds:['local-only']}], [{...group, color:{}}]]) {
    const db = database();
    let authentications = 0;
    const archive = { format:BIN_ARCHIVE, version:2, files:[file], tokenGroups };
    await assert.rejects(importBinArchive(archive, [token('local-only')], db.access,
      async () => { authentications++; return 'fixture'; }), /分组/);
    assert.equal(authentications, 0);
    assert.equal(db.rows.size, 0);
  }
});

test('old archives and ungrouped accounts leave existing local group storage alone', async () => {
  for (const version of [1,2]) {
    const db = database(), accounts = { value:[] }, groups = { value:[{ id:'keep', name:'已有分组', tokenIds:[] }] };
    const rows = new Map([['tokenGroups', JSON.stringify(groups.value)], ['autoWeeklySchedule','keep']]);
    const storage = { getItem:k=>rows.get(k)??null, setItem(k,v){ assert.equal(k,'gameTokens'); rows.set(k,v); } };
    const file = { id:'a', name:'甲', binBase64:encodeConfigBin(buffer()) };
    const archive = { format:BIN_ARCHIVE, version, files:[file], ...(version === 2 ? {tokenGroups:[]} : {}) };
    const r = await restoreBinArchive(archive, { accounts, groups, storage, access:db.access, authenticate:async ()=>'fixture' });
    assert.equal(r.groupCount, 0);
    assert.deepEqual(groups.value[0].tokenIds, []);
    assert.equal(rows.get('autoWeeklySchedule'), 'keep');
    assert.deepEqual(db.rows.get('a'), buffer());
  }
});

test('failed group persistence and concurrent edits roll back new BINs; the same archive can be retried', async () => {
  const file = { id:'a', name:'甲', binBase64:encodeConfigBin(buffer()) };
  const group = { id:'g', name:'迁移组', color:'#123456', tokenIds:['a'] };
  const archive = { format:BIN_ARCHIVE, version:2, files:[file], tokenGroups:[group] };
  for (const failure of ['quota-first-install', 'quota-existing', 'memory-edit', 'other-tab']) {
    const db = database(), accounts = { value:[] }, groups = { value:[] };
    const initialTokens = failure === 'quota-existing' ? '[]' : null;
    const rows = new Map(initialTokens === null ? [] : [['gameTokens',initialTokens]]);
    let inject = true;
    const storage = { getItem:k=>rows.get(k)??null, removeItem:k=>rows.delete(k), setItem(k,v){
      if (inject && k === 'tokenGroups' && failure.startsWith('quota')) throw Error('quota');
      rows.set(k,v);
    }};
    const access = { ...db.access, async write(k,v) {
      await db.access.write(k,v);
      if (inject && failure === 'memory-edit') groups.value.push({ id:'other', name:'新建组', tokenIds:[] });
      if (inject && failure === 'other-tab') rows.set('tokenGroups','[ ]');
    }};
    const run = () => restoreBinArchive(archive, { accounts, groups, storage, access, authenticate:async ()=>'fixture' });
    await assert.rejects(run(), /保存失败|已变化/);
    assert.deepEqual(accounts.value, []);
    assert.equal(rows.get('gameTokens') ?? null, initialTokens);
    assert.equal(db.rows.size, 0);
    if (failure === 'other-tab') assert.equal(rows.get('tokenGroups'), '[ ]');
    if (failure === 'memory-edit') assert.equal(groups.value[0].id, 'other');
    inject = false;
    await run();
    assert.deepEqual(db.rows.get('a'), buffer());
    assert.deepEqual(groups.value.find(g=>g.id==='g'), group);
    if (failure === 'memory-edit') assert.equal(groups.value[0].id, 'other');
    assert.deepEqual(JSON.parse(rows.get('tokenGroups')), groups.value);
  }
});
