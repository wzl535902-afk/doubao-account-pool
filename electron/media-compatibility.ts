import type { WebContents } from "electron";
import type { DoubaoVideoModel, MediaPageKind } from "./types.js";

export interface MediaPageProbe {
  workBrand: boolean;
  workEntry: boolean;
  conversationEntry: boolean;
  modelControl: boolean;
}

/** Work/Feishu sessions must not be mistaken for the consumer media composer. */
export function classifyMediaPage(probe: MediaPageProbe | null | undefined): MediaPageKind {
  if (!probe) return "unknown";
  if (probe.conversationEntry || probe.modelControl) return "consumer";
  if (probe.workBrand && probe.workEntry) return "work";
  return "unknown";
}

/** Read UI capabilities only; never read cookies, user IDs, drafts or chat history. */
export function mediaPageProbeScript() {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const labels = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible)
      .map(el => String(el.textContent || '').replace(/\\s+/g, '').trim());
    return {
      workBrand: /^豆包工作/.test(document.title) || labels.includes('豆包工作'),
      workEntry: labels.some(t => /^新工作任务(?:Ctrl|⌘|$)/.test(t)),
      conversationEntry: labels.some(t => /^新对话(?:Ctrl|⌘|$)/.test(t)),
      modelControl: labels.some(t => /^(?:模型)?(?:Seedream|Seedance)/i.test(t))
    };
  })()`;
}

export async function inspectMediaPageKind(contents: Pick<WebContents, "executeJavaScript" | "isDestroyed">): Promise<MediaPageKind> {
  if (contents.isDestroyed()) return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = await Promise.race([
      contents.executeJavaScript(mediaPageProbeScript()) as Promise<MediaPageProbe>,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); })
    ]);
    return classifyMediaPage(probe);
  } catch { return "unknown"; }
  finally { if (timer) clearTimeout(timer); }
}

/** Only non-generating media entry buttons are allowed in this click helper. */
export function mediaEntryClickScript(label: string) {
  if (!["更多技能", "图像生成", "视频生成"].includes(label)) throw new Error("不是允许的创作入口");
  return `(() => {
    const label = ${JSON.stringify(label)};
    const el = Array.from(document.querySelectorAll('button,[role="button"]')).find(el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return String(el.textContent || '').trim() === label && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
        && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    if (!el) return false;
    if (el.getAttribute('data-slot') === 'dropdown-menu-trigger') {
      if (el.getAttribute('aria-expanded') !== 'true') {
        el.focus();
        for (const type of ['pointerdown','pointerup']) el.dispatchEvent(new PointerEvent(type,
          {bubbles:true,button:0,buttons:type==='pointerdown'?1:0,pointerType:'mouse',isPrimary:true,pointerId:1}));
      }
    } else el.click();
    return true;
  })()`;
}

export function requestedVideoModelSelected(chip: string, model: DoubaoVideoModel) {
  const normalized = chip.replace(/^\s*模型\s*/, "").replace(/\s+/g, "");
  const expected = model === "seedance_2_0_mini" ? "Seedance2.0Mini" : model === "seedance_2_0_fast" ? "Seedance2.0Fast" : "Seedance2.0";
  return normalized.toLowerCase() === expected.toLowerCase();
}

export const WORK_MEDIA_UNSUPPORTED = "当前账号是豆包工作/飞书个人版，未提供本接口所需的普通豆包 Seedream/Seedance 模型控制条；请使用普通豆包账号并确认本地额度。未发送提示词，也未提交生成";

/** Radix dropdowns open on pointerdown, not HTMLElement.click or mouse-only events. */
export function mediaControlOpenScript(label: string) {
  if (!["模型", "比例", "视频参数"].includes(label)) throw new Error("不是允许的媒体参数控件");
  return `(() => {
    const label = ${JSON.stringify(label)};
    const el = Array.from(document.querySelectorAll('button,[role="button"]')).find(el => {
      const t = String(el.textContent || '').replace(/\\s+/g, '');
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      const matches = label === '视频参数' ? /^(?:自动|[0-9]{1,2}:[0-9]{1,2})[·•|](?:5|10|15|[4-9]|1[0-5])(?:s|秒)$/i.test(t) : t.startsWith(label);
      return matches && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
        && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    if (!el) return false;
    if (el.getAttribute('aria-expanded') === 'true') return true;
    if (el.getAttribute('data-slot') === 'dropdown-menu-trigger') {
      el.focus();
      for (const type of ['pointerdown','pointerup']) el.dispatchEvent(new PointerEvent(type,
        {bubbles:true,button:0,buttons:type==='pointerdown'?1:0,pointerType:'mouse',isPrimary:true,pointerId:1}));
    } else el.click();
    return true;
  })()`;
}

/** Scope choices to an open media menu: never select a toolbar label or a chat-history match. */
export function mediaMenuOptionClickScript(value: string) {
  const values = ["21:9","16:9","9:16","4:3","3:4","3:2","2:3","1:1",
    "Seedream 5.0 Flash","Seedream 5.0 Pro","Seedream 5.0 Lite","Seedream 4.5","Seedream 4.0",
    "Seedance 2.0","Seedance 2.0 Fast","Seedance 2.0 Mini"];
  if (!values.includes(value)) throw new Error("不是允许的媒体参数选项");
  return `(() => {
    const wanted = ${JSON.stringify(value.replace(/\s+/g, "").toLowerCase())};
    for (const root of document.querySelectorAll('[role="menu"][data-state="open"],[role="listbox"]')) {
      const rr = root.getBoundingClientRect(), rs = getComputedStyle(root);
      if (rr.width <= 0 || rr.height <= 0 || rs.visibility === 'hidden' || rs.display === 'none') continue;
      const el = Array.from(root.querySelectorAll('button,[role="menuitem"],[role="option"],[role="menuitemradio"]')).find(el => {
        const t = String(el.textContent || '').replace(/\\s+/g,'').toLowerCase();
        const match = /^seed/.test(wanted) ? t.startsWith(wanted) && !/^[a-z0-9.]/i.test(t.slice(wanted.length)) : t === wanted;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return match && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
          && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      if (el) { el.click(); root.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true})); return true; }
    }
    return false;
  })()`;
}
