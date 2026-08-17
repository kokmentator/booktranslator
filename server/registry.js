// Book registry — the list of books the app knows about (data/books.json).
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const REGISTRY = path.join(DATA_DIR, "books.json");

// If the registry is missing entirely, fall back to the bundled demo so a fresh
// clone still starts instead of crashing on an empty list.
const FALLBACK = [{ id: "demo", label: "Demo", titleTarget: "Demo book", titleSource: "Demo book" }];

export function loadBooks() {
  try {
    const books = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
    return Array.isArray(books) && books.length ? books : FALLBACK;
  } catch { return FALLBACK; }
}
export function bookIds() { return loadBooks().map((b) => b.id); }
export function isValidBook(id) { return bookIds().includes(id); }
export function bookById(id) { return loadBooks().find((b) => b.id === id) || null; }
// The book used when the request doesn't name one.
export function defaultBookId() { return bookIds()[0]; }
