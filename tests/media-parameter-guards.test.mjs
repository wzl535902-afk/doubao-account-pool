import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
const source=fs.readFileSync('electron/executor.ts','utf8');
test('image model and ratio failures throw before uploading references, filling a prompt or submitting',()=>{
 const start=source.indexOf('private async runImagePipeline');
 const image=source.slice(start,source.indexOf('private async updateProgress',start));
 assert.ok(start>0);
 for(const [guard,forbidden] of [['if (!activation.modelApplied)','继续使用页面当前模型'],['if (!ratioApplied)','比例未命中使用默认']]) {
  const p=image.indexOf(guard);assert.ok(p>=0);assert.match(image.slice(p,p+250),/throw new Error/);
  assert.ok(p<image.indexOf('await fillPrompt'));assert.ok(p<image.indexOf('onSubmitted()'));
  assert.equal(image.includes(forbidden),false);
 }
});
test('video duration and ratio are confirmed and duration is rechecked before prompt fill',()=>{
 const start=source.indexOf('await activateVideoMode(win, request.model)');
 const end=source.indexOf('message: "正在填写提示词"',start);
 const controls=source.slice(start,end);assert.ok(start>0&&end>start);
 assert.match(controls,/applyVideoAspectRatio\(request.aspectRatio/);
 assert.equal((controls.match(/await applyVideoDuration/g)||[]).length,2);
 assert.ok(controls.indexOf('applyVideoAspectRatio')>controls.indexOf('videoDurationChooseScript'));
});
