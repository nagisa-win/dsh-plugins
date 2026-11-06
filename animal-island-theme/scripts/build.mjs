/**
 * Build client.js from src/client.template.js, src/tokens/*.json,
 * src/styles/*.css and assets/fonts/nunito-latin-wght.woff2.
 *
 * Usage: node scripts/build.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a package-relative text file. */
const read = (path) => readFileSync(join(root, path), 'utf8')

/** Token files in load order; later files win on duplicate names. */
const TOKEN_FILES = ['palette.json', 'shape.json', 'surfaces.json', 'content.json']

/** Stylesheets in cascade order. */
const STYLE_FILES = ['base.css', 'controls.css', 'surfaces.css']

/** Latin, Latin-1 and general punctuation; never CJK. */
const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, ' +
  'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, ' +
  'U+2212, U+2215, U+FEFF, U+FFFD'

/** Merge token files into { name: { light, dark } }, expanding bare strings. */
function buildTokens() {
  const tokens = {}
  for (const file of TOKEN_FILES) {
    const data = JSON.parse(read(`src/tokens/${file}`))
    for (const [name, value] of Object.entries(data)) {
      /** "//" keys are comments. */
      if (name === '//') continue
      if (!name.startsWith('--')) throw new Error(`${file}: "${name}" is not a custom property`)
      if (typeof value === 'string') tokens[name] = { light: value, dark: value }
      else if (typeof value?.light === 'string' && typeof value?.dark === 'string') tokens[name] = value
      else throw new Error(`${file}: "${name}" must be a string or a { light, dark } pair`)
    }
  }
  return tokens
}

/** Concatenate stylesheets, failing loudly when one listed file is missing. */
function buildCss() {
  const present = new Set(readdirSync(join(root, 'src/styles')))
  return STYLE_FILES.map((file) => {
    if (!present.has(file)) throw new Error(`src/styles/${file} is missing`)
    return `/* ${file} */\n${read(`src/styles/${file}`)}`
  }).join('\n')
}

/** @font-face rule with the woff2 inlined as base64. */
function buildFontFace() {
  const bytes = readFileSync(join(root, 'assets/fonts/nunito-latin-wght.woff2'))
  if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('font is not a woff2 file')
  return (
    '@font-face{font-family:"AI Nunito";font-style:normal;font-weight:200 1000;font-display:swap;' +
    `src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2");` +
    `unicode-range:${LATIN_RANGE}}`
  )
}

const tokens = buildTokens()
const output = read('src/client.template.js')
  .replace('__AI_TOKENS__', () => JSON.stringify(tokens))
  .replace('__AI_CSS__', () => JSON.stringify(buildCss()))
  .replace('__AI_FONT_FACE__', () => JSON.stringify(buildFontFace()))

if (output.includes('__AI_')) throw new Error('unreplaced placeholder in client template')
writeFileSync(join(root, 'client.js'), output)
console.log(`client.js: ${Object.keys(tokens).length} tokens, ${output.length} bytes`)
