/**
 * Host half of the brand plugin.
 *
 * The visible work happens in `client.js`; this row only needs to exist so the
 * bundle's patch can mount something. It declares no services and registers
 * nothing, which is what the upstream shellRaining brand plugin does too.
 */

/** Stable plugin name, distinct from the upstream `dsh-shellraining-brand`. */
export const name = "dsh-blue-fat-fish-brand"

/** No Host services are required. */
export const inject = []

/**
 * Intentionally empty: the brand is a pure Client-side concern.
 */
export function apply() {}
