// Render a book's translation into a valid EPUB 3 — no dependencies.
// EPUB is a ZIP with a strict layout; we write a minimal store-only (uncompressed)
// ZIP by hand, which the spec explicitly allows and every reader accepts.
import fs from "node:fs";
import path from "node:path";
import { loadProject, dataDir } from "../store.js";
import { languagesFor } from "../config.js";
import { bookById } from "../registry.js";

/* ---------------- minimal store-only ZIP writer ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data (Buffer|string) }] — order preserved (mimetype must be first).
function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf-8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // local file header
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(0, 8);           // method: store
    local.writeUInt32LE(0, 10);          // dos time/date (fixed → reproducible)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ---------------- EPUB assembly ---------------- */
const escXml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

const CSS = `body{font-family:serif;line-height:1.5;margin:1em}h1{text-align:center;margin:1.5em 0 1em}p{text-indent:1.3em;margin:0 0 .2em;text-align:justify}p.noindent{text-indent:0}p.scene{text-align:center;text-indent:0;margin:1em 0}blockquote{font-style:italic;text-align:center;margin:1em 2em}.titlepage{text-align:center;margin-top:30%}.titlepage h1{font-size:1.9em}.titlepage .src{font-style:italic}.titlepage .meta{color:#666;font-size:.85em;margin-top:3em}`;

function xhtml(title, bodyInner, lang) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escXml(lang)}" lang="${escXml(lang)}">
<head><meta charset="utf-8"/><title>${escXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${bodyInner}</body></html>`;
}

export async function exportEpub(bookId) {
  const project = loadProject(bookId);
  const langs = languagesFor(bookById(bookId) || project.book);
  const lang = langs.target.code || "en";
  const title = project.book.titleTarget || project.book.titleEn || "Untitled";
  const titleSource = project.book.titleSource || project.book.titleCs || "";
  const author = project.book.author || "";
  const uid = `booktranslator:${bookId}:${Date.now()}`;

  const straight = (s) => String(s || "").replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"');

  // --- chapters with content (same skip rules as the docx export) ---
  const chapters = [];
  let bodyCount = 0, emptyCount = 0;
  for (const ch of project.chapters) {
    const segs = project.targetSegments.filter((s) => s.chapterId === ch.id);
    const hasBody = segs.some((s) => (s.kind === "body" || s.kind === "blockquote") && (s.targetText || "").trim());
    if (!hasBody) { emptyCount += segs.filter((s) => s.kind === "body" && !(s.targetText || "").trim()).length; continue; }
    const heading = segs.find((s) => s.kind === "heading");
    const chTitle = (heading?.targetText || ch.label || "").trim();
    const parts = [`<h1>${escXml(chTitle)}</h1>`];
    let sawMarker = false, first = true;
    for (const s of segs) {
      if (s.kind === "heading") continue;
      const t = straight((s.targetText || "").trim());
      if (s.kind === "label") {
        if (/^\d+\.?$/.test(t)) { if (!sawMarker) { sawMarker = true; continue; } parts.push(`<p class="scene">* * *</p>`); first = true; }
        else if (t) { parts.push(`<p class="scene">${escXml(t)}</p>`); first = true; }
        continue;
      }
      if (!t) { emptyCount++; continue; }
      if (s.kind === "blockquote") { parts.push(`<blockquote>${escXml(t)}</blockquote>`); first = true; }
      else { parts.push(`<p${first ? ' class="noindent"' : ""}>${escXml(t)}</p>`); first = false; bodyCount++; }
    }
    chapters.push({ id: ch.id, title: chTitle, html: xhtml(chTitle, parts.join("\n"), lang) });
  }
  if (!chapters.length) throw new Error("Nothing translated yet — translate at least one chapter first.");

  // --- title page + nav + opf ---
  const titlePage = xhtml(title, `<div class="titlepage"><h1>${escXml(title)}</h1>
${titleSource ? `<p class="src">${escXml(titleSource)}</p>` : ""}
${author ? `<p>${escXml(author)}</p>` : ""}
<p class="meta">Translated from the ${escXml(langs.source.name)}</p></div>`, lang);

  const nav = xhtml("Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${chapters.map((c) => `<li><a href="${c.id}.xhtml">${escXml(c.title)}</a></li>`).join("\n")}
</ol></nav>`, lang);

  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    `<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>`,
    ...chapters.map((c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`),
  ].join("\n    ");
  const spine = [`<itemref idref="titlepage"/>`, ...chapters.map((c) => `<itemref idref="${c.id}"/>`)].join("\n    ");

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${escXml(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${escXml(uid)}</dc:identifier>
    <dc:title>${escXml(title)}</dc:title>
    <dc:language>${escXml(lang)}</dc:language>
    ${author ? `<dc:creator>${escXml(author)}</dc:creator>` : ""}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const zip = zipStore([
    { name: "mimetype", data: "application/epub+zip" }, // MUST be first & stored
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/nav.xhtml", data: nav },
    { name: "OEBPS/style.css", data: CSS },
    { name: "OEBPS/titlepage.xhtml", data: titlePage },
    ...chapters.map((c) => ({ name: `OEBPS/${c.id}.xhtml`, data: c.html })),
  ]);

  const dir = path.join(dataDir(bookId), "exports");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${bookId}_ebook_${ts}.epub`);
  fs.writeFileSync(file, zip);
  return { file, bodyCount, emptyCount, chapters: chapters.length };
}
