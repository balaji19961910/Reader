import { get, set, del, keys } from "idb-keyval";

export interface Bookmark {
  id: string;
  cfi: string;
  label: string; // chapter title or "NN%"
  createdAt: number;
}

export interface Annotation {
  id: string;
  cfi: string;
  color: string;
  text: string; // the highlighted text
  note: string; // optional note
  createdAt: number;
}

// A book record stored in IndexedDB.
export interface BookRecord {
  id: string; // unique id (title+size based)
  fileName: string; // original filename (used for format detection)
  title: string;
  author: string;
  cover?: string; // data URL
  data: ArrayBuffer; // the raw book bytes (epub/mobi/…)
  cfi?: string; // last reading position
  progress?: number; // 0..1
  bookmarks?: Bookmark[];
  annotations?: Annotation[];
  addedAt: number;
  lastOpened: number;
}

const BOOK_PREFIX = "book:";
const LAST_OPENED_KEY = "app:lastOpenedId";

export async function saveBook(book: BookRecord): Promise<void> {
  await set(BOOK_PREFIX + book.id, book);
}

export async function getBook(id: string): Promise<BookRecord | undefined> {
  return get<BookRecord>(BOOK_PREFIX + id);
}

export async function deleteBook(id: string): Promise<void> {
  await del(BOOK_PREFIX + id);
}

// All books, most recently opened first.
export async function listBooks(): Promise<BookRecord[]> {
  const allKeys = await keys();
  const bookKeys = allKeys.filter(
    (k) => typeof k === "string" && k.startsWith(BOOK_PREFIX),
  ) as string[];
  const books = await Promise.all(bookKeys.map((k) => get<BookRecord>(k)));
  return books
    .filter((b): b is BookRecord => !!b)
    .sort((a, b) => b.lastOpened - a.lastOpened);
}

export async function setLastOpened(id: string): Promise<void> {
  await set(LAST_OPENED_KEY, id);
}

export async function getLastOpened(): Promise<string | undefined> {
  return get<string>(LAST_OPENED_KEY);
}

// ---- Display settings (small, kept in localStorage) ----
export interface Settings {
  theme: "light" | "sepia" | "dark" | "black";
  flow: "scrolled" | "paginated";
  font: string;
  fontSize: number; // percent
  lineHeight: number;
  marginTop: number; // px
  marginRight: number; // px
  marginBottom: number; // px
  marginLeft: number; // px

  // --- Reading view ---
  immersive: boolean; // auto-hide top/bottom bars while reading
  alwaysHeader: boolean; // keep the header visible even in immersive mode

  // --- Desktop window (macOS) ---
  floatOnTop: boolean; // keep window above all other apps
  opacityActive: number; // 0.1..1 when the window is focused
  opacityInactive: number; // 0.1..1 when the window is in the background

  // --- Screen ---
  keepAwake: boolean; // prevent the OS from auto-dimming/sleeping while reading

  // --- Reading aids ---
  mediaKeys: boolean; // F7 = prev, F9 = next (desktop)
  volumeButtons: boolean; // volume up/down turn pages (Android)

  // --- Text to speech ---
  ttsRate: number; // 0.5..2.0
  ttsVoice: string; // voiceURI ("" = default)
}

const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  flow: "scrolled",
  font: "",
  fontSize: 100,
  lineHeight: 1.5,
  marginTop: 24,
  marginRight: 24,
  marginBottom: 24,
  marginLeft: 24,

  immersive: true,
  alwaysHeader: false,

  floatOnTop: false,
  opacityActive: 1,
  opacityInactive: 0.8,

  keepAwake: true,

  mediaKeys: true,
  volumeButtons: true,

  ttsRate: 1,
  ttsVoice: "",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("app:settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  localStorage.setItem("app:settings", JSON.stringify(s));
}
