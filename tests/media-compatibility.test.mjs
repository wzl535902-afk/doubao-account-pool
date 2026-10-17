import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const output = process.env.POOL_TEST_BUILD_DIR || 'dist-electron';
const { classifyMediaPage, mediaPageProbeScript, mediaEntryClickScript, requestedVideoModelSelected, inspectMediaPageKind, mediaControlOpenScript, mediaMenuOptionClickScript } = await import(pathToFileURL(path.resolve(output, 'media-compatibility.js')).href);

function context(labels, title = '豆包') {
  const nodes = labels.map(textContent => ({ textContent, disabled:false, getAttribute:()=>null,
    getBoundingClientRect:()=>({width:100,height:25}), click(){this.clicked=true;} }));
  return {nodes, globals:{ document:{title,querySelectorAll:()=>nodes},getComputedStyle:()=>({visibility:'visible',display:'block'}) }};
}

test('separates Feishu work-only pages from consumer chat and media controls', () => {
  const work=context(['豆包工作','新工作任务 Ctrl J','更多技能'],'豆包工作 - 字节跳动旗下 AI 智能助手');
  assert.equal(classifyMediaPage(vm.runInNewContext(mediaPageProbeScript(),work.globals)),'work');
  for (const labels of [['新工作任务 Ctrl J','新对话 Ctrl Shift K'],['模型 Seedream 5.0 Flash'],['模型 Seedance 2.0 Mini']]) {
    const c=context(labels);
    assert.equal(classifyMediaPage(vm.runInNewContext(mediaPageProbeScript(),c.globals)),'consumer');
  }
  // Consumer users can enter work chat without losing their media entitlement.
  const mixed=context(['豆包工作','新工作任务 Ctrl J','新对话 Ctrl Shift K'],'豆包工作');
  assert.equal(classifyMediaPage(vm.runInNewContext(mediaPageProbeScript(),mixed.globals)),'consumer');
});

test('does not permanently reject loading or failed capability probes', async () => {
  assert.equal(classifyMediaPage(null),'unknown');
  assert.equal(classifyMediaPage(vm.runInNewContext(mediaPageProbeScript(),context([]).globals)),'unknown');
  assert.equal(await inspectMediaPageKind({isDestroyed:()=>true}),'unknown');
  assert.equal(await inspectMediaPageKind({isDestroyed:()=>false,executeJavaScript:async()=>{throw Error('renderer unavailable')}}),'unknown');
});

test('entry helper can click only navigation entries, never generate or submit', () => {
  const c=context(['生成','图像生成','视频生成','更多技能']);
  assert.equal(vm.runInNewContext(mediaEntryClickScript('图像生成'),c.globals),true);
  assert.equal(c.nodes[1].clicked,true);
  assert.equal(c.nodes[0].clicked,undefined);
  for (const label of ['生成','发送','立即生成','Seedance 2.5']) assert.throws(()=>mediaEntryClickScript(label));
  c.nodes[2].disabled=true;
  assert.equal(vm.runInNewContext(mediaEntryClickScript('视频生成'),c.globals),false);
});

test('video activation validates requested model chip, not historical Seedance text', () => {
  assert.equal(requestedVideoModelSelected('模型 Seedance 2.0 Mini','seedance_2_0_mini'),true);
  assert.equal(requestedVideoModelSelected('Seedance 2.0 Fast','seedance_2_0_fast'),true);
  assert.equal(requestedVideoModelSelected('模型 Seedance 2.0','seedance_2_0'),true);
  for (const chip of ['', '历史会话 Seedance 2.0 Mini', 'Seedance 2.0 Fast', 'Seedance 2.0', 'Seedance 2.5']) {
    assert.equal(requestedVideoModelSelected(chip,'seedance_2_0_mini'),false,chip);
  }
  assert.equal(requestedVideoModelSelected('Seedance 2.0 Mini','seedance_2_0'),false);
});

function menuContext(labels, attrs = {}) {
  const c = context(labels);
  c.globals.PointerEvent = class { constructor(type,init){Object.assign(this,init,{type})} };
  c.globals.KeyboardEvent = c.globals.PointerEvent;
  for(const n of c.nodes) {
    n.getAttribute=k=>attrs[k]??null;
    n.focus=()=>{n.focused=true};
    n.dispatchEvent=e=>{(n.events??=[]).push(e);if(e.type==='pointerdown')attrs['aria-expanded']='true';};
  }
  return c;
}
test('Radix parameter and entry menus open with pointer events, not mouse-only click', () => {
  for (const label of ['模型','比例','视频参数']) {
    const text=label==='模型'?'模型 Seedream 5.0 Flash':label==='比例'?'比例 自动':'自动 · 10s';
    const c=menuContext([text],{'data-slot':'dropdown-menu-trigger','aria-expanded':'false'});
    assert.equal(vm.runInNewContext(mediaControlOpenScript(label),c.globals),true);
    assert.deepEqual(c.nodes[0].events.map(e=>e.type),['pointerdown','pointerup']);
    assert.equal(c.nodes[0].events[0].buttons,1);
    assert.equal(c.nodes[0].clicked,undefined);
    assert.equal(vm.runInNewContext(mediaControlOpenScript(label),c.globals),true);
    assert.equal(c.nodes[0].events.length,2,'already open must not toggle closed');
  }
  const c=menuContext(['更多技能'],{'data-slot':'dropdown-menu-trigger','aria-expanded':'false'});
  assert.equal(vm.runInNewContext(mediaEntryClickScript('更多技能'),c.globals),true);
  assert.equal(c.nodes[0].events[0].type,'pointerdown');
});
test('parameter helper rejects generating labels, disabled and hidden controls', () => {
  for(const label of ['生成','发送','立即生成','Seedance 2.5']) assert.throws(()=>mediaControlOpenScript(label));
  const c=menuContext(['比例 自动']);c.nodes[0].disabled=true;
  assert.equal(vm.runInNewContext(mediaControlOpenScript('比例'),c.globals),false);
  c.nodes[0].disabled=false;c.globals.getComputedStyle=()=>({visibility:'hidden',display:'block'});
  assert.equal(vm.runInNewContext(mediaControlOpenScript('比例'),c.globals),false);
});
test('choices are scoped to an open menu and use exact ratios and exact model tiers', () => {
  const c=menuContext(['16:9','9:16','Seedance 2.0 Mini日常生成使用','Seedance 2.0 Fast快速出片选择','Seedance 2.0进阶画面表现']);
  const root={textContent:'媒体参数',getBoundingClientRect:()=>({width:300,height:200}),querySelectorAll:()=>c.nodes,dispatchEvent(){}};
  let open=true;
  c.globals.document.querySelectorAll=selector=>selector.includes('[role="menu"]')?(open?[root]:[]):c.nodes;
  assert.equal(vm.runInNewContext(mediaMenuOptionClickScript('16:9'),c.globals),true);
  assert.equal(c.nodes[0].clicked,true);assert.equal(c.nodes[1].clicked,undefined);
  assert.equal(vm.runInNewContext(mediaMenuOptionClickScript('Seedance 2.0'),c.globals),true);
  assert.equal(c.nodes[4].clicked,true);assert.equal(c.nodes[2].clicked,undefined);assert.equal(c.nodes[3].clicked,undefined);
  assert.equal(vm.runInNewContext(mediaMenuOptionClickScript('Seedance 2.0 Mini'),c.globals),true);
  open=false;c.nodes[0].clicked=false;
  assert.equal(vm.runInNewContext(mediaMenuOptionClickScript('16:9'),c.globals),false);
  assert.equal(c.nodes[0].clicked,false,'toolbar/history labels are not valid options');
  for(const value of ['生成','发送','Seedance 2.5','16:9 构图','5s']) assert.throws(()=>mediaMenuOptionClickScript(value));
});
