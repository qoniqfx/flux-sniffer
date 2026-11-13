// Service worker: per-tab capture of stream requests (webRequest), page scan, stream probing.
// State lives in chrome.storage.session ("tab:<id>") so it survives service-worker restarts.

import { classifyResponse, kindFromUrl, labelFor, normalizeKey } from './lib/classify.js';
import { probe } from './lib/probe.js';

const KEY = (id) => `tab:${id}`;
const MAX_ITEMS = 60;
const FILTER = { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] };

const armedTabs = new Set();
const redirects = new Map(); // requestId -> first URL of the redirect chain

// ───────────── state (serialized read-modify-write) ─────────────

let chain = Promise.resolve();
function mutate(tabId, fn) {
  const run = async () => {
    const k = KEY(tabId);
    const cur = (await chrome.storage.session.get(k))[k] || { armed: false, items: [], hlsDirs: [] };
    const out = await fn(cur);
    await chrome.storage.session.set({ [k]: cur });
    updateBadge(tabId, cur);
    return out;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

function updateBadge(tabId, s) {
  try {
    const n = s.items.filter((i) => i.kind !== 'file' && i.test?.state !== 'ko').length;
    chrome.action.setBadgeText({ tabId, text: s.armed ? (n ? String(n) : '•') : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#8A0206' });
    chrome.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' });
  } catch {}
}

const ready = (async () => {
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) if (k.startsWith('tab:') && v.armed) armedTabs.add(Number(k.slice(4)));
})();

// ───────────── webRequest ─────────────

const headerMap = (list = []) => {
  const o = {};
  for (const { name, value } of list) o[name.toLowerCase()] = value ?? '';
  return o;
};

function onBeforeRedirect(d) {
  if (redirects.has(d.requestId)) return;
  redirects.set(d.requestId, d.url);
  if (redirects.size > 500) redirects.delete(redirects.keys().next().value);
}

function onHeadersReceived(d) {
  handleHeaders(d).catch(() => {});
}

async function handleHeaders(d) {
  if (d.tabId < 0) return;
  await ready;
  if (!armedTabs.has(d.tabId)) return;
  const via = redirects.get(d.requestId);
  redirects.delete(d.requestId);
  const c = classifyResponse({ url: d.url, status: d.statusCode, headers: headerMap(d.responseHeaders), type: d.type });
  if (!c) return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  await addItem(d.tabId, { ...c, entry: via || d.url, finalUrl: via ? d.url : '', source: 'network', pageUrl: tab?.url || '' });
}

// Listeners are only kept while a tab is armed, so the worker isn't woken by every XHR of the browser.
function attach() {
  if (!chrome.webRequest.onHeadersReceived.hasListener(onHeadersReceived))
    chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, FILTER, ['responseHeaders']);
  if (!chrome.webRequest.onBeforeRedirect.hasListener(onBeforeRedirect))
    chrome.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, FILTER);
}
function detach() {
  chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  chrome.webRequest.onBeforeRedirect.removeListener(onBeforeRedirect);
}
attach(); // must be synchronous at top level so a wake-up event isn't lost
ready.then(() => {
  if (!armedTabs.size) detach();
});

// ───────────── items ─────────────

async function addItem(tabId, c) {
  let created = null;
  await mutate(tabId, (s) => {
    if (!s.armed) return;
    const key = normalizeKey(c.entry);
    const it = s.items.find((i) => i.key === key);
    if (it) {
      it.seenAt = Date.now();
      it.count = (it.count || 1) + 1;
      if (c.finalUrl && !it.finalUrl) it.finalUrl = c.finalUrl;
      if (c.icy?.name && !it.icy?.name) it.icy = c.icy;
      return;
    }
    if (c.kind === 'file' && s.hlsDirs.some((d) => c.entry.startsWith(d))) return; // HLS segment
    if (c.kind === 'hls') {
      const dir = c.entry.slice(0, c.entry.lastIndexOf('/') + 1);
      if (!s.hlsDirs.includes(dir)) s.hlsDirs = [...s.hlsDirs, dir].slice(-20);
    }
    created = {
      key,
      url: c.entry,
      finalUrl: c.finalUrl || '',
      kind: c.kind,
      label: c.label,
      ctype: c.ctype || '',
      server: c.server || '',
      icy: c.icy || {},
      source: c.source,
      pageUrl: c.pageUrl || '',
      firstAt: Date.now(),
      seenAt: Date.now(),
      count: 1,
    };
    s.items.unshift(created);
    if (s.items.length > MAX_ITEMS) s.items.length = MAX_ITEMS;
  });
  if (created && created.kind !== 'file') runTest(tabId, created.key);
}

async function makeCtx(pageUrl) {
  // Replay the page's Referer/Origin on probe requests so servers that check them answer like they do in the page.
  const ok = /^https?:/.test(pageUrl);
  const origin = ok ? new URL(pageUrl).origin : '';
  const hosts = new Set();
  const ids = [];
  const ensure = async (url) => {
    if (!ok) return;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (hosts.has(host)) return;
    hosts.add(host);
    const id = Math.floor(Math.random() * 1e9) + 1;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'referer', operation: 'set', value: pageUrl },
                { header: 'origin', operation: 'set', value: origin },
              ],
            },
            condition: { requestDomains: [host], tabIds: [-1], resourceTypes: ['xmlhttprequest'] },
          },
        ],
      });
      ids.push(id);
    } catch {}
  };
  return {
    api: {
      fetch: async (url, init) => {
        await ensure(url);
        return fetch(url, init);
      },
    },
    cleanup: async () => {
      if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});
    },
  };
}

async function runTest(tabId, key) {
  let it = null;
  await mutate(tabId, (s) => {
    it = s.items.find((i) => i.key === key);
    if (it) it.test = { state: 'running', at: Date.now() };
  });
  if (!it) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const ctx = await makeCtx(tab?.url || '');
  let res;
  try {
    res = await probe(it.url, ctx.api);
  } finally {
    await ctx.cleanup();
  }
  await mutate(tabId, (s) => {
    const cur = s.items.find((i) => i.key === key);
    if (!cur) return;
    cur.test = { ...res, state: res.ok ? 'ok' : 'ko', at: Date.now() };
    if (res.ok) {
      if (cur.source === 'page' && res.kind === 'stream' && res.live === false) cur.kind = 'file';
      if (cur.kind === 'stream' || cur.kind === 'file') {
        const path = new URL(cur.url).pathname;
        cur.label = labelFor(cur.kind, { server: res.server || cur.server, path, hasIcy: !!(res.name || res.metaint) });
      }
    } else if (cur.source === 'page') {
      s.items = s.items.filter((i) => i.key !== key); // page-scan false positive: drop silently
    }
  });
}

// ───────────── page scan (finds streams already playing / referenced in the page) ─────────────

function scanPage() {
  const found = new Map();
  const good = (u) => {
    let x;
    try {
      x = new URL(u);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(x.protocol)) return false;
    const p = x.pathname.toLowerCase();
    if (/\.(m3u8|pls|m3u|mp3|aac|aacp|ogg|opus|mpd)$/.test(p)) return true;
    if (p.endsWith(';') || /\/;/.test(p)) return true;
    return !!x.port && /(stream|live|listen|radio)/.test(p);
  };
  const add = (u, from) => {
    try {
      const a = new URL(u, location.href).href;
      if (!found.has(a) && good(a)) found.set(a, from);
    } catch {}
  };
  document.querySelectorAll('audio,video,source').forEach((el) => {
    if (el.currentSrc) add(el.currentSrc, 'media');
    const s = el.getAttribute('src');
    if (s) add(s, 'media');
  });
  try {
    performance.getEntriesByType('resource').forEach((e) => add(e.name, 'perf'));
  } catch {}
  const html = document.documentElement.outerHTML.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
  const re = /https?:\/\/[^\s"'<>\\`()]+/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) && n++ < 4000) add(m[0], 'html');
  return [...found.entries()].slice(0, 40).map(([url, from]) => ({ url, from }));
}

async function scanTab(tabId) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanPage });
  } catch {
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const seen = new Set();
  for (const r of results) {
    for (const c of r.result || []) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      const kind = kindFromUrl(c.url);
      await addItem(tabId, {
        entry: c.url,
        finalUrl: '',
        kind,
        label: labelFor(kind, { path: new URL(c.url).pathname }),
        ctype: '',
        server: '',
        icy: {},
        source: 'page',
        pageUrl: tab?.url || '',
      });
    }
  }
}

// ───────────── arm / disarm / messages ─────────────

async function setArmed(tabId, on) {
  await ready;
  if (on) {
    armedTabs.add(tabId);
    attach();
  } else {
    armedTabs.delete(tabId);
    if (!armedTabs.size) detach();
  }
  await mutate(tabId, (s) => {
    s.armed = on;
  });
  if (on) await scanTab(tabId);
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  (async () => {
    switch (msg?.type) {
      case 'arm':
        await setArmed(msg.tabId, !!msg.on);
        break;
      case 'scan':
        await scanTab(msg.tabId);
        break;
      case 'clear':
        await mutate(msg.tabId, (s) => {
          s.items = [];
          s.hlsDirs = [];
        });
        break;
      case 'test':
        runTest(msg.tabId, msg.key); // fire and forget, the popup follows via storage.onChanged
        break;
    }
  })().then(
    () => send({ ok: true }),
    (e) => send({ ok: false, error: String(e) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(async (id) => {
  await ready;
  armedTabs.delete(id);
  if (!armedTabs.size) detach();
  chrome.storage.session.remove(KEY(id));
});
