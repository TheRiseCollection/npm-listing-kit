# listing-kit

One `store.json` for your App Store and Google Play listings, checked before the stores see it.

```
npx listing-kit check --update     # offline: would either store reject this?
npx listing-kit diff -v            # what each store shows now vs your file, per locale
npx listing-kit push --yes         # write only what differs
npx listing-kit shots              # render store screenshots from your own web build
```

Node 20+, no dependencies. It talks to the App Store Connect API and the Google Play Developer
API directly, and signs both tokens with `node:crypto`, so you don't need Ruby, Fastlane, PyJWT
or gcloud.

## Why

We ship small games to both stores from one TypeScript codebase. Each store listing (names,
subtitles, descriptions, keywords, release notes in 11 languages, screenshots at five sizes) was
spread across a pile of per-app scripts. Every mistake we made was the kind a machine could have
caught first:

- A subtitle one character over the limit, silently truncated mid-word on Play.
- An update blocked at Add for Review because ten locales had no "What's New".
- Release notes typed into App Store Connect that the repo never knew about.
- A German listing showing the English subtitle, for weeks.

`listing-kit check` knows each store's limits per field, which locale codes each store accepts,
which fields an update needs, and which screenshot sizes are valid. `diff` shows exactly where your
file and the live stores disagree. `push` changes only what differs.

## store.json

```json
{
  "ios": { "bundleId": "com.example.game" },
  "android": { "package": "com.example.game" },
  "urls": { "support": "https://example.com", "marketing": "https://example.com", "privacy": "https://example.com/privacy" },
  "graphics": { "icon": "assets/icon-512.png", "featureGraphic": "assets/feature.png" },
  "locales": [
    {
      "asc": ["en-US"], "play": ["en-US"],
      "name": "Game", "subtitle": "Thirty characters at most",
      "short_description": "Play's 80-character line",
      "promotional_text": "App Store promotional text",
      "keywords": "comma,separated,no,spaces",
      "description": "The full description.",
      "whats_new": "Release notes for this version.",
      "overrides": { "play": { "description": "A Play-only description, if it differs." } }
    },
    { "asc": ["es-ES", "es-MX"], "play": ["es-ES", "es-419"], "name": "Juego", "...": "..." }
  ]
}
```

One locale entry can feed several store locales: Spanish for both `es-ES` and `es-MX` on the App
Store, and `es-ES` and `es-419` on Play. `overrides.<store>.<field>` replaces a field for one store only.

## Commands

**`check [--update] [--shots dir]`** runs offline and exits 1 on any error. It checks:
- field limits per store, counted in characters (an `é` is one, as both stores count it)
- locale codes each store accepts, and no code listed twice
- https support and privacy URLs
- `whats_new` in every App Store locale when `--update` is set
- screenshot pixel sizes and counts per folder

Warnings flag what the stores tolerate but you probably don't want.

**`diff [--ios|--android] [-v]`** is read-only and exits 1 if anything differs. On Play it opens an
edit to read and then deletes it, so nothing is ever committed.

**`push [--ios|--android] --yes`** writes only what differs. Without `--yes` it does exactly what
`diff` does. It also guards the risky cases:
- It refuses to touch an iOS version that is waiting for or in review, since an edit would pull it from the queue.
- On a version that's already live, it only changes promotional text, the one field Apple lets you edit there.
- It never sends release notes on a first version (Apple rejects them).
- It runs `check` first and stops on any error.

Screenshots are handled like this:
- **App Store:** a set is replaced only when its md5 list differs, in the primary locale and in any
  locale that already has its own set. Other locales keep falling back to the primary.
- **Play:** the default language's images (screenshots, icon, feature graphic) are replaced per type
  when the sha256 list differs.

Play release notes belong to a release rather than the listing, so `push` leaves them alone. Your
release script can read them from `store.json`; `stores.mjs` exports `playNotes(store)` for that.

**`shots [--size name]`** opens your app in Playwright, one fresh page per scene per size, and writes
`store/shots/<size>/<n>-<scene>.png`. These are the same folders `check` and `push` read. It uses
the Playwright and Vite already installed in your app, and you describe the scenes in
`listing.shots.mjs`:

```js
export default {
  ready: () => window.game && !document.getElementById("boot"),           // runs in the page
  before: async (page, scene) => page.evaluate(c => { window.caption = c; }, scene.caption),
  scenes: [
    { name: "title", caption: "", setup: async (page) => {} },
    { name: "boss", caption: "THE BOSS.", setup: async (page) => page.evaluate(() => window.game.spawnBoss()) },
  ],
  // sizes: { "ios-6.9": [1320, 2868], "ios-ipad-13": [2064, 2752], "play-phone": [1080, 1920], ... },
  // url: "http://localhost:3000/",   // if you don't use Vite
};
```

| folder | uploads as |
|---|---|
| `ios-6.9` | App Store 6.9" iPhone (`APP_IPHONE_67`) |
| `ios-6.5` | App Store 6.5" iPhone |
| `ios-ipad-13` | App Store 13" iPad |
| `play-phone`, `play-7in`, `play-10in` | Play phone / 7" / 10" tablet |

## Credentials

Credentials come from environment variables or `~/.listing-kit.json`, never from your repo:

```json
{
  "asc": { "keyId": "ABC123XYZ9", "issuer": "your-issuer-uuid", "keyPath": "~/.appstoreconnect/private_keys/AuthKey_ABC123XYZ9.p8" },
  "play": { "serviceAccount": "~/secrets/play-service-account.json" }
}
```

Env equivalents: `ASC_KEY_ID`, `ASC_ISSUER`, `ASC_KEY_PATH`, `PLAY_SERVICE_ACCOUNT`.

The App Store Connect key needs the App Manager role. The Play service account needs "Manage store
presence" for the app.

## What it doesn't do

Building, signing and uploading binaries, release tracks, age ratings, categories, privacy labels
and pricing are all out of scope. Xcode, Gradle and Fastlane already handle those well. listing-kit
is only the listing.

## Tests

`node test.mjs`. Each case is a rejection we have actually had, or nearly had.

## License

MIT. Made by [The Rise Collection](https://www.therisecollection.co), who use it to ship Last Harvest,
Kessler Sky, Lantern Ronin and Keep On Racing.
