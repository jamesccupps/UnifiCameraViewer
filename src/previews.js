/*
 * Camera previews for the camera list: a JPEG still from Protect's snapshot endpoint (the same
 * read-only one its web UI uses for thumbnails), handed to the renderer as a data: URL. Each
 * camera's picture is reused for maxAgeMs and at most `parallel` requests run at once, so a long
 * list scrolling into view can't flood a console. A failed request is remembered for maxAgeMs
 * too, so an offline or refusing camera isn't asked again on every re-render.
 *
 * No Electron imports, so test/run.mjs can drive it under plain Node.
 */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export class Previews {
  #getCamera;
  #log;
  #width;
  #maxAgeMs;
  #parallel;
  #timeoutMs;
  #cache = new Map(); // key -> { t, value: Promise<{ url, at } | null> }
  #active = 0;
  #waiting = [];

  /**
   * @param {object} opts
   * @param {(key: string) => object | undefined} opts.getCamera - the library's camera projection (or the mock's)
   * @param {object} [opts.log]
   */
  constructor({ getCamera, log = null, width = 480, maxAgeMs = 30_000, parallel = 3, timeoutMs = 10_000 }) {
    this.#getCamera = getCamera;
    this.#log = log;
    this.#width = width;
    this.#maxAgeMs = maxAgeMs;
    this.#parallel = parallel;
    this.#timeoutMs = timeoutMs;
  }

  /** A recent picture of the camera as { url, at }, or null when it's offline or the console refused. */
  get(key) {
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.t < this.#maxAgeMs) return hit.value;
    const cam = this.#getCamera(key);
    if (typeof cam?.snapshot !== "function" || cam.isOnline === false) return Promise.resolve(null);
    const value = this.#limit(() => cam.snapshot({ width: this.#width, signal: AbortSignal.timeout(this.#timeoutMs) }))
      .then((buf) => {
        // A 480 px JPEG is tens of KB. Anything big, or not a JPEG, isn't base64'd into a data: URL and
        // sent to the list: a console answering with hundreds of MB would fill both processes' memory.
        const bytes = Buffer.from(buf);
        if (bytes.length > MAX_SNAPSHOT_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`not a usable JPEG (${bytes.length} bytes)`);
        return { url: `data:image/jpeg;base64,${bytes.toString("base64")}`, at: Date.now() };
      })
      .catch((err) => {
        this.#log?.debug(`preview of ${String(key).split("/")[1]} failed: ${err.message}`);
        return null;
      });
    this.#cache.set(key, { t: Date.now(), value });
    return value;
  }

  clear() {
    this.#cache.clear();
  }

  #limit(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.#active++;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          this.#active--;
          this.#waiting.shift()?.();
        });
      };
      if (this.#active < this.#parallel) run();
      else this.#waiting.push(run);
    });
  }
}
