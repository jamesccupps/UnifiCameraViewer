import fs from "node:fs";
import { format } from "node:util";

const MAX_BYTES = 2_000_000;

/**
 * Tiny file logger. Writes to <userData>/protect-panes.log and rolls to .log.1 at ~2 MB.
 * Debug lines are dropped unless PANES_DEBUG=1.
 */
export function createLogger(file) {
  const debugOn = process.env.PANES_DEBUG === "1";
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* new file */ }

  function write(level, prefix, msg, params) {
    if (level === "debug" && !debugOn) return;
    const text = format(msg, ...params);
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}${text}\n`;
    try { process.stdout.write(line); } catch { /* no console attached */ }
    try {
      if (size > MAX_BYTES) {
        fs.rmSync(file + ".1", { force: true });
        fs.renameSync(file, file + ".1");
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch { /* logging must never crash the app */ }
  }

  function make(prefix) {
    return {
      debug: (m, ...p) => write("debug", prefix, m, p),
      info: (m, ...p) => write("info", prefix, m, p),
      warn: (m, ...p) => write("warn", prefix, m, p),
      error: (m, ...p) => write("error", prefix, m, p),
      child: (name) => make(`${prefix}[${name}] `),
    };
  }
  return make("");
}
