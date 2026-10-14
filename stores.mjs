// App Store Connect + Google Play clients, and the read/plan/apply logic for listings.
// Tokens are signed with node:crypto: no PyJWT, no gcloud, no SDKs.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { field, ASC_SHOT_TYPES, PLAY_SHOT_TYPES } from "./rules.mjs";

const b64u = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
const home = (p) => p.replace(/^~/, os.homedir());
const norm = (s) => (s ?? "").replace(/\r\n/g, "\n").trim();
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const clip = (v) => { const t = norm(v).replace(/\s+/g, " "); return t ? `"${t.length > 70 ? t.slice(0, 67) + "..." : t}"` : "(empty)"; };
const detail = (k, from, to) => `${k}: ${clip(from)} -> ${clip(to)}`;

/** Credentials from env, else ~/.listing-kit.json: { asc: { keyId, issuer, keyPath }, play: { serviceAccount } }. Never from the repo. */
export function creds() {
  const f = home("~/.listing-kit.json"); const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  const keyId = process.env.ASC_KEY_ID || c.asc?.keyId; const sa = process.env.PLAY_SERVICE_ACCOUNT || c.play?.serviceAccount;
  return {
    asc: keyId && { keyId, issuer: process.env.ASC_ISSUER || c.asc?.issuer, keyPath: home(process.env.ASC_KEY_PATH || c.asc?.keyPath || `~/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`) },
    play: sa && home(sa),
  };
}

async function req(method, url, { headers = {}, body } = {}) {
  const r = await fetch(url, { method, headers, body }); const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${method} ${url.split("?")[0]} -> ${r.status} ${JSON.stringify(j.errors || j.error || j).slice(0, 300)}`);
  return j;
}

export function asc({ keyId, issuer, keyPath }) {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64u({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64u({ iss: issuer, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" })}`;
  const sig = crypto.sign("sha256", Buffer.from(head), { key: fs.readFileSync(keyPath), dsaEncoding: "ieee-p1363" }).toString("base64url");
  const headers = { Authorization: `Bearer ${head}.${sig}`, "Content-Type": "application/json" };
  const call = (method, p, body) => req(method, `https://api.appstoreconnect.apple.com${p}`, { headers, body: body && JSON.stringify(body) });
  return { get: (p) => call("GET", p), call };
}

export async function play(serviceAccountFile, pkg) {
  const sa = JSON.parse(fs.readFileSync(serviceAccountFile, "utf8")); const now = Math.floor(Date.now() / 1000);
  const head = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: sa.token_uri, iat: now, exp: now + 3600 })}`;
  const sig = crypto.sign("sha256", Buffer.from(head), sa.private_key).toString("base64url");
  const tok = await req("POST", sa.token_uri, { headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${sig}` }) });
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
  return {
    call: (method, p, body) => req(method, api + p, { headers: { ...auth, "Content-Type": "application/json" }, body: body && JSON.stringify(body) }),
    upload: (p, png) => req("POST", `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${pkg}${p}?uploadType=media`, { headers: { ...auth, "Content-Type": "image/png" }, body: png }),
  };
}

// ------------------------------------------------------------------ App Store ----
// A version in these states can take any edit; READY_FOR_SALE only takes promotional text; anything else (in review) takes none.
const ASC_EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);
const ASC_VERSION_FIELDS = { description: "description", keywords: "keywords", promotional_text: "promotionalText", whats_new: "whatsNew" };
const ASC_INFO_FIELDS = { name: "name", subtitle: "subtitle" };

export async function readAsc(c, bundleId) {
  const app = (await c.get(`/v1/apps?filter[bundleId]=${bundleId}`)).data[0];
  if (!app) throw new Error(`no App Store Connect app for ${bundleId}`);
  const versions = (await c.get(`/v1/apps/${app.id}/appStoreVersions?limit=10`)).data;
  const ver = versions[0]; const state = ver.attributes.appStoreState;
  const infos = (await c.get(`/v1/apps/${app.id}/appInfos`)).data;
  const editInfo = infos.find(i => !["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"].includes(i.attributes.appStoreState || i.attributes.state));
  const info = editInfo || infos[0];
  const locales = {};
  for (const l of (await c.get(`/v1/appStoreVersions/${ver.id}/appStoreVersionLocalizations?limit=50`)).data) {
    const a = l.attributes; locales[a.locale] = { _v: l.id, support: a.supportUrl, marketing: a.marketingUrl };
    for (const [k, api] of Object.entries(ASC_VERSION_FIELDS)) locales[a.locale][k] = a[api];
  }
  for (const l of (await c.get(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=50`)).data) {
    const a = l.attributes; Object.assign(locales[a.locale] ||= {}, { _i: l.id, name: a.name, subtitle: a.subtitle, privacy: a.privacyPolicyUrl });
  }
  return { app: app.id, ver: ver.id, info: info.id, infoEditable: !!editInfo, state, version: `${ver.attributes.versionString} ${state}`,
    firstVersion: versions.length === 1, locales };
}

/** The writes that would make App Store Connect match store.json. Each op: { code, what, run(c) }. Refuses while in review. */
export function planAsc(store, live) {
  const ops = []; const skipped = [];
  const editable = ASC_EDITABLE.has(live.state), liveOnly = live.state === "READY_FOR_SALE";
  if (!editable && !liveOnly) return { ops, skipped, refused: `version is ${live.state}: editing a version in review pulls it from the queue. Wait, or reject it in App Store Connect first.` };
  const urls = { supportUrl: store.urls.support, marketingUrl: store.urls.marketing };
  for (const loc of store.locales) for (const code of loc.asc || []) {
    const l = live.locales[code] || {}; const vAttrs = {}; const iAttrs = {}; const was = {};
    for (const [k, api] of Object.entries(ASC_VERSION_FIELDS)) {
      if (k === "whats_new" && live.firstVersion) continue;   // Apple rejects release notes on a first version
      if (norm(field(loc, "asc", k)) !== norm(l[k])) { vAttrs[api] = field(loc, "asc", k); was[api] = l[k]; }
    }
    for (const [api, v] of Object.entries(urls)) { const k = api === "supportUrl" ? "support" : "marketing"; if (v && norm(v) !== norm(l[k])) { vAttrs[api] = v; was[api] = l[k]; } }
    for (const [k, api] of Object.entries(ASC_INFO_FIELDS)) if (norm(field(loc, "asc", k)) !== norm(l[k])) { iAttrs[api] = field(loc, "asc", k); was[api] = l[k]; }
    if (store.urls.privacy && norm(store.urls.privacy) !== norm(l.privacy)) { iAttrs.privacyPolicyUrl = store.urls.privacy; was.privacyPolicyUrl = l.privacy; }
    if (liveOnly) {   // only promotional text can change on a live version
      for (const k of Object.keys(vAttrs)) if (k !== "promotionalText") { skipped.push(`${code} ${k}`); delete vAttrs[k]; }
      for (const k of Object.keys(iAttrs)) { skipped.push(`${code} ${k}`); delete iAttrs[k]; }
    }
    if (!live.infoEditable) for (const k of Object.keys(iAttrs)) { skipped.push(`${code} ${k} (name/subtitle change with the next version)`); delete iAttrs[k]; }
    const details = (a) => Object.keys(a).map(k => detail(k, was[k], a[k]));
    if (Object.keys(vAttrs).length) ops.push({ code, what: Object.keys(vAttrs).join(", "), details: details(vAttrs), run: (c) => l._v
      ? c.call("PATCH", `/v1/appStoreVersionLocalizations/${l._v}`, { data: { type: "appStoreVersionLocalizations", id: l._v, attributes: vAttrs } })
      : c.call("POST", "/v1/appStoreVersionLocalizations", { data: { type: "appStoreVersionLocalizations", attributes: { ...vAttrs, locale: code }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: live.ver } } } } }) });
    if (Object.keys(iAttrs).length) ops.push({ code, what: Object.keys(iAttrs).join(", "), details: details(iAttrs), run: (c) => l._i
      ? c.call("PATCH", `/v1/appInfoLocalizations/${l._i}`, { data: { type: "appInfoLocalizations", id: l._i, attributes: iAttrs } })
      : c.call("POST", "/v1/appInfoLocalizations", { data: { type: "appInfoLocalizations", attributes: { ...iAttrs, locale: code }, relationships: { appInfo: { data: { type: "appInfos", id: live.info } } } } }) });
  }
  return { ops, skipped };
}

/** Screenshot sets that differ (by md5, in order) from the folders, for every ASC locale. Replaces a whole set when anything differs. */
export async function planAscShots(c, store, live, shotsDir) {
  const ops = [];
  if (!ASC_EDITABLE.has(live.state)) return ops;
  const local = Object.entries(ASC_SHOT_TYPES).map(([dir, type]) => {
    const d = path.join(shotsDir, dir); if (!fs.existsSync(d)) return null;
    const files = fs.readdirSync(d).filter(f => f.endsWith(".png")).sort().map(f => ({ name: f, data: fs.readFileSync(path.join(d, f)) }));
    return files.length ? { type, files } : null;
  }).filter(Boolean);
  const primary = store.locales.find(l => (l.asc || []).length)?.asc[0];
  for (const loc of store.locales) for (const code of loc.asc || []) {
    let vid = live.locales[code]?._v; if (!vid) continue;   // text push creates the localization first; shots follow on the next run
    const sets = (await c.get(`/v1/appStoreVersionLocalizations/${vid}/appScreenshotSets`)).data;
    for (const { type, files } of local) {
      const set = sets.find(s => s.attributes.screenshotDisplayType === type);
      if (!set && code !== primary) continue;   // no own set: this locale shows the primary's screenshots, keep it that way
      const have = set ? (await c.get(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`)).data : [];
      if (have.map(h => h.attributes.sourceFileChecksum).join() === files.map(f => md5(f.data)).join()) continue;
      ops.push({ code, what: `${type} ${files.length} screenshots`, run: async (c) => {
        let setId = set?.id;
        if (!setId) setId = (await c.call("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: type }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: vid } } } } })).data.id;
        for (const h of have) await c.call("DELETE", `/v1/appScreenshots/${h.id}`);
        for (const f of files) {
          const shot = (await c.call("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: f.name, fileSize: f.data.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } } } })).data;
          for (const op of shot.attributes.uploadOperations)
            await req(op.method, op.url, { headers: Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value])), body: f.data.subarray(op.offset, op.offset + op.length) });
          await c.call("PATCH", `/v1/appScreenshots/${shot.id}`, { data: { type: "appScreenshots", id: shot.id, attributes: { uploaded: true, sourceFileChecksum: md5(f.data) } } });
        }
      } });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------- Play ----
/** Opens an edit and reads listings + production notes. The caller commits or deletes the edit. */
export async function readPlay(p) {
  const edit = (await p.call("POST", "/edits")).id; const locales = {};
  for (const l of (await p.call("GET", `/edits/${edit}/listings`)).listings || [])
    locales[l.language] = { name: l.title, short_description: l.shortDescription, description: l.fullDescription };
  const rel = ((await p.call("GET", `/edits/${edit}/tracks/production`)).releases || [])[0];
  for (const n of rel?.releaseNotes || []) (locales[n.language] ||= {}).whats_new = n.text;
  return { edit, version: rel ? `${rel.name} ${rel.status}` : "no production release", locales };
}

/** Listing text per locale. Release notes are not pushed here: on Play they belong to a release (see playNotes). */
export function planPlay(store, live) {
  const ops = [];
  for (const loc of store.locales) for (const code of loc.play || []) {
    const l = live.locales[code] || {};
    const diff = ["name", "short_description", "description"].filter(k => norm(field(loc, "play", k)) !== norm(l[k]));
    if (diff.length) ops.push({ code, what: diff.join(", "), details: diff.map(k => detail(k, l[k], field(loc, "play", k))), run: (p) => p.call("PUT", `/edits/${live.edit}/listings/${code}`,
      { language: code, title: field(loc, "play", "name"), shortDescription: field(loc, "play", "short_description"), fullDescription: field(loc, "play", "description") }) });
  }
  return ops;
}

/** Screenshots + store.json "graphics" (icon, featureGraphic) for the default Play language; other languages fall back to it.
 *  A type is replaced whole when its sha256 list differs. */
export async function planPlayShots(p, store, live, shotsDir) {
  const ops = []; const lang = store.locales.find(l => (l.play || []).length)?.play[0];
  const sources = [...Object.entries(PLAY_SHOT_TYPES).map(([dir, type]) => {
    const d = path.join(shotsDir, dir); return [type, fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith(".png")).sort().map(f => path.join(d, f)) : []];
  }), ...Object.entries(store.graphics || {}).map(([type, f]) => [type, [f]])];   // icon, featureGraphic
  for (const [type, paths] of sources) {
    const files = paths.map(f => fs.readFileSync(f));
    if (!files.length) continue;
    const have = (await p.call("GET", `/edits/${live.edit}/listings/${lang}/${type}`)).images || [];
    if (have.map(i => i.sha256).join() === files.map(sha256).join()) continue;
    ops.push({ code: lang, what: `${type} ${files.length} images`, run: async (p) => {
      await p.call("DELETE", `/edits/${live.edit}/listings/${lang}/${type}`);
      for (const f of files) await p.upload(`/edits/${live.edit}/listings/${lang}/${type}`, f);
    } });
  }
  return ops;
}

/** Release notes for a Play release, from store.json: [{ language, text }]. For release scripts. */
export function playNotes(store) {
  return store.locales.flatMap(loc => (loc.play || []).map(code => ({ language: code, text: field(loc, "play", "whats_new") }))).filter(n => n.text);
}
