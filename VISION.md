# Chapterize on the phone

## Press release

**The book Luis is already reading now lives on his phone.**

Luis reads on his iPhone and in paper books. He is almost never at the computer, so a desktop library was a place he did not go. Chapterize now has one front door. At the computer he runs:

```bash
npx chapterize book.epub
```

The terminal prints a QR code. He scans it, adds the page to his Home Screen, and puts the computer away.

What opens is a reader set like a book. The type is a serif the phone already has, the line length is the line length of a page, daylight is warm paper, and night is warm dark. The chapter and the scroll position are still there the next time he opens it. After the first load the book opens with the computer asleep, because the phone kept a copy.

Each chapter ends in a study panel that is not a summary and not a chatbot. Nothing is sent over the network, and no model writes a word. The outline is the author's own sections. "Why this matters" is a sentence Luis writes before he reads; only then does the chapter's opening appear, quoted. The self-test is a short list of questions in a fixed order. The next question stays locked until he has answered the current one, or written that he does not know. The passage behind the question is the author's paragraph, and it stays hidden until that moment.

When the copy in his hands is paper, he switches the phone to the companion. The chapter text is not on screen. The recap is the section list, in order, and the same locked questions, so he can look up from the page and check himself against a quotation.

His place, his sentences, and the theme stay on that phone.

## FAQ

**Why does this get opened every day?**
The phone is already where the reading happens. A chapter now has a place to resume and a two-minute close: say what mattered, then face the next question. That is a reason to come back tomorrow. A library manager is not.

**Why are the questions plain?**
A generated insight would be a guess, and this program does not guess. The value is the order. He has to think before the words are shown. Each question is a template over one of the author's headings, and the hidden passage is that section's own paragraph. A chapter with no headings gets at most three questions — opening, middle, end — labelled as landmarks we chose, not as the author's outline. A long chapter asks five questions, spaced through the sections; the outline still lists every section.

**What is deliberately absent?**
Notes do not travel back to the computer. Clearing the phone's site data loses them. The book is never uploaded. DRM is not removed. The program does not understand the book. Anyone on the same Wi-Fi who has the link can open it; the link is a long random token, and the terminal says this out loud. The token is kept for that book, so the icon survives the next run. It does not survive the computer changing address. Safari has no install button: Home Screen is Share, then Add to Home Screen. iOS may eventually delete a saved site that has not been opened. A new book means running the command again while the phone is on the same Wi-Fi.

**What is the computer for, after this?**
One command per book. The desktop app remains the library, the splitter, and the Kindle send. It is not the thing he reads on.
