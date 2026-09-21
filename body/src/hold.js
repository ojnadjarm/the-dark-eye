/**
 * The gate in front of the mouth: speech is held, never dropped, while his mic
 * is open and for a while after it closes, then sent in order. Nothing is armed
 * between his turns — the one timer exists only after a mic close.
 */
const HOLD_MS = 1500;
const MAX = 20;

/**
 * `{offer, heard, held, list}`. `busy()` is the caller's "he is speaking" (local mic
 * open, a phone utterance in flight); `heard()` marks the moment it stopped.
 * `parked()` is audio notes mode: held with no timer at all — the caller's `heard()`
 * is what lets it go, however many days later. An item with `bypass` is one he
 * asked for (a replay, the spoken confirmation of a mode switch): the mode does not
 * park it, his voice still does, and it waits ahead of every ordinary item, parked or
 * not — it is released before the queue it may be releasing, and never drags one out.
 * `onChange()` fires when the queue does.
 */
function createHold({
  send,
  busy = () => false,
  parked = () => false,
  onChange = () => {},
  holdMs = HOLD_MS,
  max = MAX,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  log = () => {},
} = {}) {
  const queue = [];
  let lastHeard = -Infinity;
  let timer = null;

  const held = (item) => (!item?.bypass && parked()) || busy() || now() < lastHeard + holdMs;
  /** An item a timer can still release on its own — a parked one waits for `heard()`. */
  const timed = (item) => item.bypass || !parked();

  function arm() {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(drain, holdMs);
  }

  /** Everything whose gate has opened, in order; still busy → look again after the window. */
  function drain() {
    timer = null;
    const go = queue.filter((item) => !held(item));
    if (!go.length) return void (queue.some(timed) && arm());
    for (const item of go) {
      queue.splice(queue.indexOf(item), 1);
      send(item);
    }
    onChange();
  }

  return {
    offer(item) {
      if (!held(item)) return void send(item);
      if (queue.length >= max) {
        const oldest = queue.findIndex((q) => !q.bypass); // what he just asked for is not what is thrown away
        queue.splice(oldest < 0 ? 0 : oldest, 1);
        log(`hold: ${max} waiting — dropped the oldest`);
      }
      // a bypass item is one he just asked for: it goes ahead of every ordinary item, parked or not
      const ahead = item.bypass ? queue.findIndex((q) => !q.bypass) : -1;
      if (ahead < 0) queue.push(item);
      else queue.splice(ahead, 0, item);
      if (!timer && timed(item)) arm();
      onChange();
    },

    /** His mic just closed: the mouth waits `holdMs` more, then says what it held. */
    heard() {
      lastHeard = now();
      arm();
    },

    get held() {
      return queue.length;
    },

    /** What waits, in order. */
    list() {
      return queue.slice();
    },
  };
}

module.exports = { createHold, HOLD_MS, MAX };
