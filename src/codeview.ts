// ---------------------------------------------------------------------------
// Universal text / code viewer.
//
// Opens any plain-text or source file in a CodeMirror editor (syntax-highlighted,
// editable). Markdown and HTML additionally get a "Rendered" view. This is just a
// viewer/editor — saving is handled by the caller (back into the library or a
// download).
// ---------------------------------------------------------------------------

import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { marked } from "marked";

// Extensions we treat as editable text rather than a "book".
const TEXT_EXT = new Set([
  "txt", "text", "log", "md", "markdown", "mdown", "rst",
  "html", "htm", "xml", "xhtml", "svg", "json", "jsonc", "json5",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "scss", "sass", "less",
  "py", "rb", "php", "java", "kt", "kts", "c", "h", "cpp", "cc", "cxx", "hpp",
  "cs", "go", "rs", "swift", "scala", "dart", "lua", "r", "pl", "pm",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties",
  "sql", "graphql", "gql", "vue", "svelte", "astro", "gradle",
  "csv", "tsv", "diff", "patch", "tex", "bib",
]);
const TEXT_NAMES = /^(makefile|dockerfile|readme|license|changelog|\.gitignore|\.env)$/i;

export function isTextFile(name: string): boolean {
  const base = name.split(/[\\/]/).pop() || name;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return TEXT_EXT.has(ext) || TEXT_NAMES.test(base);
}

export type ViewKind = "code" | "markdown" | "html";
export function viewKind(name: string): ViewKind {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "mdown") return "markdown";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  return "code";
}

let editor: EditorView | null = null;

// Mount an editable CodeMirror with the right language for this file name.
export async function mountCode(
  container: HTMLElement,
  text: string,
  fileName: string,
): Promise<void> {
  destroyCode();
  let langExt: any[] = [];
  try {
    const desc = LanguageDescription.matchFilename(languages, fileName);
    if (desc) langExt = [(await desc.load())];
  } catch {
    /* unknown language — plain text is fine */
  }
  editor = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [basicSetup, EditorView.lineWrapping, ...langExt],
    }),
    parent: container,
  });
}

export function getCode(): string {
  return editor ? editor.state.doc.toString() : "";
}

export function destroyCode(): void {
  editor?.destroy();
  editor = null;
}

// Render markdown / html into a sandboxed iframe (no script execution, isolated).
export function renderInto(iframe: HTMLIFrameElement, text: string, kind: ViewKind): void {
  let html: string;
  if (kind === "markdown") {
    const body = marked.parse(text, { async: false }) as string;
    html = `<!doctype html><meta charset="utf-8"><style>
      body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        max-width:46rem;margin:0 auto;padding:24px;color:#1a1a1a;background:#fff;}
      pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto;}
      code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em;}
      img{max-width:100%;} table{border-collapse:collapse;} td,th{border:1px solid #ddd;padding:6px;}
      a{color:#2563eb;} blockquote{border-left:3px solid #ddd;margin:0;padding-left:14px;color:#555;}
    </style><body>${body}`;
  } else {
    html = text; // raw HTML document
  }
  iframe.srcdoc = html;
}
