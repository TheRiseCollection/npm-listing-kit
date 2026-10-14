// Store rules as data: field limits, locale codes, screenshot sizes and types. Everything `check` knows lives here.
import fs from "node:fs";
import path from "node:path";

export const LIMITS = {
  asc: { name: 30, subtitle: 30, promotional_text: 170, keywords: 100, description: 4000, whats_new: 4000 },
  play: { name: 30, short_description: 80, description: 4000, whats_new: 500 },
};

export const ASC_LOCALES = new Set(("ar-SA ca cs da de-DE el en-AU en-CA en-GB en-US es-ES es-MX fi fr-CA fr-FR he hi hr hu id it ja ko " +
  "ms nl-NL no pl pt-BR pt-PT ro ru sk sv th tr uk vi zh-Hans zh-Hant").split(" "));
const PLAY_LOCALE = /^[a-z]{2,3}(-[A-Z]{2}|-419)?$/;   // en-US, es-419, fil, zh-CN ...

// Screenshot folders: accepted pixel sizes (portrait; landscape is the pair swapped) and the store type each uploads as.
export const SHOT_SIZES = {
  "ios-6.9": [[1320, 2868], [1290, 2796], [1260, 2736]],
  "ios-6.5": [[1284, 2778], [1242, 2688]],
  "ios-ipad-13": [[2064, 2752], [2048, 2732]],
  "ios-duo": [[2007, 2853]],
};
export const ASC_SHOT_TYPES = { "ios-6.9": "APP_IPHONE_67", "ios-6.5": "APP_IPHONE_65", "ios-ipad-13": "APP_IPAD_PRO_3GEN_129", "ios-duo": "APP_IPHONE_DUO" };
export const PLAY_SHOT_TYPES = { "play-phone": "phoneScreenshots", "play-7in": "sevenInchScreenshots", "play-10in": "tenInchScreenshots" };
const MAX_SHOTS = { ios: 10, play: 8 };

/** A locale's value for one store: `overrides.<store>.<field>` wins, e.g. a longer Play description. */
export const field = (loc, store, f) => loc.overrides?.[store]?.[f] ?? loc[f] ?? "";

/** PNG width/height from the IHDR chunk; no image library needed. */
export function pngSize(file) {
  const b = Buffer.alloc(24); const fd = fs.openSync(file, "r"); fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd);
  if (b.toString("ascii", 1, 4) !== "PNG") return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const len = (s) => [...(s || "")].length;   // characters, not UTF-16 units: Apple and Google count characters

/** Every problem with a listing, as { level: "error"|"warn", where, msg }. Pure apart from reading screenshot headers. */
export function check(store, { update = false, shotsDir = null } = {}) {
  const out = []; const err = (where, msg) => out.push({ level: "error", where, msg }); const warn = (where, msg) => out.push({ level: "warn", where, msg });
  const urls = store.urls || {};
  for (const k of ["support", "privacy"]) if (!/^https:\/\//.test(urls[k] || "")) err("urls", `${k} URL missing or not https (both stores block submission without it)`);
  const seen = { asc: new Set(), play: new Set() };
  for (const [i, loc] of (store.locales || []).entries()) {
    const id = (loc.asc || loc.play || [`#${i}`])[0];
    for (const st of ["asc", "play"]) {
      for (const code of loc[st] || []) {
        const where = `${st}:${code}`;
        if (st === "asc" ? !ASC_LOCALES.has(code) : !PLAY_LOCALE.test(code)) err(where, "not a locale this store accepts");
        if (seen[st].has(code)) err(where, "listed twice"); seen[st].add(code);
      }
      if (!(loc[st] || []).length) continue;
      const where = `${st}:${id}`; const v = (f) => field(loc, st, f);
      for (const [f, max] of Object.entries(LIMITS[st])) { const n = len(v(f)); if (n > max) err(where, `${f} is ${n} chars, limit ${max}`); }
      if (!v("name") || !v("description")) err(where, "name and description are required");
      if (st === "play" && !v("short_description")) err(where, "short_description is required on Play");
      if (update && !v("whats_new")) (st === "asc" ? err : warn)(where, st === "asc" ? "whats_new is required on an update (Add for Review is blocked per locale)" : "no whats_new: Play shows the default language's notes");
    }
    if (/,\s/.test(field(loc, "asc", "keywords"))) warn(`asc:${id}`, "keywords have spaces after commas; each one costs a character of the 100");
  }
  if (!seen.asc.size && !seen.play.size) err("locales", "no locales");
  if (shotsDir && fs.existsSync(shotsDir)) {
    for (const dir of fs.readdirSync(shotsDir).sort()) {
      if (!fs.statSync(path.join(shotsDir, dir)).isDirectory()) continue;
      const files = fs.readdirSync(path.join(shotsDir, dir)).filter(f => f.endsWith(".png")).sort();
      const where = `shots:${dir}`; const ios = dir in SHOT_SIZES;
      if (!ios && !(dir in PLAY_SHOT_TYPES)) { warn(where, "unknown folder, not uploaded"); continue; }
      if (files.length > MAX_SHOTS[ios ? "ios" : "play"]) err(where, `${files.length} screenshots, max ${MAX_SHOTS[ios ? "ios" : "play"]}`);
      for (const f of files) {
        const s = pngSize(path.join(shotsDir, dir, f)); if (!s) { err(`${where}/${f}`, "not a PNG"); continue; }
        const [w, h] = s, lo = Math.min(w, h), hi = Math.max(w, h);
        if (ios && !SHOT_SIZES[dir].some(([a, b]) => a === lo && b === hi)) err(`${where}/${f}`, `${w}x${h} is not an accepted size (${SHOT_SIZES[dir].map(p => p.join("x")).join(", ")})`);
        if (!ios && (lo < 320 || hi > 3840)) err(`${where}/${f}`, `${w}x${h}: Play needs both sides between 320 and 3840`);
        // Play documents a 2:1 cap but has accepted 1080x2340 phone shots; flag it, don't block on it.
        else if (!ios && hi > 2 * lo) warn(`${where}/${f}`, `${w}x${h} is past Play's documented 2:1 ratio (accepted in practice; 1080x1920 is the safe size)`);
      }
    }
  }
  return out;
}
