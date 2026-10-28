import tls from "node:tls";

/*
 * Trust on first use for the consoles' TLS certificates.
 *
 * UniFi OS consoles present self-signed certificates, so the library connects with certificate
 * checks off (rejectUnauthorized: false) on its HTTP pool, its events stream and every livestream.
 * Anyone on the LAN who could take over a console's address (ARP spoofing, a hostname answered over
 * mDNS) then got the local account's password at the next login, and could feed fake video.
 *
 * Each console's certificate SHA-256 is now saved the first time it's seen (cfg.certSha256), and every
 * later TLS connection to that console must present the same one. A different certificate ends the
 * socket at the end of the handshake, before anything is sent on it: undici writes a request only
 * after its own "secureConnect" handler, which runs after ours.
 *
 * It works by wrapping tls.connect, which undici (and so the library) calls through the node:tls
 * module at connect time. That covers every socket the library opens without changing it: a
 * WebSocket factory passed to the library would lose the events stream's auth headers.
 *
 * The limits: the very first connection is trusted as it is, and UniFi OS sometimes makes a new
 * certificate (a reset, some updates), which the owner then accepts from the camera list.
 */

let installed = false;
let hooks = null; // { lookup(key) -> { pin } | null, pinned(key, fp), mismatch(key, fp) }

/** "host:port" the way tls.connect sees it: IPv6 without brackets, port 443 unless given. */
export function pinKey(host, port = 443) {
  const h = String(host ?? "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return `${h}:${Number(port) || 443}`;
}

/** The pin key for a console's configured host ("192.168.1.1", "nvr.local:7443", "[fe80::1]:443"). */
export function consoleKey(host) {
  const s = String(host ?? "").trim();
  const v6 = /^\[(.+)\](?::(\d+))?$/.exec(s);
  if (v6) return pinKey(v6[1], v6[2]);
  const parts = s.split(":");
  if (parts.length === 2) return pinKey(parts[0], parts[1]);
  return pinKey(s); // a bare name, IPv4 address or unbracketed IPv6 address
}

export class CertificateChangedError extends Error {
  constructor(key, seen) {
    super(`the console at ${key} presented a different TLS certificate than the one trusted before`);
    this.name = "CertificateChangedError";
    this.code = "ERR_PANES_CERT_CHANGED";
    this.key = key;
    this.seen = seen;
  }
}

export function installCertPinning(h) {
  hooks = h;
  if (installed) return;
  installed = true;
  const connect = tls.connect;
  tls.connect = function pinnedConnect(...args) {
    const socket = connect.apply(this, args);
    const opts = args.find((a) => a && typeof a === "object") ?? {};
    const key = pinKey(opts.host ?? opts.servername, opts.port);
    if (!hooks?.lookup(key)) return socket; // not a console: untouched
    socket.once("secureConnect", () => {
      const seen = socket.getPeerX509Certificate?.()?.fingerprint256 ?? null;
      const pin = hooks.lookup(key)?.pin ?? null; // again: another socket may have pinned it meanwhile
      if (pin ? seen === pin : seen) {
        if (!pin) hooks.pinned(key, seen);
        return;
      }
      hooks.mismatch(key, seen);
      socket.destroy(new CertificateChangedError(key, seen));
    });
    return socket;
  };
}
