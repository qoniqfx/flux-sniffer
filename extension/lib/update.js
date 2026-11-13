// Version check against the latest GitHub release. Pure + injectable fetch so it can be unit-tested.

export const REPO = 'qoniqfx/flux-sniffer';
const TTL = 6 * 3600 * 1000;

export function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}

export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * @returns {Promise<null | {at:number,current:string,latest:string,url:string,outdated:boolean}>}
 * null = unknown (offline, rate-limited, no cache). Result is cached 6 h by the caller (pass the previous result as `cache`).
 */
export async function checkUpdate(current, { fetchFn = fetch, cache = null, now = Date.now(), ttl = TTL } = {}) {
  if (cache && cache.current === current && now - cache.at < ttl) return cache;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (res.status === 404) return { at: now, current, latest: '', url: '', outdated: false }; // no release yet
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return { at: now, current, latest: j.tag_name || '', url: j.html_url || '', outdated: isNewer(j.tag_name, current) };
  } catch {
    return cache && cache.current === current ? cache : null;
  } finally {
    clearTimeout(timer);
  }
}
