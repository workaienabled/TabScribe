/** Non-destructive find: highlights use Ranges, never replacement HTML. */
export function createTranscriptSearch({ transcript, onNavigate, onOpen }) {
  const byId = (id) => document.getElementById(id);
  const button = byId('findBtn');
  const panel = byId('findPanel');
  const input = byId('findInput');
  const count = byId('findCount');
  const previous = byId('findPrev');
  const next = byId('findNext');
  let matches = [];
  let index = 0;

  function paint(scroll) {
    previous.disabled = next.disabled = !matches.length;
    count.textContent = !input.value.trim() ? 'Find text' : matches.length ? `${index + 1} of ${matches.length}` : 'No matches';
    CSS.highlights.delete('search-current');
    if (!matches.length) return;
    const match = matches[index];
    CSS.highlights.set('search-current', new Highlight(match));
    if (scroll) {
      onNavigate();
      // Scroll the transcript, not the whole extension page or a settings panel.
      const rect = match.getBoundingClientRect();
      const viewport = transcript.getBoundingClientRect();
      transcript.scrollTop += rect.top - viewport.top - transcript.clientHeight / 3;
    }
  }

  function refresh(scroll = false) {
    if (panel.hidden) return;
    matches = [];
    const query = input.value.trim();
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'gi');
      for (const span of transcript.querySelectorAll('.seg .txt')) {
        const node = span.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        pattern.lastIndex = 0;
        for (const hit of node.data.matchAll(pattern)) {
          const range = document.createRange();
          range.setStart(node, hit.index);
          range.setEnd(node, hit.index + hit[0].length);
          matches.push(range);
        }
      }
    }
    index = Math.min(index, Math.max(0, matches.length - 1));
    CSS.highlights.set('search-matches', new Highlight(...matches));
    paint(scroll);
  }

  function open() {
    onOpen();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    input.focus();
    input.select();
    refresh();
  }

  function close() {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    CSS.highlights.delete('search-matches');
    CSS.highlights.delete('search-current');
    button.focus({preventScroll: true});
  }

  function move(direction) {
    if (!matches.length) return;
    index = (index + direction + matches.length) % matches.length;
    paint(true);
  }

  button.addEventListener('click', () => panel.hidden ? open() : close());
  byId('findClose').addEventListener('click', close);
  input.addEventListener('input', () => { index = 0; refresh(true); });
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { move(event.shiftKey ? -1 : 1); event.preventDefault(); }
    if (event.key === 'Escape') { close(); event.preventDefault(); event.stopPropagation(); }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      open();
    }
  });
  return { refresh, isOpen: () => !panel.hidden };
}
