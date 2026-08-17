// Thin API wrapper over the local server. Every call is scoped to the active
// book via ?book=<id> (read from the page URL). With no ?book= the server
// falls back to the first registered book.
export function currentBook() {
  return new URLSearchParams(location.search).get("book") || "";
}
const q = (extra = "") => `?book=${encodeURIComponent(currentBook())}${extra}`;

export async function getBooks() {
  const r = await fetch("/api/books");
  return r.ok ? r.json() : [];
}

export async function getProject() {
  const r = await fetch("/api/project" + q());
  if (!r.ok) throw new Error("Could not load the book");
  return r.json();
}

// Save-state events for the masthead indicator: every persisting call announces
// itself, so the "All changes saved" light is driven by what ACTUALLY happened.
const announce = (state) => window.dispatchEvent(new CustomEvent("bt:save", { detail: state }));

export async function patchSegment(id, targetText, meta) {
  announce("saving");
  try {
    const r = await fetch(`/api/segment/${id}` + q(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetText, ...(meta || {}) }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || "Save failed");
    }
    const out = await r.json();
    announce("saved");
    return out;
  } catch (e) { announce("error"); throw e; }
}

export async function decideSegment(id, body) {
  announce("saving");
  try {
    const r = await fetch(`/api/segment/${id}/decide` + q(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || "Action failed");
    }
    const out = await r.json();
    announce("saved");
    return out;
  } catch (e) { announce("error"); throw e; }
}

export async function exportBook() {
  const r = await fetch("/api/export" + q(), { method: "POST" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "Export failed");
  }
  return r.json();
}

export async function translateSegment(segmentId) {
  const r = await fetch("/api/translate-segment" + q(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segmentId }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "Translate failed");
  }
  return r.json();
}

export async function translateChapter(chapterId) {
  const r = await fetch("/api/translate-chapter" + q(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapterId }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "Translate failed");
  }
  return r.json();
}

export async function getChat() {
  const r = await fetch("/api/chat" + q());
  return r.ok ? r.json() : [];
}

export async function postChat(payload) {
  const r = await fetch("/api/chat" + q(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || "Message failed");
  }
  return r.json();
}
