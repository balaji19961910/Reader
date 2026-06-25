# Reader

A privacy-first, cross-platform reader for **ebooks, audiobooks, and any text/code file**
— no ads, no tracking, no unnecessary data collection. Runs on **macOS, Windows, Android,
iPad/iOS, and the web** from a single codebase.

Built with **Tauri 2** (Rust shell) + **Vite** + **TypeScript**, using
[foliate-js](https://github.com/johnfactotum/foliate-js) for book rendering and
[CodeMirror 6](https://codemirror.net/) for the text/code viewer.

App identifier: `com.balaji.reader` · Current version: **1.2.0**

---

## Why this exists

Most readers either show ads, collect data, or only offer a paged view. This one is
local-first, open, and supports **continuous scroll** as well as classic pagination.

---

## Changelog

Versions follow `MAJOR.MINOR.PATCH` and are bumped automatically by
[`release/release.sh`](release/release.sh) — see *Updating* below. Full history lives in
[`release/version.json`](release/version.json) and shows on the in-app Help page.

- **1.2.0** — Selective Google Drive sync (opt-in per book, furthest-progress merge);
  server-side cloud moves (no re-upload when re-foldering); folder library with
  drag-and-drop and long-press move/copy; settings split into collapsible Display, Fonts
  and Margins groups; TTS + audiobook player with 0.25×–3× speed presets; offline eviction
  of unopened downloads.
- **1.1.0** — Reader enhancements: reading view, player and library refinements.
- **1.0.0 – 1.0.6** — Initial release, Android signing/APK build, layout fixes.

---

## Features

### Reading
- **Multi-format rendering** via foliate-js — **EPUB** (2 & 3), **MOBI / AZW3**,
  **FB2 / FBZ**, **CBZ**, **PDF** (experimental)
- **Universal text/code viewer** (CodeMirror) — **TXT, Markdown, HTML, XML, JSON** and source
  files for ~50 languages open with syntax highlighting; **Markdown/HTML** get a **Rendered ↔
  Source** toggle, and Source is **editable + saveable** (back into the library or a download)
- **Open once or add to library** — opening any file asks whether to keep it or just view it
- **Scroll view _and_ page view** — live toggle (no re-render)
- **Folder-structured library** — covers + progress bars, **folders** (create / rename / delete,
  breadcrumb navigation, move books between folders), **most recently opened first**,
  **multi-select import**
- **Resume** — reopens to the exact last position per book (survives refresh/close);
  **auto-restores the last book** on launch
- **Contents panel** — **Chapters** (jump to any, including chapters **nested inside parts**),
  **Bookmarks**, and **Highlights**
- **In-app Help & guide** — a built-in, platform-aware user guide covering every feature and
  tip, opened from the **?** button in the Library
- **Search** — find in the **current chapter** or the **whole book**, with highlighted
  excerpts; tap a result to jump
- **Go to** — jump by **percentage**, or by **page number** if the book has a page list
- **Bookmarks** — bookmark the current page; jump to / delete from the panel
- **Highlights & notes** — select text → colour highlight (yellow/green/blue/pink),
  add a note, or copy; highlights persist and redraw on reopen
- **Book details page** (ⓘ on each library book, or in the reader's Contents panel) — cover,
  metadata (format, size, language, publisher), **total words / characters / pages**, a chapter
  list (**including chapters nested inside parts**) with **per-chapter page ranges** (estimated
  for your current font size & margins), **editable title/author** (saved in-app, and written
  into the EPUB file), and **audiobook linking** (see below)

### Listening
- **Read aloud (TTS)** — play / pause / **stop**; starts from your **selection** (or the
  first word of the current view); auto-scroll; voice + speed.
  Uses **Web Speech** on desktop/iOS and the **native Android TextToSpeech** engine on Android
- **Configurable read-along highlight** — highlight the **current word**, the **current
  sentence**, or **both at once**. Each layer is **fully styleable** (Settings → Read aloud →
  ⚙): background & text colour with **opacity**, **underline** (solid / double / dotted /
  dashed / wavy) and thickness, **strike-through**, **font style** and **font weight
  (100–900)**. A live preview shows the result
- **Audiobook** — link audio (M4B/MP3/…) from the **book details page**; choose a **folder**
  *or* **individual files** (every platform). The **mapper** assigns files to chapters
  (incl. chapters **nested inside parts**): **reorder** with ▲▼, **pin** some manually, tick the
  target chapters and **Auto-fill** the rest in order. One file can span several chapters;
  several files can share one. Non-audio files are ignored
- **Audio queue** — a horizontal **queue strip** (current centred) + an expandable **track list**
  with durations; **per-file resume** (each file remembers where you left off, toggleable),
  **repeat off / one / all**, and a per-book **continuous mode** that plays straight through like
  a music player, ignoring the chapter map
- **Player bar** — **TTS** is one simple bar (**⏪10s · play/pause · stop · 10s⏩ · speed**);
  **audiobooks** use **⏪10s · play · 10s⏩ · ⋮** with a *more* sheet (repeat, prev/stop/next,
  speed, resume). The ▶ button chooses Text-to-speech or Audiobook
- **Speed** — a slider from **0.05× to 10×** (1× centred, exponential so slow speeds get fine
  control) plus presets **0.25× · 0.5× · 0.75× · 1× · 1.25× · 1.5× · 1.75× · 2× · 3×**
- **Auto-advance** — keep playback (TTS *and* audiobooks) flowing into the next chapter, or stop
  at each chapter's end (toggle in Settings → Reading aids)
- **Headphone / lock-screen controls** — hardware & Bluetooth media buttons (play / pause /
  skip) drive both TTS and the audiobook via the Media Session API

### Sync & backup (opt-in)
- **Google Drive sign-in** (Library → **⟳ Sync**) — OAuth per platform: token popup on web,
  loopback + PKCE on desktop, Custom Tab + custom-scheme on Android. Your data lives in **your
  own Drive**; nothing touches a server we run
- **Progress sync** — reading position, bookmarks/highlights and audio position merge with
  **furthest-progress-wins** (page 20 beats page 12). **Themes & settings stay per-device**
- **Whole-library sync, your choice** — per book, **Add to / Remove from cloud library** on its
  details page. Synced books are stored as their **original files in your folder structure**,
  mirrored inside the Drive `Reader` folder (browsable), with audiobooks under an opt-in toggle
- **Offline backup file** — Export/Import a portable JSON of your progress without the cloud
- See [`SYNC_SETUP`](src/cloud.ts) (the `SYNC_CONFIG` block) for the per-platform OAuth client ids

### Appearance
- **Themes** — Light, Paper, Sepia, Gray, Dark, Nord, Solarized Dark, OLED Black — each with its
  own **multi-colour progress/slider gradient** and a sleek, slim **theme-specific scrollbar**
- **Typography** — font family, size, line spacing, **text alignment** (left/center/right/
  justify), **hyphenation**, and **4 independent margins** (top/right/bottom/left); trailing
  space in scroll mode so the end isn't glued to the edge
- **Bundled reading fonts** (OFL, inlined for offline use) — Literata, Bitter, Lora,
  Merriweather, Inter, Atkinson Hyperlegible, OpenDyslexic
- **Immersive view** — auto-hiding bars that float over the content (no reflow),
  with an "always show header" option
- **Keep screen awake** while reading (prevents the OS auto-dim / sleep)

### Platform & system
- **File associations** — "Open with Reader" for `.epub`, `.mobi`, `.azw3`, `.fb2`, `.cbz`,
  `.pdf` (macOS, Windows, Linux, Android; iOS Document Types)
- **Float over other apps** — always-on-top + focus-based opacity (desktop) /
  **Picture-in-Picture** (Android, YouTube-style) via the 📌 button
- **Hardware keys** — ◀◀/▶▶ media keys turn pages on macOS (no `fn`), arrow keys everywhere,
  and **volume-button paging** on Android (released automatically while reading aloud)
- **Platform-aware settings** — only the relevant options are shown per platform; everything
  is toggleable

### Notes / known limits
- **TTS read-along highlight** (word *and* sentence) needs the speech engine to report word
  boundaries — `onboundary` on desktop/iOS, `onRangeStart` (Android 8+) on Android. A few
  voices don't report them, in which case speech still works without the moving highlight.
- **Audiobook sync is chapter-level** — plain audio files carry no per-word timing, so there's
  no read-along word highlight for audiobooks (that needs an EPUB3 media-overlay book).
- **File associations** are configured once in
  [`tauri.conf.json`](src-tauri/tauri.conf.json) (`bundle.fileAssociations`); Tauri registers
  them per-platform at build time. Re-install the app after building for the OS to pick them up.
- **Picture-in-Picture is Android-only.** iOS restricts PiP to video playback, so the reader
  can't float over other apps on iPhone/iPad.
- Opening books from **Google Drive** (or any cloud) already works through the system file
  picker / "Open with" — the file is copied into the library on open.
- **Cloud sync needs your own OAuth client ids** (free) — create them in Google Cloud Console
  and paste them into `SYNC_CONFIG` in [`src/cloud.ts`](src/cloud.ts); see the comments there.
- **Unsupported (for now):** binary document formats like **DOCX, CBR (RAR comics), DjVu** —
  those need heavy converters/WASM. Plain-text and source formats are all covered by the viewer.

---

## Project layout

```
.
├── index.html          # app entry (frontend)
├── src/                # TypeScript frontend (the reader UI)
├── src-tauri/          # Rust shell, config, icons
│   ├── tauri.conf.json # app config (window, bundle, file associations)
│   ├── Cargo.toml      # Rust dependencies
│   └── gen/android/    # generated Android Studio project
├── package.json
└── vite.config.ts
```

---

## Prerequisites

Already set up on this machine:

- **Node** + **npm**
- **Rust** + **Cargo** (with Android targets:
  `aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`)
- **Android SDK** (platform 35, build-tools 35.0.1), **NDK r27**, emulator AVD
- **Java 17**
- Env vars (in `~/.bash_profile` and `~/.bashrc`):
  ```bash
  export ANDROID_HOME="$HOME/Library/Android/sdk"
  export NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
  export PATH="$PATH:$ANDROID_HOME/platform-tools"
  ```

For **iOS** later: full Xcode + `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`.

---

## Running (development)

The same codebase runs three ways:

| Target | Command | Notes |
|---|---|---|
| **Web (browser)** | `npm run dev` | Fastest loop. Opens at `http://localhost:1420`. Native file dialogs/Rust calls are unavailable here — UI/rendering only. |
| **macOS (native)** | `npm run tauri dev` | Native window via WebKit |
| **Android** | `npm run tauri android dev` | Boots emulator/device. First build compiles Rust per ABI (~5–10 min); fast afterward. |

Recommended workflow: build the reader UI with `npm run dev`, sanity-check on macOS, and
run the Android build periodically.

---

## Building executables (all platforms)

One codebase, five outputs. **You can only build for a given OS on that OS** (Tauri can't
cross-compile) — so macOS/iOS need a Mac, Windows needs Windows, etc. CI (e.g. GitHub
Actions with a matrix of runners) is the usual way to produce all of them at once.

| Platform | Command | Output |
|---|---|---|
| **macOS** | `npm run tauri build` | `src-tauri/target/release/bundle/macos/Reader.app` |
| **Windows** | `npm run tauri build` *(on Windows)* | `…/bundle/nsis/Reader_x.y.z_x64-setup.exe` (or `…/msi/*.msi`) |
| **Linux** | `npm run tauri build` *(on Linux)* | `…/bundle/appimage/*.AppImage`, `…/deb/*.deb`, `…/rpm/*.rpm` |
| **Android** | `npm run tauri android build -- --apk` | `…/gen/android/app/build/outputs/apk/…` (`.apk` / `.aab`) |
| **iOS** | `npm run tauri ios build` *(needs Xcode)* | `…/gen/apple/build/…` (`.ipa`, archive in Xcode) |

Notes:
- The desktop **bundle targets** are set per-OS in
  [`tauri.conf.json`](src-tauri/tauri.conf.json) (`bundle.targets`). It's currently `["app"]`
  (macOS app only, no DMG); on Windows/Linux set it to `"all"` or list the formats you want
  (`nsis`, `msi`, `appimage`, `deb`, `rpm`).
- **Windows / Linux first-time setup:** install Rust + Node + the Tauri system deps for that
  OS (WebView2 is preinstalled on Win 10/11; Linux needs `webkit2gtk`/`libsoup` etc. — see
  the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)). Then `npm install`
  and run the build command above.
- Detailed per-platform steps (signing, install) are in the sections below.

---

## Building an Android APK

> Make sure `ANDROID_HOME` and `NDK_HOME` are exported (see Prerequisites). Open a fresh
> terminal if you just added them.

### 1. Debug APK (quick, for testing on your own device)

> **Note the `--`** before the flags — npm needs it to forward `--apk`/`--target`
> to the Tauri CLI instead of parsing them itself.

```bash
npm run tauri android build -- --apk --debug
```

Output:
```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Install it on a connected device/emulator:
```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

### 2. Release APK (signed — for sharing / Play Store)

Tauri defaults to building an **AAB** (Android App Bundle, for the Play Store). Add `--apk`
to also get an installable APK.

**a. Create a signing keystore (once):**
```bash
keytool -genkey -v -keystore ~/reader-release.keystore \
  -alias reader -keyalg RSA -keysize 2048 -validity 10000
```
Keep this file and its passwords safe — you need the *same* key for every future update.

**b. Tell Gradle about it.** Create
`src-tauri/gen/android/keystore.properties`:
```properties
storeFile=/Users/balaji-9678/reader-release.keystore
storePassword=YOUR_STORE_PASSWORD
keyAlias=reader
keyPassword=YOUR_KEY_PASSWORD
```
> Add `keystore.properties` and `*.keystore` to `.gitignore` — never commit them.

Then wire it into `src-tauri/gen/android/app/build.gradle.kts` (load the properties and
reference them in a `signingConfigs { release { ... } }` block, applied to the release
build type). See the
[Tauri Android signing guide](https://v2.tauri.app/distribute/sign/android/) for the exact
snippet.

**c. Build the signed release:**
```bash
npm run tauri android build -- --apk
```

Outputs:
```
# Signed APK:
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
# Play Store bundle:
src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

### Per-architecture (smaller) builds

A universal APK bundles all ABIs. For smaller downloads, target one architecture:
```bash
npm run tauri android build -- --apk --target aarch64   # most modern phones
```

---

## Building for desktop

```bash
npm run tauri build          # macOS .app (bundle target is "app" — see tauri.conf.json)
```

The DMG target is disabled (`"targets": ["app"]`) because the DMG step needs Finder
automation permission. To produce a `.dmg`, add `"dmg"` to `targets` and grant
**System Settings → Privacy & Security → Automation → Finder**. The built app is at:
```
src-tauri/target/release/bundle/macos/Reader.app
```

---

## App icon

All icons are generated from [`src-tauri/icon-source.png`](src-tauri/icon-source.png)
(a 1024×1024 PNG with a transparent background). To change the icon, replace that file
and regenerate every size (desktop + Android + iOS):
```bash
npm run tauri icon -- src-tauri/icon-source.png
```
Then rebuild the app(s) so the new icon is bundled.

---

## Updating (shipping changes later)

When you change anything (frontend, Rust, icon), you **rebuild and reinstall**. There's no
magic — the binary has to be regenerated.

1. **Versioning is automatic.** `release/release.sh` runs [`release/version.mjs`](release/version.mjs)
   before each build, which bumps the version and stamps it into `package.json`,
   `tauri.conf.json`, `Cargo.toml` and `src/version.ts` (shown on the in-app Help page).

   Scheme is `MAJOR.MINOR.PATCH`:
   - **PATCH** auto-increments once per release **that sits on a new commit**. Running
     `release.sh` twice on the *same* commit changes nothing — the version is keyed to the
     newest commit that changed a **non-version file** (tracked in
     [`release/version.json`](release/version.json) → `lastCommit`). A commit that only
     touches the version files themselves (`version.json`, `version.ts`, `package.json`,
     `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`) is **ignored** — so you can freely commit
     the version bump without it triggering another bump next time.
   - **MINOR** — a feature drop. Bump by hand: `./release/release.sh --minor`.
   - **MAJOR** — a drastic change. Bump by hand: `./release/release.sh --major`.
   - Pin an exact version with `./release/release.sh --set-version=2.3.0`.

   Release notes are harvested from `git log` since the last release, so write meaningful
   commit subjects — they become the "What's new" list in Help. Android derives its
   `versionCode` from the version; a device only accepts an update if the version is higher.
2. **Build + distribute** with the release script (it versions, builds macOS + Android, and
   copies the artifacts to your Drive folder):
   ```bash
   ./release/release.sh                  # patch bump (if on a new commit) + build + distribute
   ./release/release.sh --minor          # feature release (1.4.x → 1.5.0)
   ./release/release.sh --set-version=2.0.0
   ./release/release.sh --no-commit      # skip the auto-commit of the version bump
   ```
   As its **last step** the script auto-commits the version files
   (`chore: release vX.Y.Z`). That's a version-only commit, so it never triggers another
   bump. Pass `--no-commit` to skip it.
   …or build a single target manually (these do **not** auto-version):
   ```bash
   npm run tauri build                          # macOS  → Reader.app
   npm run tauri android build -- --apk         # Android → APK/AAB
   npm run tauri ios build                       # iOS    → .ipa (needs Xcode)
   ```
3. **Reinstall** (see below).

> **Android updates must use the *same* signing key** as the installed app, or the install
> is rejected (you'd have to uninstall first). Keep your keystore safe.

---

## Installing the builds

### macOS (`.app`)
Just run it:
```bash
open src-tauri/target/release/bundle/macos/Reader.app
```
Since it isn't code-signed yet, Gatekeeper may block it the first time — **right-click → Open**,
or clear the quarantine flag:
```bash
xattr -dr com.apple.quarantine src-tauri/target/release/bundle/macos/Reader.app
```
To share with others without warnings you need an **Apple Developer ID** (sign + notarize).
For a `.dmg` installer, re-enable the `dmg` bundle target (see *Building for desktop*).

### Android (`.apk`)
The **release** APK is built **unsigned** and can't be installed as-is. Two options:

- **Quick/personal** — build a debug APK (auto-signed with a debug key, installable):
  ```bash
  npm run tauri android build -- --apk --debug
  adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
  ```
- **Proper/shareable** — sign the release APK with your keystore (see *Release APK* above),
  then install via `adb install -r <signed.apk>` or copy it to the phone and tap it
  (enable *Install unknown apps* for your file manager).

### iOS / iPad (`.ipa`)
iOS **requires a Mac with Xcode and an Apple ID** — there's no sideloading without it.
```bash
npm run tauri ios init        # once
npm run tauri ios dev          # run on a connected device / simulator
# or: npm run tauri ios build  # then archive/distribute from Xcode
```
To install on your **iPad**:
1. Connect the iPad to the Mac, open the generated Xcode project
   (`src-tauri/gen/apple`), pick the iPad as the run target, and press ▶ — or use
   `npm run tauri ios dev` and select the device.
2. A **free Apple ID** lets you run on your own devices, but the app expires after **7 days**
   (re-deploy to renew). A **paid Apple Developer account ($99/yr)** gives 1-year provisioning
   plus **TestFlight** / App Store distribution.
3. On the iPad, trust the developer:
   **Settings → General → VPN & Device Management → (your Apple ID) → Trust**.

---

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) + [Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

## Privacy

No analytics, no ads, no tracking, no network calls. All books, reading positions,
bookmarks, highlights, and settings stay on the device.
