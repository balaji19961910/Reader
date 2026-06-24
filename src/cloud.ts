// ---------------------------------------------------------------------------
// Cloud sync orchestration + provider seam.
//
// A provider (Google Drive, OneDrive, …) only has to know how to read/write a
// single JSON file in a chosen folder. The engine here handles WHEN to sync,
// keeping reads/writes minimal: debounced pushes + pull-on-focus, never a tight
// poll. Providers register themselves once their OAuth client id is configured.
// ---------------------------------------------------------------------------

import { applyState, applyPendingState, collectState } from "./sync";
import {
  BookRecord,
  clearAudioBlobs,
  getAudioBlob,
  getAudioTracks,
  getBook,
  getFolders,
  listBooks,
  saveBook,
  saveFolders,
  setAudioBlob,
  setAudioTracks,
} from "./db";

// OAuth client ids, per platform. Create these in Google Cloud Console →
// Credentials and paste them in. Each platform needs the matching client type:
//   desktop → "Desktop app" client (has a clientId + clientSecret; loopback flow)
//   android → "Android" client (clientId only; package name + SHA-1 fingerprint)
//             — or leave blank to reuse the desktop loopback flow on Android
//   web     → "Web application" client (clientId only; authorised origin
//             http://localhost:1420) — only needed to test sign-in in `npm run dev`
// Scope used everywhere: https://www.googleapis.com/auth/drive.file
//
// SECRETS: client *secrets* must NOT be committed. They're read from a gitignored
// `.env.local` (see `.env.example`) at build time. Client *ids* are not secret,
// so they stay here for convenience.
const ENV = ((import.meta as any).env || {}) as Record<string, string>;
export const SYNC_CONFIG = {
  google: {
    desktop: {
      clientId: "1075055591516-jc20nah26di6krjc37s21e75dsfqtklu.apps.googleusercontent.com",
      clientSecret: ENV.VITE_GOOGLE_DESKTOP_SECRET || "", // from .env.local
    },
    // Android clients lock to one package + one SHA-1, so the debug-signed and
    // release-signed APKs each need their own client (different client id).
    android: {
      debug: { clientId: "1075055591516-9smo20nohso17ls1k5mlnh4c0a1vmens.apps.googleusercontent.com" }, // SHA-1 C4:B2:C7:73:… (debug keystore)
      release: { clientId: "1075055591516-thhk7hmhc85pirp7bdcjmseasb8jpj11.apps.googleusercontent.com" }, // SHA-1 D3:3F:48:6D:… (reader-release.jks)
    },
    web: {
      clientId: "1075055591516-oqlhnrdel0r4essadje1udi047acdn5n.apps.googleusercontent.com",
      clientSecret: ENV.VITE_GOOGLE_WEB_SECRET || "", // from .env.local
    },
  },
  // Microsoft / OneDrive — skipped for now.
  microsoft: {
    desktop: { clientId: "" },
    android: { debug: { clientId: "" }, release: { clientId: "" } },
    web: { clientId: "" },
  },
};

export type OAuthClient = { clientId: string; clientSecret?: string };

// Pick the Google client for the running platform. On Android the signing
// variant (debug vs release) selects which client id to use.
export function googleClient(
  platform: string,
  androidVariant: "debug" | "release" = "release",
): OAuthClient {
  if (platform === "android") return SYNC_CONFIG.google.android[androidVariant];
  if (platform === "web") return SYNC_CONFIG.google.web;
  return SYNC_CONFIG.google.desktop;
}

export type ProviderId = "gdrive" | "onedrive";

export interface SyncSettings {
  provider: "" | ProviderId; // active provider for state sync ("" = off)
  folder: string; // folder name in the cloud
  filename: string; // sync document filename
  auto: boolean; // auto-sync on change + on focus
  content: boolean; // also sync book + audio files (opt-in, heavy)
  evictDays: number; // free up local files not opened in N days (0 = never)
}

const SYNC_DEFAULTS: SyncSettings = {
  provider: "",
  folder: "ReaderAppData",
  filename: "reader-sync.json",
  auto: true,
  content: false,
  evictDays: 0,
};

export function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem("sync:settings");
    if (raw) return { ...SYNC_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...SYNC_DEFAULTS };
}

export function saveSyncSettings(s: SyncSettings): void {
  localStorage.setItem("sync:settings", JSON.stringify(s));
}

// A cloud backend moves JSON docs and (for library sync) binary files around.
export interface SyncProvider {
  id: ProviderId;
  name: string;
  isConfigured(): boolean; // client id present
  isConnected(): boolean; // have a valid/refreshable token
  account(): string | null; // email / name for display
  connect(): Promise<void>; // run the OAuth flow
  disconnect(): Promise<void>;
  readJson(folder: string, name: string): Promise<any | null>;
  writeJson(folder: string, name: string, obj: any): Promise<void>;
  uploadFile(folder: string, name: string, blob: Blob, mime?: string): Promise<void>;
  downloadFile(folder: string, name: string): Promise<ArrayBuffer | null>;
  listFiles(folder: string): Promise<{ id: string; name: string }[]>;
  deleteFile(folder: string, name: string): Promise<void>;
}

// Per-book opt-in: which books this device puts in the shared cloud library.
export function isCloudSynced(id: string): boolean {
  return localStorage.getItem(`cloudSync:${id}`) === "1";
}
export function setCloudSynced(id: string, on: boolean): void {
  localStorage.setItem(`cloudSync:${id}`, on ? "1" : "0");
}

const PROVIDERS: Partial<Record<ProviderId, SyncProvider>> = {};

export function registerProvider(p: SyncProvider): void {
  PROVIDERS[p.id] = p;
}
export function getProvider(id: ProviderId): SyncProvider | undefined {
  return PROVIDERS[id];
}
export function allProviders(): SyncProvider[] {
  return Object.values(PROVIDERS) as SyncProvider[];
}
export function activeProvider(): SyncProvider | undefined {
  const id = loadSyncSettings().provider;
  return id ? PROVIDERS[id] : undefined;
}

export function lastSynced(): number {
  return Number(localStorage.getItem("sync:lastSynced")) || 0;
}

// Let the UI refresh the library grid after books are pulled down.
let onLibraryChanged: (() => void) | null = null;
export function setLibraryChangedHandler(fn: () => void): void {
  onLibraryChanged = fn;
}

// --- Sync activity state (for the UI: busy flag + live progress) ----------
let busy = false;
export function isSyncing(): boolean {
  return busy;
}
export type SyncItem = {
  name: string;
  dir: "up" | "down";
  status: "pending" | "active" | "done";
};
export interface SyncProgress {
  message: string;
  pct: number;
  items: SyncItem[];
}
let syncItems: SyncItem[] = [];
let onProgress: ((p: SyncProgress) => void) | null = null;
export function setSyncProgressHandler(fn: (p: SyncProgress) => void): void {
  onProgress = fn;
}
function report(message: string, pct: number): void {
  onProgress?.({
    message,
    pct: Math.max(0, Math.min(100, Math.round(pct))),
    items: syncItems.map((x) => ({ ...x })),
  });
}

let syncing = false;
let pushTimer: number | undefined;

// The core round-trip: pull remote → merge → push merged. Idempotent & minimal.
export async function syncNow(): Promise<{ ok: boolean; message: string }> {
  const s = loadSyncSettings();
  const p = activeProvider();
  if (!p) return { ok: false, message: "No cloud provider selected" };
  if (!p.isConnected()) return { ok: false, message: "Not signed in" };
  if (syncing) return { ok: false, message: "Sync already in progress" };
  syncing = true;
  try {
    const remote = await p.readJson(s.folder, s.filename); // 1 read
    if (remote) await applyState(remote);
    const merged = await collectState();
    await p.writeJson(s.folder, s.filename, merged); // 1 write
    localStorage.setItem("sync:lastSynced", String(Date.now()));
    return { ok: true, message: "Synced" };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Sync failed" };
  } finally {
    syncing = false;
  }
}

// ---- Whole-library sync (real files inside browsable sub-folders) ---------
// Layout in the user's Drive:
//   <folder>/reader-library.json   catalog (id ↔ stored filenames)
//   <folder>/Books/<filename>      the original book file
//   <folder>/Audiobooks/<dir>/...  the original audio files
const CATALOG = "reader-library.json";
// Books live in the user's own folder structure mirrored under the sync folder:
//   <sync>/Fiction/SciFi/<file>   and audio in <sync>/Fiction/SciFi/<audioDir>/
const bookDir = (sync: string, folder: string) => (folder ? `${sync}/${folder}` : sync);
const sanitize = (s: string) =>
  (s || "book").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);

interface CatalogBook {
  id: string;
  fileName: string; // original name (for format detection)
  storedName: string; // name used on disk (unique within its folder)
  folder?: string; // library folder path ("" = root)
  title: string;
  author: string;
  cover?: string;
  addedAt?: number;
  audioDir?: string; // audio sub-folder name (under the book's folder)
  audio?: string[]; // audio track names, in order
}
interface Catalog {
  version: number;
  books: Record<string, CatalogBook>;
}

// Sync only the books the user chose (isCloudSynced); pull any the cloud has.
export async function syncLibrary(
  onStep?: (msg: string) => void,
): Promise<{ ok: boolean; message: string; added: number; uploaded: number }> {
  const s = loadSyncSettings();
  const p = activeProvider();
  if (!p) return { ok: false, message: "No cloud provider selected", added: 0, uploaded: 0 };
  if (!p.isConnected()) return { ok: false, message: "Not signed in", added: 0, uploaded: 0 };

  const withAudio = s.content;
  let added = 0;
  let uploaded = 0;
  try {
    report("Reading cloud catalog…", 2);
    const catalog: Catalog =
      (await p.readJson(s.folder, CATALOG)) || { version: 1, books: {} };
    const local = await listBooks();
    const localIds = new Set(local.map((b) => b.id));

    // figure out the work up-front so we can show a real progress bar
    const toUpload = local.filter((b) => {
      if (!isCloudSynced(b.id)) return false;
      const e = catalog.books[b.id];
      return !e || (e.folder || "") !== (b.folder || "");
    });
    const toDownload = Object.keys(catalog.books).filter((id) => !localIds.has(id));
    const total = toUpload.length + toDownload.length || 1;
    let done = 0;

    // the full plan, so the UI can list synced / syncing / queued files
    syncItems = [
      ...toUpload.map((b) => ({ name: b.title, dir: "up" as const, status: "pending" as const })),
      ...toDownload.map((id) => ({
        name: catalog.books[id].title,
        dir: "down" as const,
        status: "pending" as const,
      })),
    ];
    report(
      total > 1 || syncItems.length ? "Preparing…" : "Nothing to sync",
      2,
    );

    // 1) upload opted-in books that are new — or moved to a different folder
    for (const b of toUpload) {
      const folder = b.folder || "";
      const existing = catalog.books[b.id];
      syncItems[done].status = "active";
      report(`${existing ? "Moving" : "Uploading"} “${b.title}”…`, (done / total) * 100);
      onStep?.(`${existing ? "Moving" : "Uploading"} “${b.title}”…`);

      // if it moved, delete the old copy first
      if (existing) {
        const oldDir = bookDir(s.folder, existing.folder || "");
        await p.deleteFile(oldDir, existing.storedName);
        if (existing.audioDir && existing.audio)
          for (const n of existing.audio) await p.deleteFile(`${oldDir}/${existing.audioDir}`, n);
      }

      const dir = bookDir(s.folder, folder);
      let storedName = existing?.storedName || b.fileName;
      if (!existing) {
        const clash = Object.values(catalog.books).some(
          (e) => e.id !== b.id && (e.folder || "") === folder && e.storedName === storedName,
        );
        if (clash) storedName = `${b.id.slice(0, 6)}-${b.fileName}`;
      }
      await p.uploadFile(dir, storedName, new Blob([b.data]));
      const entry: CatalogBook = {
        id: b.id,
        fileName: b.fileName,
        storedName,
        folder,
        title: b.title,
        author: b.author,
        cover: b.cover,
        addedAt: b.addedAt,
      };
      if (withAudio) {
        const names = await getAudioTracks(b.id);
        if (names.length) {
          const adir = sanitize(b.title) + " — " + b.id.slice(0, 6) + " audio";
          for (let i = 0; i < names.length; i++) {
            const blob = await getAudioBlob(b.id, i);
            if (blob) await p.uploadFile(`${dir}/${adir}`, names[i], blob);
          }
          entry.audioDir = adir;
          entry.audio = names;
        }
      }
      catalog.books[b.id] = entry;
      uploaded++;
      syncItems[done].status = "done";
      done++;
    }

    // 2) pull cloud books we don't have locally (recreating their folders)
    const localFolders = new Set(await getFolders());
    for (const id of toDownload) {
      const meta = catalog.books[id];
      if (syncItems[done]) syncItems[done].status = "active";
      const folder = meta.folder || "";
      report(`Downloading “${meta.title}”…`, (done / total) * 100);
      onStep?.(`Downloading “${meta.title}”…`);
      const dir = bookDir(s.folder, folder);
      const bytes = await p.downloadFile(dir, meta.storedName);
      if (!bytes) {
        if (syncItems[done]) syncItems[done].status = "done";
        done++;
        continue;
      }
      await saveBook({
        id,
        fileName: meta.fileName,
        title: meta.title,
        author: meta.author,
        cover: meta.cover,
        data: bytes,
        folder,
        addedAt: meta.addedAt || Date.now(),
        lastOpened: 0,
      } as BookRecord);
      if (folder) localFolders.add(folder);
      setCloudSynced(id, true); // it lives in the cloud now
      await applyPendingState(id); // restore any synced progress/bookmarks
      if (withAudio && meta.audio?.length && meta.audioDir) {
        const names: string[] = [];
        for (let i = 0; i < meta.audio.length; i++) {
          const ab = await p.downloadFile(`${dir}/${meta.audioDir}`, meta.audio[i]);
          if (ab) {
            await setAudioBlob(id, i, new Blob([ab]));
            names.push(meta.audio[i]);
          }
        }
        if (names.length) await setAudioTracks(id, names);
      }
      added++;
      if (syncItems[done]) syncItems[done].status = "done";
      done++;
    }
    await saveFolders([...localFolders]);

    report("Saving catalog…", 99);
    await p.writeJson(s.folder, CATALOG, catalog);
    localStorage.setItem("sync:lastSynced", String(Date.now()));
    if (added > 0) onLibraryChanged?.();
    return {
      ok: true,
      added,
      uploaded,
      message: `Library synced — ${uploaded} up, ${added} down`,
    };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Library sync failed", added, uploaded };
  }
}

// Remove one book's files + catalog entry from the cloud (keeps the local copy).
export async function removeBookFromCloud(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const s = loadSyncSettings();
  const p = activeProvider();
  if (!p?.isConnected()) return { ok: false, message: "Not signed in" };
  try {
    const catalog: Catalog =
      (await p.readJson(s.folder, CATALOG)) || { version: 1, books: {} };
    const meta = catalog.books[id];
    if (meta) {
      const dir = bookDir(s.folder, meta.folder || "");
      await p.deleteFile(dir, meta.storedName);
      if (meta.audioDir && meta.audio)
        for (const name of meta.audio) await p.deleteFile(`${dir}/${meta.audioDir}`, name);
      delete catalog.books[id];
      await p.writeJson(s.folder, CATALOG, catalog);
    }
    setCloudSynced(id, false);
    return { ok: true, message: "Removed from cloud" };
  } catch (e: any) {
    return { ok: false, message: e?.message || "Couldn't remove from cloud" };
  }
}

// State first (fast), then the whole library. Sets the busy flag + reports progress.
export async function fullSync(
  onStep?: (msg: string) => void,
): Promise<{ ok: boolean; message: string; added: number }> {
  if (busy) return { ok: false, message: "Sync already running", added: 0 };
  busy = true;
  syncItems = [];
  try {
    report("Syncing reading progress…", 1);
    onStep?.("Syncing progress…");
    const st = await syncNow();
    if (!st.ok) return { ok: false, message: st.message, added: 0 };
    const lib = await syncLibrary(onStep);
    // free up local files that haven't been opened in a while (if enabled)
    await evictOldBooks(loadSyncSettings().evictDays);
    report(lib.message, 100);
    return { ok: lib.ok, message: lib.message, added: lib.added };
  } finally {
    busy = false;
  }
}

// ---- Offline eviction (soft-delete local file bytes; re-fetch on open) ----
// Drop a book's local file bytes + audio blobs but keep its metadata + cover,
// so it still shows in the library and re-downloads from the cloud when opened.
export async function evictBook(id: string): Promise<void> {
  const rec = await getBook(id);
  if (!rec || rec.evicted || !isCloudSynced(id)) return;
  await clearAudioBlobs(id);
  rec.data = new ArrayBuffer(0);
  rec.evicted = true;
  await saveBook(rec);
}

// Evict cloud-synced books not opened in `days` days (0 = never).
export async function evictOldBooks(days: number): Promise<number> {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  let n = 0;
  for (const b of await listBooks()) {
    if (!b.evicted && isCloudSynced(b.id) && (b.lastOpened || 0) < cutoff && b.data.byteLength) {
      await evictBook(b.id);
      n++;
    }
  }
  if (n) onLibraryChanged?.();
  return n;
}

// Re-download an evicted book's bytes (+ audio) before opening it.
export async function ensureBookData(id: string): Promise<boolean> {
  const rec = await getBook(id);
  if (!rec) return false;
  if (!rec.evicted && rec.data.byteLength) return true; // already present
  const s = loadSyncSettings();
  const p = activeProvider();
  if (!p?.isConnected()) return false;
  try {
    report(`Fetching “${rec.title}”…`, 30);
    const catalog: Catalog = (await p.readJson(s.folder, CATALOG)) || { version: 1, books: {} };
    const meta = catalog.books[id];
    if (!meta) return false;
    const dir = bookDir(s.folder, meta.folder || "");
    const bytes = await p.downloadFile(dir, meta.storedName);
    if (!bytes) return false;
    rec.data = bytes;
    rec.evicted = false;
    await saveBook(rec);
    if (s.content && meta.audio?.length && meta.audioDir) {
      const names: string[] = [];
      for (let i = 0; i < meta.audio.length; i++) {
        const ab = await p.downloadFile(`${dir}/${meta.audioDir}`, meta.audio[i]);
        if (ab) {
          await setAudioBlob(id, i, new Blob([ab]));
          names.push(meta.audio[i]);
        }
      }
      if (names.length) await setAudioTracks(id, names);
    }
    report("Ready", 100);
    return true;
  } catch {
    return false;
  }
}

// Call whenever state changes — coalesces into one debounced push (minimal writes).
export function markDirty(): void {
  const p = activeProvider();
  if (!loadSyncSettings().auto || !p?.isConnected()) return;
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void syncNow(), 8000);
}

// Call when the app regains focus / becomes visible — one pull, the moment it matters.
export function syncOnFocus(): void {
  const p = activeProvider();
  if (!loadSyncSettings().auto || !p?.isConnected()) return;
  void syncNow();
}
