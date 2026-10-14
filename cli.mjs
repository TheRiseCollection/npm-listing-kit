#!/usr/bin/env node
// listing-kit: one store.json -> App Store + Google Play listings.
//   listing-kit check [--update]             offline: limits, locales, URLs, release notes, screenshot sizes
//   listing-kit diff  [--ios|--android] [-v] read-only: what would change on each store (-v: show the values)
//   listing-kit push  [--ios|--android] --yes   write those changes (refuses while an iOS version is in review)
//   listing-kit shots [--size ios-6.9]       render screenshots with listing.shots.mjs
// Options: --file store.json   --shots store/shots (screenshot folders; diff/push include them when the folder exists)
import fs from "node:fs";
import path from "node:path";
import { check } from "./rules.mjs";
import { creds, asc, play, readAsc, planAsc, planAscShots, readPlay, planPlay, planPlayShots } from "./stores.mjs";
import { shots } from "./shots.mjs";

const argv = process.argv.slice(2); const cmd = argv[0];
const flag = (f) => argv.includes(f); const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const file = opt("--file", "store.json"); const shotsDir = opt("--shots", "store/shots");
const tty = process.stdout.isTTY; const paint = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = paint(31), yel = paint(33), grn = paint(32);

function load() {
  if (!fs.existsSync(file)) { console.error(`no ${file} (run from your app folder or pass --file)`); process.exit(2); }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function sync(write) {
  const store = load(); const c = creds(); const both = !flag("--ios") && !flag("--android"); const withShots = fs.existsSync(shotsDir);
  let pending = 0, failed = 0;
  const show = (name, version, ops, extra = []) => {
    console.log(`\n${name}: ${version}`);
    for (const o of ops) { console.log(`  ${yel(o.code.padEnd(8))} ${o.what}`); if (flag("-v")) for (const d of o.details || []) console.log(`           ${d}`); }
    for (const s of extra) console.log(`  ${s}`);
    if (!ops.length) console.log(`  ${grn("matches store.json")}`);
    pending += ops.length;
  };
  const apply = async (client, ops) => { for (const o of ops) { try { await o.run(client); console.log(`  ${grn("done")}  ${o.code} ${o.what}`); } catch (e) { failed++; console.log(`  ${red("fail")}  ${o.code} ${o.what}: ${e.message}`); } } };
  if (both || flag("--ios")) {
    if (!store.ios?.bundleId) console.log("\nios: no ios.bundleId in store.json, skipped");
    else if (!c.asc) console.log("\nios: no ASC credentials (ASC_KEY_ID or ~/.listing-kit.json), skipped");
    else {
      const client = asc(c.asc); const live = await readAsc(client, store.ios.bundleId).catch(e => ({ error: e.message })); const plan = live.error ? {} : planAsc(store, live);
      if (live.error) { console.log(`\nios: ${red(live.error)}`); failed++; }
      else if (plan.refused) { console.log(`\nios: ${live.version}\n  ${red("refused")}: ${plan.refused}`); failed += write ? 1 : 0; }
      else {
        const ops = [...plan.ops, ...(withShots ? await planAscShots(client, store, live, shotsDir) : [])];
        show("ios", live.version, ops, plan.skipped.map(s => `skipped ${s} (not editable on a live version)`));
        if (write && ops.length) await apply(client, ops);
      }
    }
  }
  if (both || flag("--android")) {
    if (!store.android?.package) console.log("\nandroid: no android.package in store.json, skipped");
    else if (!c.play) console.log("\nandroid: no Play service account (PLAY_SERVICE_ACCOUNT or ~/.listing-kit.json), skipped");
    else {
      const client = await play(c.play, store.android.package); const live = await readPlay(client).catch(e => ({ error: e.message }));
      if (live.error) { console.log(`\nandroid: ${red(live.error)}`); failed++; }
      else try {
        const ops = [...planPlay(store, live), ...(withShots || store.graphics ? await planPlayShots(client, store, live, shotsDir) : [])];
        show("android", live.version, ops);
        if (write && ops.length) {
          const before = failed; await apply(client, ops);
          if (failed === before) { await client.call("POST", `/edits/${live.edit}:commit`); live.edit = null; console.log(`  ${grn("committed")}`); }
          else console.log(`  ${red("not committed")}: fix the failures and run again`);
        }
      } finally { if (live.edit) await client.call("DELETE", `/edits/${live.edit}`).catch(() => {}); }
    }
  }
  if (!write && pending) console.log(`\n${pending} change(s). Apply with: listing-kit push --yes`);
  return failed ? 1 : (!write && pending ? 1 : 0);
}

if (cmd === "check") {
  const found = check(load(), { update: flag("--update"), shotsDir });
  for (const f of found) console.log(`${f.level === "error" ? red("error") : yel("warn ")}  ${f.where}  ${f.msg}`);
  const errors = found.filter(f => f.level === "error").length;
  console.log(errors ? red(`\n${errors} error(s): the stores would reject this.`) : grn(`\nready${found.length ? ` (${found.length} warning(s))` : ""}.`));
  process.exit(errors ? 1 : 0);
} else if (cmd === "diff") {
  process.exit(await sync(false));
} else if (cmd === "push") {
  if (!flag("--yes")) { console.log("push writes to the live stores. Showing what would change; re-run with --yes to apply."); process.exit(await sync(false)); }
  const found = check(load(), { shotsDir }).filter(f => f.level === "error");
  if (found.length) { console.log(red(`check found ${found.length} error(s); run listing-kit check. Nothing was pushed.`)); process.exit(1); }
  process.exit(await sync(true));
} else if (cmd === "shots") {
  const r = await shots(process.cwd(), { only: opt("--size", null), out: shotsDir });
  console.log(`${r.n} screenshots in ${path.join(shotsDir)}`); if (r.errors.length) console.log(red("page errors:\n  " + r.errors.join("\n  ")));
  process.exit(r.errors.length ? 1 : 0);
} else {
  console.log("usage: listing-kit check [--update] | diff [--ios|--android] | push [--ios|--android] --yes | shots [--size name]\n       options: --file store.json  --shots store/shots");
  process.exit(cmd ? 2 : 0);
}
