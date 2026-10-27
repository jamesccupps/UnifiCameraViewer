/*
 * H.264 color range in an fMP4 init segment.
 *
 * Several UniFi cameras encode full-range luma (0-255) without saying so: their SPS has no
 * video_signal_type in the VUI. Chromium, like every decoder, then assumes limited range (16-235)
 * and stretches it, so everything below 16 turns solid black - about 4% of a typical garage frame.
 * Streams that do flag full range (some models do) render correctly, so the fix is to tell
 * Chromium the truth: rewrite the SPS inside avcC to carry video_full_range_flag.
 *
 * Only the avcC SPS is touched; avc1 streams don't repeat the SPS in-band. Box sizes up the
 * moov > trak > mdia > minf > stbl > stsd > avc1 chain are recomputed. H.265 isn't handled.
 */

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
const VISUAL_ENTRY_HEADER = 78; // SampleEntry (8) + VisualSampleEntry fields (70), before child boxes
const STSD_HEADER = 8;          // version/flags + entry_count

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  bit() {
    if (this.pos >= this.bytes.length * 8) throw new Error("SPS ended early");
    const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) if (++zeros > 31) throw new Error("bad exp-Golomb code");
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}

class BitWriter {
  constructor() { this.out = []; this.cur = 0; this.n = 0; }
  bit(b) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) { this.out.push(this.cur); this.cur = 0; this.n = 0; }
  }
  bits(v, n) { for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1); }
  copy(reader, from, to) { for (let p = from; p < to; p++) this.bit((reader.bytes[p >> 3] >> (7 - (p & 7))) & 1); }
  /** rbsp_trailing_bits: a stop bit, then zeros to the byte boundary. */
  finish() { this.bit(1); while (this.n) this.bit(0); return Uint8Array.from(this.out); }
}

function unescapeRbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && out.length >= 2 && out[out.length - 1] === 0 && out[out.length - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function escapeRbsp(rbsp) {
  const out = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

function skipScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Read an SPS RBSP (after the NAL header byte) up to and including vui_parameters_present_flag. */
function readToVui(r) {
  const profile = r.bits(8);
  r.bits(16); // constraint flags + level
  r.ue();     // seq_parameter_set_id
  if (HIGH_PROFILES.has(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue(); r.ue(); r.bit();
    if (r.bit()) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
  }
  r.ue(); // log2_max_frame_num_minus4
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) {
    r.bit(); r.se(); r.se();
    for (let n = r.ue(); n > 0; n--) r.se();
  }
  r.ue(); r.bit();          // max_num_ref_frames, gaps
  r.ue(); r.ue();           // size in macroblocks
  if (!r.bit()) r.bit();    // frame_mbs_only, mb_adaptive_frame_field
  r.bit();                  // direct_8x8_inference
  if (r.bit()) { r.ue(); r.ue(); r.ue(); r.ue(); } // cropping
  return r.bit();           // vui_parameters_present_flag
}

/** Skip aspect-ratio and overscan info; leaves the reader at video_signal_type_present_flag. */
function skipVuiHead(r) {
  if (r.bit() && r.bits(8) === 255) r.bits(32);
  if (r.bit()) r.bit();
}

function lastSetBit(bytes) {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i]) return i * 8 + 7 - Math.log2(bytes[i] & -bytes[i]);
  }
  return -1;
}

/** true / false from video_full_range_flag, or null when the SPS doesn't say. */
function spsRange(spsNal) {
  const r = new BitReader(unescapeRbsp(spsNal.subarray(1)));
  if (!readToVui(r)) return null;
  skipVuiHead(r);
  if (!r.bit()) return null;
  r.bits(3);
  return r.bit() === 1;
}

/*
 * Chromium only builds a color space from the SPS when colour_description_present_flag is set;
 * a range flag on its own is ignored. So when the stream has no colour description, write BT.709
 * primaries/transfer/matrix: what the flagged UniFi models declare, and what Chromium already
 * assumes for unflagged HD video, so only the range changes.
 */
const BT709 = 1;

function writeSignalType(w, videoFormat, full) {
  w.bit(1);                   // video_signal_type_present_flag
  w.bits(videoFormat, 3);
  w.bit(full ? 1 : 0);        // video_full_range_flag
}

function writeBt709(w) {
  w.bit(1);                   // colour_description_present_flag
  w.bits(BT709, 8); w.bits(BT709, 8); w.bits(BT709, 8);
}

/** Return the SPS NAL with video_full_range_flag = full, keeping every other field. */
function spsWithRange(spsNal, full) {
  const r = new BitReader(unescapeRbsp(spsNal.subarray(1)));
  const end = lastSetBit(r.bytes); // the rbsp stop bit
  const w = new BitWriter();
  const hadVui = readToVui(r);
  w.copy(r, 0, r.pos - 1);
  w.bit(1);
  if (!hadVui) {
    w.bits(0, 2);             // no aspect ratio, no overscan
    writeSignalType(w, 5, full);
    writeBt709(w);
    w.bits(0, 6);             // chroma loc, timing, nal/vcl hrd, pic_struct, bitstream restriction
  } else {
    const head = r.pos;
    skipVuiHead(r);
    w.copy(r, head, r.pos);
    if (r.bit()) {
      const format = r.bits(3);
      r.bit();                // old range flag
      writeSignalType(w, format, full);
      if (r.bit()) { w.bit(1); w.copy(r, r.pos, r.pos + 24); r.pos += 24; }
      else writeBt709(w);
    } else {
      writeSignalType(w, 5, full);
      writeBt709(w);
    }
    w.copy(r, r.pos, end);
  }
  return Uint8Array.from([spsNal[0], ...escapeRbsp(w.finish())]);
}

// --- MP4 boxes -------------------------------------------------------------------------------

function boxes(bytes, start, end) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start;
  while (p + 8 <= end) {
    const size = dv.getUint32(p);
    if (size < 8 || p + size > end) return null; // 64-bit or truncated boxes don't occur in Protect init segments
    out.push({ type: String.fromCharCode(...bytes.subarray(p + 4, p + 8)), start: p, end: p + size });
    p += size;
  }
  return p === end ? out : null;
}

function box(type, header, children) {
  const size = 8 + header.length + children.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(header, 8);
  let p = 8 + header.length;
  for (const c of children) { out.set(c, p); p += c.length; }
  return out;
}

function findAvcC(bytes) {
  let range = { start: 0, end: bytes.length };
  const walk = (list, depth) => {
    for (const b of list) {
      if (CONTAINERS.has(b.type)) { const r = walk(boxes(bytes, b.start + 8, b.end) ?? [], depth + 1); if (r) return r; }
      if (b.type === "stsd") { const r = walk(boxes(bytes, b.start + 8 + STSD_HEADER, b.end) ?? [], depth + 1); if (r) return r; }
      if (b.type === "avc1" || b.type === "avc3") {
        const c = boxes(bytes, b.start + 8 + VISUAL_ENTRY_HEADER, b.end)?.find((x) => x.type === "avcC");
        if (c) return c;
      }
    }
    return null;
  };
  return walk(boxes(bytes, range.start, range.end) ?? [], 0);
}

function parseAvcC(bytes, b) {
  const d = bytes.subarray(b.start + 8, b.end);
  let p = 5;
  const sps = [];
  for (let n = d[p++] & 0x1f; n > 0; n--) {
    const len = (d[p] << 8) | d[p + 1];
    sps.push(d.subarray(p + 2, p + 2 + len));
    p += 2 + len;
  }
  return { head: d.subarray(0, 5), sps, rest: d.subarray(p) };
}

/** Rebuild the init segment with a replacement avcC payload, fixing every parent box size. */
function replaceAvcC(bytes, payload) {
  const rebuild = (list, inside) => list.map((b) => {
    const whole = bytes.subarray(b.start, b.end);
    if (b.type === "avcC" && inside) return box("avcC", payload, []);
    let headerLen = 0;
    if (CONTAINERS.has(b.type)) headerLen = 0;
    else if (b.type === "stsd") headerLen = STSD_HEADER;
    else if ((b.type === "avc1" || b.type === "avc3") && inside) headerLen = VISUAL_ENTRY_HEADER;
    else return whole;
    const kids = boxes(bytes, b.start + 8 + headerLen, b.end);
    if (!kids) return whole;
    return box(b.type, bytes.subarray(b.start + 8, b.start + 8 + headerLen), rebuild(kids, true));
  });
  const top = boxes(bytes, 0, bytes.length);
  const parts = rebuild(top, false);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  return out;
}

/** The init segment's declared range: true (full), false (limited), or null (not stated / not H.264). */
export function initRange(init) {
  try {
    const bytes = init instanceof Uint8Array ? init : new Uint8Array(init);
    const b = findAvcC(bytes);
    if (!b) return null;
    const { sps } = parseAvcC(bytes, b);
    return sps.length ? spsRange(sps[0]) : null;
  } catch {
    return null;
  }
}

/**
 * The init segment with every SPS declaring full (true) or limited (false) range, or null when
 * it can't be rewritten (not H.264, SPS only in-band, or a parse failure). Callers fall back to
 * the original bytes on null.
 */
export function initWithRange(init, full) {
  try {
    return mapSps(init, (s) => spsWithRange(s, full));
  } catch {
    return null;
  }
}

/** Rewrite every SPS NAL in the init segment's avcC with fn; null when there's none. Throws on bad input. */
function mapSps(init, fn) {
  const bytes = init instanceof Uint8Array ? init : new Uint8Array(init);
  const b = findAvcC(bytes);
  if (!b) return null;
  const { head, sps, rest } = parseAvcC(bytes, b);
  if (!sps.length) return null;
  const patched = sps.map(fn);
  const payload = [...head, 0xe0 | patched.length];
  for (const s of patched) payload.push(s.length >> 8, s.length & 0xff, ...s);
  payload.push(...rest);
  return replaceAvcC(bytes, Uint8Array.from(payload));
}

// For test/run.mjs, which builds SPS variants no camera at hand produces (e.g. no VUI at all).
export const internals = { BitReader, BitWriter, readToVui, unescapeRbsp, escapeRbsp, mapSps };

/**
 * Range policy for one window. "auto" assumes full range when the stream doesn't say: every
 * UniFi camera measured so far sends 0-255 luma, flagged or not. "full" / "limited" override.
 * Returns the bytes to hand the decoder (the original when nothing needs to change).
 */
export function applyRange(init, setting = "auto") {
  const declared = initRange(init);
  const want = setting === "full" ? true : setting === "limited" ? false : declared === null ? true : null;
  if (want === null || want === declared) return init;
  return initWithRange(init, want) ?? init;
}
