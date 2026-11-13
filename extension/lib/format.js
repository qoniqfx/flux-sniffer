// Shared formatting helpers (popup + probe). Pure functions, no chrome.* calls.

export const fmtKbps = (n) => (n ? `${Math.round(n)} kbps` : '');
export const fmtKhz = (hz) =>
  hz ? `${(hz / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kHz` : '';
export const fmtCh = (c) => (c === 1 ? 'mono' : c === 2 ? 'stéréo' : c ? `${c} canaux` : '');

/** URL the browser really ends up on (after redirect / playlist resolution), or '' if same as entry. */
export function realUrl(item) {
  const r = item.test?.resolved || item.finalUrl || '';
  return r && r !== item.url ? r : '';
}

const TRACKING = /^(aw_|utm_|origine$|origin$|source$|fbclid$|gclid$|us_privacy$|gdpr|.*consent|listener|context$|ref$|referrer$|cb$|_$|ts$|rnd$)/i;

/** Cleaner variants of a stream URL (tracking / consent / ad params removed), most minimal first. Callers must test them. */
export function cleanCandidates(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (!u.search) return [];
  const out = [];
  const bare = `${u.origin}${u.pathname}`;
  out.push(bare);
  const kept = new URL(url);
  for (const k of [...kept.searchParams.keys()]) if (TRACKING.test(k)) kept.searchParams.delete(k);
  const stripped = kept.toString().replace(/\?$/, '');
  if (stripped !== bare && stripped !== url) out.push(stripped);
  return out;
}

/** URL to hand to the user: the verified clean one when there is one, else the captured one. */
export const bestUrl = (item) => item.cleanUrl || item.url;

function recExt(item) {
  const c = (item.test?.codec || '').toLowerCase();
  if (/mp3|mp2/.test(c)) return 'mp3';
  if (/aac/.test(c) && item.kind !== 'hls') return 'aac';
  if (/opus|vorbis|ogg/.test(c)) return 'ogg';
  if (/flac/.test(c)) return 'flac';
  return 'mka';
}

/** Text put in the clipboard for a given format: url | ffplay | ffmpeg. */
export function copyValue(item, fmt) {
  const target = item.test?.resolved || bestUrl(item);
  if (fmt === 'ffplay') return `ffplay -nodisp "${target}"`;
  if (fmt === 'ffmpeg') return `ffmpeg -i "${target}" -c copy "rec.${recExt(item)}"`;
  return bestUrl(item);
}
