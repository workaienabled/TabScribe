# TabScribe product goal

## Founder request (verbatim)

> Let me give you more context about the product's goal, and keep it in the repo for reference as well: The goal of the product is a focused and minimal live transcript extension that people can use to copy text from current tab meeting transcript and ask AI about it, and also download the whole transcript at the end.
>
> So with this in mind, for example the find feature is not useful. Considering this, make UI/UX adjustments

## Core workflow

1. Open TabScribe on the current meeting tab and start live transcription.
2. Read the incoming text without interrupting the meeting or losing a selection.
3. Select a relevant passage, copy it, and paste it into the user's chosen AI chat.
4. At the end, download the entire transcript as a text file.

## Design decisions derived from that goal

- Keep the live transcript dominant. Visible controls must support capture,
  selection/copy, or full-transcript download—not a general document-reading app.
- Do not include Find, transcript search, a transcript library, or document-management
  controls. Their absence is intentional, not a missing roadmap feature.
- Do not add an embedded AI client, provider picker, API-key setup, automatic upload,
  or an “Ask AI” button unless the founder separately requests an integration.
- Copy may mean a selected passage or the whole transcript; label that scope clearly.
  Download always means the whole transcript, even while a passage is selected.
- Keep default-on select-to-copy and the separate optional short “Copied” toast.
  Copy confirmation must not replace recognition status or flash the transcript.
- Keep occasional settings and Clear behind the gear. Theme, reading size, language,
  and ergonomic preferences may remain there; they must not clutter the main view.
- Preserve selection-safe updates, audible tab playback, remembered window size,
  on-device-only default, and a recoverable Clear. No model-ready/Done banner.
- Keep a quiet way back to the live end after selecting or reviewing older text,
  without covering the words the user is trying to copy.

## Acceptance criteria for future UI changes

A change should make starting, reading, copying a useful passage, or downloading the
whole meeting simpler or more reliable. If it does not, leave it out. Verify real
clipboard and downloaded-file contents, not only labels or button clicks. Preserve
privacy and audio-capture behavior unless a change is explicitly scoped and tested.
