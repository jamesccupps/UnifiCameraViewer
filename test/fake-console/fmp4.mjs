// Test helpers for fragmented MP4: split ffmpeg's output into boxes, and pull one track's samples
// out of a moof+mdat. The fake console uses them to stream like a UniFi Access reader (bare
// samples, no moof/mdat/end frames); test/connection-unit.mjs uses them to build its input.

/** Top-level boxes of `buf` as [{ type, data }], and the bytes left over (an incomplete box). */
export function splitBoxes(buf) {
  const out = [];
  let i = 0;
  while (buf.length - i >= 8) {
    const size = buf.readUInt32BE(i);
    if (size < 8 || buf.length - i < size) break;
    out.push({ type: buf.toString("latin1", i + 4, i + 8), data: Buffer.from(buf.subarray(i, i + size)) });
    i += size;
  }
  return { boxes: out, rest: buf.subarray(i) };
}

function children(body) {
  return splitBoxes(body).boxes.map((b) => ({ type: b.type, body: b.data.subarray(8) }));
}

/**
 * The samples of track `trackId` in one fragment, as Buffers. Expects what ffmpeg writes with
 * default_base_moof: data offsets from the start of the moof, sample sizes in the trun (or a
 * default size in the tfhd).
 */
export function trackSamples(moof, mdat, trackId = 1) {
  const all = Buffer.concat([moof, mdat]);
  const out = [];
  for (const traf of children(moof.subarray(8)).filter((b) => b.type === "traf")) {
    const kids = children(traf.body);
    const tfhd = kids.find((b) => b.type === "tfhd").body;
    if (tfhd.readUInt32BE(4) !== trackId) continue;
    const tf = tfhd.readUInt32BE(0) & 0xffffff;
    let p = 8;
    if (tf & 0x1) p += 8; // base_data_offset
    if (tf & 0x2) p += 4; // sample_description_index
    if (tf & 0x8) p += 4; // default_sample_duration
    const defaultSize = tf & 0x10 ? tfhd.readUInt32BE(p) : 0;
    for (const trun of kids.filter((b) => b.type === "trun").map((b) => b.body)) {
      const f = trun.readUInt32BE(0) & 0xffffff;
      const count = trun.readUInt32BE(4);
      let q = 8;
      let offset = 0;
      if (f & 0x1) { offset = trun.readInt32BE(q); q += 4; }
      if (f & 0x4) q += 4; // first_sample_flags
      for (let s = 0; s < count; s++) {
        if (f & 0x100) q += 4;
        const size = f & 0x200 ? trun.readUInt32BE(q) : defaultSize;
        if (f & 0x200) q += 4;
        if (f & 0x400) q += 4;
        if (f & 0x800) q += 4;
        out.push(all.subarray(offset, offset + size));
        offset += size;
      }
    }
  }
  return out;
}
