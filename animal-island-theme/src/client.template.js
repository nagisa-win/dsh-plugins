/**
 * Animal Island theme: Client half (source template).
 *
 * scripts/build.mjs replaces the three generated-value placeholders and writes the
 * result to client.js. Edit this file, not client.js.
 *
 * Palette, radii and font stacks go through ctx.theme.overrideTokens, the
 * supported path for third-party palettes: the layer stacks over whichever
 * built-in theme is active, so light/dark/system keeps working. Control
 * silhouettes and CJK text shaping are a scoped stylesheet keyed on
 * body[data-ai-island].
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-animal-island-theme',
  factory() {
    /** Layer identity for overrideTokens; one layer per source. */
    const SOURCE = '@local/dsh-animal-island-theme'

    /** Body attribute that scopes every rule in the stylesheet. */
    const SCOPE_ATTR = 'data-ai-island'

    /** Marks the injected <style> so a second activation never duplicates it. */
    const STYLE_ATTR = 'data-ai-island-style'

    /** Token overrides as { light, dark } pairs, generated from src/tokens. */
    const TOKENS = __AI_TOKENS__

    /** Control and typography rules, generated from src/styles. */
    const CSS = __AI_CSS__

    /**
     * Nunito (Latin subset, variable weight) as a data URI. unicode-range keeps
     * it off CJK code points, so Han, kana and full-width punctuation fall
     * through to the system CJK face in the stack.
     */
    const FONT_FACE = __AI_FONT_FACE__

    /** Insert the stylesheet once and return its remover. */
    function mountStyle() {
      const existing = document.head.querySelector(`style[${STYLE_ATTR}]`)
      if (existing !== null) existing.remove()
      const style = document.createElement('style')
      style.setAttribute(STYLE_ATTR, '')
      style.textContent = FONT_FACE + '\n' + CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    return {
      name: 'dsh-animal-island-theme',
      inject: ['theme'],
      apply(ctx) {
        ctx.effect(() => ctx.theme.overrideTokens(SOURCE, TOKENS))
        ctx.effect(mountStyle)
        ctx.effect(() => {
          document.body.setAttribute(SCOPE_ATTR, '')
          return () => document.body.removeAttribute(SCOPE_ATTR)
        })
      },
    }
  },
})
