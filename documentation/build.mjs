// Builds the documentation site: src/*.md (Markdown + Mermaid) -> site/*.html, one page per chapter.
// Diagrams are rendered to inline SVG here (headless Chromium), so the pages need no JavaScript.
//   npm ci && npm run build
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const SRC = join(import.meta.dirname, "src");
const OUT = join(import.meta.dirname, "site");
const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, "../../chat_app/package.json"), "utf8")).version;

const files = readdirSync(SRC)
  .filter((f) => f.endsWith(".md"))
  .sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));
// README.md -> index.html; "01-architecture.md" -> "01-architecture.html" (served as /documentation/01-architecture)
const pageOf = (f) => (f === "README.md" ? "index" : f.replace(/\.md$/, ""));
const docs = files.map((f) => {
  const md = readFileSync(join(SRC, f), "utf8");
  return { f, page: pageOf(f), md, title: (md.match(/^#\s+(.*)$/m) ?? [, f])[1] };
});

const browser = await chromium.launch();
const tab = await browser.newPage();
await tab.setContent("<html><body></body></html>");
await tab.addScriptTag({ path: require.resolve("marked/marked.min.js") });
await tab.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });

const rendered = await tab.evaluate(async (docs) => {
  mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict", flowchart: { htmlLabels: true } });
  let n = 0;
  const out = [];
  for (const d of docs) {
    // Links between chapters: "02-tech-stack.md#x" -> "02-tech-stack#x"; README -> index
    let md = d.md.replace(/\]\((README|\d\d-[a-z0-9-]+)\.md(#[^)]+)?\)/g, (_m, f, h) => `](${f === "README" ? "./" : f}${h ?? ""})`);
    const diagrams = [];
    md = md.replace(/```mermaid\n([\s\S]*?)```/g, (_m, code) => {
      diagrams.push(code);
      return `<div class="diagram" data-i="${diagrams.length - 1}"></div>`;
    });
    let html = marked.parse(md, { gfm: true });
    for (const [i, code] of diagrams.entries()) {
      const { svg } = await mermaid.render(`m${n++}`, code);
      html = html.replace(`<div class="diagram" data-i="${i}"></div>`, `<figure class="diagram">${svg}</figure>`);
    }
    out.push(html);
  }
  return out;
}, docs);
await browser.close();

// Heading anchors, e.g. "13.7 Updating this documentation" -> id "137-updating-this-documentation"
const slug = (t) =>
  t
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
const withAnchors = (html) =>
  html.replace(/<h([1-3])>(.*?)<\/h\1>/g, (_m, l, t) => `<h${l} id="${slug(t)}"><a class="anchor" href="#${slug(t)}">${t}</a></h${l}>`);
// Screenshots open full size; wide tables scroll inside their own box
const polish = (html) =>
  html
    .replace(/<img src="(images\/[^"]+)" alt="([^"]*)">/g, '<a href="$1"><img src="$1" alt="$2" loading="lazy"></a>')
    .replace(/<table>/g, '<div class="table"><table>')
    .replace(/<\/table>/g, "</table></div>");

const nav = (current) =>
  docs
    .map((d) => {
      const label = d.f === "README.md" ? "Overview" : d.title;
      return `<a href="${d.page === "index" ? "./" : d.page}"${d.page === current ? ' aria-current="page"' : ""}>${label}</a>`;
    })
    .join("\n");

const page = (d, i) => {
  const prev = docs[i - 1];
  const next = docs[i + 1];
  const link = (x) => (x.page === "index" ? "./" : x.page);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${d.f === "README.md" ? "H_CHAT documentation" : `${d.title.replace(/<[^>]+>/g, "")} · H_CHAT documentation`}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="./">H<span>_</span>CHAT <small>docs</small></a>
  <span class="version">version ${VERSION}</span>
</header>
<div class="layout">
<nav aria-label="Chapters">
${nav(d.page)}
<form method="post" action="lock"><button type="submit">Lock the documentation</button></form>
</nav>
<main>
${polish(withAnchors(rendered[i]))}
<footer>
  <span>${prev ? `<a href="${link(prev)}">← ${prev.f === "README.md" ? "Overview" : prev.title}</a>` : ""}</span>
  <span>${next ? `<a href="${link(next)}">${next.title} →</a>` : ""}</span>
</footer>
<p class="meta">Built from chat_backend/documentation/src · H_CHAT ${VERSION}</p>
</main>
</div>
</body>
</html>
`;
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
docs.forEach((d, i) => writeFileSync(join(OUT, `${d.page}.html`), page(d, i)));
cpSync(join(SRC, "images"), join(OUT, "images"), { recursive: true });
cpSync(join(import.meta.dirname, "style.css"), join(OUT, "style.css"));
const diagrams = rendered.join("").match(/<svg/g)?.length ?? 0;
console.log(`site/: ${docs.length} pages, ${diagrams} diagrams, version ${VERSION}`);
