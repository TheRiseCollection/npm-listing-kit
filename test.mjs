// node test.mjs — the rules every listing hits. Each case is a rejection we have actually had, or nearly had.
import assert from "node:assert/strict";
import { check } from "./rules.mjs";
import { planAsc, planPlay, playNotes } from "./stores.mjs";

const ok = { urls: { support: "https://x.co", privacy: "https://x.co/p" },
  locales: [{ asc: ["en-US"], play: ["en-US"], name: "Game", subtitle: "Sub", short_description: "Short", description: "Desc", keywords: "a,b", whats_new: "New" }] };
const errs = (s, o) => check(s, o).filter(f => f.level === "error").map(f => `${f.where} ${f.msg}`);
const loc = (patch) => ({ ...ok, locales: [{ ...ok.locales[0], ...patch }] });

// --- check
assert.deepEqual(errs(ok, { update: true }), []);
assert.match(errs(loc({ subtitle: "x".repeat(31) }))[0], /asc:en-US subtitle is 31 chars, limit 30/);
assert.match(errs(loc({ short_description: "é".repeat(81) }))[0], /play:en-US short_description is 81 chars/);   // counts characters, not bytes
assert.deepEqual(errs(loc({ short_description: "é".repeat(80) })), []);
assert.match(errs(loc({ whats_new: "x".repeat(501) }))[0], /play:en-US whats_new is 501/);                   // Play notes cap at 500, ASC at 4000
assert.match(errs(loc({ whats_new: "" }), { update: true }).join(), /whats_new is required on an update/);    // the 10-locale blocker from 1.1.0
assert.deepEqual(errs(loc({ whats_new: "" })), []);                                                          // fine on a first version
assert.match(errs({ ...ok, urls: { support: "https://x.co" } })[0], /privacy URL missing/);
assert.match(errs(loc({ asc: ["es-419"] }))[0], /asc:es-419 not a locale/);                                    // Play's code, not Apple's
assert.match(errs({ ...ok, locales: [ok.locales[0], { ...ok.locales[0], play: [] }] }).join(), /asc:en-US listed twice/);
assert.ok(check(loc({ keywords: "a, b" })).some(f => f.level === "warn"));
assert.match(errs(loc({ overrides: { play: { description: "x".repeat(4001) } } }))[0], /play:en-US description is 4001/);   // overrides are checked too

// --- plan: App Store
const live = (state, patch = {}) => ({ state, ver: "v", info: "i", infoEditable: true, firstVersion: false, version: state,
  locales: { "en-US": { _v: "lv", _i: "li", name: "Game", subtitle: "Sub", description: "Desc", keywords: "a,b", promotional_text: "", whats_new: "New",
    support: "https://x.co", privacy: "https://x.co/p", ...patch } } });
assert.match(planAsc(ok, live("WAITING_FOR_REVIEW")).refused, /in review/);                                   // never touch a queued version
assert.deepEqual(planAsc(ok, live("PREPARE_FOR_SUBMISSION")).ops, []);                                       // in sync: nothing to do
assert.equal(planAsc(ok, live("PREPARE_FOR_SUBMISSION", { description: "Old\n" })).ops.length, 1);
assert.deepEqual(planAsc(ok, live("PREPARE_FOR_SUBMISSION", { description: "Desc\n" })).ops, []);              // trailing whitespace is not a change
const onSale = planAsc(loc({ promotional_text: "Promo", subtitle: "New sub" }), { ...live("READY_FOR_SALE"), infoEditable: false });
assert.deepEqual(onSale.ops.map(o => o.what), ["promotionalText"]);                                          // live version: promo text only
assert.ok(onSale.skipped.some(s => /subtitle/.test(s)));
const first = planAsc(loc({ whats_new: "Changed" }), { ...live("PREPARE_FOR_SUBMISSION"), firstVersion: true });
assert.deepEqual(first.ops, []);                                                                             // no release notes on a first version
assert.equal(planAsc(loc({ asc: ["de-DE"], play: [] }), live("PREPARE_FOR_SUBMISSION")).ops.length, 2);         // a new locale: version + info

// --- plan: Play
const pl = { edit: "e", locales: { "en-US": { name: "Game", short_description: "Short", description: "Desc" } } };
assert.deepEqual(planPlay(ok, pl), []);
assert.deepEqual(planPlay(loc({ overrides: { play: { description: "Longer" } } }), pl).map(o => o.what), ["description"]);
assert.deepEqual(playNotes(ok), [{ language: "en-US", text: "New" }]);
console.log("listing-kit: ok");
