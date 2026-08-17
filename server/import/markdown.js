// Parse a translation Markdown file (prolog.md / chNN_us.md) into structured blocks.
// The notation, invented by the translator, is:
//   **bold**            -> an uncertain span
//   *(alt: A / B — why)*-> alternatives + reasoning attached to the preceding bold
//   *(Note: ...)*       -> an editorial note / decision-needed
//   *(... clarification)*-> inline translator clarification
// We turn each paragraph into { targetText (clean), hesitations[], raw }.

// Extract bold spans + their optional trailing editorial parenthetical.
export function extractHesitations(raw) {
  const hes = [];
  // **span** optionally followed by *(...)*, tolerating punctuation in between
  // (e.g. "**little trip**. *(alt: ...)*").
  const re = /\*\*(.+?)\*\*[\s.,!?;:'"”’]*(?:\*\(([^)]*)\)\*)?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const span = m[1].trim();
    const note = (m[2] || "").trim();
    const h = { span, kind: "uncertain", options: [], reasoning: "", note: "" };
    if (note) {
      const altMatch = note.match(/^alt:\s*(.*)$/is);
      if (altMatch) {
        // "A / B — reasoning"  (em dash separates options from reasoning)
        const body = altMatch[1];
        const dash = body.search(/\s[—-]\s/);
        const optsPart = dash >= 0 ? body.slice(0, dash) : body;
        const reasoning = dash >= 0 ? body.slice(dash).replace(/^\s*[—-]\s*/, "") : "";
        h.options = optsPart.split("/").map((s) => s.trim()).filter(Boolean);
        h.reasoning = reasoning.trim();
        h.kind = "alt";
      } else if (/^note/i.test(note)) {
        h.kind = "note";
        h.note = note;
      } else {
        h.kind = "clarify";
        h.note = note;
      }
    }
    hes.push(h);
  }
  return hes;
}

// Produce clean, readable English text: keep the chosen (bold) word, drop the
// editorial parentheticals and emphasis markers. Plain parentheses are kept.
export function cleanText(raw) {
  let t = raw;
  // Remove editorial parentheticals: *(...)*  (italic-wrapped parens only)
  t = t.replace(/\s*\*\([^)]*\)\*/g, "");
  // Drop emphasis markers, keep their contents.
  t = t.replace(/\*\*/g, "").replace(/\*/g, "");
  // Collapse whitespace.
  return t.replace(/[ \t]+/g, " ").trim();
}

// Split markdown into classified blocks. Each paragraph in these files is a
// single line; blockquotes span consecutive ">" lines.
export function parseMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let bq = null; // blockquote accumulator

  const flushBq = () => {
    if (bq && bq.length) {
      const text = bq.map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
      if (text) blocks.push({ kind: "blockquote", raw: text });
    }
    bq = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, ""); // trailing ws (markdown hard breaks)
    const t = line.trim();

    if (/^>/.test(t)) {
      if (!bq) bq = [];
      bq.push(t);
      continue;
    }
    flushBq();

    if (!t) continue;
    if (t === "---") continue;
    if (/^\*\[.*\]\*$/.test(t)) {
      blocks.push({ kind: "marker", raw: t.replace(/^\*\[|\]\*$/g, "").trim() });
      continue;
    }
    if (/^#\s+/.test(t)) { blocks.push({ kind: "h1", raw: t.replace(/^#\s+/, "") }); continue; }
    if (/^##\s+/.test(t)) { blocks.push({ kind: "h2", raw: t.replace(/^##\s+/, "") }); continue; }
    if (/^###\s+/.test(t)) { blocks.push({ kind: "h3", raw: t.replace(/^###\s+/, "") }); continue; }
    blocks.push({ kind: "para", raw: t });
  }
  flushBq();
  return blocks;
}
