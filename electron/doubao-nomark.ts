import crypto from "node:crypto";

/**
 * 豆包无水印原片解析（自研，复刻 community doubao-nomark 方案，2026-10-14 实测跑通）
 *
 * 原理：页面数据里携带 fallback_api（豆包自家播放接口 vas-*.snssdk.com/video/fplay/...），
 * 把参数改为 logo_type=unwatermarked 调用即可拿到「无水印原片」的加密 token（qAAB 开头），
 * 用页面里的 key_seed 经 SHA-512 派生 AES-128-CBC 密钥解密 token 得到真实 URL。
 * 结果为 quality=original 的原画母带（例：1080P档 / 20.9Mbps / 26MB），无水印、无压缩、无第三方依赖。
 */

const QAAB_SALT_HEX =
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58";

export interface NomarkVideoInfo {
  url: string;
  definition: string;
  quality: string;
  width: number;
  height: number;
  bitrate: number;
  sizeBytes: number;
  duration: number;
}

function base64DecodeLoose(text: string): Buffer | null {
  const input = String(text || "").trim();
  if (!input) return null;
  const variants = [
    input,
    input.replace(/\$/g, "_").replace(/@/g, "/").replace(/#/g, "."),
    input.replace(/\$/g, "+").replace(/@/g, "/").replace(/#/g, "=")
  ];
  const seen = new Set<string>();
  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const normalized = candidate.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
      return Buffer.from(normalized, "base64");
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 解密 qAAB 加密 token → 真实 URL（复刻 doubao-nomark decodeQaabToken） */
export function decodeQaabToken(token: string, keySeed: string): string | null {
  if (/^https?:\/\//i.test(token)) return token;
  if (!token.startsWith("qAAB")) return null;
  const data = base64DecodeLoose(token);
  const seed = base64DecodeLoose(keySeed);
  if (!data || !seed || seed.length < 32) return null;

  const digest1 = crypto.createHash("sha512").update(seed.subarray(0, 32)).digest();
  const salt = Buffer.from(QAAB_SALT_HEX, "hex");
  const digest2 = crypto.createHash("sha512").update(Buffer.concat([digest1, salt])).digest();
  const key = digest2.subarray(0, 16);
  const iv = digest2.subarray(16, 32);

  const attempts: Array<[Buffer, Buffer, Buffer]> = [];
  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
    attempts.push([data.subarray(4), key, iv]);
    attempts.push([data.subarray(4), iv, key]);
    if (data.length > 36) {
      attempts.push([data.subarray(36), key, data.subarray(20, 36)]);
      attempts.push([data.subarray(36), key, iv]);
    }
  } else {
    attempts.push([data, key, iv]);
  }

  for (const [payload, useKey, useIv] of attempts) {
    if (!payload.length || payload.length % 16 !== 0) continue;
    try {
      const decipher = crypto.createDecipheriv("aes-128-cbc", useKey, useIv);
      const out = Buffer.concat([decipher.update(payload), decipher.final()]);
      const text = out.toString("utf8").trim();
      if (/^https?:\/\//i.test(text)) return text;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 从页面 HTML（多层转义）里提取全部 fallback_api + key_seed */
export function extractFallbackApis(pageHtml: string): Array<{ apiUrl: string; keySeed: string }> {
  let s = String(pageHtml || "");
  for (let round = 0; round < 4; round += 1) {
    const next = s
      .replace(/&quot;/gi, '"')
      .replace(/&#34;/g, '"')
      .replace(/&amp;/gi, "&")
      .replace(/\\u002F/gi, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/\\\\"/g, '"')
      .replace(/\\"/g, '"');
    if (next === s) break;
    s = next;
  }

  const out: Array<{ apiUrl: string; keySeed: string }> = [];
  const seen = new Set<string>();
  const re = /https:\/\/vas-[a-z0-9-]+\.snssdk\.com\/video\/fplay\/[^\s"'\\<>]+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s))) {
    const apiUrl = match[0].replace(/[)\\]+,?$/, "");
    if (seen.has(apiUrl)) continue;
    seen.add(apiUrl);
    let keySeed = "";
    try {
      keySeed = new URL(apiUrl).searchParams.get("key_seed") || "";
    } catch {
      continue;
    }
    out.push({ apiUrl, keySeed });
  }
  return out;
}

/** 调 fallback_api（改为 unwatermarked）并解密出原片 URL */
export async function resolveUnwatermarkedVideo(apiUrl: string, fallbackKeySeed = ""): Promise<NomarkVideoInfo | null> {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return null;
  }
  const apiKeySeed = parsed.searchParams.get("key_seed") || fallbackKeySeed;
  parsed.searchParams.set("logo_type", "unwatermarked");
  parsed.searchParams.set("channel", "no");
  parsed.searchParams.set("codec_type", "8");

  const response = await fetch(parsed.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.doubao.com/"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) return null;

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const data = (payload as any)?.video_info?.data || (payload as any)?.data || payload;
  const videoList = (data as any)?.video_list;
  const entries: any[] = videoList && typeof videoList === "object" ? Object.values(videoList) : [data];
  const entry = (entries.find((item) => item && typeof item === "object" && (item.main_url || item.play_url)) ||
    entries[0] ||
    {}) as any;
  const token: string = String(entry.main_url || entry.play_url || "");
  if (!token) return null;

  const findKeySeed = (node: unknown, depth = 0): string => {
    if (depth > 8 || node == null) return "";
    if (typeof node === "string") {
      const m = node.match(/[?&]key_seed=([^&"'<>\s]+)/i);
      return m ? decodeURIComponent(m[1]) : "";
    }
    if (typeof node !== "object") return "";
    const record = node as Record<string, unknown>;
    if (typeof record.key_seed === "string" && record.key_seed.trim()) return record.key_seed.trim();
    for (const value of Object.values(record)) {
      const hit = findKeySeed(value, depth + 1);
      if (hit) return hit;
    }
    return "";
  };

  const keySeed = findKeySeed(payload) || apiKeySeed;
  const url = decodeQaabToken(token, keySeed);
  if (!url) return null;

  return {
    url,
    definition: String(entry.definition || ""),
    quality: String(entry.quality || ""),
    width: Number(entry.vwidth || entry.width || 0),
    height: Number(entry.vheight || entry.height || 0),
    bitrate: Number(entry.bitrate || entry.real_bitrate || 0),
    sizeBytes: Number(entry.size || 0),
    duration: Number((data as any)?.video_duration || entry.duration || 0)
  };
}

/** 从整页 HTML 直接解析无水印原片（爬页面 → 找接口 → 调接口 → 解密） */
export async function resolveUnwatermarkedFromHtml(pageHtml: string): Promise<NomarkVideoInfo | null> {
  const apis = extractFallbackApis(pageHtml);
  for (const { apiUrl, keySeed } of apis) {
    try {
      const info = await resolveUnwatermarkedVideo(apiUrl, keySeed);
      if (info?.url) return info;
    } catch {
      /* try next api */
    }
  }
  return null;
}

/** 格式化元信息（用于进度文案） */
export function formatNomarkMeta(info: NomarkVideoInfo | null | undefined): string {
  if (!info) return "无水印原片";
  const parts: string[] = [];
  const qualityLabel = info.definition ? `${info.definition.toUpperCase()}档` : "原画";
  parts.push(info.quality === "original" ? `${qualityLabel}原画` : qualityLabel);
  if (info.width && info.height) parts.push(`${info.width}x${info.height}`);
  if (info.bitrate) parts.push(`${(info.bitrate / 1_000_000).toFixed(1)}Mbps`);
  return parts.join(" · ");
}
