# Study packs

A chapter export is the text. A study pack is that chapter turned into something you can revise on a phone: the whole argument in order, the few sentences worth keeping, why each one is there, and questions you answer with the book closed.

## Try it

```bash
npx chapterize study book.epub --out ~/Desktop/study
```

`npm install` builds the command. Open any `*-study.html` on the phone. Paste any `*-prompt.md` into Grok. The command does not call a model.

`--mode offline` skips the prompt. `--mode prompt` writes only the prompt. `--chapter 4` writes one chapter. Chapters under 15 words are skipped; `--all` keeps them.

## What it does

Offline mode quotes the book. Every heading is a step, nested headings stay nested, and the numbers run 1, 2, 3 without restarting. A chapter with no headings becomes one step per paragraph. List items stay in order under their step. A running header that repeats across chapters is left out; a sentence that merely mentions the title is kept.

“Why it matters” is its own section, one line per step. It is the author’s own sentence when the chapter says *because*, *therefore*, or *so that*. When the chapter never says why, the note names the neighboring step that would be left with nothing in front of this one, and it is marked as coming from the order, not from the author. That is a fact about the outline. It is not a guess about the author’s motive.

Key ideas are at most five sentences: a definition, a line the author emphasised, a reason, or the sentence a step opens with. The outline is the complete walk. The ideas are the short list.

Questions are recall, then deeper. Recall asks the reader to finish a sentence. Deeper asks why a step matters, what the next step claims, what a later step loses if this one is skipped, and what a step establishes in the reader’s own words. The check is a sentence the outline already showed, or the order note. In the HTML it sits inside a disclosure, so opening the file does not show the answer.

The prompt file is optional. It fences the chapter between `CHAPTER-START` and `CHAPTER-END` and tells the model to treat that text as the book, not as instructions. It asks for the same four parts, with nothing skipped and nothing brought in from outside the chapter. The command does not call a model.

## Tests

`npm test` and `npm run typecheck` pass. The study-pack tests build an EPUB (a nested chapter, a headingless chapter, a cover, a repeated header, a list, an emphasised sentence, and a paragraph that contains the characters `<script>`) and run it through the same parser the app uses. The built `chapterize` command is executed on that file and the HTML and the prompt are read back. A real book is also checked when `CHAPTERIZE_FIXTURES` is set. It was not set here, so that test skipped.

## Unfinished

The desktop window has no Study button. The command is the way to get the files. A button would write the same three files beside the chapter export. It was not added.

The offline “why” can name a neighbor that is a tangent rather than a consequence. The prompt file is there for that case. Making the offline note smarter would mean paraphrasing, which this mode refuses to do.

A chapter whose only heading is its title is one step. Every sentence is still in the outline. There is no next step, so the deeper question about what the next step claims does not appear.

A chapter under 15 words is skipped unless you pass `--all` or `--chapter`. A real one-sentence chapter needs one of those.

The HTML was not opened on a phone. Tests check that it is a document, that book text cannot become a tag, and that each question’s answer is inside `<details>`.

Nothing copies the folder to the phone. You move `~/Desktop/study` the way you already move files.
