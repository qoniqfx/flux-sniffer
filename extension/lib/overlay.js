// Floating Flux Sniffer window injected INTO the page: clicking the page never closes it.
// `showOverlay` is serialized by chrome.scripting, so it must stay self-contained.

export function showOverlay(src, label) {
  const ID = 'flux-sniffer-overlay';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'closed' });
  const css = document.createElement('style');
  css.textContent = `
    .box{width:390px;height:580px;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;
      background:#0a0809;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 70px rgba(0,0,0,.65);font:500 12px system-ui,sans-serif}
    .bar{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;background:#14100f;color:#c9c2c2;cursor:grab;user-select:none;flex:none}
    .bar span{flex:1;letter-spacing:.02em}
    button{all:unset;cursor:pointer;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;color:#e8e2e2}
    button:hover{background:#8a0206}
    iframe{border:0;flex:1;width:100%;background:#0a0809}
    .min .box{height:auto}.min iframe{display:none}`;
  const wrap = document.createElement('div');
  const box = document.createElement('div');
  box.className = 'box';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const title = document.createElement('span');
  title.textContent = label;
  const bMin = document.createElement('button');
  bMin.textContent = '–';
  bMin.title = 'Réduire';
  const bClose = document.createElement('button');
  bClose.textContent = '×';
  bClose.title = 'Fermer';
  bar.append(title, bMin, bClose);
  const frame = document.createElement('iframe');
  frame.src = src;
  box.append(bar, frame);
  wrap.append(box);
  root.append(css, wrap);

  bMin.addEventListener('click', () => wrap.classList.toggle('min'));
  bClose.addEventListener('click', () => {
    host.remove();
    chrome.runtime.sendMessage({ type: 'overlay', on: false }).catch(() => {});
  });
  // Drag by the title bar.
  bar.addEventListener('pointerdown', (e) => {
    if (e.target !== bar && e.target !== title) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    frame.style.pointerEvents = 'none';
    const move = (ev) => {
      host.style.left = `${Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx))}px`;
      host.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    };
    const up = () => {
      frame.style.pointerEvents = '';
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  });
  (document.body || document.documentElement).append(host);
}

export function hideOverlay() {
  document.getElementById('flux-sniffer-overlay')?.remove();
}
