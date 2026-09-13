# TabScribe repository guidance

Read `PRODUCT.md` before proposing or changing UI/UX. It contains the founder's
verbatim goal and the product's scope: focused live meeting transcription, copying
passages for use with an external AI, and downloading the entire transcript.

Prefer removing friction and clutter over adding features. Find/search and a
built-in AI client are not part of this product's current scope. Do not treat the
older broad UI pass in Git history as the product specification.

Keep the compact 13px meeting panel, gear toolbar, selection-safe live updates,
default-on select to copy, optional quiet copy toast, full-transcript download,
audible passthrough, remembered preferences/window size, and no model-download
Done notice. Do not grow chrome, type size, or reading-app features unless they
make copy-a-passage or download-the-whole-meeting faster.

Use isolated Chrome profiles and a private display for tests; never borrow the
user's signed-in browser. Tests precede behavior changes. Clipboard and download
checks must inspect their real outputs. Commit each verified change separately.
