# Release

One script to build Reader (Android + macOS) and distribute it.

```bash
# build everything and copy to the default Drive folder + /Applications
./release/release.sh

# build, then copy to a specific (local) folder — e.g. a Google Drive folder
./release/release.sh "/Users/you/Library/CloudStorage/GoogleDrive-…/My Drive/Reader"

# skip building, just redistribute the last build
./release/release.sh --no-build "/path/to/folder"
```

What it does:
- `npm run tauri android build -- --apk --target aarch64` → signed APK
- `npm run tauri build` → `Reader.app`
- copies into the destination folder (overwriting): the `.apk`, `Reader.app`, and a
  shareable `Reader.zip`
- installs `Reader.app` into `/Applications` (quits a running copy first)

Notes:
- The destination must be a **local folder path** (the mounted Google Drive folder under
  `~/Library/CloudStorage/…`), **not** a `drive.google.com` link.
- Share the **`Reader.zip`**, not the raw `Reader.app` — Google Drive stores a `.app` as a
  folder and the bundle breaks on download.
- The release APK must be **signed** (`src-tauri/gen/android/keystore.properties`) or it
  won't install; the script warns if it finds an unsigned APK.
- Edit `DEFAULT_DEST` at the top of `release.sh` to change the default folder.
