// Small shared helpers.

/** Resolve after `ms`, or immediately when `signal` aborts. Never rejects. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { clearTimeout(timer); timer = null; fn(...args); };
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const wait = last + ms - Date.now();
    if (wait <= 0) { last = Date.now(); fn(); return; }
    if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(); }, wait);
  };
}

/** Accept "192.168.1.1", "https://192.168.1.1/", "nvr.local:443/protect" and return just host[:port]. */
export function normalizeHost(input) {
  let h = String(input ?? "").trim();
  h = h.replace(/^[a-z]+:\/\//i, "");
  h = h.split("/")[0];
  return h;
}

/**
 * Make "start at login" match `wanted`, touching the OS only when it doesn't already. `read()` returns
 * the current { openAtLogin }, `write(on)` changes it. Returns true if it wrote. On Windows every write
 * or delete under HKCU\...\Run is an autostart (ASEP) change, which Microsoft Defender flagged as an
 * anomaly when the app did it on every launch.
 */
export function syncLoginItem(wanted, read, write) {
  if (!!read().openAtLogin === !!wanted) return false;
  write(!!wanted);
  return true;
}

export function errorText(err) {
  if (!err) return "Unknown error";
  return err.message || String(err);
}
