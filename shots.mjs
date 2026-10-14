// `listing-kit shots`: render store screenshots from the app's own web build, one fresh page per scene per size.
// The app folder holds listing.shots.mjs:
//   export default {
//     ready: () => window.myGame && !document.getElementById("boot"),   // runs in the page; screenshot waits for it
//     before: async (page, scene) => {},                                   // optional: per page, e.g. set the caption
//     scenes: [{ name: "title", caption: "...", setup: async (page) => {} }],
//     sizes: { "ios-6.9": [1320, 2868], ... },                             // optional, defaults below
//     url: "http://localhost:5173/",                                       // optional: skip the built-in Vite server
//   }
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const DEFAULT_SIZES = {
  "ios-6.9": [1320, 2868], "ios-ipad-13": [2064, 2752],
  "play-phone": [1080, 1920], "play-7in": [1200, 1920], "play-10in": [1600, 2560],
};

export async function shots(cwd, { only = null, out = "store/shots" } = {}) {
  const cfgFile = path.join(cwd, "listing.shots.mjs");
  if (!fs.existsSync(cfgFile)) throw new Error(`no listing.shots.mjs in ${cwd}`);
  const cfg = (await import(pathToFileURL(cfgFile))).default;
  // Playwright and Vite come from the app's own node_modules, so listing-kit adds no dependencies.
  const req = createRequire(path.join(cwd, "package.json"));
  const { chromium } = req("@playwright/test");
  let server = null, url = cfg.url;
  if (!url) {   // ponytail: Vite only; apps on another dev server pass `url`
    const vite = await import(pathToFileURL(req.resolve("vite"))); const createServer = vite.createServer || vite.default.createServer;
    server = await createServer({ root: cwd, server: { port: 0 }, logLevel: "silent" }); await server.listen(); url = server.resolvedUrls.local[0];
  }
  const browser = await chromium.launch(); const errors = []; let n = 0;
  try {
    for (const [size, [w, h]] of Object.entries(cfg.sizes || DEFAULT_SIZES)) {
      if (only && size !== only) continue;
      const dir = path.resolve(cwd, out, size); fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".png")) fs.rmSync(path.join(dir, f));   // the folder is exactly what gets uploaded
      for (const [i, s] of cfg.scenes.entries()) {
        const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
        page.on("pageerror", e => errors.push(`${size}/${s.name}: ${e}`));
        await page.goto(url); await page.waitForFunction(cfg.ready, null, { timeout: 15000 });
        if (cfg.before) await cfg.before(page, s);
        await s.setup(page);
        await page.waitForTimeout(s.settle ?? 450);
        await page.screenshot({ path: path.join(dir, `${i + 1}-${s.name}.png`) }); n++;
        await page.close();
      }
      console.log("  ", size, `${w}x${h}`, cfg.scenes.length, "shots");
    }
  } finally { await browser.close(); if (server) await server.close(); }
  return { n, errors };
}
