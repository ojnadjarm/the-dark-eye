/**
 * The gallery: the visuals a brain sends, held until he looks. Pure node —
 * the window that shows them is `canvas.js` + `canvas-app`.
 */
const MAX_ITEMS = 12;

/** The held visuals, oldest first; the oldest is dropped past MAX_ITEMS. */
function createGallery(max = MAX_ITEMS) {
  const items = [];
  let seq = 0;
  return {
    push({ title, kind, data, verdict }) {
      const item = { id: String(++seq), title, kind, data, verdict: !!verdict, ts: Date.now() };
      items.push(item);
      while (items.length > max) items.shift();
      return item;
    },
    current: () => (items.length ? { ...items[0], queued: items.length } : null),
    verdict(id) {
      const i = items.findIndex((s) => s.id === id);
      return i < 0 ? null : items.splice(i, 1)[0];
    },
  };
}

module.exports = { createGallery, MAX_ITEMS };
