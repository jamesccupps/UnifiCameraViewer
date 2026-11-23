import os from "node:os";

/*
 * One line in the log each hour with what the app cost over that hour: CPU and RAM by process kind,
 * the streams playing, the video that came in (total, rate and the busiest cameras), the PC's free
 * RAM, and the camera pages' stream restarts by reason.
 *
 * Why: a wall PC that slowed down over days (Camera Desktop, 2026-11: 14 windows, 10 of them 360°
 * Quad views, on a 35 W i3) left only a one-off snapshot of its processes and thousands of single
 * restart lines. Whether memory grew, or which process got busier as the restarts piled up, couldn't
 * be told afterwards. With this in the log, a copy of it (or Beam) shows the trend.
 *
 * CPU is the share of one core over the interval, from each process's cumulative CPU time, so it
 * matches Task Manager's per-process figures times the number of logical CPUs. A process that ended
 * within the interval isn't counted. RAM is the working set.
 */

const KINDS = { Browser: "main", GPU: "GPU", Tab: "pages" };
const CHANNELS = ["High", "Medium", "Low"];
const MAX_REASONS = 20; // the reason comes from the page: don't let one keep inventing new ones

export class LoadLog {
  #getMetrics;
  #getStreams;
  #log;
  #now;
  #memory;
  #cpuSeen = new Map(); // "<pid>/<creationTime>" -> cumulative CPU seconds at the last line
  #since;
  #restarts = new Map();
  #bytes = new Map(); // camera key -> video bytes sent to its pages since the last line

  /**
   * @param {object} opts
   * @param {() => Electron.ProcessMetric[]} opts.getMetrics - app.getAppMetrics
   * @param {() => {state?: string, channel?: number, view?: string}[]} opts.getStreams - one per camera page
   * @param {{info: (msg: string) => void}} opts.log
   * @param {() => number} [opts.now]
   * @param {() => {free: number, total: number}} [opts.memory] - the PC's RAM in bytes
   */
  constructor({ getMetrics, getStreams, log, now = Date.now, memory = () => ({ free: os.freemem(), total: os.totalmem() }) }) {
    this.#getMetrics = getMetrics;
    this.#getStreams = getStreams;
    this.#log = log;
    this.#now = now;
    this.#memory = memory;
    this.#since = now();
  }

  /** Writes a line every intervalMs, counting from now. */
  start(intervalMs) {
    this.#cpuSeen = this.#cpuTotals(this.#getMetrics());
    this.#since = this.#now();
    return setInterval(() => this.#log.info(this.line()), intervalMs);
  }

  /** A camera page asked for its stream to be restarted. */
  restart(reason) {
    let key = String(reason).slice(0, 40);
    if (!this.#restarts.has(key) && this.#restarts.size >= MAX_REASONS) key = "other";
    this.#restarts.set(key, (this.#restarts.get(key) ?? 0) + 1);
  }

  /** A video fragment went to a camera page. */
  media(key, bytes) {
    this.#bytes.set(key, (this.#bytes.get(key) ?? 0) + bytes);
  }

  /** The line for the time since the last one (or start()); the counts start over. */
  line() {
    const now = this.#now();
    const seconds = Math.max(1, (now - this.#since) / 1000);
    const metrics = this.#getMetrics();
    const totals = this.#cpuTotals(metrics);
    const groups = {};
    for (const p of metrics) {
      const id = `${p.pid}/${p.creationTime}`;
      // A process not seen at the last line started since: all of its time is in this interval.
      const used = totals.get(id) - (this.#cpuSeen.get(id) ?? 0);
      const pct = (used / seconds) * 100;
      const g = (groups[KINDS[p.type] ?? "other"] ??= { n: 0, cpu: 0, busiest: 0, ram: 0 });
      g.n++;
      g.cpu += pct;
      g.busiest = Math.max(g.busiest, pct);
      g.ram += p.memory.workingSetSize * 1024; // Electron reports KB
    }
    this.#cpuSeen = totals;
    this.#since = now;

    const order = ["main", "GPU", "pages", "other"].filter((k) => groups[k]);
    const label = (k) => (k === "pages" ? `${groups[k].n} pages` : k);
    const cpu = order.map((k) => `${label(k)} ${Math.round(groups[k].cpu)}${k === "pages" && groups[k].n > 1 ? ` (busiest ${Math.round(groups[k].busiest)})` : ""}`);
    const ram = order.map((k) => `${k} ${Math.round(groups[k].ram / 2 ** 20)} MB`);

    const streams = this.#getStreams();
    const live = streams.filter((s) => s.state === "live").length;
    const byChannel = {};
    for (const s of streams) if (s.channel !== undefined) byChannel[CHANNELS[s.channel] ?? `ch${s.channel}`] = (byChannel[CHANNELS[s.channel] ?? `ch${s.channel}`] ?? 0) + 1;
    const views = streams.filter((s) => s.view && s.view !== "off").length;
    const channelText = Object.entries(byChannel).map(([c, n]) => `${c} ${n}`).join(", ");
    const streamText = `${live} of ${streams.length} streams live${channelText ? ` (${channelText})` : ""}${views ? `, ${views} in a 360° view` : ""}`;

    // Video in: the total and the three busiest cameras. A window and a grid tile of the same camera
    // at the same quality share one socket (the library pools them) but count twice here.
    const mbps = (b) => ((b * 8) / seconds / 1e6).toFixed(1);
    const perCamera = [...this.#bytes].sort((a, b) => b[1] - a[1]);
    const videoBytes = perCamera.reduce((n, [, b]) => n + b, 0);
    this.#bytes.clear();
    const amount = videoBytes >= 2 ** 30 ? `${(videoBytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(videoBytes / 2 ** 20)} MB`;
    const busiest = perCamera.slice(0, 3).map(([k, b]) => `…${k.slice(-6)} ${mbps(b)}`).join(", ");
    const videoText = `video in ${amount}, ${mbps(videoBytes)} Mbps${perCamera.length ? ` from ${perCamera.length} cameras (most: ${busiest})` : ""}`;

    const { free, total } = this.#memory();
    const gb = (b) => (b / 2 ** 30).toFixed(1);

    const restarts = [...this.#restarts].sort((a, b) => b[1] - a[1]);
    const restartCount = restarts.reduce((n, [, c]) => n + c, 0);
    this.#restarts.clear();
    const restartText = restartCount ? `page restarts ${restartCount} (${restarts.map(([r, c]) => `${r} ${c}`).join(", ")})` : "no page restarts";

    const span = seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
    return `last ${span}: CPU (% of one core) ${cpu.join(", ")}; RAM ${ram.join(", ")}; ${streamText}; ${videoText}; PC RAM free ${gb(free)} of ${gb(total)} GB; ${restartText}`;
  }

  #cpuTotals(metrics) {
    return new Map(metrics.map((p) => [`${p.pid}/${p.creationTime}`, p.cpu.cumulativeCPUUsage ?? 0]));
  }
}
