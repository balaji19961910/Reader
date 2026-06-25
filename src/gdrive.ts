// ---------------------------------------------------------------------------
// Google Drive sync provider.
//
// Reads/writes a single JSON file in an app-created folder using the
// `drive.file` scope (the app only ever sees files it created — private &
// minimal). Auth differs per platform:
//   web     → Google Identity Services token popup (no secret, ~1h token)   ✅ now
//   desktop → system browser + 127.0.0.1 loopback + PKCE (uses secret)      ⏳ next
//   android → Chrome Custom Tab + custom-scheme redirect + PKCE             ⏳ next
// Drive REST is identical across platforms once we hold an access token.
// ---------------------------------------------------------------------------

import { OAuthClient, SyncProvider, googleClient, registerProvider } from "./cloud";
import { platform } from "./desktop";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const TOK = "gdrive:access";
const EXP = "gdrive:expiry";
const EMAIL = "gdrive:email";
const REFRESH = "gdrive:refresh";

type TokenResp = { access_token: string; refresh_token?: string; expires_in: number };

function storeTokens(t: TokenResp): void {
  if (t.access_token) localStorage.setItem(TOK, t.access_token);
  localStorage.setItem(EXP, String(Date.now() + ((t.expires_in || 3600) - 60) * 1000));
  if (t.refresh_token) localStorage.setItem(REFRESH, t.refresh_token);
}

// --- PKCE (used by the desktop & Android code flows) ----------------------
function b64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const rand = new Uint8Array(32);
  crypto.getRandomValues(rand);
  const verifier = b64url(rand.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

function androidVariant(): "debug" | "release" {
  try {
    return (window as any).ReaderNative?.isDebugBuild?.() ? "debug" : "release";
  } catch {
    return "release";
  }
}

function clientId(): string {
  return googleClient(platform(), androidVariant()).clientId;
}

// --- Web sign-in via Google Identity Services -----------------------------
let gisLoading: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Google sign-in"));
    document.head.appendChild(s);
  });
  return gisLoading;
}

async function webAuth(prompt: "consent" | ""): Promise<void> {
  await loadGis();
  const token: { access_token: string; expires_in: number } = await new Promise(
    (resolve, reject) => {
      const client = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: SCOPE,
        callback: (resp: any) =>
          resp.error ? reject(new Error(resp.error)) : resolve(resp),
        error_callback: (err: any) => reject(new Error(err?.type || "sign-in cancelled")),
      });
      client.requestAccessToken({ prompt });
    },
  );
  localStorage.setItem(TOK, token.access_token);
  localStorage.setItem(EXP, String(Date.now() + (token.expires_in - 60) * 1000));
}

// --- Desktop sign-in: system browser + 127.0.0.1 loopback + PKCE ----------
async function desktopAuth(client: OAuthClient): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { verifier, challenge } = await pkce();
  const t = (await invoke("desktop_oauth", {
    clientId: client.clientId,
    clientSecret: client.clientSecret || "",
    scope: SCOPE,
    challenge,
    verifier,
    authBase: AUTH_BASE,
    tokenUrl: TOKEN_URL,
  })) as TokenResp;
  storeTokens(t);
}

async function desktopRefresh(client: OAuthClient): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const rt = localStorage.getItem(REFRESH);
  if (!rt) throw new Error("Google Drive needs reconnecting");
  const t = (await invoke("oauth_refresh", {
    clientId: client.clientId,
    clientSecret: client.clientSecret || "",
    refreshToken: rt,
    tokenUrl: TOKEN_URL,
  })) as TokenResp;
  storeTokens(t);
  return t.access_token;
}

// --- Android sign-in: Custom Tab + reversed-client-id redirect + PKCE ------
function androidRedirect(id: string): string {
  return `com.googleusercontent.apps.${id.replace(/\.apps\.googleusercontent\.com$/, "")}:/oauth2redirect`;
}

async function androidExchange(
  client: OAuthClient,
  form: Record<string, string>,
): Promise<TokenResp> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.clientId, ...form }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error_description || j.error);
  return j as TokenResp;
}

async function androidAuth(client: OAuthClient): Promise<void> {
  const { verifier, challenge } = await pkce();
  const redirect = androidRedirect(client.clientId);
  const url =
    `${AUTH_BASE}?client_id=${encodeURIComponent(client.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&response_type=code` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  const code: string = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("oauth-code", handler);
      reject(new Error("Sign-in timed out"));
    }, 180000);
    const handler = (e: Event) => {
      clearTimeout(timer);
      window.removeEventListener("oauth-code", handler);
      const detail = String((e as CustomEvent).detail || "");
      const m = /[?&]code=([^&]+)/.exec(detail);
      resolve(m ? decodeURIComponent(m[1]) : detail);
    };
    window.addEventListener("oauth-code", handler);
    try {
      (window as any).ReaderNative.openAuthUrl(url);
    } catch {
      clearTimeout(timer);
      window.removeEventListener("oauth-code", handler);
      reject(new Error("Couldn't open the browser"));
    }
  });

  storeTokens(
    await androidExchange(client, {
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }),
  );
}

async function androidRefresh(client: OAuthClient): Promise<string> {
  const rt = localStorage.getItem(REFRESH);
  if (!rt) throw new Error("Google Drive needs reconnecting");
  const t = await androidExchange(client, {
    refresh_token: rt,
    grant_type: "refresh_token",
  });
  storeTokens(t);
  return t.access_token;
}

// --- token access (refresh transparently per platform) --------------------
async function getAccessToken(): Promise<string> {
  const token = localStorage.getItem(TOK);
  const exp = Number(localStorage.getItem(EXP)) || 0;
  if (token && Date.now() < exp) return token;
  const plat = platform();
  if (plat === "web") {
    await webAuth(""); // silent — reuses prior consent
    return localStorage.getItem(TOK) || "";
  }
  if (plat === "desktop") return desktopRefresh(googleClient(plat));
  if (plat === "android") return androidRefresh(googleClient(plat, androidVariant()));
  throw new Error("Session expired — reconnect Google Drive");
}

async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not signed in to Google Drive");
  // a hard timeout so a stalled mobile request fails loudly instead of hanging
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });
  } catch (e: any) {
    throw new Error(e?.name === "AbortError" ? "Drive request timed out" : "Network error reaching Drive");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    localStorage.removeItem(TOK);
    localStorage.removeItem(EXP);
    throw new Error("Google Drive session expired — reconnect");
  }
  // surface real failures (e.g. 403 = Drive API not enabled) instead of hanging
  if (res.status === 400 || res.status === 403 || res.status >= 500) {
    let detail = "";
    try {
      detail = (await res.clone().json())?.error?.message || "";
    } catch {
      /* ignore */
    }
    throw new Error(`Drive error ${res.status}${detail ? ": " + detail : ""}`);
  }
  return res;
}

// --- Drive REST -----------------------------------------------------------
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// Cache folder path → id so we don't re-query Drive on every single operation
// (huge speed-up on mobile — folder lookups dominated the round-trips).
const folderCache = new Map<string, string>();
function clearFolderCache() {
  folderCache.clear();
}

// Find (or create) a folder by PATH, resolving each level under its parent so
// books live in real, browsable sub-folders.
async function ensureFolder(path: string): Promise<string> {
  const cached = folderCache.get(path);
  if (cached) return cached;
  let parentId: string | null = null;
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    const hit = folderCache.get(acc);
    if (hit) {
      parentId = hit;
      continue;
    }
    const scope = parentId ? `'${parentId}' in parents` : `'root' in parents`;
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and name='${esc(part)}' and ${scope} and trashed=false`,
    );
    const r = await authFetch(`${API}/files?q=${q}&fields=files(id)&spaces=drive`);
    const j = await r.json();
    if (j.files?.length) {
      parentId = j.files[0].id;
    } else {
      const cr = await authFetch(`${API}/files?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: part,
          mimeType: "application/vnd.google-apps.folder",
          ...(parentId ? { parents: [parentId] } : {}),
        }),
      });
      parentId = (await cr.json()).id;
    }
    folderCache.set(acc, parentId as string);
  }
  return parentId as string;
}

async function findFile(folderId: string, filename: string): Promise<string | null> {
  const q = encodeURIComponent(
    `name='${esc(filename)}' and '${folderId}' in parents and trashed=false`,
  );
  const r = await authFetch(`${API}/files?q=${q}&fields=files(id)&spaces=drive`);
  const j = await r.json();
  return j.files?.[0]?.id || null;
}

async function fetchAccount(): Promise<void> {
  try {
    const r = await authFetch(`${API}/about?fields=user`);
    const j = await r.json();
    if (j.user?.emailAddress) localStorage.setItem(EMAIL, j.user.emailAddress);
    else localStorage.setItem(EMAIL, "Google Drive");
  } catch {
    localStorage.setItem(EMAIL, "Google Drive");
  }
}

export const googleDrive: SyncProvider = {
  id: "gdrive",
  name: "Google Drive",

  isConfigured() {
    return !!clientId();
  },
  isConnected() {
    return !!localStorage.getItem(EMAIL);
  },
  account() {
    return localStorage.getItem(EMAIL);
  },

  async connect() {
    const plat = platform();
    const client = googleClient(plat, androidVariant());
    if (!client.clientId) throw new Error(`No Google client id set for ${plat}`);
    if (plat === "web") await webAuth("consent");
    else if (plat === "desktop") await desktopAuth(client);
    else if (plat === "android") await androidAuth(client);
    else throw new Error(`Sign-in unsupported on ${plat}`);
    await fetchAccount();
  },

  async disconnect() {
    const token = localStorage.getItem(TOK);
    try {
      if (token && (window as any).google?.accounts?.oauth2)
        (window as any).google.accounts.oauth2.revoke(token);
    } catch {
      /* ignore */
    }
    localStorage.removeItem(TOK);
    localStorage.removeItem(EXP);
    localStorage.removeItem(EMAIL);
    localStorage.removeItem(REFRESH);
    clearFolderCache();
  },

  async readJson(folder, name): Promise<any | null> {
    const folderId = await ensureFolder(folder);
    const fileId = await findFile(folderId, name);
    if (!fileId) return null;
    const r = await authFetch(`${API}/files/${fileId}?alt=media`);
    if (!r.ok) return null;
    try {
      return await r.json();
    } catch {
      return null;
    }
  },

  async writeJson(folder, name, obj): Promise<void> {
    await this.uploadFile(folder, name, new Blob([JSON.stringify(obj)]), "application/json");
  },

  // Create-or-update a binary file (book/audio bytes or a JSON blob).
  async uploadFile(folder, name, blob, mime): Promise<void> {
    const folderId = await ensureFolder(folder);
    let fileId = await findFile(folderId, name);
    if (!fileId) {
      const cr = await authFetch(`${API}/files?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parents: [folderId] }),
      });
      fileId = (await cr.json()).id;
    }
    await authFetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mime || "application/octet-stream" },
      body: blob,
    });
  },

  async downloadFile(folder, name): Promise<ArrayBuffer | null> {
    const folderId = await ensureFolder(folder);
    const fileId = await findFile(folderId, name);
    if (!fileId) return null;
    const r = await authFetch(`${API}/files/${fileId}?alt=media`);
    if (!r.ok) return null;
    return r.arrayBuffer();
  },

  async listFiles(folder): Promise<{ id: string; name: string }[]> {
    const folderId = await ensureFolder(folder);
    const out: { id: string; name: string }[] = [];
    let pageToken: string | undefined;
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const url =
        `${API}/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const r = await authFetch(url);
      const j = await r.json();
      out.push(...(j.files || []));
      pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  },

  async deleteFile(folder, name): Promise<void> {
    const folderId = await ensureFolder(folder);
    const fileId = await findFile(folderId, name);
    if (fileId) await authFetch(`${API}/files/${fileId}`, { method: "DELETE" });
  },

  // Server-side move: only the file's parent changes, the bytes stay in place.
  // No download/re-upload — instant regardless of file size.
  async moveFile(fromFolder, name, toFolder): Promise<boolean> {
    const fromId = await ensureFolder(fromFolder);
    const fileId = await findFile(fromId, name);
    if (!fileId) return false;
    const toId = await ensureFolder(toFolder);
    if (toId === fromId) return true;
    await authFetch(
      `${API}/files/${fileId}?addParents=${toId}&removeParents=${fromId}&fields=id`,
      { method: "PATCH" },
    );
    clearFolderCache();
    return true;
  },

  // Reparent a whole sub-folder (e.g. a book's audio folder) — also bytes-free.
  async moveFolder(fromFolder, folderName, toFolder): Promise<boolean> {
    const fromId = await ensureFolder(fromFolder);
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and name='${esc(folderName)}' and '${fromId}' in parents and trashed=false`,
    );
    const r = await authFetch(`${API}/files?q=${q}&fields=files(id)&spaces=drive`);
    const id = (await r.json()).files?.[0]?.id;
    if (!id) return false;
    const toId = await ensureFolder(toFolder);
    if (toId === fromId) return true;
    await authFetch(
      `${API}/files/${id}?addParents=${toId}&removeParents=${fromId}&fields=id`,
      { method: "PATCH" },
    );
    clearFolderCache();
    return true;
  },
};

export function registerGoogleDrive(): void {
  registerProvider(googleDrive);
}
