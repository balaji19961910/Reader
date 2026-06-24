// ---------------------------------------------------------------------------
// Sync & backup — Tier-1 "state" (positions, progress, bookmarks, highlights,
// settings, audio progress/maps). Content (book + audio files) is NOT included
// here; that is the opt-in "library" sync handled separately.
//
// Strategy: a single small JSON document (SyncDoc). Devices merge it with
// per-record last-writer-wins (scalars) + union-by-id (lists). This same doc is
// what gets exported to a file or written to the user's cloud.
// ---------------------------------------------------------------------------

import {
  Annotation,
  Bookmark,
  BookRecord,
  getAudioMap,
  getBook,
  listBooks,
  saveBook,
  setAudioMap,
} from "./db";

export const SYNC_DOC_VERSION = 1;

// Per-book synced state (no file bytes — those are content, synced separately).
export interface BookState {
  title?: string;
  author?: string;
  fileName?: string;
  cfi?: string;
  progress?: number;
  lastOpened?: number;
  bookmarks?: Bookmark[];
  annotations?: Annotation[];
  audioPos?: { track: number; time: number };
  audioTimes?: number[]; // per-file resume seconds (merged by max — furthest wins)
  audioContinuous?: boolean;
  audioMap?: number[];
  updatedAt: number; // last-writer-wins for config fields (map/continuous/audioPos)
}

export interface SyncDoc {
  version: number;
  deviceId: string;
  updatedAt: number;
  books: Record<string, BookState>; // per-book progress only — no settings/theme
}

// --- device identity ---
export function getDeviceId(): string {
  let id = localStorage.getItem("sync:deviceId") || "";
  if (!id) {
    id =
      (crypto as any)?.randomUUID?.() ||
      "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("sync:deviceId", id);
  }
  return id;
}

// "this book's state last changed" — proxy used for last-writer-wins.
function bookUpdatedAt(rec: {
  lastOpened?: number;
  bookmarks?: Bookmark[];
  annotations?: Annotation[];
}): number {
  return Math.max(
    rec.lastOpened || 0,
    ...(rec.bookmarks || []).map((b) => b.createdAt || 0),
    ...(rec.annotations || []).map((a) => a.createdAt || 0),
    0,
  );
}

// --- collect everything syncable into one document ---
export async function collectState(): Promise<SyncDoc> {
  const books = await listBooks();
  // NOTE: only per-book progress is synced — NOT settings/theme/fonts/speed
  // (those stay per-device on purpose).
  const doc: SyncDoc = {
    version: SYNC_DOC_VERSION,
    deviceId: getDeviceId(),
    updatedAt: Date.now(),
    books: {},
  };
  for (const rec of books) {
    const id = rec.id;
    const audioMap = await getAudioMap(id);
    let audioPos: { track: number; time: number } | undefined;
    try {
      const raw = localStorage.getItem(`audioPos:${id}`);
      if (raw) audioPos = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    let audioTimes: number[] | undefined;
    try {
      const raw = localStorage.getItem(`audioTimes:${id}`);
      if (raw) audioTimes = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    doc.books[id] = {
      title: rec.title,
      author: rec.author,
      fileName: rec.fileName,
      cfi: localStorage.getItem(`pos:${id}`) || rec.cfi || "",
      progress: rec.progress,
      lastOpened: rec.lastOpened,
      bookmarks: rec.bookmarks || [],
      annotations: rec.annotations || [],
      audioPos,
      audioTimes,
      audioContinuous: localStorage.getItem(`audioContinuous:${id}`) === "1",
      audioMap: audioMap.length ? audioMap : undefined,
      updatedAt: bookUpdatedAt(rec),
    };
  }
  return doc;
}

// union two lists of {id} keeping each id once (incoming wins on collision)
function mergeById<T extends { id: string }>(local: T[], incoming: T[]): T[] {
  const map = new Map<string, T>();
  for (const it of local) map.set(it.id, it);
  for (const it of incoming) map.set(it.id, it);
  return [...map.values()];
}

// --- merge a remote document into local storage ---
export async function applyState(remote: SyncDoc): Promise<{ books: number }> {
  let count = 0;
  for (const [id, rs] of Object.entries(remote.books || {})) {
    const rec = await getBook(id);
    // book not present locally yet → stash for when it's added/downloaded
    if (!rec) {
      try {
        localStorage.setItem(`pendingState:${id}`, JSON.stringify(rs));
      } catch {
        /* ignore */
      }
      continue;
    }
    if (applyBookState(rec, rs)) {
      await saveBook(rec);
      count++;
    }
  }
  return { books: count };
}

// Merge one BookState onto an in-memory BookRecord (mutates rec).
// Returns true if anything changed.
//  • Reading position: FURTHEST progress wins (12 pages vs 20 → keep 20).
//  • Audio per-file resume: the larger time per file wins (more completed).
//  • Config (map / continuous / which track): newest edit wins.
//  • Bookmarks / highlights: union by id (nothing is lost).
function applyBookState(rec: BookRecord, rs: BookState): boolean {
  let changed = false;

  // reading position — keep whichever is further along
  if ((rs.progress ?? -1) > (rec.progress ?? -1)) {
    rec.progress = rs.progress;
    if (rs.cfi) {
      rec.cfi = rs.cfi;
      localStorage.setItem(`pos:${rec.id}`, rs.cfi);
    }
    changed = true;
  }
  if (rs.lastOpened) rec.lastOpened = Math.max(rec.lastOpened || 0, rs.lastOpened);

  // per-file audio resume — keep the furthest position for each file
  if (rs.audioTimes?.length) {
    const local: number[] = (() => {
      try {
        return JSON.parse(localStorage.getItem(`audioTimes:${rec.id}`) || "[]");
      } catch {
        return [];
      }
    })();
    const merged: number[] = [];
    const n = Math.max(local.length, rs.audioTimes.length);
    for (let i = 0; i < n; i++) merged[i] = Math.max(local[i] || 0, rs.audioTimes[i] || 0);
    localStorage.setItem(`audioTimes:${rec.id}`, JSON.stringify(merged));
    changed = true;
  }

  // config fields — newest edit wins
  if ((rs.updatedAt || 0) > bookUpdatedAt(rec)) {
    if (rs.audioPos)
      localStorage.setItem(`audioPos:${rec.id}`, JSON.stringify(rs.audioPos));
    if (rs.audioContinuous != null)
      localStorage.setItem(`audioContinuous:${rec.id}`, rs.audioContinuous ? "1" : "0");
    if (rs.audioMap) void setAudioMap(rec.id, rs.audioMap);
  }

  // lists always union (so a bookmark made on either device survives)
  const bm = mergeById(rec.bookmarks || [], rs.bookmarks || []);
  const an = mergeById(rec.annotations || [], rs.annotations || []);
  if (bm.length !== (rec.bookmarks || []).length) changed = true;
  if (an.length !== (rec.annotations || []).length) changed = true;
  rec.bookmarks = bm;
  rec.annotations = an;
  return changed;
}

// Apply any state that arrived for a book before the book itself existed.
export async function applyPendingState(id: string): Promise<boolean> {
  const raw = localStorage.getItem(`pendingState:${id}`);
  if (!raw) return false;
  try {
    const rs: BookState = JSON.parse(raw);
    const rec = await getBook(id);
    if (rec) {
      applyBookState(rec, rs);
      await saveBook(rec);
    }
  } catch {
    /* ignore */
  }
  localStorage.removeItem(`pendingState:${id}`);
  return true;
}

// --- export / import to a local file (the offline backup path) ---
export async function exportBackup(filename: string): Promise<void> {
  const doc = await collectState();
  const name = (filename || "reader-backup").replace(/\.json$/i, "") + ".json";
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importBackup(file: File): Promise<{ books: number }> {
  const text = await file.text();
  const doc = JSON.parse(text) as SyncDoc;
  if (!doc || !doc.version) throw new Error("Not a Reader backup file");
  return applyState(doc);
}
