import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const output = process.env.POOL_TEST_BUILD_DIR || 'dist-electron';
const { normalizeVideoDuration, applyVideoDuration, videoDurationProbeScript, videoDurationChooseScript, applyVideoAspectRatio } = await import(pathToFileURL(path.resolve(output, 'video-duration.js')).href);
for (const duration of [5, 10, 15]) test(`accepts and verifies duration ${duration}`, async () => {
  let current = 5;
  await applyVideoDuration(String(duration), { read: async () => current, open: async () => true, choose: async (value) => { current = value; return true; } });
  assert.equal(current, duration);
});
test('rejects invalid duration before touching page controls', async () => {
  let touched = false;
  await assert.rejects(applyVideoDuration(30, { read: async () => { touched = true; return 5; }, open: async () => false, choose: async () => false }), /必须/);
  assert.equal(touched, false);
  assert.equal(normalizeVideoDuration(null), null);
});
test('refuses missing controls instead of silently using a default duration', async () => {
  await assert.rejects(applyVideoDuration(10, { read: async () => null, open: async () => false, choose: async () => false }), /停止提交/);
});
test('rereads the selection after a successful click', async () => {
  await assert.rejects(applyVideoDuration(10, { read: async () => 5, open: async () => true, choose: async () => true }), /停止提交/);
});
test('recognizes duration control labels but not arbitrary model names', () => {
  const texts = ['Seedance 2.0', '时长 10 秒', '15s'];
  const elements = texts.map((text) => ({ innerText: text, getBoundingClientRect: () => ({ x: 20, y: 100, width: 80, height: 30 }) }));
  const context = { document: { querySelectorAll: () => elements }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  assert.equal(vm.runInNewContext(videoDurationProbeScript('control'), context).duration, 10);
  assert.equal(vm.runInNewContext(videoDurationProbeScript('option', 15), context).duration, 15);
});

test('reads new combined ratio-duration chip without matching incidental duration text', () => {
  for(const [text,ratio,duration] of [['自动 · 10s','自动',10],['16:9 · 5s','16:9',5],['9:16 · 15s','9:16',15],['1:1 · 4s','1:1',4]]) {
    const node={textContent:text,getBoundingClientRect:()=>({x:5,y:5,width:120,height:30})};
    const globals={document:{querySelectorAll:()=>[node]},getComputedStyle:()=>({visibility:'visible',display:'block'})};
    const actual=vm.runInNewContext(videoDurationProbeScript('control'),globals);
    assert.equal(actual.duration,duration);assert.equal(actual.aspectRatio,ratio);
    assert.equal(vm.runInNewContext(videoDurationProbeScript('option',duration),globals),null);
  }
});
test('video ratio is selected, reread, and missing or unconfirmed choices stop submission',async()=>{
  let ratio='自动';let opened=0;
  await applyVideoAspectRatio('16:9',{read:async()=>ratio,open:async()=>{opened++;return true},choose:async x=>{ratio=x;return true}});
  assert.equal(ratio,'16:9');assert.equal(opened,1);
  await assert.rejects(applyVideoAspectRatio('16:9',{read:async()=>null,open:async()=>false,choose:async()=>true}),/停止提交/);
  await assert.rejects(applyVideoAspectRatio('16:9',{read:async()=> '自动',open:async()=>true,choose:async()=>true}),/默认比例/);
  await assert.rejects(applyVideoAspectRatio('bogus',{read:async()=> '自动',open:async()=>true,choose:async()=>true}),/停止提交/);
});
function sliderContext({stuck=false,disabled=false,offset=4}={}) {
  let position=10-offset,closed=false,events=0;
  const rect=()=>({x:1,y:1,width:100,height:20});
  const slider={getBoundingClientRect:rect,getAttribute:k=>({'aria-valuenow':String(position),'aria-valuemin':'0','aria-valuemax':'11','aria-disabled':disabled?'true':'false'})[k]??null,
    hasAttribute:()=>false,focus(){},dispatchEvent(e){events++;if(!stuck)position+=e.key==='ArrowLeft'?-1:1;}};
  const menu={textContent:'比例时长10s4s15s',getBoundingClientRect:rect,querySelectorAll:s=>s==='[role="slider"]'?[slider]:[],dispatchEvent:e=>{if(e.key==='Escape')closed=true;}};
  const chip={get textContent(){return '16:9 · '+(position+offset)+'s';},getBoundingClientRect:rect};
  const globals={document:{querySelectorAll:s=>s.includes('[role="menu"]')?[menu]:[chip]},getComputedStyle:()=>({visibility:'visible',display:'block'}),
    KeyboardEvent:class {constructor(type,init){Object.assign(this,init,{type})}},setTimeout:fn=>setTimeout(fn,0)};
  return {globals,get duration(){return position+offset},get closed(){return closed},get events(){return events}};
}
test('sets requested 5s using indexed slider, not its 0..11 accessibility index',async()=>{
  const c=sliderContext();assert.equal(await vm.runInNewContext(videoDurationChooseScript(5),c.globals),true);
  assert.equal(c.duration,5);assert.equal(c.events,5);assert.equal(c.closed,true);
});
test('slider derives offsets, moves both ways and fails closed on stuck/disabled controls',async()=>{
  const c=sliderContext({offset:5});assert.equal(await vm.runInNewContext(videoDurationChooseScript(15),c.globals),true);assert.equal(c.duration,15);
  const stuck=sliderContext({stuck:true});assert.equal(await vm.runInNewContext(videoDurationChooseScript(5),stuck.globals),false);
  const disabled=sliderContext({disabled:true});assert.equal(await vm.runInNewContext(videoDurationChooseScript(5),disabled.globals),false);assert.equal(disabled.events,0);
  assert.throws(()=>videoDurationChooseScript(30));
});
