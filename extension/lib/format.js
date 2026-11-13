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
  const target = item.test?.resolved || item.url;
  if (fmt === 'ffplay') return `ffplay -nodisp "${target}"`;
  if (fmt === 'ffmpeg') return `ffmpeg -i "${target}" -c copy "rec.${recExt(item)}"`;
  return item.url;
}
