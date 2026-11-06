/**
 * Host half of the jelly theme bundle.
 *
 * The visible work is entirely Client-side; this row exists so the bundle's
 * patch can mount something. It declares no services and registers nothing.
 */

/** Stable plugin name. */
export const name = "dsh-jelly-theme"

/** No Host services are required. */
export const inject = []

/** Intentionally empty: the theme is a pure Client-side concern. */
export function apply() {}