// Bundled open-source reading fonts (OFL). The woff2 files are imported as URLs
// by Vite, then loaded once and inlined as base64 @font-face into the book
// iframe — inlining avoids cross-origin font loading issues in the webview.
import literataUrl from "./fonts/literata.woff2";
import atkinsonUrl from "./fonts/atkinson.woff2";
import opendyslexicUrl from "./fonts/opendyslexic.woff2";

export interface BundledFont {
  key: string; // selector value, e.g. "bundled:literata"
  label: string; // shown in the dropdown
  family: string; // CSS font-family name we register
  url: string;
}

export const BUNDLED_FONTS: BundledFont[] = [
  { key: "bundled:literata", label: "Literata", family: "ReaderLiterata", url: literataUrl },
  {
    key: "bundled:atkinson",
    label: "Atkinson Hyperlegible",
    family: "ReaderAtkinson",
    url: atkinsonUrl,
  },
  {
    key: "bundled:opendyslexic",
    label: "OpenDyslexic",
    family: "ReaderOpenDyslexic",
    url: opendyslexicUrl,
  },
];

export function isBundled(key: string): boolean {
  return key.startsWith("bundled:");
}

export function familyFor(key: string): string | null {
  return BUNDLED_FONTS.find((f) => f.key === key)?.family ?? null;
}

const cache = new Map<string, string>();

// Returns an @font-face rule (with the font inlined as base64) for a bundled key.
export async function fontFaceCSS(key: string): Promise<string> {
  const font = BUNDLED_FONTS.find((f) => f.key === key);
  if (!font) return "";
  let dataUri = cache.get(font.key);
  if (!dataUri) {
    const buf = await (await fetch(font.url)).arrayBuffer();
    dataUri = "data:font/woff2;base64," + bytesToBase64(new Uint8Array(buf));
    cache.set(font.key, dataUri);
  }
  return `@font-face{font-family:'${font.family}';src:url('${dataUri}') format('woff2');font-display:swap;}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
