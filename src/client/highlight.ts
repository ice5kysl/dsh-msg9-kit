/**
 * Syntax highlighting for mail-body code blocks, backed by Shiki (the VS Code
 * TextMate engine) with its pure-JS RegExp engine — no wasm, no CJS-breaking
 * top-level await. The highlighter initializes asynchronously at module load;
 * `highlightCode` degrades to escaped plaintext until `highlightReady`
 * resolves, and the panel re-renders once when it does.
 *
 * The `css-variables` Shiki theme emits token colors as CSS variables, so one
 * render serves both shell themes — the palette lives in theme.ts (M9_CSS).
 *
 * @module dsh-msg9-kit/client-highlight
 */

import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// Fine-grained imports: only these grammars ship in the client bundle (the
// full `shiki` entry pulls in every language — 10 MB class). Kept to the
// languages agent mail actually carries; cpp alone would add 0.8 MB.
const highlighterPromise = createHighlighterCore({
  themes: [createCssVariablesTheme()],
  langs: [
    import('shiki/langs/typescript.mjs'),
    import('shiki/langs/tsx.mjs'),
    import('shiki/langs/javascript.mjs'),
    import('shiki/langs/jsx.mjs'),
    import('shiki/langs/go.mjs'),
    import('shiki/langs/python.mjs'),
    import('shiki/langs/bash.mjs'),
    import('shiki/langs/json.mjs'),
    import('shiki/langs/yaml.mjs'),
    import('shiki/langs/toml.mjs'),
    import('shiki/langs/markdown.mjs'),
    import('shiki/langs/sql.mjs'),
    import('shiki/langs/diff.mjs'),
  ],
  engine: createJavaScriptRegexEngine(),
})

let highlighter: HighlighterCore | undefined

/** Resolves when the highlighter is usable (never rejects). */
export const highlightReady: Promise<void> = highlighterPromise.then((instance) => {
  highlighter = instance
}, () => {
  /* highlighting is cosmetic: a failed init just means plaintext code */
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const BOLD = 2
const ITALIC = 1

/**
 * Highlight one code block, returning inner HTML for the <code> element.
 * Falls back to escaped plaintext while Shiki is still initializing, for
 * unknown languages, or when initialization failed.
 */
export function highlightCode(code: string, lang: string | undefined): string {
  if (highlighter) {
    // NOTE: `getLanguage(name)` THROWS on an unloaded grammar (ShikiError) —
    // one ```jsonc fence in a letter would crash the whole panel render.
    // Membership must go through getLoadedLanguages() instead.
    const language = lang && highlighter.getLoadedLanguages().includes(lang) ? lang : 'text'
    try {
      const { tokens } = highlighter.codeToTokens(code, { lang: language, theme: 'css-variables' })
      return tokens
        .map((line) => line
          .map((token) => {
            const styles: string[] = []
            if (token.color) styles.push(`color:${token.color}`)
            if (token.fontStyle && token.fontStyle & BOLD) styles.push('font-weight:600')
            if (token.fontStyle && token.fontStyle & ITALIC) styles.push('font-style:italic')
            const content = escapeHtml(token.content)
            return styles.length > 0 ? `<span style="${styles.join(';')}">${content}</span>` : content
          })
          .join(''))
        .join('\n')
    } catch {
      /* fall through to plaintext */
    }
  }
  return escapeHtml(code)
}
