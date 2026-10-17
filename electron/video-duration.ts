export function normalizeVideoDuration(value: unknown): number | null {
  if (value == null || value === "") return null;
  const duration = Number(value);
  if (![5, 10, 15].includes(duration)) throw new Error("豆包视频时长必须为 5、10 或 15 秒");
  return duration;
}

/** Never submit a video while merely assuming that a requested duration was selected. */
export async function applyVideoDuration(
  value: unknown,
  controls: { read(): Promise<number | null>; open(): Promise<boolean>; choose(duration: number): Promise<boolean> }
): Promise<void> {
  const duration = normalizeVideoDuration(value);
  if (duration == null) return;
  if (await controls.read() === duration) return;
  if (!(await controls.open()) || !(await controls.choose(duration)) || await controls.read() !== duration) {
    throw new Error(`无法确认豆包页面已选择 ${duration} 秒；已停止提交，不使用默认时长替代`);
  }
}

/** Locate visible controls only, never incidental durations in conversation text. */
export function videoDurationProbeScript(kind: "control" | "option", duration?: number): string {
  return `(() => {
    const selector = ${JSON.stringify(kind === "control" ? 'button,[role="button"]' : '[role="option"],[role="menuitem"],button')};
    const candidates = Array.from(document.querySelectorAll(selector)).map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
      const match = text.match(/^(?:视频)?(?:时长[:：]?)?(5|10|15)(?:秒|s|seconds?)(?:时长)?$/i);
      const combined = ${JSON.stringify(kind)} === 'control' && text.match(/^(自动|[0-9]{1,2}:[0-9]{1,2})[·•|]([4-9]|1[0-5])(?:秒|s)$/i);
      if ((!match && !combined) || rect.width < 5 || rect.height < 5 || style.display === 'none' || style.visibility === 'hidden') return null;
      return { duration: Number(match ? match[1] : combined[2]), aspectRatio: combined ? combined[1] : null, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    }).filter(Boolean);
    return candidates.find((item) => ${kind === "option" ? `item.duration === ${Number(duration)}` : "true"}) || null;
  })()`;
}

/** Ratio must be confirmed in the same combined parameter chip, never inferred from the prompt. */
export async function applyVideoAspectRatio(
  value: string | null,
  controls: { read(): Promise<string | null>; open(): Promise<boolean>; choose(ratio: string): Promise<boolean> }
): Promise<void> {
  const ratio = String(value || '').trim().replace('：', ':');
  if (!ratio || /^(auto|自动|默认)$/i.test(ratio)) return;
  if (!["21:9","16:9","9:16","4:3","3:4","1:1"].includes(ratio)) throw new Error("不支持的豆包视频比例；已停止提交");
  if (await controls.read() === ratio) return;
  if (!(await controls.open()) || !(await controls.choose(ratio)) || await controls.read() !== ratio) {
    throw new Error(`无法确认豆包页面已选择 ${ratio}；已停止提交，不使用默认比例替代`);
  }
}

/** Current Doubao uses an indexed 0..11 slider for 4..15 seconds. Derive, do not assume, its offset. */
export function videoDurationChooseScript(value: number): string {
  const duration = normalizeVideoDuration(value);
  if (duration == null) throw new Error("视频时长不能为空");
  return `(async () => {
    const wanted = ${duration};
    const visible = el => {const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
    const menus = Array.from(document.querySelectorAll('[role="menu"][data-state="open"],[role="listbox"]')).filter(visible);
    const close = root => root.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
    for (const root of menus) {
      const option = Array.from(root.querySelectorAll('button,[role="option"],[role="menuitem"]')).find(el => {
        const t=String(el.textContent||'').replace(/\\s+/g,'');
        return visible(el) && !el.disabled && el.getAttribute('aria-disabled')!=='true' && new RegExp('^(?:时长)?'+wanted+'(?:s|秒)$','i').test(t);
      });
      if (option) {option.click();close(root);return true;}
      if (!String(root.textContent||'').includes('时长')) continue;
      const sliders=Array.from(root.querySelectorAll('[role="slider"]')).filter(visible);
      if(sliders.length!==1) continue;
      const slider=sliders[0];
      if(slider.getAttribute('aria-disabled')==='true'||slider.hasAttribute('data-disabled')) return false;
      const read = () => {const p=${videoDurationProbeScript('control')};return p ? p.duration : null;};
      const current=read(),now=Number(slider.getAttribute('aria-valuenow'));
      const min=Number(slider.getAttribute('aria-valuemin')),max=Number(slider.getAttribute('aria-valuemax'));
      if(current===null||![now,min,max].every(Number.isFinite)||max<=min||max-min>60) return false;
      const offset=current-now,target=wanted-offset;
      if(!Number.isInteger(target)||target<min||target>max) return false;
      slider.focus();
      for(let step=0;step<20;step++) {
        const actual=read(),position=Number(slider.getAttribute('aria-valuenow'));
        if(actual===wanted&&position===target) {close(root);return true;}
        if(actual===null||actual-position!==offset) return false;
        const key=actual>wanted?'ArrowLeft':'ArrowRight';
        slider.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve,60));
        const next=read();
        if(next===null||next===actual||Math.abs(next-wanted)>=Math.abs(actual-wanted)) return false;
      }
      return false;
    }
    return false;
  })()`;
}
