# BookTranslator

A local, single-user, side-by-side **book translation editor** — for any language pair.
Original on the right, your translation on the left, paragraph-aligned. Built for
translating whole novels, not sentences.

No account, no cloud, no database. One Node process, your files, your machine.

![Translation desk: original right, translation left, suggestions panel]

## Why it exists

Machine translation gets you a draft. The real work — the voice, the idioms, the
register, the thousand small choices that make a book read like the author wrote
it — happens in the *editing*. BookTranslator is built around that editing loop:

- **Side-by-side desk** — source paragraph and its translation always aligned;
  select a sentence on either side and its match lights up on the other.
- **House style that compounds** — your rules, glossary, locked idioms and voice
  notes live in plain Markdown files and are injected into *every* AI call. The
  longer you translate, the better the drafts get.
- **Training data for free** — every edit, every accepted/rejected suggestion is
  captured as preference data (SFT / DPO / eval JSONL) you can later fine-tune on.
- **KDP-ready export** — one click produces a clean ebook `.docx` (navigation
  headings, scene breaks, optional per-chapter art).

## Quick start

```
git clone <this repo>
cd booktranslator
npm install
npm start          # or double-click start.cmd on Windows
```

Open **http://localhost:4319** — a demo book (Alice in Wonderland, English → Spanish)
is included so you can try the whole workflow immediately.

## Import your own book

```
node server/import/importBook.js mybook path/to/manuscript.docx \
  --title "Working Title" --author "Author Name" \
  --source-lang German --target-lang English
```

`.docx`, `.md` and `.txt` manuscripts work. Chapters are detected from headings
("Chapter 7", "Kapitel 7", "Capítulo 7", `# Heading`, ALL-CAPS lines…). Every
paragraph imports untranslated; the app is where the translation happens.

Language pairs are per-book (`data/books.json`); the project-wide default lives
in `data/config.json`.

## The AI engine — two ways to run it

**1. Any OpenAI-compatible API.** Settings → AI provider: pick a preset
(Gemini, Groq, Mistral, DeepSeek, OpenRouter, GLM, Kimi, custom…), paste a key,
done. Powers *Translate chapter*, in-context synonyms, and chat. Your key stays
on your machine in `data/engine.config.json` (gitignored).

**2. A Claude Code session — no API key at all.** The app writes request files to
`data/<book>/exchange/requests/`; a Claude session in the project folder answers
them with the `/engine` command (`/loop 30s /engine` keeps it running). The server
watches the exchange folders and merges answers in live. Works with any agent
that can read and write files.

Either way, every request is grounded in your house style:

```
data/style/                 shared across books
  house-style.md            the non-negotiable rules
  voice.md                  the author's rhythm signature
  avoid-ai-style.md         how not to sound machine-translated
  glossary.md               locked terms (Markdown tables)
  idioms.md                 editor-confirmed idiom choices
data/<book>/style/          per-book overrides/additions
```

## The editing loop

- **Click into a paragraph and rewrite it.** Enter saves; every save is versioned.
- **Right-click a word** → glossary hits (locked terms first), offline thesaurus
  (English targets), and the AI's in-context picks.
- **Suggestions panel** — where the translation wasn't sure, pick the wording.
- **Flag a paragraph** → the engine re-translates it with your reason attached.
- **Chat** — discuss a passage; *Apply to selection* uses the proposed rewrite.

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
events, chat, your API key) is gitignored — the repo stays clean.

## License

MIT. The demo text is Lewis Carroll's *Alice's Adventures in Wonderland* (public domain).
