import { CONFIRMATION_POLL_MS } from '#domain';

/**
 * Calls `tick` every `interval` ms while the tab is visible, and once right away when it becomes
 * visible again. `tick` returns false to stop; errors are ignored until the next tick.
 * Kept apart so a push service can replace it later without touching the screens.
 * @param {() => Promise<boolean | void>} tick
 * @param {{ interval?: number }} [options]
 * @returns {() => void} stops polling
 */
export function startPolling(tick, { interval = CONFIRMATION_POLL_MS } = {}) {
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let running = false;

  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(run, interval);
  };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if ((await tick()) === false) stop();
    } catch {
      // network blip: try again on the next tick
    } finally {
      running = false;
      schedule();
    }
  };
  const onVisibility = () => {
    if (document.hidden) clearTimeout(timer);
    else run();
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };

  document.addEventListener('visibilitychange', onVisibility);
  schedule();
  return stop;
}
