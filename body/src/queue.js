/**
 * A listen bus: transcripts are pushed here and a brain takes them with a
 * timeout — an empty take returns null so the caller can poll again instead
 * of hanging. It holds his words while no brain listens, but only the last
 * `MAX` of them. Each brain gets its own (`create`); the default export is one bus.
 */
const MAX = 200;

function create() {
  const waiters = [];
  const items = [];
  return {
    push(item) {
      const w = waiters.shift();
      if (w) return void w(item);
      items.push(item);
      if (items.length > MAX) items.shift();
    },
    take(ms) {
      if (items.length) return Promise.resolve(items.shift());
      return new Promise((res) => {
        waiters.push(res);
        setTimeout(() => {
          const i = waiters.indexOf(res);
          if (i >= 0) {
            waiters.splice(i, 1);
            res(null);
          }
        }, ms);
      });
    },
    get waiting() {
      return waiters.length;
    },
  };
}

module.exports = Object.assign(create(), { MAX, create });
