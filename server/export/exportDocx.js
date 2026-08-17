// Render a book's translation (from project.json) into a KDP-ready ebook .docx:
// title page, one chapter/story per page (page break + optional illustration +
// Heading 1 so Kindle builds its navigation), justified body with first-line
// indents, "* * *" scene breaks, Times New Roman, straight apostrophes.
// Per-chapter illustrations are embedded when found in the book's art folder.
import fs from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } from "docx";
import { Jimp } from "jimp";
import { loadProject, dataDir } from "../store.js";
import { languagesFor, imprint } from "../config.js";
import { bookById } from "../registry.js";

const FONT_DEFAULT = "Times New Roman";

// Optional per-chapter art: drop hf_<chapterId>.png/jpg (and hf_cover.*) into
// data/<book>/art/ and they are embedded automatically.
const artDir = (bookId) => path.join(dataDir(bookId), "art");

const straight = (s) => String(s || "")
  .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"');

function run(text, FONT, o = {}) {
  return new TextRun({ text: straight(text), font: FONT, size: o.size || 24, bold: o.bold, italics: o.italics, color: o.color });
}

// --- image helpers (no extra deps: read PNG/JPEG dimensions from the header) ---
function imageDims(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) // PNG
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) { // JPEG
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xFF) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}
function findFile(dir, re) {
  let out = null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, re); if (r) return r; }
    else if (re.test(e.name)) return p;
    if (out) break;
  }
  return null;
}
function artFile(bookId, baseName) {
  const dir = artDir(bookId);
  if (!dir || !fs.existsSync(dir)) return null;
  const hit = findFile(dir, new RegExp(`^${baseName}\\.(png|jpe?g)$`, "i"));
  if (!hit) return null;
  const ext = hit.split(".").pop().toLowerCase();
  return { path: hit, type: ext === "png" ? "png" : "jpg" };
}
const imageForChapter = (bookId, chapterId) => artFile(bookId, `hf_${chapterId}`);
const coverImage = (bookId) => artFile(bookId, "hf_cover");

async function imageParagraph(img, opts = {}) {
  const { pageBreakBefore = false, maxW = 460, maxH = 620 } = opts;
  const raw = fs.readFileSync(img.path);
  const d = imageDims(raw) || { width: 800, height: 600 };
  const ds = Math.min(maxW / d.width, maxH / d.height, 1);
  const dispW = Math.round(d.width * ds), dispH = Math.round(d.height * ds);
  // downscale + recompress the actual pixels so the ebook is KDP-friendly (a
  // 10 MB PNG → ~0.4 MB JPEG), which keeps the delivery fee low.
  let data = raw, type = img.type;
  try {
    const image = await Jimp.read(raw);
    const px = 1400; // longest embedded pixel side
    const s = Math.min(px / image.width, px / image.height, 1);
    if (s < 1) image.resize({ w: Math.round(image.width * s), h: Math.round(image.height * s) });
    data = await image.getBuffer("image/jpeg", { quality: 82 });
    type = "jpg";
  } catch { /* fall back to the original bytes */ }
  return new Paragraph({
    alignment: AlignmentType.CENTER, pageBreakBefore: !!pageBreakBefore, spacing: { after: 200 },
    children: [new ImageRun({ type, data, transformation: { width: dispW, height: dispH } })],
  });
}

export async function exportDocx(bookId) {
  const project = loadProject(bookId);
  const FONT = project.book.deliveryFont || FONT_DEFAULT;
  const author = project.book.author || "";
  const langs = languagesFor(bookById(bookId) || project.book);
  // titleTarget/titleSource are the current keys; titleEn/titleCs still read for older projects.
  const titleTarget = project.book.titleTarget || project.book.titleEn || "Untitled";
  const titleSource = project.book.titleSource || project.book.titleCs || "";
  const translatedLine = `Translated from the ${langs.source.name}`;
  const imprintName = imprint();
  const P = (text, o = {}) => new Paragraph({ alignment: o.align, spacing: { before: o.before || 0, after: o.after ?? 160, line: o.line }, indent: o.indent, children: [run(text, FONT, o)] });

  const children = [];

  // --- Cover / title page (page 1) ---
  const cover = coverImage(bookId);
  if (cover) {
    children.push(await imageParagraph(cover, { maxW: 450, maxH: 520 }));
    children.push(P(titleTarget, { align: AlignmentType.CENTER, size: 44, bold: true, before: 140, after: 110 }));
    if (titleSource) children.push(P(titleSource, { align: AlignmentType.CENTER, size: 24, italics: true, after: 110 }));
    if (author) children.push(P(author, { align: AlignmentType.CENTER, size: 26, after: 80 }));
    children.push(P([translatedLine, author && `© ${author}`, imprintName].filter(Boolean).join("  ·  "), { align: AlignmentType.CENTER, size: 16, color: "808080", before: 140 }));
  } else {
    children.push(new Paragraph({ spacing: { before: 2600 }, children: [] }));
    children.push(P(titleTarget, { align: AlignmentType.CENTER, size: 52, bold: true, after: 140 }));
    if (titleSource) children.push(P(titleSource, { align: AlignmentType.CENTER, size: 26, italics: true, after: 320 }));
    if (author) children.push(P(author, { align: AlignmentType.CENTER, size: 26, after: 100 }));
    children.push(P(translatedLine, { align: AlignmentType.CENTER, size: 22, italics: true }));
    const copyLine = [author && `© ${author}`, imprintName && `Published by ${imprintName}`].filter(Boolean).join("  ·  ");
    if (copyLine) children.push(P(copyLine, { align: AlignmentType.CENTER, size: 18, color: "808080", before: 700 }));
  }

  let bodyCount = 0, emptyCount = 0;
  for (const ch of project.chapters) {
    const segs = project.targetSegments.filter((s) => s.chapterId === ch.id);
    const hasBody = segs.some((s) => (s.kind === "body" || s.kind === "blockquote") && (s.targetText || "").trim());
    if (!hasBody) { // count what we skipped, don't emit an empty chapter
      emptyCount += segs.filter((s) => s.kind === "body" && !(s.targetText || "").trim()).length;
      continue;
    }

    const heading = segs.find((s) => s.kind === "heading");
    const titleText = (heading?.targetText || ch.label || "").trim();
    const img = imageForChapter(bookId, ch.id);

    if (img) children.push(await imageParagraph(img, { pageBreakBefore: true }));
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER,
      pageBreakBefore: !img, spacing: { before: img ? 120 : 0, after: 280 },
      children: [run(titleText, FONT, { size: 34, bold: true })],
    }));

    let sawMarker = false;
    for (const s of segs) {
      if (s.kind === "heading") continue;
      const t = (s.targetText || "").trim();
      if (s.kind === "label") {
        if (/^\d+\.?$/.test(t)) { // numeric section marker -> scene break (skip the first)
          if (!sawMarker) { sawMarker = true; continue; }
          children.push(P("* * *", { align: AlignmentType.CENTER, before: 260, after: 260, size: 24 }));
        } else if (t) {
          children.push(P(t, { align: AlignmentType.CENTER, italics: true, size: 22, after: 140 }));
        }
        continue;
      }
      if (!t) { emptyCount++; continue; }
      if (s.kind === "blockquote") children.push(P(t, { italics: true, align: AlignmentType.CENTER, before: 140, after: 140 }));
      else children.push(P(t, { align: AlignmentType.JUSTIFIED, after: 120, line: 276, indent: { firstLine: 360 } }));
      bodyCount++;
    }
  }

  const doc = new Document({
    creator: "BookTranslator", title: titleTarget, description: "Ebook export",
    sections: [{ properties: {}, children }],
  });
  const buf = await Packer.toBuffer(doc);

  const dir = path.join(dataDir(bookId), "exports");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${bookId}_ebook_${ts}.docx`);
  fs.writeFileSync(file, buf);
  return { file, bodyCount, emptyCount };
}
