# BookTranslator

A local, single-user, side-by-side **book translation editor** — for any language pair.
Original on the right, your translation on the left, paragraph-aligned. Built for
translating whole novels, not sentences.

No account, no cloud, no database. One Node process, your files, your machine.

## Why it exists

Machine translation gets you a draft. The real work — the voice, the idioms, the
register, the thousand small choices that make a book read like the author wrote
it — happens in the *editing*. BookTranslator is built around that editing loop:

- **Side-by-side desk** — source paragraph and its translation always aligned;
  select a sentence on either side and its match lights up on the other.
- **House style that compounds** — author notes, style sliders, glossary, slang
  and locked idioms are injected into *every* AI call. The longer you translate,
  the better the drafts get.
- **Training data for free** — every edit, every accepted/rejected suggestion is
  captured as preference data (SFT / DPO / eval JSONL) you can later fine-tune on.
- **Publish-ready export** — one click produces a clean, KDP-ready ebook `.docx`
  or a dependency-free **EPUB 3**.

## Quick start

```
git clone https://github.com/kokmentator/booktranslator
cd booktranslator
npm install
npm start          # or double-click start.cmd (Windows) / run ./start.sh (macOS, Linux)
```

Open **http://localhost:4319** — a demo book (Alice in Wonderland, English → Spanish)
is included so you can try the whole workflow immediately. The server binds to
localhost only; your manuscripts and API key are never visible to the network.

## Import your own book

Click the **"+" tab** (top-left) — it opens **Your books**: a card per book with
author, language pair and translation progress, plus an *Add a book* form. Pick a
`.docx`, `.md` or `.txt` manuscript, set the title and the translate-from/into
languages, and **preview the detected chapter split before anything is written** —
then confirm. Cards also let you rename a book or remove it from the shelf
(removal moves its folder to `data/_trash`; nothing is ever hard-deleted).

The same import works from the command line:

```
node server/import/importBook.js mybook path/to/manuscript.docx \
  --title "Working Title" --author "Author Name" \
  --source-lang German --target-lang English
```

Chapters are detected from headings ("Chapter 7", "Kapitel 7", "Capítulo 7",
`# Heading`, ALL-CAPS lines…). Every paragraph imports untranslated; the app is
where the translation happens.

Language pairs are per-book (`data/books.json`); the project-wide default lives
in `data/config.json`.

## The editing loop

- **Click into a paragraph and rewrite it.** Enter saves; the masthead shows a
  live *All saved* indicator (plus a hard **Save** button for the sceptics), and
  every save keeps the previous version.
- **History** — the side panel lists a paragraph's earlier versions with one-click
  *Restore*.
- **Search both texts** (Ctrl+F) — match counter, Enter/Shift+Enter walks the hits.
- **→ Untranslated** (Ctrl+J) — jump to the next untranslated or flagged paragraph;
  the masthead shows the book's live progress bar.
- **Double-click an untranslated paragraph** — translates just that paragraph.
  Double-click a chapter heading — translates the whole chapter.
- **Right-click a word** → your locked glossary terms first, an offline thesaurus
  (English targets), and the AI's in-context picks.
- **Suggestions panel** — where the translation wasn't sure, pick the wording;
  a sensitivity slider controls how often the AI offers alternatives.
- **Flag a paragraph** → the engine re-translates it with your reason attached.
- **Chat** — discuss a passage; *Apply to selection* uses the proposed rewrite.

## Teach it the author's voice

Settings holds the whole "personality" of a translation, per book:

- **The author** (Settings → Style) — free text about who the author is, how they
  write, what must survive translation. Read by the AI before every call.
- **Style sliders** — fidelity, register, rhythm, local idiom, strong language,
  opening variation, suggestion sensitivity: 0–100 each, turned into plain-language
  directives that override generic translation instincts.
- **Glossary** (Settings → Glossary) — in-app table editors for three per-book
  dictionaries: *Glossary & names*, *Slang*, and *Idioms*. Locked terms are used
  verbatim by the AI and surface first in the word popup — a name or phrase is
  translated once, then never drifts again.

Everything is stored as plain Markdown under `data/style/` (shared) and
`data/<book>/style/` (per book), so it's also editable in any text editor:

```
data/style/                 shared across books
  house-style.md            the non-negotiable rules
  avoid-ai-style.md         how not to sound machine-translated
  glossary.md · idioms.md   locked terms (Markdown tables)
data/<book>/style/          per-book: voice.md (author notes), glossary.md,
                            slang.md, idioms.md, editorial.md
```

## The AI engine — two ways to run it

**1. Any OpenAI-compatible API.** Settings → AI provider: pick a preset
(Gemini, Groq, Mistral, DeepSeek, OpenRouter, GLM, Kimi, custom…), paste a key,
done. Powers chapter/paragraph translation, in-context synonyms, and chat. Your
key stays on your machine in `data/engine.config.json` (gitignored), and a token
counter in the status bar shows how much work the AI is doing.

**2. A Claude Code session — no API key at all.** The app writes request files to
`data/<book>/exchange/requests/`; a Claude session in the project folder answers
them with the `/engine` command (`/loop 30s /engine` keeps it running). The server
watches the exchange folders and merges answers in live. Works with any agent
that can read and write files.

Either way, every request is grounded in the book's house style, author notes,
sliders and locked terms.

## Export

The **Export** button offers two formats, built from the same translation:

- **Word (.docx)** — KDP-ready: navigation headings, scene breaks, straight
  quotes, optional per-chapter art from `data/<book>/art/`.
- **EPUB (.epub)** — valid EPUB 3 with title page and table of contents,
  generated with zero dependencies.

## Training dataset

Open **/training.html**. Every editorial decision is an append-only JSONL event;
export builds three files per book:

- `sft.jsonl` — source → human-approved translation (with your rules as system prompt)
- `dpo.jsonl` — (prompt, chosen, rejected) preference pairs
- `eval.jsonl` — held-out pairs for benchmarking any model against your taste

The dashboard also scores *which model needs the least correction* for your style.

## Layout

```
server/        Express server — the ONLY writer of data/<book>/project.json
web/           vanilla-JS frontend, no build step
data/          books.json registry, config.json, per-book project data, style files
demo/          the bundled public-domain demo manuscript
```

Everything the app writes at runtime (backups, exports, exchange files, training
events, chat, trash, your API key) is gitignored — the repo stays clean.

## License

MIT. The demo text is Lewis Carroll's *Alice's Adventures in Wonderland* (public domain).
