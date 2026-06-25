#!/usr/bin/env node
//
// Reader version manager — run by release/release.sh before each build.
//
// Scheme: MAJOR.MINOR.PATCH  (e.g. 1.4.7)
//   MAJOR  — a drastic rewrite. Bump by hand: `--major` or `--set 2.0.0`.
//   MINOR  — "major changes on this version". Bump by hand: `--minor`.
//   PATCH  — the bug-fix counter. Auto-incremented on every release that sits
//            on a NEW commit. Running release.sh twice on the SAME commit
//            changes nothing — the version is keyed to the commit it was cut
//            from (release/version.json → lastCommit).
//
// State lives in release/version.json (the source of truth). Each run rewrites
// the version into package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml
// and src/version.ts (consumed by the in-app Help page), and records the
// release notes harvested from `git log` since the previous release.
//
// Usage:
//   node release/version.mjs            # auto: patch++ iff HEAD changed
//   node release/version.mjs --minor    # y+1, x=0   (a feature drop)
//   node release/version.mjs --major    # major+1, y=0, x=0
//   node release/version.mjs --set 2.3.0
//
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, "release", "version.json");
const sh = (c) => execSync(c, { cwd: ROOT }).toString().trim();

// Files this script itself rewrites on every bump. A commit that touches ONLY
// these is a "version-only" commit — it must NOT count as new work, otherwise
// committing the bump would trigger another bump on the next release.
const VERSION_FILES = [
  "release/version.json",
  "src/version.ts",
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock", // the package version propagates here too
];
const EXCLUDE = VERSION_FILES.map((f) => `':(exclude)${f}'`).join(" ");

// --- where we are in git ---
// The newest commit that changed something OTHER than the version files. This
// is the identity we key bumps off, so version-only commits are transparent.
const contentSha = sh(`git log -1 --pretty=%H -- . ${EXCLUDE}`) || sh("git rev-parse HEAD");
const contentShort = contentSha.slice(0, 7);

// --- parse args ---
let mode = "auto";
let setVer = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--minor") mode = "minor";
  else if (a === "--major") mode = "major";
  else if (a === "--set") { mode = "set"; setVer = argv[++i]; }
  else if (a.startsWith("--set=")) { mode = "set"; setVer = a.slice(6); }
}

// --- load (or seed) state ---
const state = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, "utf8"))
  : { version: "1.0.0", lastCommit: "", releases: [] };
const prevCommit = state.lastCommit || "";
const [maj, min, pat] = state.version.split(".").map(Number);

// --- decide the new version ---
let version = state.version;
let changed = true;

if (mode === "set") {
  if (!/^\d+\.\d+\.\d+$/.test(setVer || "")) {
    console.error("✗ --set needs a version like 2.3.0");
    process.exit(1);
  }
  version = setVer;
} else if (mode === "minor") {
  version = `${maj}.${min + 1}.0`;
} else if (mode === "major") {
  version = `${maj + 1}.0.0`;
} else {
  // auto
  if (!prevCommit) {
    version = state.version; // first release ever — adopt current version as-is
  } else if (contentSha === prevCommit) {
    changed = false; // no real work since last release (version-only commits ignored)
  } else {
    version = `${maj}.${min}.${pat + 1}`; // new content commit → bug-fix bump
  }
}

if (!changed) {
  console.log(`• Version unchanged (${version}) — no new commits since ${contentShort} (version-only commits are ignored).`);
  process.exit(0);
}

// --- release notes: subjects of real-work commits added since the last release ---
let notes = [];
try {
  const raw = prevCommit
    ? sh(`git log ${prevCommit}..${contentSha} --no-merges --pretty=format:%s -- . ${EXCLUDE}`)
    : sh(`git log -8 --no-merges --pretty=format:%s -- . ${EXCLUDE}`);
  notes = raw.split("\n").map((s) => s.trim()).filter(Boolean);
} catch {
  /* shallow clone / detached weirdness — fall through */
}
if (!notes.length) notes = [sh(`git log -1 --pretty=%s ${contentSha}`)]; // manual bump, no new commits

const date = new Date().toISOString().slice(0, 10);

// --- 1) persist state ---
const release = { version, commit: contentShort, date, notes };
state.version = version;
state.lastCommit = contentSha;
state.releases = (state.releases || []).filter((r) => r.version !== version);
state.releases.unshift(release);
writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");

// --- 2) stamp the manifests (replace the first version line, keep formatting) ---
const patch = (file, re, repl) => {
  const p = join(ROOT, file);
  const before = readFileSync(p, "utf8");
  const after = before.replace(re, repl);
  if (before !== after) writeFileSync(p, after);
  else console.warn(`⚠ ${file}: version line not found — left untouched`);
};
patch("package.json", /"version":\s*"[^"]*"/, `"version": "${version}"`);
patch("src-tauri/tauri.conf.json", /"version":\s*"[^"]*"/, `"version": "${version}"`);
patch("src-tauri/Cargo.toml", /^version = "[^"]*"/m, `version = "${version}"`);

// --- 3) generate src/version.ts for the in-app Help page ---
const ts = `// AUTO-GENERATED by release/version.mjs — do not edit by hand.
export const APP_VERSION = "${version}";
export const APP_BUILD_DATE = "${date}";
export const APP_COMMIT = "${contentShort}";
export const RELEASE_NOTES: string[] = ${JSON.stringify(notes, null, 2)};
`;
writeFileSync(join(ROOT, "src", "version.ts"), ts);

// --- summary ---
console.log(`✓ Version ${version}  (commit ${contentShort}, ${date})`);
notes.forEach((n) => console.log(`   • ${n}`));
