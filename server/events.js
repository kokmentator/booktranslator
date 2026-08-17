// Server-Sent Events: one-way live push from server to the browser.
// Each client is bound to a book, so events never leak across books.
import { isValidBook, defaultBookId } from "./registry.js";

const clients = new Set();

export function sseHandler(req, res) {
  // Same resolution as the API routes: fall back to the first registered book,
  // so a client with no ?book= and the server's broadcasts agree on the name.
  const q = (req.query.book || "").toString();
  const book = isValidBook(q) ? q : defaultBookId();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const client = { res, book };
  clients.add(client);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(client); });
}

export function broadcast(book, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.book !== book) continue;
    try { c.res.write(payload); } catch {}
  }
}
