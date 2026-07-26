#!/usr/bin/env node

/**
 * Merge an `ohos` lane into test/expected-durations.json from ohos-full-test
 * job logs.
 *
 * The sibling update-test-durations.mjs reads Buildkite, which has no OHOS
 * lane — ohos-full-test runs on GitHub Actions instead, so the log format and
 * the transport are both different and this is a separate entry point. It
 * only adds/replaces the `ohos` key on each entry; every other lane in the
 * file is passed through untouched.
 *
 * Why the lane is worth having: OHOS costs do not resemble the x64 ones the
 * table is otherwise built from. cli/run/run-crash-handler.test.ts is 2268ms
 * on the default lane and 519s here — a factor of ~230 — so packing OHOS
 * shards with default-lane numbers leaves one shard doing several times the
 * work of another. Measured on run 30179934099: packing 4 shards by the
 * default lane put 30.1 min on the heaviest shard where packing by real
 * numbers puts 15.8 min.
 *
 * Usage:
 *   gh api repos/social4hyq/ohos-bun/actions/jobs/<id>/logs > run.log
 *   node scripts/update-ohos-test-durations.mjs run.log [more.log ...]
 *
 * Several logs may be passed; each path takes the median across them, the
 * same as the Buildkite script does across builds.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "test", "expected-durations.json");

const logs = process.argv.slice(2);
if (!logs.length) {
  console.error("usage: update-ohos-test-durations.mjs <job.log> [more.log ...]");
  process.exit(1);
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * GitHub Actions prefixes every line with an ISO timestamp, which is the only
 * clock available here — there is no Buildkite `_bk;t=` marker.
 *
 * Two things are read off the header line besides the path:
 *
 *  - Indentation. runTest() prints concurrent titles with console.log and
 *    serial ones through startGroup(); with GITHUB_ACTIONS unset (see
 *    ohos-full-test.yml for why) startGroup falls through to console.group,
 *    so the parallel-safe phase is the indented one. Those headers are all
 *    emitted at once and their spans are meaningless, so they are capped the
 *    same way parseLog() caps its `concurrent` case.
 *  - Whether the title is a path at all. `... - code 1` and `... [attempt #2]`
 *    are retry/failure headers, not files; they close the open span.
 */
function parseLog(raw) {
  const out = [];
  const lines = raw.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  let path = null;
  let start = null;
  let indented = false;
  const emit = ts => {
    if (path === null || start === null || ts === null) return;
    out.push([path, indented ? Math.min(ts - start, 500) : ts - start]);
  };
  for (const line of lines) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(\s*)(?:##\[group\])?\s*\[\d+\/\d+\]\s+(.+)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    emit(ts);
    // `<path> - code 1` closes an attempt and is not a path. `<path>
    // [attempt #2]` opens the next one and IS: strip the marker so the retry's
    // span is attributed to the file instead of being dropped, which is what
    // the summing below relies on. The Buildkite parser has no such case
    // because it does not want retry time; see the note there.
    const title = m[3].trim().replace(/\s*\[attempt #\d+\]$/, "");
    const isPath = /\.(?:[cm]?[jt]sx?|json)$/.test(title);
    path = isPath ? title : null;
    start = isPath ? ts : null;
    indented = m[2].length > 0;
  }
  return out;
}

// path -> [ms, ...]
const samples = {};
for (const file of logs) {
  const parsed = parseLog(readFileSync(file, "utf8"));
  if (parsed.length < 1000) {
    console.error(`${file}: only parsed ${parsed.length} test paths; expected >1000.`);
    console.error("This usually means the '[N/M] <path>' header format changed, or the run died early.");
    process.exit(1);
  }
  // A file may appear more than once when it is retried. parseLog already
  // drops the retry header itself, but the attempt that follows it is a real
  // span and, unlike the Buildkite lanes where retries are rare flakes, OHOS
  // has a stable set of deterministic failures whose retry time a shard
  // genuinely pays. Sum rather than discard, so the packer sees the cost the
  // shard will actually incur.
  const perLog = {};
  for (const [p, ms] of parsed) perLog[p] = (perLog[p] || 0) + ms;
  for (const [p, ms] of Object.entries(perLog)) {
    if (!p.startsWith("test/")) continue; // vendor tests are sharded separately
    const key = p.slice("test/".length);
    if (key === "package.json" || key.endsWith("/package.json")) continue;
    (samples[key] ||= []).push(ms);
  }
  console.error(`${file}: ${Object.keys(perLog).length} paths`);
}

const existing = JSON.parse(readFileSync(outputPath, "utf8"));
const meta = existing._meta ?? {};
delete existing._meta;

for (const [p, xs] of Object.entries(samples)) {
  (existing[p] ||= {}).ohos = median(xs);
}

const out = {
  _meta: {
    ...meta,
    lanes: { ...(meta.lanes ?? {}), ohos: "ohos-full-test (GitHub Actions, ubuntu-24.04-arm + OHOS container)" },
    ohos_generated_at: new Date().toISOString(),
    ohos_note:
      "Summed across retry attempts, unlike the Buildkite lanes which keep only the first: " +
      "OHOS failures are deterministic, so retry time is cost rather than noise.",
  },
};
for (const p of Object.keys(existing).sort()) out[p] = existing[p];

writeFileSync(outputPath, JSON.stringify(out, null, 2) + "\n");
const withOhos = Object.values(out).filter(v => typeof v?.ohos === "number").length;
console.error(`wrote ${Object.keys(out).length - 1} entries (${withOhos} with an ohos lane) to ${outputPath}`);
