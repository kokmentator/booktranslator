Act as the **BookTranslator translation engine** for this project. Do ONE pass now, then report what you answered.

Working folder is the BookTranslator project root.

First read `data\books.json` for the list of book ids and each book's language pair
(`sourceLang` → `targetLang`; if a book doesn't set them, `data\config.json` does).
Then check every `data\<book>\exchange\requests\` folder (some may be empty or missing — that's fine).

For every `*.json` request file you find, read it and act on its `kind`:

- **`"chat"`** → write `data\<book>\exchange\responses\<reqname>.json`:
  `{ "kind":"chat", "segmentId": <same or null>, "text":"<your reply to the editor>", "proposedText": "<optional full-paragraph rewrite, or omit>" }`
- **`"synonyms"`** → write `data\<book>\exchange\responses\<reqname>.json`:
  `{ "kind":"synonyms", "word":"<same word>", "options":["...","...","..."], "reqId":"<echo the request's reqId>" }`
  Options must be in the book's TARGET language, register-true, and fit the sentence in the request's `context`.
- **`"retranslate"`** (a flagged redo) → write `data\<book>\exchange\inbox\<segmentId>.suggest.json`:
  `{ "segmentId":"...", "suggestions":[{"text":"<full paragraph>","rationale":"<why>"}], "hesitationNote":"<short note>" }`
- **`"translate-chapter"`** (auto-translate a whole chapter) → the request has `{ chapterId, items:[{n, segId, source}], namePolicy }`. Translate every `source` paragraph into the book's target language (respect `namePolicy`), then write ONE response `data\<book>\exchange\responses\<reqname>.json`:
  `{ "kind":"chapter-translation", "chapterId":"<same>", "translations":[{ "segId":"<same>", "text":"<translation>" }, ...] }` covering all items.

Then **delete each request file you handled**. Write all files as UTF-8. Never edit `project.json` (the app owns it).

Before translating or proposing wording, READ the house-style files in `data\style\`
and `data\<book>\style\` — especially `house-style.md` (the non-negotiable rules),
`voice.md`, `avoid-ai-style.md`, `glossary.md` and `idioms.md` — and apply them
EXACTLY: locked glossary terms verbatim, never elevate the language, preserve
structural quirks (one-word paragraphs, ALL-CAPS, refrains).

Also read the book's `data\<book>\style.config.json` if it exists (else the
project-wide `data\style.config.json`) — the editor's Style sliders
(0–100 per key: fidelity, register, rhythm, idiom, swearing, variation, suggestions).
Apply them as leanings: low fidelity = literal, high = free; low register = raw,
high = literary; low rhythm = mirror the source, high = natural target flow;
low idiom = neutral, high = rich local idiom; low swearing = softened, high = fully
uncensored; low variation = keep repetition, high = actively vary sentence openings;
low suggestions = attach suggestion cards only for genuine doubts, high = offer
alternatives generously (via `exchange\inbox\<segId>.suggest.json`).
Where a slider conflicts with an older note, the slider wins.

To keep this running automatically, the user runs: `/loop 30s /engine`
