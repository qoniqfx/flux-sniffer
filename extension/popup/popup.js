import { bestUrl, copyValue, realUrl } from '../lib/format.js';
import { checkUpdate } from '../lib/update.js';

const $ = (s) => document.querySelector(s);
const STALE_RUNNING_MS = 20000;
const LIVE = new Set(['stream', 'hls', 'dash', 'playlist']);
const KIND_ORDER = { stream: 0, playlist: 1, hls: 2, dash: 3, file: 4 };
const KIND_NAME = { ICECAST: 'Icecast', SHOUTCAST: 'Shoutcast', ICY: 'Icecast/Shoutcast', STREAM: 'Flux direct', HLS: 'HLS', DASH: 'DASH', PLS: 'Playlist PLS', M3U: 'Playlist M3U', FICHIER: 'Fichier audio' };

let tabId = null;
let tabUrl = '';
let winId = null;
let state = { armed: false, items: [] };
let selectedKey = null;
let showFiles = false;
let audio = null;
let playingKey = null;
let playError = '';
let upd = null; // result of the version check (null = unknown)
const CURRENT = chrome.runtime.getManifest().version;

// DOM builder: textContent only (URLs, ICY names and titles come from untrusted pages).
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1500);
}
async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copié ✓`);
  } catch {
    toast('Copie refusée');
  }
}
const send = (msg) => chrome.runtime.sendMessage({ ...msg, tabId });

function testState(it) {
  const t = it.test;
  if (!t) return 'run';
  if (t.state === 'running') return Date.now() - t.at > STALE_RUNNING_MS ? 'run' : 'run';
  return t.state; // ok | ko
}
const rank = (it) =>
  (testState(it) === 'ok' ? 0 : testState(it) === 'run' ? 1 : 2) * 10 + (KIND_ORDER[it.kind] ?? 5) + (it.test?.playlist === 'media' ? 0.5 : 0);
const kindName = (it) => (it.test?.playlist === 'media' ? 'HLS · variante' : KIND_NAME[it.label] || it.label);

function explain(t = {}) {
  const e = t.error || '';
  if (/^HTTP (401|403)/.test(e)) return `Le serveur refuse l’accès (${e.slice(5)}). Il exige sûrement un token, ta session ou un autre site d’origine.`;
  if (/^HTTP 404/.test(e)) return 'Ce flux n’existe plus (404).';
  if (/HTML/.test(e)) return 'C’est une page web, pas un flux audio.';
  if (/Timeout/.test(e)) return 'Aucune donnée reçue en 8 secondes.';
  if (/segment/.test(e)) return 'La playlist répond mais ses morceaux audio sont inaccessibles.';
  return e || 'Le test n’a pas abouti.';
}

function stopAudio() {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  audio = null;
  playingKey = null;
}
function togglePlay(it) {
  if (playingKey === it.key) {
    stopAudio();
    return render();
  }
  stopAudio();
  playError = '';
  audio = new Audio();
  audio.volume = 0.8;
  audio.src = it.test?.resolved || it.url;
  playingKey = it.key;
  audio.addEventListener('error', () => {
    playError = it.kind === 'hls' ? 'Chrome/Brave ne lit pas le HLS ici. Copie l’URL dans VLC ou ffplay.' : 'Lecture refusée par le serveur (token ou Referer).';
    stopAudio();
    render();
  });
  audio.play().catch(() => {});
  render();
}

function heroCard(it) {
  const st = testState(it);
  const t = it.test || {};
  const host = (() => {
    try {
      return new URL(it.url).host;
    } catch {
      return '';
    }
  })();
  const name = t.name || it.icy?.name || '';
  const real = realUrl(it);
  const kind = kindName(it);

  const statusEl =
    st === 'ok'
      ? h('div', { class: 'status ok' }, h('i'), 'Flux trouvé · ça marche')
      : st === 'ko'
        ? h('div', { class: 'status ko' }, h('i'), 'Flux trouvé · ne répond pas')
        : h('div', { class: 'status run' }, h('i'), 'Flux trouvé · test en cours…');

  const tags = [kind, ...(st === 'ok' ? t.parts || [] : [])].filter(Boolean);

  return h(
    'section',
    { class: `hero ${st === 'run' ? '' : st}` },
    statusEl,
    h('div', {}, h('div', { class: 'title' }, name || host), name ? h('div', { class: 'sub' }, host) : null),
    st === 'ok' && t.title ? h('div', { class: 'np' }, h('small', {}, 'En ce moment'), t.title) : null,
    h('div', { class: 'q' }, tags.map((x, i) => h('span', { class: `tag ${i === 0 ? '' : 'mono'}` }, x))),
    h('div', { class: 'url', title: 'Clic pour copier', onclick: () => copy(bestUrl(it), 'URL') }, bestUrl(it)),
    it.cleanUrl ? h('div', { class: 'sub' }, 'URL nettoyée : paramètres de suivi retirés, flux retesté ✓') : null,
    st === 'ko' ? h('div', { class: 'why' }, explain(t)) : null,
    playError ? h('div', { class: 'why' }, playError) : null,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn btn-white', type: 'button', onclick: () => copy(bestUrl(it), 'URL') }, 'Copier l’URL'),
      st === 'ko'
        ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => send({ type: 'test', key: it.key }) }, 'Retester')
        : h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => togglePlay(it) }, playingKey === it.key ? 'Stop' : 'Écouter'),
    ),
    h(
      'details',
      { class: 'more' },
      h('summary', {}, 'Plus d’options'),
      h(
        'div',
        { class: 'opts' },
        real ? h('button', { class: 'opt', type: 'button', onclick: () => copy(real, 'URL réelle') }, 'Copier l’URL réelle', h('span', {}, 'après redirection')) : null,
        h('button', { class: 'opt', type: 'button', onclick: () => copy(copyValue(it, 'ffplay'), 'Commande') }, 'Copier la commande ffplay', h('span', {}, 'écouter')),
        h('button', { class: 'opt', type: 'button', onclick: () => copy(copyValue(it, 'ffmpeg'), 'Commande') }, 'Copier la commande ffmpeg', h('span', {}, 'enregistrer')),
        st !== 'ko' ? h('button', { class: 'opt', type: 'button', onclick: () => send({ type: 'test', key: it.key }) }, 'Retester ce flux') : null,
        st === 'ko' ? h('button', { class: 'opt', type: 'button', onclick: () => togglePlay(it) }, playingKey === it.key ? 'Stop' : 'Essayer de l’écouter quand même') : null,
      ),
    ),
  );
}

function otherRow(it) {
  const st = testState(it);
  let host = '';
  let path = '';
  try {
    const u = new URL(it.url);
    host = u.host;
    path = u.pathname;
  } catch {}
  const name = it.test?.name || it.icy?.name;
  return h(
    'button',
    { class: 'item', type: 'button', onclick: () => ((selectedKey = it.key), render()) },
    h('span', { class: `dot ${st === 'run' ? '' : st}` }),
    h('span', { class: 't' }, name || host, h('small', {}, path || it.url)),
    h('span', { class: 'k' }, kindName(it)),
  );
}

function updBanner() {
  if (!upd?.outdated) return null;
  return h(
    'button',
    { class: 'upd', type: 'button', onclick: () => chrome.tabs.create({ url: upd.url }) },
    `Nouvelle version ${upd.latest} disponible`,
    h('span', {}, 'Télécharger →'),
  );
}

function renderVer() {
  const el = $('#ver');
  el.className = `ver ${$('#foot').hidden ? '' : 'sep'}`;
  const dot = upd?.outdated ? 'warn' : upd && upd.latest ? 'ok' : '';
  const txt = upd?.outdated ? `v${CURRENT} · version obsolète (dernière : ${upd.latest})` : upd && upd.latest ? `v${CURRENT} · à jour` : `v${CURRENT}`;
  el.replaceChildren(h('span', { class: `dot ${dot}` }), txt);
}

function render() {
  renderVer();
  const http = /^https?:/.test(tabUrl);
  try {
    $('#host').textContent = http ? new URL(tabUrl).host : '';
  } catch {}
  $('#foot').hidden = !state.armed || !http;
  $('#clear').hidden = !state.items.length;

  const view = $('#view');
  if (!http) {
    view.replaceChildren(updBanner(), h('div', { class: 'state' }, h('h2', {}, 'Page non analysable'), h('p', {}, 'Ouvre le site d’une radio (http ou https) puis relance l’extension.')));
    return;
  }

  const all = state.items;
  const live = all.filter((i) => LIVE.has(i.kind)).sort((a, b) => rank(a) - rank(b) || b.firstAt - a.firstAt);
  const files = all.filter((i) => !LIVE.has(i.kind));
  $('#reload').hidden = !live.length; // while searching, the big button already does it

  if (!live.length) {
    view.replaceChildren(
      updBanner(),
      h(
        'div',
        { class: 'state' },
        h('div', { class: 'spin' }),
        h('h2', {}, 'J’écoute cette page…'),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, h('b', {}, '1'), h('span', {}, 'Lance la lecture de la radio sur le site (bouton play).')),
          h('li', {}, h('b', {}, '2'), h('span', {}, 'Le flux apparaît ici tout seul, déjà testé.')),
        ),
        h('button', { class: 'btn btn-secondary btn-block', type: 'button', onclick: () => chrome.tabs.reload(tabId, { bypassCache: true }) }, 'Le son était déjà lancé ? Recharger la page'),
        files.length ? h('button', { class: 'linkbtn', type: 'button', onclick: () => ((showFiles = !showFiles), render()) }, `${files.length} fichier(s) audio ignoré(s) · ${showFiles ? 'masquer' : 'voir'}`) : null,
        showFiles ? h('div', { class: 'list', style: 'width:100%' }, files.map(otherRow)) : null,
      ),
    );
    return;
  }

  const main = live.find((i) => i.key === selectedKey) || live[0];
  const others = live.filter((i) => i !== main);
  const nodes = [updBanner(), heroCard(main)].filter(Boolean);
  if (others.length || files.length) {
    nodes.push(
      h(
        'div',
        { class: 'others' },
        others.length ? h('h3', {}, `AUTRES FLUX TROUVÉS (${others.length})`) : null,
        h('div', { class: 'list' }, others.map(otherRow), showFiles ? files.map(otherRow) : null),
        files.length ? h('button', { class: 'linkbtn', type: 'button', onclick: () => ((showFiles = !showFiles), render()) }, showFiles ? 'Masquer les fichiers audio' : `Afficher ${files.length} fichier(s) audio`) : null,
      ),
    );
  }
  view.replaceChildren(...nodes);
}

async function load() {
  const k = `tab:${tabId}`;
  state = (await chrome.storage.session.get(k))[k] || { armed: false, items: [] };
  render();
}

const PANEL = document.body.dataset.mode === 'panel';

async function currentTab() {
  if (!PANEL) return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  return w ? (await chrome.tabs.query({ active: true, windowId: w.id }))[0] : null;
}

// Binds the UI to a tab. In the side panel this runs again each time the user switches tab or navigates.
let bindSeq = 0;
async function bind(tab) {
  const seq = ++bindSeq;
  if ((tab?.id ?? null) !== tabId) {
    stopAudio();
    selectedKey = null;
    showFiles = false;
  }
  tabId = tab?.id ?? null;
  tabUrl = tab?.url || '';
  winId = tab?.windowId ?? null;
  $('#host').textContent = '';
  if (tabId == null) return render();
  await load();
  if (seq !== bindSeq) return;
  if (/^https?:/.test(tabUrl) && !state.armed) await send({ type: 'arm', on: true });
}

async function refreshTab() {
  const tab = await currentTab();
  if (!tab || (tab.id === tabId && (tab.url || '') === tabUrl)) return;
  await bind(tab);
}

async function pin() {
  try {
    await chrome.sidePanel.open({ windowId: winId });
  } catch {
    // No side panel (older or alternative Chromium build): fall back to a detached window.
    await chrome.windows.create({ url: chrome.runtime.getURL('popup/panel.html'), type: 'popup', width: 400, height: 660 });
  }
  window.close();
}

async function init() {
  await bind(await currentTab());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && tabId != null && changes[`tab:${tabId}`]) {
      state = changes[`tab:${tabId}`].newValue || { armed: false, items: [] };
      render();
    }
  });

  if (PANEL) {
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onUpdated.addListener((id, info) => {
      if (id === tabId && (info.url || info.status === 'complete')) refreshTab();
    });
    chrome.windows.onFocusChanged.addListener(refreshTab);
  } else {
    $('#pin').hidden = false;
    $('#pin').addEventListener('click', pin);
  }

  $('#reload').addEventListener('click', () => chrome.tabs.reload(tabId, { bypassCache: true }));
  $('#clear').addEventListener('click', () => {
    selectedKey = null;
    send({ type: 'clear' });
  });
  $('#stop').addEventListener('click', async () => {
    stopAudio();
    await send({ type: 'arm', on: false });
    if (!PANEL) window.close();
  });

  // Version check (cached 6 h, never blocks the UI).
  chrome.storage.local.get('upd').then(async ({ upd: cache }) => {
    const r = await checkUpdate(CURRENT, { cache });
    if (r && r !== cache) chrome.storage.local.set({ upd: r });
    upd = r;
    render();
  });
}

init();
