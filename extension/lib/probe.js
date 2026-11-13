// Verifies that a candidate URL really is a working stream and extracts what we can
// (codec, bitrate, ICY name / current title, HLS variants...). Runs in the service worker
// and in Node (tests): only needs fetch + AbortController.

import { fmtKbps, fmtKhz, fmtCh } from './format.js';

const TIMEOUT = 8000;
const FAIL_NET = 'Connexion impossible (réseau, DNS ou TLS)';

const dec = (u8) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    return new TextDecoder('windows-1252').decode(u8);
  }
};
const ascii = (u8) => {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return s;
};
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function merge(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Reads the body until stop(buf,total) is true, then cancels. Partial data survives a timeout. */
async function readSome(res, ctrl, stop, ms = TIMEOUT) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (stop(merge(chunks, total), total)) break;
    }
  } catch (e) {
    if (!total) throw e;
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {}
    ctrl.abort();
  }
  return merge(chunks, total);
}

async function fetchText(f, url, ms = TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await f(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      url: res.url || url,
      ctype: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      text: dec(buf.subarray(0, 262144)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── audio sniffing ─────────────────────────

const MP3_BR = {
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const AAC_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseMpegFrame(b, i) {
  const ver = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1] >> 1) & 3; // 1 = III, 2 = II
  const bi = (b[i + 2] >> 4) & 15;
  const si = (b[i + 2] >> 2) & 3;
  if (ver === 1 || layer === 0 || layer === 3 || bi === 0 || bi === 15 || si === 3) return null;
  const tbl = MP3_BR[`${ver === 3 ? 1 : 2}-${layer === 1 ? 3 : 2}`];
  const kbps = tbl?.[bi];
  const sr = MP3_SR[ver]?.[si];
  if (!kbps || !sr) return null;
  const pad = (b[i + 2] >> 1) & 1;
  const coef = layer === 1 && ver !== 3 ? 72 : 144;
  const len = Math.floor((coef * kbps * 1000) / sr) + pad;
  return {
    codec: layer === 1 ? 'MP3' : 'MP2',
    kbps,
    hz: sr,
    ch: ((b[i + 3] >> 6) & 3) === 3 ? 1 : 2,
    len,
  };
}

function parseAdtsFrame(b, i) {
  const sfi = (b[i + 2] >> 2) & 15;
  if (sfi > 12) return null;
  const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
  if (len < 7) return null;
  return { codec: 'AAC', hz: AAC_SR[sfi], ch: ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6), len };
}

export function sniffAudio(b) {
  if (b.length < 4) return null;
  const head = ascii(b.subarray(0, 4));
  if (head === 'OggS') {
    const s = ascii(b.subarray(0, Math.min(b.length, 512)));
    let i = s.indexOf('OpusHead');
    if (i >= 0) return { codec: 'Opus', hz: 48000, ch: b[i + 9] };
    i = s.indexOf('\x01vorbis');
    if (i >= 0) {
      const nom = le32(b, i + 20);
      return { codec: 'Vorbis', ch: b[i + 11], hz: le32(b, i + 12), kbps: nom ? Math.round(nom / 1000) : 0 };
    }
    return { codec: 'Ogg' };
  }
  if (head === 'fLaC') return { codec: 'FLAC' };
  if (ascii(b.subarray(4, 8)) === 'ftyp') return { codec: 'MP4/AAC' };

  let off = 0;
  if (head.startsWith('ID3') && b.length > 10) {
    off = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
    if (off >= b.length) return { codec: 'MP3' };
  }
  const end = Math.min(b.length - 6, off + 4096);
  for (let i = off; i < end; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const layer = (b[i + 1] >> 1) & 3;
    const fr = layer === 0 ? parseAdtsFrame(b, i) : parseMpegFrame(b, i);
    if (!fr) continue;
    const n = i + fr.len; // a real frame is followed by another sync word
    if (n + 2 <= b.length && !(b[n] === 0xff && (b[n + 1] & 0xe0) === 0xe0)) continue;
    return fr;
  }
  return null;
}

function parseIcyTitle(buf, metaint) {
  if (!metaint || buf.length <= metaint) return '';
  const len = buf[metaint] * 16;
  if (!len || buf.length < metaint + 1 + len) return '';
  const meta = dec(buf.subarray(metaint + 1, metaint + 1 + len)).replace(/\0+$/, '');
  const m = /StreamTitle='([\s\S]*?)'\s*(?:;|$)/.exec(meta);
  return (m?.[1] || '').trim();
}

// ───────────────────────── probes ─────────────────────────

async function probeStream(f, url, depth) {
  const ctrl = new AbortController();
  let res;
  try {
    res = await f(url, {
      headers: { 'Icy-MetaData': '1' },
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
    });
  } catch (e) {
    ctrl.abort();
    throw e;
  }
  const h = (n) => res.headers.get(n) || '';
  const info = {
    status: res.status,
    ctype: h('content-type').split(';')[0].trim().toLowerCase(),
    server: h('server'),
    name: h('icy-name'),
    genre: h('icy-genre'),
  };
  if (!res.ok) {
    ctrl.abort();
    return fail(`HTTP ${res.status}`, info);
  }
  const metaint = parseInt(h('icy-metaint'), 10) || 0;
  const hasLength = h('content-length') !== '';
  const buf = await readSome(res, ctrl, (b, t) => {
    if (metaint) return t > metaint && t >= metaint + 1 + b[metaint] * 16;
    return t >= 8192;
  });
  if (!buf.length) return fail('Aucune donnée reçue', info);

  const start = ascii(buf.subarray(0, 16)).trimStart().toLowerCase();
  if (start.startsWith('#extm3u')) return probeHls(f, url);
  if (start.startsWith('[playlist]')) return probePlaylist(f, url, depth);
  if (start.startsWith('<mpd') || start.startsWith('<?xml')) return probeDash(f, url);
  if (start.startsWith('<')) return fail('Page HTML, pas un flux audio', info);

  let a = sniffAudio(buf);
  if (!a) {
    if (!info.ctype.startsWith('audio/')) return fail('Contenu non reconnu comme audio', info);
    a = { codec: info.ctype.split('/')[1].toUpperCase() };
  }
  const kbps = a.kbps || parseInt(h('icy-br'), 10) || 0;
  const title = parseIcyTitle(buf, metaint);
  return {
    ok: true,
    kind: 'stream',
    ...info,
    codec: a.codec,
    kbps,
    hz: a.hz || parseInt(h('icy-sr'), 10) || 0,
    ch: a.ch || 0,
    metaint,
    title,
    hasLength,
    live: !hasLength || metaint > 0,
    parts: [a.codec, fmtKbps(kbps), fmtKhz(a.hz), fmtCh(a.ch)].filter(Boolean),
  };
}

function parseAttrs(line) {
  const o = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}

function codecName(codecs = '') {
  const c = codecs.split(',').map((s) => s.trim());
  const a = c.find((x) => /^(mp4a|opus|ac-3|ec-3|flac|mp3)/i.test(x));
  if (!a) return '';
  if (/^mp4a\.40\.2$/i.test(a)) return 'AAC-LC';
  if (/^mp4a\.40\.5$/i.test(a)) return 'HE-AAC';
  if (/^mp4a\.40\.29$/i.test(a)) return 'HE-AACv2';
  if (/^mp4a\.(69|6b)$|^mp3$/i.test(a) || /^mp4a\.40\.3[34]$/i.test(a)) return 'MP3';
  if (/^opus/i.test(a)) return 'Opus';
  return a;
}

async function probeHls(f, url) {
  const first = await fetchText(f, url);
  if (!first.ok) return fail(`HTTP ${first.status}`, { status: first.status });
  if (!first.text.trimStart().startsWith('#EXTM3U')) return fail('Pas une playlist HLS valide', { status: first.status });

  let media = first;
  let variants = [];
  const lines = first.text.split(/\r?\n/);
  if (first.text.includes('#EXT-X-STREAM-INF')) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const at = parseAttrs(lines[i].slice(lines[i].indexOf(':') + 1));
      const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
      if (uri) variants.push({ bw: parseInt(at.BANDWIDTH, 10) || 0, codecs: at.CODECS || '', res: at.RESOLUTION, uri: uri.trim() });
    }
    if (!variants.length) return fail('Master playlist sans variante', { status: first.status });
    const pick = variants[0];
    media = await fetchText(f, new URL(pick.uri, first.url).href);
    if (!media.ok) return fail(`Variante HTTP ${media.status}`, { status: media.status });
  }

  const mlines = media.text.split(/\r?\n/);
  const segs = mlines.filter((l) => l.trim() && !l.startsWith('#'));
  const live = !media.text.includes('#EXT-X-ENDLIST');
  const encrypted = /#EXT-X-KEY:.*METHOD=(?!NONE)/.test(media.text);
  if (!segs.length) return fail('Playlist HLS sans segment', { status: first.status });

  let segmentOk = null;
  const segUrl = new URL(segs[0].trim(), media.url).href;
  try {
    const ctrl = new AbortController();
    const r = await f(segUrl, { headers: { Range: 'bytes=0-2047' }, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    segmentOk = r.status === 200 || r.status === 206;
    await readSome(r, ctrl, (_b, t) => t >= 1, 5000).catch(() => {});
  } catch {
    segmentOk = false;
  }
  if (segmentOk === false) return fail('Playlist OK mais le premier segment est inaccessible', { status: first.status, kind: 'hls' });

  const bws = variants.map((v) => v.bw).filter(Boolean);
  const kbpsMin = bws.length ? Math.round(Math.min(...bws) / 1000) : 0;
  const kbpsMax = bws.length ? Math.round(Math.max(...bws) / 1000) : 0;
  const codec = codecName(variants[0]?.codecs);
  const video = variants.some((v) => v.res || /avc|hev|hvc|vp0?9|av01/i.test(v.codecs));
  const range = kbpsMin ? (kbpsMin === kbpsMax ? fmtKbps(kbpsMin) : `${kbpsMin}–${kbpsMax} kbps`) : '';
  return {
    ok: true,
    kind: 'hls',
    status: first.status,
    ctype: first.ctype,
    codec,
    kbps: kbpsMax,
    live,
    video,
    encrypted,
    variants: variants.length,
    parts: [
      codec,
      range,
      variants.length > 1 ? `${variants.length} variantes` : '',
      live ? 'direct' : 'VOD',
      video ? 'vidéo' : 'audio seul',
      encrypted ? 'chiffré' : '',
    ].filter(Boolean),
  };
}

async function probeDash(f, url) {
  const r = await fetchText(f, url);
  if (!r.ok) return fail(`HTTP ${r.status}`, { status: r.status });
  if (!/<MPD[\s>]/.test(r.text)) return fail('Pas un manifeste DASH valide', { status: r.status });
  const live = /type="dynamic"/.test(r.text);
  const codec = (/codecs="(mp4a[^"]*|opus)"/.exec(r.text) || [])[1] || '';
  return { ok: true, kind: 'dash', status: r.status, ctype: r.ctype, live, codec, parts: [codec, live ? 'direct' : 'VOD'].filter(Boolean) };
}

async function probePlaylist(f, url, depth) {
  const r = await fetchText(f, url);
  if (!r.ok) return fail(`HTTP ${r.status}`, { status: r.status });
  const text = r.text.trim();
  if (text.startsWith('#EXTM3U') && text.includes('#EXT-X-')) return probeHls(f, url);

  let entries = [];
  let title = '';
  if (/^\[playlist\]/i.test(text)) {
    entries = [...text.matchAll(/^File\d+=(.+)$/gim)].map((m) => m[1].trim());
    title = (/^Title1=(.+)$/im.exec(text) || [])[1]?.trim() || '';
  } else {
    entries = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  const urls = [];
  for (const e of entries) {
    try {
      urls.push(new URL(e, r.url).href);
    } catch {}
  }
  if (!urls.length) return fail('Playlist vide', { status: r.status });

  let last = null;
  for (const u of urls.slice(0, 3)) {
    const child = await probeAny(f, u, depth + 1);
    if (child.ok) return { ...child, resolved: child.resolved || u, name: child.name || title, alternates: urls.length - 1 };
    last = { ...child, resolved: u };
  }
  return fail(last?.error || 'Aucune entrée valide', { resolved: last?.resolved });
}

async function probeAny(f, url, depth) {
  if (depth > 2) return fail('Playlists imbriquées trop profondes');
  const p = new URL(url).pathname.toLowerCase();
  if (p.endsWith('.m3u8')) return probeHls(f, url);
  if (p.endsWith('.pls') || p.endsWith('.m3u')) return probePlaylist(f, url, depth);
  if (p.endsWith('.mpd')) return probeDash(f, url);
  return probeStream(f, url, depth);
}

/** @returns {Promise<object>} {ok, ...details, ms}. Never throws. */
export async function probe(url, ctx = {}) {
  const f = ctx.fetch || ((u, i) => fetch(u, i));
  const t0 = Date.now();
  try {
    const r = await probeAny(f, url, 0);
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    const timeout = e?.name === 'AbortError';
    const msg = timeout ? 'Timeout (aucune donnée en 8 s)' : /fetch|network|ENOTFOUND|ECONN|TLS|cert/i.test(e?.message || '') ? FAIL_NET : e?.message || String(e);
    return { ok: false, error: msg, ms: Date.now() - t0 };
  }
}
