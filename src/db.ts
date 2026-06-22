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
export type Theme =
  | "light"
  | "paper"
  | "sepia"
  | "gray"
  | "dark"
  | "nord"
  | "solarizeddark"
  | "black";

export interface Settings {
  theme: Theme;
  flow: "scrolled" | "paginated";
  font: string;
  fontSize: number; // percent
  lineHeight: number;
  textAlign: "left" | "center" | "right" | "justify";
  hyphenate: boolean; // break words with a hyphen at line ends
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

  // --- TTS highlighting (word and/or sentence, each independently styled) ---
  ttsWordHl: boolean; // highlight the word currently being spoken
  ttsSentenceHl: boolean; // highlight the sentence currently being spoken
  ttsWordStyle: HighlightStyle;
  ttsSentenceStyle: HighlightStyle;
}

// Visual style for a TTS highlight layer.
export interface HighlightStyle {
  bg: string; // background hex, "" = none
  bgOpacity: number; // 0..100
  fg: string; // text-color hex, "" = inherit book color
  fgOpacity: number; // 0..100
  underline: "none" | "solid" | "double" | "dotted" | "dashed" | "wavy";
  strike: boolean; // strike-through
  thickness: number; // text-decoration thickness, px (1..6)
  fontStyle: "normal" | "italic";
  fontWeight: number; // 100..900
}

const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  flow: "scrolled",
  font: "",
  fontSize: 100,
  lineHeight: 1.5,
  textAlign: "justify",
  hyphenate: true,
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

  ttsWordHl: true,
  ttsSentenceHl: false,
  ttsWordStyle: {
    bg: "#ffe08a",
    bgOpacity: 100,
    fg: "",
    fgOpacity: 100,
    underline: "none",
    strike: false,
    thickness: 2,
    fontStyle: "normal",
    fontWeight: 700,
  },
  ttsSentenceStyle: {
    bg: "#cfe8ff",
    bgOpacity: 55,
    fg: "",
    fgOpacity: 100,
    underline: "none",
    strike: false,
    thickness: 2,
    fontStyle: "normal",
    fontWeight: 400,
  },
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

// ---------------------------------------------------------------------------
// Audiobook (per-book ordered audio tracks; blobs stored separately so they
// load lazily rather than all at once — audiobooks can be hundreds of MB)
// ---------------------------------------------------------------------------

export async function getAudioTracks(bookId: string): Promise<string[]> {
  return (await get<string[]>(`audioManifest:${bookId}`)) ?? [];
}

export async function setAudioTracks(bookId: string, names: string[]): Promise<void> {
  await set(`audioManifest:${bookId}`, names);
}

export async function setAudioBlob(bookId: string, i: number, blob: Blob): Promise<void> {
  await set(`audioBlob:${bookId}:${i}`, blob);
}

export async function getAudioBlob(bookId: string, i: number): Promise<Blob | undefined> {
  return get<Blob>(`audioBlob:${bookId}:${i}`);
}

export async function deleteAudio(bookId: string): Promise<void> {
  const names = await getAudioTracks(bookId);
  await del(`audioManifest:${bookId}`);
  for (let i = 0; i < names.length; i++) await del(`audioBlob:${bookId}:${i}`);
  await del(`audioMap:${bookId}`);
  localStorage.removeItem(`audioPos:${bookId}`);
}

// Per-track chapter index (many audio files can map to one chapter).
export async function getAudioMap(bookId: string): Promise<number[]> {
  return (await get<number[]>(`audioMap:${bookId}`)) ?? [];
}

export async function setAudioMap(bookId: string, map: number[]): Promise<void> {
  await set(`audioMap:${bookId}`, map);
}

export interface AudioPos {
  track: number;
  time: number;
}

export function loadAudioPos(bookId: string): AudioPos {
  try {
    const raw = localStorage.getItem(`audioPos:${bookId}`);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { track: 0, time: 0 };
}

export function saveAudioPos(bookId: string, pos: AudioPos): void {
  localStorage.setItem(`audioPos:${bookId}`, JSON.stringify(pos));
}
