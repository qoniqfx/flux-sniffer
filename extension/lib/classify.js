// Turns a response seen by webRequest into a stream candidate (or null).

const AUDIO_EXT = /\.(mp3|aac|aacp|ogg|oga|opus|flac|m4a)$/i;
const HLS_CT = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl']);
const PLS_CT = new Set([
  'audio/x-scpls',
  'audio/scpls',
  'application/pls+xml',
  'audio/x-mpegurl',
  'audio/mpegurl',
  'audio/m3u',
]);
const VOLATILE = /^(_|_t|ts|timestamp|cb|cachebust|nocache|rnd|rand|random)$/i;

export function pickIcy(h) {
  return {
    name: h['icy-name'] || '',
    genre: h['icy-genre'] || '',
    br: parseInt(h['icy-br'], 10) || 0,
    metaint: parseInt(h['icy-metaint'], 10) || 0,
    url: h['icy-url'] || '',
    description: h['icy-description'] || '',
  };
}

export function labelFor(kind, { server = '', path = '', hasIcy = false } = {}) {
  if (kind === 'hls') return 'HLS';
  if (kind === 'dash') return 'DASH';
  if (kind === 'playlist') return /\.pls$/i.test(path) ? 'PLS' : 'M3U';
  if (kind === 'file') return 'FICHIER';
  if (/icecast/i.test(server)) return 'ICECAST';
  if (/shoutcast/i.test(server) || /;$/.test(path)) return 'SHOUTCAST';
  return hasIcy ? 'ICY' : 'STREAM';
}

export function kindFromUrl(url) {
  let p = '';
  try {
    p = new URL(url).pathname.toLowerCase();
  } catch {
    return 'stream';
  }
  if (p.endsWith('.m3u8')) return 'hls';
  if (p.endsWith('.mpd')) return 'dash';
  if (p.endsWith('.pls') || p.endsWith('.m3u')) return 'playlist';
  return 'stream';
}

/**
 * @param {{url:string,status:number,headers:Record<string,string>,type?:string}} r
 * headers must have lower-cased names.
 */
export function classifyResponse({ url, status, headers }) {
  if (status !== 200 && status !== 206) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;

  const path = u.pathname.toLowerCase();
  const ct = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const icy = pickIcy(headers);
  const hasIcy = !!(icy.name || icy.metaint || icy.br || icy.genre || headers['icy-notice1']);
  const hasLength = (headers['content-length'] ?? '') !== '';
  const server = headers['server'] || '';

  const make = (kind) => ({
    kind,
    label: labelFor(kind, { server, path, hasIcy }),
    ctype: ct,
    server,
    icy,
    hasLength,
  });

  if (path.endsWith('.m3u8') || HLS_CT.has(ct)) return make('hls');
  if (path.endsWith('.mpd') || ct === 'application/dash+xml') return make('dash');
  if (path.endsWith('.pls') || path.endsWith('.m3u') || PLS_CT.has(ct)) return make('playlist');

  const audioCt =
    ct.startsWith('audio/') ||
    ct === 'application/ogg' ||
    (ct === 'application/octet-stream' && (AUDIO_EXT.test(path) || hasIcy));
  if (!audioCt && !hasIcy) return null;

  const live = hasIcy || !hasLength || path.endsWith(';') || /\/;/.test(path);
  return make(live ? 'stream' : 'file');
}

/** Dedup key: same stream even if the player appends a cache-buster. */
export function normalizeKey(url) {
  try {
    const u = new URL(url);
    const params = [];
    for (const [k, v] of u.searchParams) {
      if (VOLATILE.test(k)) continue;
      if (v === '' && /^\d{9,}$/.test(k)) continue; // ?1731500000
      params.push(`${k}=${v}`);
    }
    params.sort();
    return `${u.origin}${u.pathname}${params.length ? '?' + params.join('&') : ''}`;
  } catch {
    return url;
  }
}
