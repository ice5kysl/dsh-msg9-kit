/**
 * Design tokens and the interactive-state stylesheet for dsh-msg9-kit's
 * browser face.
 *
 * Colors ride the dsh shell's `--dsw-alias-*` design tokens (the same ones the
 * shipped surfaces use), with fallbacks for older shells. Inline styles cannot
 * express :hover / :focus / :disabled, so every interactive element carries a
 * class from `M9_CSS`, injected once per surface via <style>{M9_CSS}</style>.
 *
 * @module dsh-msg9-kit/client-theme
 */

export const FG = 'var(--dsw-alias-label-primary, #1f2328)'
export const DIM = 'var(--dsw-alias-label-secondary, #6b7280)'
export const BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
export const BG_SUNK = 'var(--dsw-alias-bg-layer-1, #f5f7fa)'
export const BORDER = 'var(--dsw-alias-border-l1, rgba(28,35,51,0.12))'
export const BORDER_STRONG = 'var(--dsw-alias-border-l2, rgba(28,35,51,0.20))'
export const ACCENT = 'var(--dsw-alias-brand-primary, #2d66f7)'
export const HOVER_BG = 'var(--dsw-alias-interactive-bg-hover, rgba(28,35,51,0.06))'
export const ACTIVE_BG = 'var(--dsw-specific-sidebar-nav-item-active, rgba(45,102,247,0.12))'

const CHEVRON = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="%23787887" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')`

/** Interactive-state rules for the m9-* classes used across the surfaces. */
export const M9_CSS = `
.m9-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: transparent; color: inherit; padding: 5px 10px; font-size: 12px; font-family: inherit; line-height: 1.4; cursor: pointer; }
.m9-btn:hover { background: ${HOVER_BG}; }
.m9-btn:disabled { opacity: 0.55; cursor: default; }
.m9-btn:disabled:hover { background: transparent; }
.m9-btn-primary { background: ${ACCENT}; border-color: transparent; color: #fff; font-weight: 500; }
.m9-btn-primary:hover { background: ${ACCENT}; opacity: 0.88; }
.m9-btn-primary:disabled:hover { background: ${ACCENT}; opacity: 0.55; }
.m9-iconbtn { display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 6px; background: transparent; color: ${DIM}; padding: 4px; cursor: pointer; }
.m9-iconbtn:hover { background: ${HOVER_BG}; color: ${FG}; }
.m9-input, .m9-select, .m9-textarea { width: 100%; box-sizing: border-box; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: ${BG}; color: inherit; padding: 6px 9px; font-size: 12.5px; font-family: inherit; line-height: 1.5; }
.m9-input::placeholder, .m9-textarea::placeholder { color: ${DIM}; opacity: 0.7; }
.m9-input:focus, .m9-select:focus, .m9-textarea:focus { outline: none; border-color: ${ACCENT}; box-shadow: 0 0 0 3px rgba(45,102,247,0.18); }
.m9-select { appearance: none; -webkit-appearance: none; padding-right: 26px; background-image: ${CHEVRON}; background-repeat: no-repeat; background-position: right 9px center; cursor: pointer; }
.m9-textarea { resize: vertical; }
.m9-nav-item { display: flex; align-items: center; gap: 8px; width: 100%; border: none; border-radius: 8px; background: transparent; color: inherit; padding: 7px 9px; font-size: 13px; font-family: inherit; cursor: pointer; text-align: left; }
.m9-nav-item:hover { background: ${HOVER_BG}; }
.m9-nav-item.active, .m9-nav-item.active:hover { background: ${ACTIVE_BG}; color: ${ACCENT}; font-weight: 600; }
.m9-chip { border: 1px solid ${BORDER}; border-radius: 999px; background: transparent; color: ${DIM}; padding: 3px 11px; font-size: 11px; font-family: inherit; cursor: pointer; }
.m9-chip:hover { color: ${FG}; border-color: ${BORDER_STRONG}; }
.m9-chip.active { background: ${ACTIVE_BG}; color: ${ACCENT}; border-color: transparent; font-weight: 600; }
.m9-row { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; padding: 5px 10px; font-family: inherit; cursor: pointer; }
.m9-row:hover { background: ${HOVER_BG}; }
.m9-row.active { background: ${ACTIVE_BG}; }
.m9-link { color: ${ACCENT}; text-decoration: none; }
.m9-link:hover { text-decoration: underline; }
.m9-md { font-size: 13px; line-height: 1.65; overflow-wrap: break-word; }
.m9-md h1, .m9-md h2, .m9-md h3, .m9-md h4 { margin: 1em 0 0.4em; line-height: 1.35; font-weight: 600; }
.m9-md h1 { font-size: 17px; } .m9-md h2 { font-size: 15px; } .m9-md h3, .m9-md h4 { font-size: 13.5px; }
.m9-md p { margin: 0.5em 0; }
.m9-md ul, .m9-md ol { margin: 0.4em 0; padding-left: 1.4em; }
.m9-md li { margin: 0.15em 0; }
.m9-md a { color: ${ACCENT}; text-decoration: none; }
.m9-md a:hover { text-decoration: underline; }
.m9-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: ${HOVER_BG}; padding: 1px 5px; border-radius: 5px; }
.m9-md pre { background: ${BG_SUNK}; border: 1px solid ${BORDER}; border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 0.6em 0; line-height: 1.6; tab-size: 2; }
.m9-md pre code { background: transparent; padding: 0; display: block; white-space: pre; }
/* 组存档频道里的 markdown：长串字符（路径/标识符）必须断行，代码块横向滚动
   且不撑破卡片。作用域限定在频道内，收件箱详情的 .m9-md 表现不变。 */
.m9-letter-md { overflow-wrap: anywhere; word-break: break-word; min-width: 0; }
.m9-letter-md pre { overflow-x: auto; max-width: 100%; }
/* 宽表格不撑破卡片：表格块级化后在自身内部横向滚动；单元格允许断行。 */
.m9-letter-md table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.m9-letter-md td, .m9-letter-md th { overflow-wrap: anywhere; }
.m9-letter-md img { max-width: 100%; }
.m9-letterhead { display: flex; flex: 1; align-items: center; gap: 6px; width: 100%; border: none; background: transparent; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; min-width: 0; }
/* Syntax highlighting (Shiki css-variables theme): the palette maps token
   variables onto shell colors, so one render serves both themes. */
.m9-md pre code {
  --shiki-foreground: ${FG};
  --shiki-background: transparent;
  --shiki-token-constant: #d97706;
  --shiki-token-string: #2da44e;
  --shiki-token-string-expression: #2da44e;
  --shiki-token-comment: ${DIM};
  --shiki-token-keyword: ${ACCENT};
  --shiki-token-parameter: ${FG};
  --shiki-token-function: ${FG};
  --shiki-token-punctuation: ${DIM};
  --shiki-token-link: ${ACCENT};
}
.m9-md blockquote { margin: 0.6em 0; padding: 2px 12px; border-left: 3px solid ${ACCENT}; color: ${DIM}; border-radius: 0 6px 6px 0; }
.m9-md table { border-collapse: collapse; margin: 0.6em 0; }
.m9-md th, .m9-md td { border: 1px solid ${BORDER}; padding: 4px 10px; font-size: 12px; }
.m9-md th { background: ${BG_SUNK}; font-weight: 600; }
.m9-md hr { border: none; border-top: 1px solid ${BORDER}; margin: 1em 0; }
.m9-spin { animation: m9-rotate 0.9s linear infinite; }
@keyframes m9-rotate { to { transform: rotate(360deg); } }
@media (max-width: 860px) {
  .m9-nav { width: 148px !important; }
  .m9-listcol { width: 250px !important; }
}
`
