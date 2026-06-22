# Reader

A privacy-first, cross-platform ebook reader for **EPUB, MOBI and more** — no ads, no
tracking, no unnecessary data collection. Runs on **macOS, Windows, Android, iPad/iOS,
and the web** from a single codebase.

Built with **Tauri 2** (Rust shell) + **Vite** + **TypeScript**, using
[foliate-js](https://github.com/johnfactotum/foliate-js) for rendering.

App identifier: `com.balaji.reader`

---

## Why this exists

Most readers either show ads, collect data, or only offer a paged view. This one is
local-first, open, and supports **continuous scroll** as well as classic pagination.

---

## Features

### Reading
- **Multi-format rendering** via foliate-js — **EPUB** (2 & 3), **MOBI / AZW3**,
  **FB2 / FBZ**, **CBZ**, **PDF** (experimental)
- **Scroll view _and_ page view** — live toggle (no re-render)
- **Library** — covers + progress bars, **most recently opened first**, **multi-select import**
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
  *or* **individual files** (both supported on every platform). A **mapper UI** assigns audio
  files to chapters — including chapters **nested inside parts** — with several files per
  chapter and a "distribute evenly" helper. The **text follows the audio** chapter during
  playback. Non-audio files in a folder are ignored
- **Unified player bar** (TTS + audiobook) — a 2-line bar: progress (`current | ==== | total`)
  on top; controls below (**⏪ 10s · play/pause · stop · 10s ⏩** + a compact **speed pill**).
  Tapping the pill opens a **YouTube-style speed sheet** — a slider in fine **0.05× steps**
  (0.25×–3×) with quick presets (1× · 1.25× · 1.5× · 2× · 3×). The ▶ button chooses
  Text-to-speech or Audiobook
- **Headphone / lock-screen controls** — hardware & Bluetooth media buttons (play / pause /
  skip) drive both TTS and the audiobook via the Media Session API

### Appearance
- **Themes** — Light, Paper, Sepia, Gray, Dark, Nord, Solarized Dark, OLED Black
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

1. **Bump the version** in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)
   (`"version": "0.2.0"`). Android derives its `versionCode` from this; a device will only
   accept an update if the version is higher.
2. **Rebuild the target(s):**
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
