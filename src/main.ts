import { makeBook } from "./foliate-js/view.js"; // also registers <foliate-view>
import { Overlayer } from "./foliate-js/overlayer.js";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { fontFaceCSS, familyFor, isBundled } from "./fonts";
import {
  Annotation,
  BookRecord,
  Bookmark,
  Settings,
  deleteAudio,
  deleteBook,
  getAudioBlob,
  getAudioTracks,
  getBook,
  getLastOpened,
  listBooks,
  loadAudioPos,
  loadSettings,
  saveAudioPos,
  saveBook,
  saveSettings,
  setAudioBlob,
  setAudioTracks,
  setLastOpened,
} from "./db";
import {
  desktopAvailable,
  getPendingFiles,
  onFocusChange,
  onMediaKey,
  onOpenFile,
  platform,
  readFileBytes,
  setAlwaysOnTop,
  setMediaKeys,
  setWindowOpacity,
} from "./desktop";

// foliate-js is plain JS; treat the view/book as `any`.
type AnyView = any;

const ACCENT = "#3b82f6";
const THEME_COLORS: Record<Settings["theme"], { bg: string; color: string }> = {
  light: { bg: "#ffffff", color: "#1a1a1a" },
  paper: { bg: "#f6f0e3", color: "#43403a" }, // warm off-white, low glare
  sepia: { bg: "#f4ecd8", color: "#5b4636" },
  gray: { bg: "#dcdcdc", color: "#2c2c2c" }, // soft gray, low contrast
  dark: { bg: "#1e1e1e", color: "#cfcfcf" },
  nord: { bg: "#2e3440", color: "#d8dee9" }, // cool blue-gray dark
  solarizeddark: { bg: "#002b36", color: "#93a1a1" },
  black: { bg: "#000000", color: "#b8b8b8" }, // OLED
};

// ---- DOM ----
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const viewer = $("#viewer");
const bookTitleEl = $("#book-title");
const progressLabel = $("#progress-label");
const libraryEl = $("#library");
const settingsEl = $("#settings");
const scrim = $("#scrim");
const bookGrid = $("#book-grid");
const emptyHint = $("#empty-hint");
const fileInput = $<HTMLInputElement>("#file-input");
const tocEl = $("#toc");
const tocList = $("#toc-list");
const searchEl = $("#search");
const detailsEl = $("#details");
const PLATFORM = platform();

// ---- State ----
let settings: Settings = loadSettings();
let view: AnyView = null;
let currentId: string | null = null;

// ---------------------------------------------------------------------------
// Position (synchronous localStorage = reliable across refresh/close)
// ---------------------------------------------------------------------------

const posKey = (id: string) => `pos:${id}`;
const savePos = (id: string, cfi: string) => localStorage.setItem(posKey(id), cfi);
const loadPos = (id: string): string | undefined =>
  localStorage.getItem(posKey(id)) || undefined;

// Store the exact current location synchronously — called on every relocate and
// right before the page is hidden/unloaded so a refresh never loses the spot.
function captureNow() {
  if (!view || !currentId) return;
  try {
    const cfi = view.lastLocation?.cfi;
    if (cfi) savePos(currentId, cfi);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Desktop window features (float on top + focus-based opacity)
// ---------------------------------------------------------------------------

let windowFocused = true;

function effectiveOpacity(): number {
  return windowFocused ? settings.opacityActive : settings.opacityInactive;
}

function applyFloat() {
  setAlwaysOnTop(settings.floatOnTop);
  $("#btn-float").classList.toggle("on", settings.floatOnTop);
}

function applyOpacity() {
  setWindowOpacity(effectiveOpacity());
}

// Tell the Android side whether to grab the volume keys. While read-aloud is
// active we release them so the hardware keys control the speech volume.
function applyVolumeNative() {
  const enabled = settings.volumeButtons && !ttsActive;
  try {
    (window as any).ReaderNative?.setVolumePaging?.(enabled);
  } catch {
    /* not on Android */
  }
}

// ---------------------------------------------------------------------------
// Keep screen awake (prevents the OS from auto-dimming/sleeping while reading)
// ---------------------------------------------------------------------------

let wakeLock: any = null;

async function acquireWake() {
  if (!settings.keepAwake || !currentId) return;
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await (navigator as any).wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    /* unsupported or denied */
  }
}

async function releaseWake() {
  try {
    await wakeLock?.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function applyWake() {
  if (settings.keepAwake) acquireWake();
  else releaseWake();
}

// Re-apply all runtime effects after a settings change / on boot.
function applyDesktopFeatures() {
  applyFloat();
  applyOpacity();
  applyVolumeNative();
  applyWake();
  setMediaKeys(settings.mediaKeys);
}

// ---------------------------------------------------------------------------
// Immersive chrome (auto-hide top/bottom bars)
// ---------------------------------------------------------------------------

let chromeTimer: number | undefined;

function applyChromeMode() {
  // in immersive mode the bars float over the content (no reflow on hide/show)
  document.body.classList.toggle("immersive", settings.immersive);
  document.body.classList.toggle("always-header", settings.alwaysHeader);
  if (!settings.immersive) {
    document.body.classList.remove("chrome-hidden");
    window.clearTimeout(chromeTimer);
  } else {
    scheduleHideChrome();
  }
}

function showChrome() {
  document.body.classList.remove("chrome-hidden");
  scheduleHideChrome();
}

function scheduleHideChrome() {
  window.clearTimeout(chromeTimer);
  if (settings.immersive && currentId) {
    chromeTimer = window.setTimeout(() => {
      document.body.classList.add("chrome-hidden");
    }, 2500);
  }
}

function toggleChrome() {
  if (document.body.classList.contains("chrome-hidden")) showChrome();
  else if (settings.immersive) document.body.classList.add("chrome-hidden");
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

function buildTOC() {
  tocList.innerHTML = "";
  const toc = view?.book?.toc;
  if (!toc || !toc.length) {
    tocList.innerHTML = `<p class="hint">No chapters.</p>`;
    return;
  }
  const render = (items: any[], depth: number) => {
    for (const item of items) {
      const a = document.createElement("button");
      a.className = "toc-item";
      a.style.paddingLeft = 12 + depth * 16 + "px";
      a.textContent = item.label?.trim() || "—";
      a.addEventListener("click", () => {
        if (item.href) view?.goTo(item.href).catch(() => {});
        closeOverlays();
      });
      tocList.appendChild(a);
      if (item.subitems?.length) render(item.subitems, depth + 1);
    }
  };
  render(toc, 0);
}

// ---------------------------------------------------------------------------
// Bookmarks, highlights & notes
// ---------------------------------------------------------------------------

let bookmarks: Bookmark[] = [];
let annotations: Annotation[] = [];
let selIndex = -1;
let selRange: Range | null = null;
let selText = "";

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

async function saveMarks() {
  if (!currentId) return;
  const rec = await getBook(currentId);
  if (!rec) return;
  rec.bookmarks = bookmarks;
  rec.annotations = annotations;
  await saveBook(rec);
}

// Re-draw stored highlights (called when a section's overlay is created).
function redrawAnnotations() {
  for (const a of annotations) {
    try {
      view?.addAnnotation({ value: a.cfi, color: a.color });
    } catch {
      /* section not currently rendered */
    }
  }
}

// Wire foliate's annotation events (called per opened book).
function setupAnnotations() {
  view.addEventListener("draw-annotation", (e: any) => {
    const { draw, annotation } = e.detail;
    draw(Overlayer.highlight, { color: annotation.color });
  });
  view.addEventListener("create-overlay", () => redrawAnnotations());
  view.addEventListener("show-annotation", (e: any) => {
    const a = annotations.find((x) => x.cfi === e.detail.value);
    if (a?.note) alert(a.note);
  });
}

// ---- selection popup ----
function hideSelPopup() {
  $("#sel-popup").hidden = true;
  selRange = null;
}

function onSelection(index: number, doc: Document) {
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
    hideSelPopup();
    return;
  }
  selIndex = index;
  selRange = sel.getRangeAt(0);
  selText = sel.toString();
  const iframe = doc.defaultView?.frameElement as HTMLElement | null;
  const ir = iframe?.getBoundingClientRect();
  const rr = selRange.getBoundingClientRect();
  const popup = $("#sel-popup");
  popup.hidden = false;
  const cx = (ir?.left ?? 0) + rr.left + rr.width / 2;
  const top = (ir?.top ?? 0) + rr.top;
  popup.style.left =
    Math.max(8, Math.min(window.innerWidth - 8 - popup.offsetWidth, cx - popup.offsetWidth / 2)) +
    "px";
  popup.style.top = Math.max(8, top - popup.offsetHeight - 10) + "px";
}

function createHighlight(color: string, note = "") {
  if (selIndex < 0 || !selRange) return;
  let cfi: string;
  try {
    cfi = view.getCFI(selIndex, selRange);
  } catch {
    return;
  }
  annotations.push({ id: uid(), cfi, color, text: selText, note, createdAt: Date.now() });
  try {
    view.addAnnotation({ value: cfi, color });
  } catch {
    /* ignore */
  }
  saveMarks();
  buildHighlights();
  view.deselect?.();
  hideSelPopup();
}

// ---- bookmarks ----
function currentLabel(): string {
  const loc = view?.lastLocation;
  return (
    loc?.tocItem?.label?.trim() ||
    (loc?.fraction != null ? Math.round(loc.fraction * 100) + "%" : "Bookmark")
  );
}

function addBookmark() {
  const cfi = view?.lastLocation?.cfi;
  if (!cfi || bookmarks.some((b) => b.cfi === cfi)) return;
  bookmarks.push({ id: uid(), cfi, label: currentLabel(), createdAt: Date.now() });
  saveMarks();
  buildBookmarks();
  const b = $("#btn-bookmark");
  b.classList.add("on");
  window.setTimeout(() => b.classList.remove("on"), 600);
}

function deleteBookmark(id: string) {
  bookmarks = bookmarks.filter((b) => b.id !== id);
  saveMarks();
  buildBookmarks();
}

function deleteHighlight(a: Annotation) {
  annotations = annotations.filter((x) => x.id !== a.id);
  try {
    view.deleteAnnotation({ value: a.cfi });
  } catch {
    /* ignore */
  }
  saveMarks();
  buildHighlights();
}

// ---- lists ----
function markRow(
  label: string,
  sub: string,
  onOpen: () => void,
  onDelete: () => void,
  swatch?: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "mark-row";
  row.innerHTML = `
    ${swatch ? `<span class="mark-swatch" style="background:${swatch}"></span>` : ""}
    <button class="mark-open">
      <span class="mark-label">${escapeHtml(label)}</span>
      ${sub ? `<span class="mark-sub">${escapeHtml(sub)}</span>` : ""}
    </button>
    <button class="mark-del" title="Delete">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
    </button>`;
  row.querySelector(".mark-open")!.addEventListener("click", onOpen);
  row.querySelector(".mark-del")!.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete();
  });
  return row;
}

function buildBookmarks() {
  const list = $("#bookmark-list");
  list.innerHTML = "";
  if (!bookmarks.length) {
    list.innerHTML = `<p class="hint">No bookmarks.</p>`;
    return;
  }
  for (const b of [...bookmarks].reverse()) {
    list.appendChild(
      markRow(
        b.label,
        new Date(b.createdAt).toLocaleDateString(),
        () => {
          view?.goTo(b.cfi).catch(() => {});
          closeOverlays();
        },
        () => deleteBookmark(b.id),
      ),
    );
  }
}

function buildHighlights() {
  const list = $("#highlight-list");
  list.innerHTML = "";
  if (!annotations.length) {
    list.innerHTML = `<p class="hint">No highlights.</p>`;
    return;
  }
  for (const a of [...annotations].reverse()) {
    const text = a.text.length > 80 ? a.text.slice(0, 80) + "…" : a.text;
    list.appendChild(
      markRow(
        text,
        a.note || "",
        () => {
          view?.goTo(a.cfi).catch(() => {});
          closeOverlays();
        },
        () => deleteHighlight(a),
        a.color,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Text to speech (Web Speech API + foliate word marks)
// ---------------------------------------------------------------------------

// Web Speech works on desktop/iOS; Android WebView lacks it, so we fall back to
// a native Android TextToSpeech engine exposed via the ReaderNative bridge.
const webTTS =
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  typeof SpeechSynthesisUtterance !== "undefined";
const nativeTTS = (): boolean =>
  typeof (window as any).ReaderNative?.ttsSpeak === "function";
let ttsEngine: "web" | "native" | "none" = "none";
let ttsSupported = false;

let ttsActive = false; // a read-aloud session is ongoing (playing or paused)
let ttsPlaying = false;
let voices: SpeechSynthesisVoice[] = [];
let ttsVoiceObj: SpeechSynthesisVoice | null = null;
let lastHlWin: any = null;
let currentMarks: { name: string; pos: number }[] = [];
let awaitingEnd = false; // guards against stale end events when skipping/seeking

function cancelSpeech() {
  awaitingEnd = false;
  if (ttsEngine === "native") {
    try {
      (window as any).ReaderNative?.ttsStop?.();
    } catch {
      /* ignore */
    }
  } else if (webTTS) {
    speechSynthesis.cancel();
  }
}

function loadVoices() {
  if (!webTTS) return;
  voices = speechSynthesis.getVoices();
  const sel = $<HTMLSelectElement>("#tts-voice");
  sel.innerHTML =
    `<option value="">Default</option>` +
    voices
      .map(
        (v) =>
          `<option value="${v.voiceURI}">${escapeHtml(v.name)} (${v.lang})</option>`,
      )
      .join("");
  sel.value = settings.ttsVoice;
  ttsVoiceObj = voices.find((v) => v.voiceURI === settings.ttsVoice) || null;
}

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

function setTtsButton() {
  const b = $("#btn-tts");
  b.innerHTML = ttsPlaying ? ICON_PAUSE : ICON_PLAY;
  b.classList.toggle("on", ttsActive);
  updatePlayPauseIcon();
}

// Highlight + auto-scroll the spoken word (foliate hands us a DOM Range).
function ttsHighlight(range: Range) {
  try {
    const doc = (range.startContainer as Node)?.ownerDocument;
    const win: any = doc?.defaultView;
    if (win?.CSS?.highlights && win.Highlight) {
      let hl = win.CSS.highlights.get("tts");
      if (!hl) {
        hl = new win.Highlight();
        win.CSS.highlights.set("tts", hl);
      }
      hl.clear();
      hl.add(range);
      lastHlWin = win;
    }
    view?.renderer?.scrollToAnchor?.(range, false);
  } catch {
    /* ignore */
  }
}

function clearTtsHighlight() {
  try {
    lastHlWin?.CSS?.highlights?.get("tts")?.clear();
  } catch {
    /* ignore */
  }
}

// Convert foliate's SSML (text + <mark name>) into plain text + mark positions.
function parseSSML(ssml: string): { text: string; marks: { name: string; pos: number }[] } {
  let text = "";
  const marks: { name: string; pos: number }[] = [];
  try {
    const doc = new DOMParser().parseFromString(ssml, "application/xml");
    const walk = (node: Node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === 3) text += child.nodeValue || "";
        else if (child.nodeType === 1) {
          const el = child as Element;
          const ln = el.localName;
          if (ln === "mark")
            marks.push({ name: el.getAttribute("name") || "", pos: text.length });
          else if (ln === "break") text += " ";
          else walk(child);
        }
      });
    };
    if (doc.documentElement) walk(doc.documentElement);
  } catch {
    /* ignore */
  }
  return { text, marks };
}

async function ensureTTS(): Promise<boolean> {
  if (!view) return false;
  if (!view.tts) {
    try {
      await view.initTTS("word", ttsHighlight);
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  return !!view.tts;
}

// Highlight the spoken word given its character index in the current block.
function handleTtsBoundary(charIndex: number) {
  let m: { name: string; pos: number } | null = null;
  for (const mk of currentMarks) {
    if (mk.pos <= charIndex) m = mk;
    else break;
  }
  if (m && view?.tts) {
    try {
      view.tts.setMark(m.name);
    } catch {
      /* ignore */
    }
  }
}

function handleTtsEnd() {
  if (!awaitingEnd) return; // ignore end events from a cancelled utterance
  awaitingEnd = false;
  if (ttsActive && ttsPlaying) onBlockEnd();
}

function speakSSML(ssml: string | undefined) {
  if (!ssml) {
    onBlockEnd();
    return;
  }
  const { text, marks } = parseSSML(ssml);
  if (!text.trim()) {
    onBlockEnd();
    return;
  }
  currentMarks = marks;
  awaitingEnd = true;
  if (ttsEngine === "native") {
    try {
      (window as any).ReaderNative.ttsSpeak(text, settings.ttsRate);
    } catch {
      handleTtsEnd();
    }
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = settings.ttsRate;
  if (ttsVoiceObj) u.voice = ttsVoiceObj;
  u.onboundary = (e) => handleTtsBoundary(e.charIndex);
  u.onend = handleTtsEnd;
  u.onerror = handleTtsEnd;
  speechSynthesis.speak(u);
}

function onBlockEnd() {
  let next: string | undefined;
  try {
    next = view?.tts?.next();
  } catch {
    /* ignore */
  }
  if (next) speakSSML(next);
  else advanceSection();
}

let advancing = false;
async function advanceSection() {
  if (advancing) return;
  advancing = true;
  try {
    await view.next(); // move to the next section/page
    await new Promise((r) => setTimeout(r, 350));
    view.tts = null; // re-init TTS against the newly loaded document
    if (!(await ensureTTS())) return stopTTS();
    const ssml = view.tts.start();
    if (ssml) speakSSML(ssml);
    else stopTTS();
  } catch (e) {
    console.error(e);
    stopTTS();
  } finally {
    advancing = false;
  }
}

async function startTTS() {
  if (!ttsSupported || !view) return;
  stopAudio(); // the two playback modes are mutually exclusive
  if (!(await ensureTTS())) return;
  ttsActive = true;
  ttsPlaying = true;
  showPlayer("tts");
  setTtsButton();
  applyVolumeNative(); // release volume keys so they control speech loudness
  // keep an OS media session alive so headphone buttons reach us during TTS
  ensureSilence();
  ttsSilence.play().catch(() => {});
  setMediaMetadata("Read aloud");
  setMediaState(true);

  // Start from the selection if any, else from the first word of the current
  // view, else from the section start.
  let ssml: string | undefined;
  try {
    const doc = view.renderer.getContents()?.[0]?.doc;
    const sel = doc?.getSelection?.();
    if (sel && !sel.isCollapsed && sel.rangeCount && sel.toString().trim()) {
      ssml = view.tts.from(sel.getRangeAt(0));
    } else if (view.lastLocation?.range) {
      ssml = view.tts.from(view.lastLocation.range);
    } else {
      ssml = view.tts.start();
    }
  } catch (e) {
    console.error(e);
    try {
      ssml = view.tts.start();
    } catch {
      /* ignore */
    }
  }
  view.deselect?.();
  speakSSML(ssml);
}

function pauseResumeTTS() {
  if (!ttsActive) return;
  if (ttsEngine === "native") {
    // Android TextToSpeech has no pause — stop, and resume from the last word.
    if (ttsPlaying) {
      awaitingEnd = false; // the stop below must not trigger auto-advance
      try {
        (window as any).ReaderNative?.ttsStop?.();
      } catch {
        /* ignore */
      }
      ttsPlaying = false;
    } else {
      ttsPlaying = true;
      try {
        speakSSML(view.tts.resume());
      } catch {
        /* ignore */
      }
    }
  } else {
    if (ttsPlaying) {
      speechSynthesis.pause();
      ttsPlaying = false;
    } else {
      speechSynthesis.resume();
      ttsPlaying = true;
    }
  }
  if (ttsPlaying) ttsSilence.play().catch(() => {});
  else ttsSilence.pause();
  setMediaState(ttsPlaying);
  setTtsButton();
}

function stopTTS() {
  awaitingEnd = false;
  if (ttsEngine === "native") {
    try {
      (window as any).ReaderNative?.ttsStop?.();
    } catch {
      /* ignore */
    }
  } else if (webTTS) {
    speechSynthesis.cancel();
  }
  const wasActive = ttsActive;
  ttsActive = false;
  ttsPlaying = false;
  clearTtsHighlight();
  ttsSilence.pause();
  setMediaState(false);
  setTtsButton();
  applyVolumeNative();
  if (wasActive) hidePlayer();
}

// ---------------------------------------------------------------------------
// Unified playback bar (shared by TTS and the audiobook player)
// ---------------------------------------------------------------------------

let playerMode: "tts" | "audio" | null = null;

function fmtTime(s: number): string {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function updatePlayPauseIcon() {
  const playing =
    playerMode === "tts" ? ttsPlaying : playerMode === "audio" ? !audioEl.paused : false;
  $("#pb-play").innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}

function showPlayer(mode: "tts" | "audio") {
  playerMode = mode;
  $("#player-bar").hidden = false;
  $("#pb-speed-btn").textContent = (mode === "audio" ? audioRate : settings.ttsRate) + "×";
  if (mode === "tts") {
    $("#pb-cur").textContent = "0%";
    $("#pb-dur").textContent = "";
  }
  updatePlayPauseIcon();
}

function hidePlayer() {
  $("#player-bar").hidden = true;
  playerMode = null;
}

// ---------------------------------------------------------------------------
// Audiobook (per-chapter audio files mapped to the book's chapters)
// ---------------------------------------------------------------------------

const audioEl = $<HTMLAudioElement>("#audio-el");
let audioNames: string[] = [];
let audioTrack = 0;
let audioActive = false;
let audioUrl: string | null = null;
let audioSaveTimer: number | undefined;
let audioRate = parseFloat(localStorage.getItem("audioRate") || "1") || 1;
let audioImportTarget: "play" | "details" = "play"; // where an audio import goes

// top-level chapters used for the track↔chapter mapping
function tocTop(): any[] {
  return view?.book?.toc ?? [];
}

// move the text to the chapter matching the playing track (when 1:1)
function syncTextToTrack(i: number) {
  const toc = tocTop();
  if (toc.length === audioNames.length && toc[i]?.href) {
    view?.goTo(toc[i].href).catch(() => {});
  }
}

const AUDIO_RE = /\.(m4b|m4a|mp4|mp3|aac|ogg|oga|opus|wav|flac)$/i;

// Store audio files for a book (ordered by name). Returns the track names.
async function storeAudio(bookId: string, files: File[]): Promise<string[] | null> {
  // a folder import may include covers/metadata — keep only audio
  const audio = files.filter(
    (f) => AUDIO_RE.test(f.name) || f.type.startsWith("audio/"),
  );
  if (!audio.length) {
    alert("No audio files found.");
    return null;
  }
  const key = (f: File) => (f as any).webkitRelativePath || f.name;
  const sorted = audio.sort((a, b) =>
    key(a).localeCompare(key(b), undefined, { numeric: true }),
  );
  const names = sorted.map((f) => f.name);
  await setAudioTracks(bookId, names);
  for (let i = 0; i < sorted.length; i++) await setAudioBlob(bookId, i, sorted[i]);
  saveAudioPos(bookId, { track: 0, time: 0 });
  return names;
}

async function importAudio(files: File[]) {
  if (!currentId) return;
  const names = await storeAudio(currentId, files);
  if (!names) return;
  audioNames = names;
  openAudiobook();
}

async function playTrack(i: number, time = 0, autoplay = true) {
  if (!currentId) return;
  if (i < 0 || i >= audioNames.length) {
    stopAudio();
    return;
  }
  audioTrack = i;
  const blob = await getAudioBlob(currentId, i);
  if (!blob) return;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  audioEl.src = audioUrl;
  audioEl.playbackRate = audioRate;
  syncTextToTrack(i);
  const toc = tocTop();
  const label =
    toc.length === audioNames.length && toc[i]?.label
      ? toc[i].label.trim()
      : audioNames[i] || "Audiobook";
  setMediaMetadata(audioNames.length > 1 ? `${i + 1}. ${label}` : label);
  const begin = () => {
    try {
      if (time) audioEl.currentTime = time;
    } catch {
      /* ignore */
    }
    if (autoplay) audioEl.play().catch(() => {});
  };
  if (audioEl.readyState >= 1) begin();
  else audioEl.addEventListener("loadedmetadata", begin, { once: true });
}

async function openAudiobook() {
  if (!currentId || !view) return;
  if (!audioNames.length) {
    // desktop: pick a folder of audio files; mobile: multi-select files
    if (PLATFORM === "desktop" || PLATFORM === "web") $("#audio-folder-input").click();
    else $("#audio-input").click();
    return;
  }
  stopTTS();
  audioActive = true;
  showPlayer("audio");
  const pos = loadAudioPos(currentId);
  await playTrack(Math.min(pos.track, audioNames.length - 1), pos.time, true);
}

function stopAudio() {
  audioEl.pause();
  if (audioActive) {
    audioActive = false;
    hidePlayer();
  }
}

function persistAudioPos() {
  if (currentId && audioActive)
    saveAudioPos(currentId, { track: audioTrack, time: audioEl.currentTime });
}

function wireAudio() {
  audioEl.addEventListener("play", updatePlayPauseIcon);
  audioEl.addEventListener("pause", updatePlayPauseIcon);
  audioEl.addEventListener("ended", () => playTrack(audioTrack + 1));
  audioEl.addEventListener("timeupdate", () => {
    if (playerMode !== "audio") return;
    const d = audioEl.duration || 0;
    if (d) {
      $<HTMLInputElement>("#pb-seek").value = String(
        Math.round((audioEl.currentTime / d) * 1000),
      );
    }
    $("#pb-cur").textContent = fmtTime(audioEl.currentTime);
    $("#pb-dur").textContent = fmtTime(d);
    window.clearTimeout(audioSaveTimer);
    audioSaveTimer = window.setTimeout(persistAudioPos, 1000);
  });

  const onAudioFiles = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files || [])];
    input.value = "";
    if (!files.length) return;
    if (audioImportTarget === "details" && detailsId) {
      const id = detailsId;
      const names = await storeAudio(id, files);
      audioImportTarget = "play";
      if (names) {
        if (id === currentId) audioNames = names;
        const rec = await getBook(id);
        if (rec) openDetails(rec); // refresh the details page
      }
    } else {
      await importAudio(files);
    }
  };
  $<HTMLInputElement>("#audio-input").addEventListener("change", onAudioFiles);
  $<HTMLInputElement>("#audio-folder-input").addEventListener("change", onAudioFiles);
}

// ---------------------------------------------------------------------------
// Shared player controls (dispatch to TTS or audio by mode)
// ---------------------------------------------------------------------------

function ttsSkip(dir: number) {
  if (!view?.tts) return;
  cancelSpeech();
  const ssml = dir < 0 ? view.tts.prev() : view.tts.next();
  if (ssml) speakSSML(ssml);
}

async function ttsSeekFraction(frac: number) {
  if (!view) return;
  cancelSpeech();
  await view.goToFraction(frac);
  await new Promise((r) => setTimeout(r, 300));
  view.tts = null;
  if (await ensureTTS()) {
    let ssml: string | undefined;
    try {
      ssml = view.tts.from(view.lastLocation.range);
    } catch {
      ssml = view.tts.start();
    }
    speakSSML(ssml);
  }
}

// --- player actions (shared by the on-screen bar AND the Media Session) ---
function playerTogglePlay() {
  if (playerMode === "tts") pauseResumeTTS();
  else if (playerMode === "audio")
    audioEl.paused ? audioEl.play().catch(() => {}) : audioEl.pause();
  updatePlayPauseIcon();
}
function playerBack() {
  if (playerMode === "audio") audioEl.currentTime = Math.max(0, audioEl.currentTime - 10);
  else if (playerMode === "tts") ttsSkip(-1);
}
function playerFwd() {
  if (playerMode === "audio")
    audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 10);
  else if (playerMode === "tts") ttsSkip(1);
}
function playerPrev() {
  if (playerMode === "audio") playTrack(audioTrack - 1);
  else if (playerMode === "tts") ttsSkip(-1);
}
function playerNext() {
  if (playerMode === "audio") playTrack(audioTrack + 1);
  else if (playerMode === "tts") ttsSkip(1);
}
function playerStop() {
  if (playerMode === "tts") stopTTS();
  else {
    persistAudioPos();
    stopAudio();
  }
}

// ---------------------------------------------------------------------------
// Media Session — lets headphone / lock-screen / Bluetooth buttons control us
// ---------------------------------------------------------------------------

const ttsSilence = $<HTMLAudioElement>("#tts-silence");
let silenceReady = false;

// a looping silent track keeps the OS media session alive while TTS speaks
function ensureSilence() {
  if (silenceReady) return;
  const rate = 8000;
  const n = rate; // 1 second
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  ttsSilence.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  silenceReady = true;
}

function setMediaState(playing: boolean) {
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch {
      /* ignore */
    }
  }
}

function setMediaMetadata(chapter: string) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter,
      album: bookTitleEl.textContent || "Reader",
      artist: "Reader",
    });
  } catch {
    /* ignore */
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a: MediaSessionAction, fn: () => void) => {
    try {
      ms.setActionHandler(a, fn);
    } catch {
      /* unsupported action */
    }
  };
  set("play", playerTogglePlay);
  set("pause", playerTogglePlay);
  set("stop", playerStop);
  set("seekbackward", playerBack);
  set("seekforward", playerFwd);
  set("previoustrack", playerPrev);
  set("nexttrack", playerNext);
}

function wirePlayer() {
  wireAudio();
  setupMediaSession();
  $("#pb-play").addEventListener("click", playerTogglePlay);
  $("#pb-back").addEventListener("click", playerBack);
  $("#pb-fwd").addEventListener("click", playerFwd);
  $("#pb-stop").addEventListener("click", playerStop);
  $<HTMLInputElement>("#pb-seek").addEventListener("input", (e) => {
    const frac = Number((e.target as HTMLInputElement).value) / 1000;
    if (playerMode === "audio") {
      const d = audioEl.duration || 0;
      if (d) audioEl.currentTime = frac * d;
    } else if (playerMode === "tts") {
      ttsSeekFraction(frac);
    }
  });

  // compact speed: a pill that opens a small speed menu
  $("#pb-speed-btn").addEventListener("click", openSpeedMenu);
  document.querySelectorAll<HTMLElement>("#speed-menu button").forEach((b) =>
    b.addEventListener("click", () => setSpeed(parseFloat(b.dataset.rate || "1") || 1)),
  );
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.("#speed-menu") && !t.closest?.("#pb-speed-btn")) closeSpeedMenu();
  });
}

function setSpeed(v: number) {
  if (playerMode === "audio") {
    audioRate = v;
    audioEl.playbackRate = v;
    localStorage.setItem("audioRate", String(v));
  } else if (playerMode === "tts") {
    settings.ttsRate = v;
    commit();
    if (ttsPlaying && view?.tts) {
      cancelSpeech();
      speakSSML(view.tts.resume());
    }
  }
  $("#pb-speed-btn").textContent = v + "×";
  closeSpeedMenu();
}

function openSpeedMenu() {
  const m = $("#speed-menu");
  const r = $("#pb-speed-btn").getBoundingClientRect();
  m.hidden = false;
  // anchor above the pill (bar is at the bottom of the screen)
  m.style.bottom = window.innerHeight - r.top + 6 + "px";
  m.style.right = window.innerWidth - r.right + "px";
}
function closeSpeedMenu() {
  $("#speed-menu").hidden = true;
}

// ---------------------------------------------------------------------------
// Play source menu (▶ → Text-to-speech / Audiobook)
// ---------------------------------------------------------------------------

function openPlayMenu() {
  const menu = $("#play-menu");
  const r = $("#btn-tts").getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = r.bottom + 6 + "px";
  menu.style.right = window.innerWidth - r.right + "px";
}
function closePlayMenu() {
  $("#play-menu").hidden = true;
}

// The ▶ toolbar button: pause/resume TTS if it's running, else choose a source.
function onPlayButton() {
  if (ttsActive) {
    pauseResumeTTS();
    return;
  }
  if ($("#play-menu").hidden) openPlayMenu();
  else closePlayMenu();
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function contentCSS(s: Settings): string {
  const c = THEME_COLORS[s.theme];
  let fontRule = "";
  if (isBundled(s.font)) {
    const fam = familyFor(s.font);
    if (fam) fontRule = `font-family: '${fam}', serif !important;`;
  } else if (s.font) {
    fontRule = `font-family: ${s.font} !important;`;
  }
  // In scroll mode, add trailing space after the last line so the end of a
  // section can be scrolled up toward the middle instead of sitting at the
  // very bottom edge. (px, since vh is unreliable inside the sized iframe.)
  const trail =
    s.flow === "scrolled"
      ? `body::after{content:"";display:block;height:${Math.round(
          (viewer.clientHeight || 600) * 0.5,
        )}px;}`
      : "";
  return `
    ${bundledFontFace}
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color: ${c.color};
      background: ${c.bg};
      font-size: ${s.fontSize}%;
    }
    body {
      color: ${c.color};
      background: ${c.bg};
      ${fontRule}
      line-height: ${s.lineHeight};
    }
    p, li, blockquote, dd {
      line-height: ${s.lineHeight};
      text-align: ${s.textAlign};
      -webkit-hyphens: ${s.hyphenate ? "auto" : "manual"};
      hyphens: ${s.hyphenate ? "auto" : "manual"};
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 2;
      /* a word longer than the column still breaks instead of overflowing */
      overflow-wrap: break-word;
    }
    /* don't override an explicit alignment baked into the book */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    a:link, a:visited { color: ${ACCENT}; }
    img { max-width: 100%; height: auto; }
    ::highlight(tts) { background: #ffe08a; color: #111; }
    ${trail}
  `;
}

// @font-face for the currently-selected bundled font (loaded lazily, base64).
let bundledFontFace = "";
async function ensureFontFace() {
  bundledFontFace = isBundled(settings.font)
    ? await fontFaceCSS(settings.font)
    : "";
  applyReaderStyles();
}

function applyReaderStyles() {
  if (!view) return;
  try {
    view.renderer.setStyles?.(contentCSS(settings));
  } catch {
    /* ignore */
  }
}

// Margins are applied to our container (foliate overwrites the book body's
// padding/margin inline with !important, so styling it there has no effect).
function applyMargins() {
  const s = settings;
  viewer.style.padding = `${s.marginTop}px ${s.marginRight}px ${s.marginBottom}px ${s.marginLeft}px`;
}

function applyFlow() {
  try {
    view?.renderer.setAttribute("flow", settings.flow);
  } catch {
    /* ignore */
  }
}

async function openBook(record: BookRecord) {
  stopTTS();
  stopAudio();
  audioNames = await getAudioTracks(record.id);
  audioTrack = 0;
  // tear down any existing view
  if (view) {
    try {
      view.close();
    } catch {
      /* ignore */
    }
    view.remove();
    view = null;
  }
  viewer.innerHTML = "";

  currentId = record.id;
  bookTitleEl.textContent = record.title || "Reader";
  bookmarks = record.bookmarks ?? [];
  annotations = record.annotations ?? [];

  view = document.createElement("foliate-view");
  viewer.append(view);

  const file = new File([record.data], record.fileName || record.title || "book");
  try {
    await view.open(file);
  } catch (e) {
    console.error(e);
    alert("Sorry, this file couldn't be opened.");
    return;
  }

  applyFlow();
  applyReaderStyles();
  applyMargins();
  ensureFontFace();

  setupAnnotations();

  // persist position + progress as the reader moves
  view.addEventListener("relocate", (e: any) => {
    hideSelPopup();
    const { cfi, fraction } = e.detail || {};
    if (cfi) {
      savePos(record.id, cfi);
      persistPosition(cfi, fraction ?? 0);
    }
    updateProgressLabel(fraction ?? 0);
    // when reading aloud, the player bar shows reading progress
    if (playerMode === "tts") {
      const f = fraction ?? 0;
      $<HTMLInputElement>("#pb-seek").value = String(Math.round(f * 1000));
      $("#pb-cur").textContent = Math.round(f * 100) + "%";
    }
  });

  // each loaded section: keys, tap-to-toggle bars, wheel fix, text selection
  view.addEventListener("load", (e: any) => {
    const doc: Document = e.detail.doc;
    const index: number = e.detail.index;
    doc.addEventListener("keyup", onKey);
    doc.addEventListener("pointerup", () => onSelection(index, doc));

    // tap on the page (not a link) toggles the bars in immersive mode
    doc.addEventListener("click", (ev) => {
      const a = (ev.target as HTMLElement)?.closest?.("a");
      if (!a) toggleChrome();
    });

    // WKWebView (Tauri desktop) doesn't chain wheel from the content iframe to
    // foliate's scroll container — forward it manually in scrolled mode.
    if (desktopAvailable) {
      let scroller: HTMLElement | null = null;
      doc.addEventListener(
        "wheel",
        (ev: WheelEvent) => {
          if (settings.flow !== "scrolled") return;
          if (!scroller) {
            const iframe = doc.defaultView?.frameElement as HTMLElement | null;
            scroller = scrollableAncestor(iframe);
          }
          if (scroller) {
            scroller.scrollTop += ev.deltaY;
            scroller.scrollLeft += ev.deltaX;
            ev.preventDefault();
          }
        },
        { passive: false },
      );
    }
  });

  // restore last position (or jump to the start of the text for a new book)
  await view.init({
    lastLocation: loadPos(record.id) || record.cfi || undefined,
    showTextStart: true,
  });

  buildTOC();
  buildBookmarks();
  buildHighlights();
  await setLastOpened(record.id);
  closeOverlays();
  acquireWake();
  applyChromeMode();
}

// Walk up from an element to the nearest scrollable ancestor (works inside
// foliate's shadow DOM since element references cross the boundary).
function scrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let n = el;
  while (n && n.parentElement) {
    n = n.parentElement;
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n;
  }
  return null;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowLeft") view?.goLeft();
  else if (e.key === "ArrowRight") view?.goRight();
  else if (settings.mediaKeys && e.key === "F7") view?.prev();
  else if (settings.mediaKeys && e.key === "F9") view?.next();
}

let saveTimer: number | undefined;
function persistPosition(cfi: string, progress: number) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (!currentId) return;
    const rec = await getBook(currentId);
    if (!rec) return;
    rec.cfi = cfi;
    rec.progress = progress;
    rec.lastOpened = Date.now();
    await saveBook(rec);
  }, 400);
}

function updateProgressLabel(fraction: number) {
  progressLabel.textContent =
    fraction > 0 ? Math.round(fraction * 100) + "%" : "—";
}

// ---------------------------------------------------------------------------
// Metadata helpers (foliate returns language-maps / arrays)
// ---------------------------------------------------------------------------

function formatLangMap(x: any): string {
  if (!x) return "";
  if (typeof x === "string") return x;
  const keys = Object.keys(x);
  return keys.length ? x[keys[0]] : "";
}

function formatContributor(c: any): string {
  if (!c) return "";
  if (Array.isArray(c)) return c.map(formatContributor).filter(Boolean).join(", ");
  if (typeof c === "string") return c;
  return formatLangMap(c.name);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Importing books
// ---------------------------------------------------------------------------

async function importFile(file: File, open = true) {
  await importBytes(file.name, await file.arrayBuffer(), open);
}

async function importBytes(fileName: string, data: ArrayBuffer, open = true) {
  const id = `${fileName}-${data.byteLength}`;

  // already in library? just (optionally) open it
  const existing = await getBook(id);
  if (existing) {
    existing.lastOpened = Date.now();
    await saveBook(existing);
    await refreshLibrary();
    if (open) await openBook(existing);
    return;
  }

  // parse metadata + cover without rendering
  const file = new File([data], fileName);
  let title = fileName.replace(/\.[^.]+$/, "");
  let author = "Unknown";
  let cover: string | undefined;
  try {
    const book: any = await makeBook(file);
    title = formatLangMap(book.metadata?.title) || title;
    author = formatContributor(book.metadata?.author) || "Unknown";
    const blob = await book.getCover?.();
    if (blob) cover = await blobToDataUrl(blob);
  } catch (e) {
    console.error(e);
  }

  const now = Date.now();
  const record: BookRecord = {
    id,
    fileName,
    title,
    author,
    cover,
    data,
    addedAt: now,
    lastOpened: now,
  };
  await saveBook(record);
  await refreshLibrary();
  if (open) await openBook(record);
}

// Open a book by filesystem path (from a file association / "Open with").
async function openPath(path: string) {
  const data = await readFileBytes(path);
  if (!data) return;
  const name = path.split(/[\\/]/).pop() || "book";
  await importBytes(name, data);
}

// ---------------------------------------------------------------------------
// Library UI
// ---------------------------------------------------------------------------

async function refreshLibrary() {
  const books = await listBooks();
  bookGrid.querySelectorAll(".book-card").forEach((n) => n.remove());
  emptyHint.style.display = books.length ? "none" : "block";

  for (const b of books) {
    const card = document.createElement("div");
    card.className = "book-card";
    card.innerHTML = `
      <div class="cover">${
        b.cover
          ? `<img src="${b.cover}" alt="" />`
          : `<span>${escapeHtml(b.title)}</span>`
      }</div>
      <div class="meta">
        <div class="t">${escapeHtml(b.title)}</div>
        <div class="a">${escapeHtml(b.author)}</div>
        <div class="bar"><span style="width:${Math.round((b.progress ?? 0) * 100)}%"></span></div>
      </div>
      <button class="info" title="Details"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg></button>
      <button class="del" title="Remove"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>`;
    card.querySelector(".cover")!.addEventListener("click", () => openBook(b));
    card.querySelector(".meta")!.addEventListener("click", () => openBook(b));
    card.querySelector(".info")!.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetails(b);
    });
    card.querySelector(".del")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`Remove “${b.title}” from library?`)) {
        await deleteBook(b.id);
        await refreshLibrary();
      }
    });
    bookGrid.appendChild(card);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// ---------------------------------------------------------------------------
// Book details page (metadata, chapters, audiobook linking)
// ---------------------------------------------------------------------------

let detailsId: string | null = null;

interface ChapterStat {
  label: string;
  href: string;
  chars: number;
  pages: number;
  startPage: number;
  endPage: number;
}
interface BookStats {
  totalChars: number;
  totalWords: number;
  totalPages: number;
  chapters: ChapterStat[];
}

// Estimate characters per "page" for the CURRENT layout (viewport, font, margins).
function charsPerPage(): number {
  const w = (viewer.clientWidth || 700) - settings.marginLeft - settings.marginRight;
  const h = (viewer.clientHeight || 900) - settings.marginTop - settings.marginBottom;
  const fontPx = 16 * (settings.fontSize / 100);
  const charsPerLine = Math.max(8, w / (fontPx * 0.5)); // ~0.5em per glyph
  const linesPerPage = Math.max(4, h / (fontPx * settings.lineHeight));
  return Math.max(200, Math.round(charsPerLine * linesPerPage));
}

// Read every section's text to count words/chars and paginate per chapter.
async function computeDetails(book: any, toc: any[]): Promise<BookStats> {
  const sections: any[] = book.sections || [];
  const secChars = new Array(sections.length).fill(0);
  let totalChars = 0;
  let totalWords = 0;
  for (let i = 0; i < sections.length; i++) {
    let text = "";
    try {
      const doc = await sections[i].createDocument?.();
      text = doc?.body?.textContent || "";
    } catch {
      /* ignore */
    }
    const clean = text.replace(/\s+/g, " ").trim();
    secChars[i] = clean.length;
    totalChars += clean.length;
    totalWords += clean ? clean.split(" ").length : 0;
  }

  const cpp = charsPerPage();
  const idx = toc.map((c) => {
    try {
      return book.resolveHref?.(c.href)?.index ?? -1;
    } catch {
      return -1;
    }
  });

  let running = 0;
  const chapters: ChapterStat[] = toc.map((c, i) => {
    let start = idx[i];
    if (start == null || start < 0) start = i > 0 ? running && 0 : 0; // fallback
    if (start < 0) start = 0;
    let endExclusive = sections.length;
    for (let j = i + 1; j < toc.length; j++) {
      if (idx[j] >= 0) {
        endExclusive = idx[j];
        break;
      }
    }
    let chars = 0;
    for (let s = start; s < endExclusive; s++) chars += secChars[s] || 0;
    const pages = Math.max(1, Math.ceil(chars / cpp));
    const startPage = running + 1;
    const endPage = running + pages;
    running = endPage;
    return { label: c.label, href: c.href, chars, pages, startPage, endPage };
  });

  const totalPages = running || Math.max(1, Math.ceil(totalChars / cpp));
  return { totalChars, totalWords, totalPages, chapters };
}

async function openDetails(rec: BookRecord) {
  detailsId = rec.id;
  openOverlay(detailsEl);
  const body = $("#details-body");
  body.innerHTML = `<p class="hint">Analysing book…</p>`;
  let meta: any = {};
  let stats: BookStats = { totalChars: 0, totalWords: 0, totalPages: 0, chapters: [] };
  try {
    const book: any = await makeBook(
      new File([rec.data], rec.fileName || rec.title || "book"),
    );
    meta = book.metadata || {};
    stats = await computeDetails(book, book.toc || []);
    book.destroy?.();
  } catch (e) {
    console.error(e);
  }
  if (detailsId !== rec.id) return; // user navigated away while analysing
  const tracks = await getAudioTracks(rec.id);
  renderDetails(rec, meta, stats, tracks);
}

function chaptersHtml(chapters: ChapterStat[], tracks: string[], mapped: boolean): string {
  if (!chapters.length) return `<p class="hint">No chapter list.</p>`;
  return chapters
    .map(
      (c, i) => `
      <button class="d-chapter" data-href="${escapeHtml(c.href || "")}">
        <span class="d-ch-title">${i + 1}. ${escapeHtml((c.label || "").trim() || "—")}</span>
        <span class="d-ch-sub">p. ${c.startPage}–${c.endPage} · ${c.pages} page${
          c.pages > 1 ? "s" : ""
        }${mapped ? ` · 🎧 ${escapeHtml(tracks[i])}` : ""}</span>
      </button>`,
    )
    .join("");
}

function renderDetails(
  rec: BookRecord,
  meta: any,
  stats: BookStats,
  tracks: string[],
) {
  const title = formatLangMap(meta.title) || rec.title;
  const author = formatContributor(meta.author) || rec.author;
  const lang = formatLangMap(meta.language) || "—";
  const publisher = formatLangMap(meta.publisher) || "—";
  const ext = (rec.fileName.split(".").pop() || "").toUpperCase();
  const size = (rec.data.byteLength / 1048576).toFixed(1) + " MB";
  const nChapters = stats.chapters.length;
  const mapped = tracks.length > 0 && tracks.length === nChapters;
  const num = (n: number) => n.toLocaleString();

  const audioStatus = !tracks.length
    ? "No audiobook linked."
    : mapped
      ? `${tracks.length} files · auto-mapped to chapters`
      : tracks.length === 1
        ? "1 file · plays as one track (whole book)"
        : `${tracks.length} files · ${nChapters} chapters (no 1:1 map — plays in order)`;

  $("#details-body").innerHTML = `
    <div class="d-head">
      <div class="d-cover">${
        rec.cover ? `<img src="${rec.cover}" alt="" />` : escapeHtml(title)
      }</div>
      <div class="d-headmeta">
        <div class="d-title">${escapeHtml(title)}</div>
        <div class="d-author">${escapeHtml(author)}</div>
        <div class="d-prog">${Math.round((rec.progress ?? 0) * 100)}% read</div>
      </div>
    </div>

    <button id="d-edit" class="open-btn ghost d-edit-btn">✎ Edit title / author</button>

    <div class="d-rows">
      <div><span>Format</span><b>${ext}</b></div>
      <div><span>Size</span><b>${size}</b></div>
      <div><span>Language</span><b>${escapeHtml(lang)}</b></div>
      <div><span>Publisher</span><b>${escapeHtml(publisher)}</b></div>
      <div><span>Chapters</span><b>${nChapters}</b></div>
      <div><span>Pages</span><b>${num(stats.totalPages)}</b></div>
      <div><span>Words</span><b>${num(stats.totalWords)}</b></div>
      <div><span>Characters</span><b>${num(stats.totalChars)}</b></div>
    </div>
    <p class="d-note">Page counts are estimated for your current font size & margins.</p>

    <h3 class="group mark-head">Audiobook</h3>
    <p class="d-note">${audioStatus}</p>
    ${
      tracks.length
        ? `<button id="d-remove-audio" class="open-btn danger">Remove audiobook</button>`
        : `<button id="d-add-audio" class="open-btn">+ Link audiobook ${
            PLATFORM === "desktop" || PLATFORM === "web" ? "folder" : "files"
          }</button>`
    }

    <h3 class="group mark-head">Chapters</h3>
    <div class="d-chapters">${chaptersHtml(stats.chapters, tracks, mapped)}</div>
  `;

  const body = $("#details-body");
  body.querySelector("#d-edit")?.addEventListener("click", () =>
    renderEditMeta(rec, title, author),
  );
  body.querySelector("#d-add-audio")?.addEventListener("click", () => {
    audioImportTarget = "details";
    if (PLATFORM === "desktop" || PLATFORM === "web") $("#audio-folder-input").click();
    else $("#audio-input").click();
  });
  body.querySelector("#d-remove-audio")?.addEventListener("click", async () => {
    if (!confirm("Remove the linked audiobook?")) return;
    await deleteAudio(rec.id);
    if (rec.id === currentId) {
      audioNames = [];
      stopAudio();
    }
    openDetails(rec);
  });
  body.querySelectorAll<HTMLElement>(".d-chapter").forEach((el) =>
    el.addEventListener("click", async () => {
      const href = el.dataset.href;
      await openBook(rec);
      if (href) window.setTimeout(() => view?.goTo(href).catch(() => {}), 150);
    }),
  );
}

// ---- metadata editor (in-app override + write into the EPUB file) ----
function renderEditMeta(rec: BookRecord, title: string, author: string) {
  const isEpub = (rec.fileName.split(".").pop() || "").toLowerCase() === "epub";
  $("#details-body").innerHTML = `
    <div class="d-edit">
      <label>Title</label>
      <input id="ed-title" class="search-input" value="${escapeHtml(title)}" />
      <label>Author</label>
      <input id="ed-author" class="search-input" value="${escapeHtml(author)}" />
      <p class="d-note">${
        isEpub
          ? "Saved in the app and written into the EPUB file."
          : "Saved in the app (this format can't be rewritten in-file)."
      }</p>
      <div class="d-edit-actions">
        <button id="ed-cancel" class="open-btn ghost">Cancel</button>
        <button id="ed-save" class="open-btn">Save</button>
      </div>
    </div>`;
  $("#ed-cancel").addEventListener("click", () => openDetails(rec));
  $("#ed-save").addEventListener("click", async () => {
    const t = $<HTMLInputElement>("#ed-title").value.trim();
    const a = $<HTMLInputElement>("#ed-author").value.trim();
    await saveMeta(rec, t, a, isEpub);
  });
}

async function saveMeta(rec: BookRecord, title: string, author: string, isEpub: boolean) {
  rec.title = title || rec.title;
  rec.author = author || rec.author;
  if (isEpub) {
    try {
      rec.data = editEpubMetadata(rec.data, title, author);
    } catch (e) {
      console.error(e);
      alert("Couldn't write into the EPUB file — saved in the app only.");
    }
  }
  await saveBook(rec);
  await refreshLibrary();
  openDetails(rec);
}

// Find the OPF path from META-INF/container.xml (fallback: first .opf).
function opfPath(files: Record<string, Uint8Array>): string | null {
  const container = files["META-INF/container.xml"];
  if (container) {
    try {
      const xml = new DOMParser().parseFromString(strFromU8(container), "application/xml");
      const p = xml.querySelector("rootfile")?.getAttribute("full-path");
      if (p) return p;
    } catch {
      /* ignore */
    }
  }
  return Object.keys(files).find((k) => k.toLowerCase().endsWith(".opf")) || null;
}

// Rewrite dc:title / dc:creator in the EPUB's OPF and repack the zip.
function editEpubMetadata(bytes: ArrayBuffer, title: string, author: string): ArrayBuffer {
  const files = unzipSync(new Uint8Array(bytes));
  const path = opfPath(files);
  if (!path || !files[path]) throw new Error("OPF not found");

  const DC = "http://purl.org/dc/elements/1.1/";
  const doc = new DOMParser().parseFromString(strFromU8(files[path]), "application/xml");
  const metadata = doc.querySelector("metadata");
  const setDC = (tag: string, val: string) => {
    if (!val) return;
    let el = doc.getElementsByTagNameNS(DC, tag)[0] as Element | undefined;
    if (!el) {
      el = doc.createElementNS(DC, "dc:" + tag);
      metadata?.appendChild(el);
    }
    el.textContent = val;
  };
  setDC("title", title);
  setDC("creator", author);
  files[path] = strToU8(new XMLSerializer().serializeToString(doc));

  // repack: mimetype MUST be first and stored (uncompressed)
  const ordered: Record<string, [Uint8Array, { level: 0 | 8 }]> = {} as any;
  if (files["mimetype"]) ordered["mimetype"] = [files["mimetype"], { level: 0 }];
  for (const k of Object.keys(files)) {
    if (k !== "mimetype") (ordered as any)[k] = [files[k], { level: 8 }];
  }
  const out = zipSync(ordered as any);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

const ALL_OVERLAYS = [libraryEl, settingsEl, tocEl, searchEl, detailsEl];

function openOverlay(el: HTMLElement) {
  showChrome();
  for (const o of ALL_OVERLAYS) o.classList.toggle("open", o === el);
  scrim.classList.add("show");
}
const openLibrary = () => openOverlay(libraryEl);
const openSettings = () => openOverlay(settingsEl);
const openTOC = () => openOverlay(tocEl);
function openSearch() {
  openOverlay(searchEl);
  setupGotoPlaceholder();
  $<HTMLInputElement>("#search-input").focus();
}
function closeOverlays() {
  for (const o of ALL_OVERLAYS) o.classList.remove("open");
  scrim.classList.remove("show");
}

// ---------------------------------------------------------------------------
// Search & Go to
// ---------------------------------------------------------------------------

let searchScope: "chapter" | "book" = "book";
let searchToken = 0;

function currentIndex(): number {
  try {
    return view?.renderer?.getContents?.()?.[0]?.index ?? 0;
  } catch {
    return 0;
  }
}

async function runSearch(query: string) {
  const results = $("#search-results");
  const count = $("#search-count");
  const token = ++searchToken;
  try {
    view?.clearSearch?.();
  } catch {
    /* ignore */
  }
  query = query.trim();
  if (!view || !query) {
    results.innerHTML = `<p class="hint">Type to search.</p>`;
    count.textContent = "";
    return;
  }
  results.innerHTML = `<p class="hint">Searching…</p>`;
  count.textContent = "";

  const opts: any =
    searchScope === "chapter" ? { query, index: currentIndex() } : { query };
  let n = 0;
  let cleared = false;
  try {
    for await (const r of view.search(opts)) {
      if (token !== searchToken) return; // superseded by a newer search
      if (r === "done") break;
      const items = r.subitems
        ? r.subitems.map((s: any) => ({ ...s, label: r.label }))
        : r.cfi
          ? [r]
          : [];
      for (const it of items) {
        if (!cleared) {
          results.innerHTML = "";
          cleared = true;
        }
        results.appendChild(searchRow(it));
        n++;
        count.textContent = String(n);
        if (n >= 500) {
          // safety cap; avoid runaway lists on common words
          results.appendChild(
            Object.assign(document.createElement("p"), {
              className: "hint",
              textContent: "Showing first 500 matches.",
            }),
          );
          return;
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
  if (token !== searchToken) return;
  if (!n) results.innerHTML = `<p class="hint">No matches.</p>`;
}

function searchRow(item: any): HTMLElement {
  const ex = item.excerpt || {};
  const row = document.createElement("button");
  row.className = "toc-item search-result";
  row.innerHTML =
    `<span class="ex-pre">${escapeHtml(ex.pre || "")}</span>` +
    `<b class="ex-match">${escapeHtml(ex.match || "")}</b>` +
    `<span class="ex-post">${escapeHtml(ex.post || "")}</span>`;
  row.addEventListener("click", () => {
    view?.goTo(item.cfi).catch(() => {});
    closeOverlays();
  });
  return row;
}

// ---- Go to (page number if the book has a page list, else percentage) ----
function flattenPageList(list: any[] | undefined, out: any[] = []): any[] {
  for (const item of list || []) {
    if (item.href) out.push(item);
    if (item.subitems) flattenPageList(item.subitems, out);
  }
  return out;
}

function setupGotoPlaceholder() {
  const pages = flattenPageList(view?.book?.pageList);
  $<HTMLInputElement>("#goto-input").placeholder = pages.length
    ? "Page number"
    : "Position % (0–100)";
}

function goToPosition(value: string) {
  const v = value.trim();
  if (!view || !v) return;
  const pages = flattenPageList(view.book?.pageList);
  if (pages.length) {
    const p = pages.find((x) => String(x.label).trim() === v);
    if (p?.href) {
      view.goTo(p.href).catch(() => {});
      closeOverlays();
      return;
    }
  }
  const num = parseFloat(v);
  if (!isNaN(num)) {
    view.goToFraction(Math.max(0, Math.min(100, num)) / 100);
    closeOverlays();
  }
}

// ---------------------------------------------------------------------------
// Settings wiring
// ---------------------------------------------------------------------------

function applyChrome() {
  document.body.dataset.theme = settings.theme;
}

// Show only the settings groups relevant to the current platform, and hide the
// float (pin) button anywhere it can't work (web / mobile).
function applyPlatformVisibility() {
  document.querySelectorAll<HTMLElement>("[data-platforms]").forEach((el) => {
    const list = (el.dataset.platforms || "").split(/\s+/);
    el.style.display = list.includes(PLATFORM) ? "" : "none";
  });
  // float = always-on-top (desktop) or Picture-in-Picture (Android)
  const float = $("#btn-float");
  float.style.display =
    PLATFORM === "desktop" || PLATFORM === "android" ? "" : "none";
  float.title = PLATFORM === "android" ? "Float (Picture-in-Picture)" : "Float on top";
}

function syncSettingsUI() {
  document
    .querySelectorAll<HTMLElement>("#theme-row .chip")
    .forEach((c) => c.classList.toggle("on", c.dataset.theme === settings.theme));
  document
    .querySelectorAll<HTMLElement>("#flow-row .chip")
    .forEach((c) => c.classList.toggle("on", c.dataset.flow === settings.flow));
  $<HTMLSelectElement>("#font-select").value = settings.font;
  $<HTMLInputElement>("#fontsize").value = String(settings.fontSize);
  $("#fontsize-val").textContent = settings.fontSize + "%";
  $<HTMLInputElement>("#lineheight").value = String(settings.lineHeight);
  $("#lineheight-val").textContent = String(settings.lineHeight);
  document
    .querySelectorAll<HTMLElement>("#align-row .chip")
    .forEach((c) => c.classList.toggle("on", c.dataset.align === settings.textAlign));
  $<HTMLInputElement>("#t-hyphenate").checked = settings.hyphenate;
  const mset = (id: string, val: number) => {
    $<HTMLInputElement>("#" + id).value = String(val);
    $("#" + id + "-val").textContent = val + "px";
  };
  mset("margintop", settings.marginTop);
  mset("marginbottom", settings.marginBottom);
  mset("marginleft", settings.marginLeft);
  mset("marginright", settings.marginRight);

  // reading view ("keep header" only applies when auto-hide is on)
  $<HTMLInputElement>("#t-immersive").checked = settings.immersive;
  const ah = $<HTMLInputElement>("#t-alwaysheader");
  ah.checked = settings.alwaysHeader;
  ah.disabled = !settings.immersive;

  // window
  $<HTMLInputElement>("#t-float").checked = settings.floatOnTop;
  $<HTMLInputElement>("#opacity-active").value = String(
    Math.round(settings.opacityActive * 100),
  );
  $("#opacity-active-val").textContent =
    Math.round(settings.opacityActive * 100) + "%";
  $<HTMLInputElement>("#opacity-inactive").value = String(
    Math.round(settings.opacityInactive * 100),
  );
  $("#opacity-inactive-val").textContent =
    Math.round(settings.opacityInactive * 100) + "%";

  // screen
  $<HTMLInputElement>("#t-keepawake").checked = settings.keepAwake;

  // reading aids
  $<HTMLInputElement>("#t-mediakeys").checked = settings.mediaKeys;
  $<HTMLInputElement>("#t-volume").checked = settings.volumeButtons;

  // tts
  $<HTMLInputElement>("#tts-rate").value = String(settings.ttsRate);
  $("#tts-rate-val").textContent = settings.ttsRate.toFixed(1) + "×";
}

function commit() {
  saveSettings(settings);
  applyChrome();
  syncSettingsUI();
}

function wireUi() {
  $("#btn-toc").addEventListener("click", openTOC);
  $("#btn-search").addEventListener("click", openSearch);
  $("#btn-bookmark").addEventListener("click", addBookmark);
  $("#btn-library").addEventListener("click", openLibrary);

  // --- Search & Go to ---
  $("#btn-close-search").addEventListener("click", closeOverlays);
  let searchTimer: number | undefined;
  const searchInput = $<HTMLInputElement>("#search-input");
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => runSearch(searchInput.value), 300);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      window.clearTimeout(searchTimer);
      runSearch(searchInput.value);
    }
  });
  document.querySelectorAll<HTMLElement>("#search-scope .chip").forEach((c) =>
    c.addEventListener("click", () => {
      searchScope = c.dataset.scope as "chapter" | "book";
      document
        .querySelectorAll<HTMLElement>("#search-scope .chip")
        .forEach((x) => x.classList.toggle("on", x === c));
      if (searchInput.value.trim()) runSearch(searchInput.value);
    }),
  );
  const gotoInput = $<HTMLInputElement>("#goto-input");
  $("#goto-go").addEventListener("click", () => goToPosition(gotoInput.value));
  gotoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goToPosition(gotoInput.value);
  });
  // default search scope
  document
    .querySelectorAll<HTMLElement>("#search-scope .chip")
    .forEach((c) => c.classList.toggle("on", c.dataset.scope === searchScope));
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-close-settings").addEventListener("click", closeOverlays);
  $("#btn-close-toc").addEventListener("click", closeOverlays);
  $("#btn-toc-info").addEventListener("click", async () => {
    if (!currentId) return;
    const rec = await getBook(currentId);
    if (rec) openDetails(rec);
  });
  $("#btn-back-details").addEventListener("click", () => {
    // back to reading if we came from the open book, else to the library
    if (currentId && detailsId === currentId) closeOverlays();
    else openLibrary();
  });
  scrim.addEventListener("click", closeOverlays);

  $("#nav-prev").addEventListener("click", () => view?.goLeft());
  $("#nav-next").addEventListener("click", () => view?.goRight());

  // selection popup: highlight colors / note / copy
  document.querySelectorAll<HTMLElement>("#sel-popup .hl-color").forEach((b) =>
    b.addEventListener("click", () => createHighlight(b.dataset.color || "#ffe08a")),
  );
  $("#sel-note").addEventListener("click", () => {
    const note = prompt("Note:");
    if (note != null) createHighlight("#ffe08a", note);
  });
  $("#sel-copy").addEventListener("click", () => {
    if (selText) navigator.clipboard?.writeText(selText).catch(() => {});
    view?.deselect?.();
    hideSelPopup();
  });

  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = "";
    if (files.length === 1) {
      await importFile(files[0]); // import + open
    } else if (files.length > 1) {
      // import all into the library without opening; stay in the library
      for (const f of files) await importFile(f, false);
      await refreshLibrary();
      openLibrary();
    }
  });

  // theme
  document.querySelectorAll<HTMLElement>("#theme-row .chip").forEach((c) =>
    c.addEventListener("click", () => {
      settings.theme = c.dataset.theme as Settings["theme"];
      commit();
      applyReaderStyles();
    }),
  );

  // flow (scroll vs page) — foliate switches live
  document.querySelectorAll<HTMLElement>("#flow-row .chip").forEach((c) =>
    c.addEventListener("click", () => {
      settings.flow = c.dataset.flow as Settings["flow"];
      commit();
      applyFlow();
    }),
  );

  $<HTMLSelectElement>("#font-select").addEventListener("change", (e) => {
    settings.font = (e.target as HTMLSelectElement).value;
    commit();
    ensureFontFace();
  });

  $<HTMLInputElement>("#fontsize").addEventListener("input", (e) => {
    settings.fontSize = Number((e.target as HTMLInputElement).value);
    commit();
    applyReaderStyles();
  });

  $<HTMLInputElement>("#lineheight").addEventListener("input", (e) => {
    settings.lineHeight = Number((e.target as HTMLInputElement).value);
    commit();
    applyReaderStyles();
  });

  // text alignment
  document.querySelectorAll<HTMLElement>("#align-row .chip").forEach((c) =>
    c.addEventListener("click", () => {
      settings.textAlign = c.dataset.align as Settings["textAlign"];
      commit();
      applyReaderStyles();
    }),
  );

  // hyphenation
  $<HTMLInputElement>("#t-hyphenate").addEventListener("change", (e) => {
    settings.hyphenate = (e.target as HTMLInputElement).checked;
    commit();
    applyReaderStyles();
  });

  const wireMargin = (id: string, key: keyof Settings) => {
    $<HTMLInputElement>("#" + id).addEventListener("input", (e) => {
      (settings[key] as number) = Number((e.target as HTMLInputElement).value);
      commit();
      applyMargins();
    });
  };
  wireMargin("margintop", "marginTop");
  wireMargin("marginbottom", "marginBottom");
  wireMargin("marginleft", "marginLeft");
  wireMargin("marginright", "marginRight");

  // reading view (immersive)
  $<HTMLInputElement>("#t-immersive").addEventListener("change", (e) => {
    settings.immersive = (e.target as HTMLInputElement).checked;
    commit();
    applyChromeMode();
  });
  $<HTMLInputElement>("#t-alwaysheader").addEventListener("change", (e) => {
    settings.alwaysHeader = (e.target as HTMLInputElement).checked;
    commit();
    applyChromeMode();
  });

  // --- Float button: always-on-top (desktop) / Picture-in-Picture (Android) ---
  $("#btn-float").addEventListener("click", () => {
    if (PLATFORM === "android") {
      try {
        (window as any).ReaderNative?.setPipEnabled?.(true);
        (window as any).ReaderNative?.enterPip?.();
      } catch {
        /* ignore */
      }
      return;
    }
    settings.floatOnTop = !settings.floatOnTop;
    commit();
    applyFloat();
  });
  $<HTMLInputElement>("#t-float").addEventListener("change", (e) => {
    settings.floatOnTop = (e.target as HTMLInputElement).checked;
    commit();
    applyFloat();
  });

  // --- Window: focus-based opacity ---
  $<HTMLInputElement>("#opacity-active").addEventListener("input", (e) => {
    settings.opacityActive = Number((e.target as HTMLInputElement).value) / 100;
    commit();
    applyOpacity();
  });
  $<HTMLInputElement>("#opacity-inactive").addEventListener("input", (e) => {
    settings.opacityInactive = Number((e.target as HTMLInputElement).value) / 100;
    commit();
    applyOpacity();
  });

  // --- Screen: keep awake ---
  $<HTMLInputElement>("#t-keepawake").addEventListener("change", (e) => {
    settings.keepAwake = (e.target as HTMLInputElement).checked;
    commit();
    applyWake();
  });

  // --- Reading aids ---
  $<HTMLInputElement>("#t-mediakeys").addEventListener("change", (e) => {
    settings.mediaKeys = (e.target as HTMLInputElement).checked;
    commit();
    setMediaKeys(settings.mediaKeys);
  });
  $<HTMLInputElement>("#t-volume").addEventListener("change", (e) => {
    settings.volumeButtons = (e.target as HTMLInputElement).checked;
    commit();
    applyVolumeNative();
  });

  // --- Play (TTS / Audiobook) ---
  $("#btn-tts").addEventListener("click", onPlayButton);
  $("#menu-tts").addEventListener("click", () => {
    closePlayMenu();
    startTTS();
  });
  $("#menu-audio").addEventListener("click", () => {
    closePlayMenu();
    openAudiobook();
  });
  // close the play menu when clicking elsewhere
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.("#play-menu") && !t.closest?.("#btn-tts")) closePlayMenu();
  });
  wirePlayer();
  $<HTMLSelectElement>("#tts-voice").addEventListener("change", (e) => {
    settings.ttsVoice = (e.target as HTMLSelectElement).value;
    ttsVoiceObj = voices.find((v) => v.voiceURI === settings.ttsVoice) || null;
    commit();
  });
  $<HTMLInputElement>("#tts-rate").addEventListener("input", (e) => {
    settings.ttsRate = Number((e.target as HTMLInputElement).value);
    commit();
  });

  // Android volume keys → page turns (forwarded from native as a DOM event)
  window.addEventListener("reader-volume", (e: Event) => {
    if (!settings.volumeButtons || ttsActive) return;
    const dir = (e as CustomEvent).detail;
    if (dir === "next") view?.next();
    else view?.prev();
  });

  // keyboard nav at the document level (when focus is outside the book iframe)
  document.addEventListener("keyup", onKey);

  // desktop affordance: moving the pointer to the top edge reveals the bars
  document.addEventListener("mousemove", (e) => {
    if (e.clientY < 48) showChrome();
  });

  // clicking the chrome-less reading area (outside the book iframe) also toggles
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) toggleChrome();
  });

  // save exact position before the page is hidden or refreshed
  window.addEventListener("beforeunload", captureNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") captureNow();
    // a screen wake lock is dropped when the page is hidden; re-acquire it
    else acquireWake();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  wireUi();
  applyChrome();
  applyPlatformVisibility();
  syncSettingsUI();

  // Text-to-speech: pick the engine (web on desktop/iOS, native on Android)
  ttsEngine =
    PLATFORM === "android" && nativeTTS()
      ? "native"
      : webTTS
        ? "web"
        : nativeTTS()
          ? "native"
          : "none";
  ttsSupported = ttsEngine !== "none";
  if (!ttsSupported) {
    $("#btn-tts").style.display = "none";
    $("#tts-group").style.display = "none";
  } else {
    if (ttsEngine === "web") {
      loadVoices();
      speechSynthesis.onvoiceschanged = loadVoices;
    } else {
      // native engine: no JS voice list, and word boundaries arrive as events
      const voiceSetting = $("#tts-voice").closest(".setting") as HTMLElement | null;
      if (voiceSetting) voiceSetting.style.display = "none";
      window.addEventListener("tts-boundary", (e) =>
        handleTtsBoundary(parseInt((e as CustomEvent).detail, 10) || 0),
      );
      window.addEventListener("tts-end", () => handleTtsEnd());
    }
    setTtsButton();
  }

  // react to native window focus/blur for the opacity feature
  onFocusChange((focused) => {
    windowFocused = focused;
    applyOpacity();
  });
  // macOS hardware media keys (◀◀/▶▶) → page turns
  onMediaKey((dir) => {
    if (!settings.mediaKeys) return;
    if (dir === "next") view?.next();
    else view?.prev();
  });
  applyDesktopFeatures();

  await refreshLibrary();

  // --- File associations ("Open with Reader") ---
  // react to files opened while the app is already running
  onOpenFile((paths) => paths.forEach((p) => openPath(p)));
  // Android delivers the opened file via a DOM event from native
  window.addEventListener("open-file-android", (e) =>
    openPath((e as CustomEvent).detail),
  );

  // files passed at launch (desktop queue + Android pending)
  const pending = await getPendingFiles();
  const androidPending = (window as any).ReaderNative?.getPendingFile?.();
  if (androidPending) pending.push(androidPending);
  if (pending.length) {
    for (const p of pending) await openPath(p);
    return;
  }

  // otherwise auto-open the last read book
  const lastId = await getLastOpened();
  if (lastId) {
    const rec = await getBook(lastId);
    if (rec) {
      await openBook(rec);
      return;
    }
  }
  openLibrary();
}

boot();
