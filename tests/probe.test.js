import { cleanCandidates, bestUrl } from '../extension/lib/format.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probe } from '../extension/lib/probe.js';
import { classifyResponse, normalizeKey, isSegment } from '../extension/lib/classify.js';
import { copyValue } from '../extension/lib/format.js';
import { isNewer, checkUpdate } from '../extension/lib/update.js';

// MPEG1 Layer III, 128 kbps, 44.1 kHz, joint stereo -> 417-byte frames
const frame = () => {
  const f = Buffer.alloc(417);
  f.set([0xff, 0xfb, 0x90, 0x64]);
  return f;
};
const audio = (n) => {
  const out = Buffer.alloc(n);
  for (let o = 0; o < n; o += 417) frame().copy(out, o, 0, Math.min(417, n - o));
  return out;
};
const metaBlock = (title) => {
  const txt = Buffer.from(`StreamTitle='${title}';`);
  const n = Math.ceil(txt.length / 16);
  const b = Buffer.alloc(1 + n * 16);
  b[0] = n;
  txt.copy(b, 1);
  return b;
};

let srv, base;
const timers = new Set();

before(async () => {
  srv = http.createServer((req, res) => {
    const u = req.url;
    if (u.startsWith('/live')) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': 'Radio Test', 'icy-genre': 'Pop', 'icy-br': '128', 'icy-metaint': '8192', Server: 'Icecast 2.4.4' });
      res.write(audio(8192));
      res.write(metaBlock("Artist - L'été"));
      const t = setInterval(() => res.write(audio(4096)), 20);
      timers.add(t);
      res.on('close', () => clearInterval(t));
    } else if (u === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>SHOUTcast server status</body></html>');
    } else if (u === '/radio.pls') {
      res.writeHead(200, { 'Content-Type': 'audio/x-scpls' });
      res.end(`[playlist]\nNumberOfEntries=1\nFile1=${base}/live\nTitle1=Ma Radio\nLength1=-1\nVersion=2\n`);
    } else if (u === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\nhigh/index.m3u8\n');
    } else if (u.endsWith('/index.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:6.0,\nseg10.aac\n#EXTINF:6.0,\nseg11.aac\n');
    } else if (u === '/missing.aac') {
      res.writeHead(404).end();
    } else if (u.endsWith('.aac')) {
      res.writeHead(206, { 'Content-Type': 'audio/aac' });
      res.end(Buffer.alloc(2048, 0xaa));
    } else if (u === '/broken.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:6.0,\nmissing.aac\n');
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(() => {
  for (const t of timers) clearInterval(t);
  srv.closeAllConnections?.();
  srv.close();
});

test('Icecast stream: codec, bitrate, ICY name and current title', async () => {
  const r = await probe(`${base}/live`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, 'stream');
  assert.equal(r.codec, 'MP3');
  assert.equal(r.kbps, 128);
  assert.equal(r.hz, 44100);
  assert.equal(r.ch, 2);
  assert.equal(r.name, 'Radio Test');
  assert.equal(r.metaint, 8192);
  assert.equal(r.title, "Artist - L'été");
  assert.equal(r.live, true);
  assert.ok(r.ms < 4000);
});

test('HTML page is rejected', async () => {
  const r = await probe(`${base}/page`);
  assert.equal(r.ok, false);
  assert.match(r.error, /HTML/);
});

test('404 is reported', async () => {
  const r = await probe(`${base}/nothing`);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'HTTP 404');
});

test('connection refused does not throw', async () => {
  const r = await probe('http://127.0.0.1:9/stream');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('PLS playlist resolves to the working stream', async () => {
  const r = await probe(`${base}/radio.pls`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.resolved, `${base}/live`);
  assert.equal(r.codec, 'MP3');
  assert.equal(r.name, 'Radio Test');
});

test('HLS master: variants, codec, live, first segment fetched', async () => {
  const r = await probe(`${base}/master.m3u8`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, 'hls');
  assert.equal(r.variants, 2);
  assert.equal(r.codec, 'AAC-LC');
  assert.equal(r.live, true);
  assert.equal(r.video, false);
  assert.ok(r.parts.includes('64–128 kbps'));
});

test('HLS with unreachable segment is KO', async () => {
  const r = await probe(`${base}/broken.m3u8`);
  assert.equal(r.ok, false);
  assert.match(r.error, /segment/);
});

test('custom fetch hook is used for every request (Referer replay point)', async () => {
  const seen = [];
  const r = await probe(`${base}/radio.pls`, { fetch: (u, i) => (seen.push(u), fetch(u, i)) });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [`${base}/radio.pls`, `${base}/live`]);
});

test('classifyResponse', () => {
  const icy = classifyResponse({ url: 'http://a.fr:8000/live', status: 200, headers: { 'content-type': 'audio/mpeg', 'icy-name': 'X', server: 'Icecast 2.4' } });
  assert.deepEqual([icy.kind, icy.label], ['stream', 'ICECAST']);
  const sc = classifyResponse({ url: 'http://a.fr:8000/;', status: 200, headers: { 'content-type': 'audio/aacp', 'icy-metaint': '8192' } });
  assert.deepEqual([sc.kind, sc.label], ['stream', 'SHOUTCAST']);
  const hls = classifyResponse({ url: 'https://a.fr/x/master.m3u8?token=1', status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  assert.equal(hls.kind, 'hls');
  const file = classifyResponse({ url: 'https://a.fr/pod.mp3', status: 206, headers: { 'content-type': 'audio/mpeg', 'content-length': '123456' } });
  assert.equal(file.kind, 'file');
  const chunked = classifyResponse({ url: 'https://a.fr/stream', status: 200, headers: { 'content-type': 'audio/mpeg' } });
  assert.equal(chunked.kind, 'stream');
  assert.equal(classifyResponse({ url: 'https://a.fr/api', status: 200, headers: { 'content-type': 'application/json' } }), null);
  assert.equal(classifyResponse({ url: 'https://a.fr/live', status: 302, headers: { 'content-type': 'audio/mpeg' } }), null);
});

test('HLS segments are never streams (typical CDN segment URLs)', () => {
  const u = 'https://cdn.example.net/radio/webradio/live/short/audio-64000/segment_311557914.ts';
  assert.equal(classifyResponse({ url: u, status: 200, headers: { 'content-type': 'video/mp2t' } }), null);
  assert.equal(classifyResponse({ url: u, status: 200, headers: { 'content-type': 'audio/mpeg' } }), null);
  assert.equal(classifyResponse({ url: 'https://a.fr/x/chunk-00042.aac', status: 200, headers: { 'content-type': 'audio/aac' } }), null);
  assert.equal(classifyResponse({ url: 'https://a.fr/live/stream.mp3', status: 200, headers: { 'content-type': 'audio/mpeg' } }).kind, 'stream');
  assert.equal(isSegment('/a/b/seg_12.m4s'), true);
  assert.equal(isSegment('/live/stream.mp3'), false);
});

test('variant playlist: master playlist is found one level up', async () => {
  const r = await probe(`${base}/low/index.m3u8`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.playlist, 'media');
  assert.equal(r.masterUrl, `${base}/master.m3u8`);
  const m = await probe(`${base}/master.m3u8`);
  assert.equal(m.playlist, 'master');
  assert.equal(m.masterUrl, '');
});

test('normalizeKey ignores cache busters only', () => {
  assert.equal(normalizeKey('http://a.fr/live?_=123&mount=a'), normalizeKey('http://a.fr/live?mount=a&ts=999'));
  assert.equal(normalizeKey('http://a.fr/live?1731500000123'), 'http://a.fr/live');
  assert.notEqual(normalizeKey('http://a.fr/live?mount=a'), normalizeKey('http://a.fr/live?mount=b'));
});

test('copy formats', () => {
  const it = { url: 'http://a.fr/live', kind: 'stream', test: { codec: 'MP3' } };
  assert.equal(copyValue(it, 'url'), 'http://a.fr/live');
  assert.equal(copyValue(it, 'ffplay'), 'ffplay -nodisp "http://a.fr/live"');
  assert.equal(copyValue(it, 'ffmpeg'), 'ffmpeg -i "http://a.fr/live" -c copy "rec.mp3"');
});

test('isNewer compares semver', () => {
  assert.equal(isNewer('v0.1.3', '0.1.2'), true);
  assert.equal(isNewer('v0.2.0', '0.1.9'), true);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isNewer('v0.1.2', '0.1.2'), false);
  assert.equal(isNewer('v0.1.1', '0.1.2'), false);
  assert.equal(isNewer('nope', '0.1.2'), false);
});

const rel = (tag, status = 200) => async () => ({ ok: status === 200, status, json: async () => ({ tag_name: tag, html_url: `https://github.com/qoniqfx/flux-sniffer/releases/tag/${tag}` }) });

test('checkUpdate: outdated, up to date, no release, offline', async () => {
  const a = await checkUpdate('0.1.2', { fetchFn: rel('v0.1.3') });
  assert.equal(a.outdated, true);
  assert.equal(a.latest, 'v0.1.3');
  assert.match(a.url, /releases\/tag\/v0\.1\.3$/);
  assert.equal((await checkUpdate('0.1.3', { fetchFn: rel('v0.1.3') })).outdated, false);
  const none = await checkUpdate('0.1.3', { fetchFn: rel('', 404) });
  assert.deepEqual([none.outdated, none.latest], [false, '']);
  assert.equal(await checkUpdate('0.1.3', { fetchFn: async () => { throw new Error('offline'); } }), null);
});

test('checkUpdate: fresh cache avoids the network, stale cache is kept when offline', async () => {
  const cache = { at: 1000, current: '0.1.2', latest: 'v0.1.3', url: 'u', outdated: true };
  let calls = 0;
  const f = async () => (calls++, { ok: true, status: 200, json: async () => ({ tag_name: 'v0.1.3', html_url: 'u' }) });
  assert.equal(await checkUpdate('0.1.2', { fetchFn: f, cache, now: 2000 }), cache);
  assert.equal(calls, 0);
  const offline = await checkUpdate('0.1.2', { fetchFn: async () => { throw new Error('x'); }, cache, now: 1000 + 7 * 3600 * 1000 });
  assert.equal(offline.outdated, true);
  const reset = await checkUpdate('0.1.4', { fetchFn: f, cache, now: 2000 });
  assert.equal(calls, 1);
  assert.equal(reset.outdated, false);
});

test('cleanCandidates strips tracking params, bare URL first', () => {
  const c = cleanCandidates('https://s.example/live?origine=player&aw_0_req.userConsentV2=&aw_0_1st.station=&token=abc');
  assert.equal(c[0], 'https://s.example/live');
  assert.equal(c[1], 'https://s.example/live?token=abc');
  assert.deepEqual(cleanCandidates('https://s.example/live'), []);
  assert.equal(bestUrl({ url: 'a', cleanUrl: 'b' }), 'b');
});
