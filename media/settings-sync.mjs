/**
 * Settings round-trip guard — pure, so `node --test` can pin the race that made
 * 「立即生效」 look broken.
 *
 * The bug (reported as "点了立即生效会回弹到之前的设置，然后也没生效"): the panel writes a
 * slider value to the configuration through a 150 ms debounce, and the write itself is
 * async. Clicking apply inside that window asked the host for a configuration that
 * still held the OLD value, so the host pushed the old value back — syncInputs() then
 * snapped the slider back — and the value sent to the windows was the old one too.
 *
 * The rule this encodes: a value the user has already set locally wins over an echo
 * that does not confirm it yet, and it stops winning the moment the host agrees.
 */

/**
 * @param {object} [initial] values already pending (rarely useful; for tests)
 */
export function createPendingSettings(initial) {
  /** key → the value the panel set and the host has not confirmed. */
  const pending = new Map(Object.entries(initial || {}));

  return {
    /** Record a value the panel just changed. */
    set(key, value) {
      pending.set(key, value);
    },

    /** Keys still waiting for confirmation (diagnostics/tests). */
    keys() {
      return [...pending.keys()];
    },

    /**
     * Merge a host echo into the local settings.
     *
     * Pending values are re-asserted on top, and cleared only when the host's own value
     * equals them — i.e. when the write has actually landed.
     *
     * @param {Record<string, unknown>} local   the panel's current settings
     * @param {Record<string, unknown>|undefined} fromHost  what the host reported
     * @returns {Record<string, unknown>} the settings the panel should use
     */
    merge(local, fromHost) {
      const merged = { ...local, ...(fromHost || {}) };
      for (const [key, value] of pending) {
        if (fromHost && Object.prototype.hasOwnProperty.call(fromHost, key) && fromHost[key] === value) {
          pending.delete(key);
          continue;
        }
        merged[key] = value;
      }
      return merged;
    },
  };
}
