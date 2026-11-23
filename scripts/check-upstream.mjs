#!/usr/bin/env node
/*
 * Early warning for the one dependency tied to Protect's firmware. Prints:
 * - the unifi-protect version we pin against the newest on npm, with the release notes in between
 *   (breaking changes marked);
 * - the last 30 days of issues on homebridge-unifi-protect, the same author's plugin on the same
 *   library: thousands of people run it on new Protect firmware, so breakage shows up there first.
 *   Livestream, video and firmware ones are marked.
 *
 *   npm run check:upstream            (GITHUB_TOKEN in the environment raises GitHub's rate limit)
 *
 * Read-only, public data only. Then, if something changed: npm run check:real (CLAUDE.md, Upstream).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies["unifi-protect"];
const DAYS = 30;
const headers = { "User-Agent": "protect-panes-upstream-check", Accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function getJson(url, h = {}) {
  const res = await fetch(url, { headers: h });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const mark = /livestream|stream|video|firmware|protect \d|unifi os/i;

const npm = await getJson("https://registry.npmjs.org/unifi-protect");
const latest = npm["dist-tags"].latest;
const between = Object.keys(npm.time).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && newer(v, pinned) && !newer(v, latest))
  .sort((a, b) => (newer(a, b) ? 1 : -1));
console.log(`unifi-protect: we pin ${pinned} (${npm.time[pinned]?.slice(0, 10)}); newest is ${latest} (${npm.time[latest]?.slice(0, 10)})`);
if (!between.length) console.log("  Up to date.");
else {
  const releases = await getJson("https://api.github.com/repos/hjdhjd/unifi-protect/releases?per_page=30", headers).catch(() => []);
  for (const v of between) {
    console.log(`\n  ${v} (${npm.time[v].slice(0, 10)})`);
    const body = releases.find((r) => r.tag_name === `v${v}`)?.body ?? "";
    const items = body.split(/\r?\n/).filter((l) => /^\s*\*/.test(l)).map((l) => l.replace(/^\s*\*\s*/, ""));
    for (const item of items.length ? items : ["(no release notes on GitHub)"]) {
      console.log(`  ${/breaking/i.test(item) ? "!!" : " -"} ${item.length > 160 ? `${item.slice(0, 157)}…` : item}`);
    }
  }
}

const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
const issues = await getJson(`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:hjdhjd/homebridge-unifi-protect type:issue created:>=${since}`)}&sort=created&order=desc&per_page=50`, headers);
console.log(`\nhomebridge-unifi-protect issues since ${since}: ${issues.total_count}`);
for (const i of issues.items) {
  const flag = mark.test(i.title) ? "*" : " "; // titles only: nearly every body mentions streams
  console.log(` ${flag} #${i.number} ${i.state.padEnd(6)} ${i.created_at.slice(0, 10)}  ${i.title.slice(0, 90)}`);
}
console.log("\n* title mentions livestreams, video or firmware. If one is open, or unifi-protect moved, run npm run check:real.");
