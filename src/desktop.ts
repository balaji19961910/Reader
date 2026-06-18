// Thin wrappers around Tauri desktop-only window features.
// Safe to import everywhere: every call no-ops when Tauri isn't present
// (e.g. plain browser via `npm run dev`).

export const desktopAvailable =
  typeof window !== "undefined" && "__TAURI__" in window;

export type Platform = "desktop" | "android" | "ios" | "web";

export function platform(): Platform {
  const ua = navigator.userAgent;
  const isAndroid = /android/i.test(ua);
  const isIOS =
    /iphone|ipad|ipod/i.test(ua) ||
    (/Macintosh/.test(ua) && "ontouchend" in document);
  if (isAndroid) return "android";
  if (isIOS) return "ios";
  return desktopAvailable ? "desktop" : "web";
}

async function call(cmd: string, args?: Record<string, unknown>): Promise<void> {
  if (!desktopAvailable) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(cmd, args);
  } catch {
    /* ignore — feature simply unavailable here */
  }
}

export function setAlwaysOnTop(on: boolean): Promise<void> {
  return call("set_always_on_top", { on });
}

export function setWindowOpacity(opacity: number): Promise<void> {
  return call("set_window_opacity", { opacity });
}

// Toggle the macOS hardware media-key (◀◀/▶▶) page-turn monitor.
export function setMediaKeys(on: boolean): Promise<void> {
  return call("set_media_keys", { on });
}

// Fired (macOS) when a hardware media key is pressed: payload "prev" | "next".
export async function onMediaKey(cb: (dir: string) => void): Promise<void> {
  if (!desktopAvailable) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("media-key", (e) => cb(e.payload));
  } catch {
    /* ignore */
  }
}

// Files the OS queued for us to open (desktop launch-with-file).
export async function getPendingFiles(): Promise<string[]> {
  if (!desktopAvailable) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("get_pending_files");
  } catch {
    return [];
  }
}

// Read a file's bytes via Rust (returns an ArrayBuffer). Works on desktop+Android.
export async function readFileBytes(path: string): Promise<ArrayBuffer | null> {
  if (!desktopAvailable) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ArrayBuffer>("read_file_bytes", { path });
  } catch (e) {
    console.error(e);
    return null;
  }
}

// Fired when a file is opened while the app is already running (macOS).
export async function onOpenFile(cb: (paths: string[]) => void): Promise<void> {
  if (!desktopAvailable) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string[]>("open-file", (e) => cb(e.payload));
  } catch {
    /* ignore */
  }
}

// Subscribe to native window focus/blur. No-op (and never calls back) off Tauri.
export async function onFocusChange(cb: (focused: boolean) => void): Promise<void> {
  if (!desktopAvailable) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onFocusChanged(({ payload }) => cb(payload));
  } catch {
    /* ignore */
  }
}
