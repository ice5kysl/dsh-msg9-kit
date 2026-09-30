/**
 * Design tokens and the interactive-state stylesheet for dsh-msg9-kit's
 * browser face.
 *
 * Colors ride the dsh shell's `--dsw-alias-*` design tokens (the same ones the
 * shipped surfaces use), with fallbacks for older shells. Inline styles cannot
 * express :hover / :focus / :disabled, so every interactive element carries a
 * class from `M9_CSS`, injected once into document.head as a package-owned tag
 * by {@link ensureMsg9Styles} — never as a React-rendered `<style>` (dsh's
 * module loader claims untagged sheets and deletes them on a stranger's HMR).
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
/** 「我发出的信」卡片底色：选中态是给导航/行用的 12% 强调色，铺满整张信件卡片太重，
    这里单独给一档更淡的底色（可用 shell 变量覆盖），并保留 ACCENT 时间线节点做身份区分。 */
export const MINE_BG = 'var(--dsw-specific-mail-sent-bg, rgba(45,102,247,0.055))'

/** Interactive-state rules for the m9-* classes used across the surfaces. */
export const M9_CSS = `
.m9-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: transparent; color: inherit; padding: 5px 10px; font-size: 12px; font-family: inherit; line-height: 1.4; cursor: pointer; }
.m9-btn:hover { background: ${HOVER_BG}; }
.m9-btn:disabled { opacity: 0.55; cursor: default; }
.m9-btn:disabled:hover { background: transparent; }
// ⚠️ 主按钮的**背景**不能用 ${ACCENT}（= var(--dsw-alias-brand-primary)）。
// 那个 token 在外壳主题里是**会翻转成近白**的：
//     body                     → var(--dsw-static-neutral-bluish-1000) = #0f1115（近黑）
//     body[data-ds-dark-theme] → var(--dsw-static-neutral-bluish-50)   = #f9fafb（★近白）
// ⇒ 深色模式下 background 变 #f9fafb，而下面字色写死 #fff：**白字白底，对比度 1.06:1**，
//    按钮看上去是"空白"的（边框还恰好是 transparent，连轮廓都没有）。
// 主按钮是要人点的，可见性不能交给一个会翻转的 token ⇒ 用我们自己的强调色字面量
// （= 胶囊底色在用的 rgba(45,102,247,…) 那个蓝，写法保持一致）。
// ACCENT 本身保留：它当**字色**用时（nav/chip 的 active 态）深浅模式都正常。
.m9-btn-primary { background: #2d66f7; border-color: transparent; color: #fff; font-weight: 500; }
.m9-btn-primary:hover { background: #2d66f7; opacity: 0.88; }
.m9-btn-primary:disabled:hover { background: #2d66f7; opacity: 0.55; }
.m9-iconbtn { display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 6px; background: transparent; color: ${DIM}; padding: 4px; cursor: pointer; }
.m9-iconbtn:hover { background: ${HOVER_BG}; color: ${FG}; }
.m9-input, .m9-select, .m9-textarea { width: 100%; box-sizing: border-box; border: 1px solid ${BORDER_STRONG}; border-radius: 8px; background: ${BG}; color: inherit; padding: 6px 9px; font-size: 12.5px; font-family: inherit; line-height: 1.5; }
.m9-input::placeholder, .m9-textarea::placeholder { color: ${DIM}; opacity: 0.7; }
.m9-input:focus, .m9-select:focus, .m9-textarea:focus { outline: none; border-color: ${ACCENT}; box-shadow: 0 0 0 3px rgba(45,102,247,0.18); }
.m9-select { cursor: pointer; }
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

/** The package id dsh's client module loader knows us by (package.json name). */
export const CLIENT_PLUGIN_ID = 'dsh-msg9-kit'

/** The stylesheet tag's fingerprint: loader inventory key + our dedupe key. */
export const CSS_TAG_ID = `${CLIENT_PLUGIN_ID}/theme.css`

/** Minimal DOM face {@link ensureMsg9Styles} needs (real Document, or a test
 *  stub — the function is deliberately drivable in tests). */
export interface StylesDocument {
  head: { appendChild(node: unknown): unknown }
  createElement(tag: string): { textContent: string; setAttribute(name: string, value: string): void }
  querySelector(selector: string): unknown
}

/**
 * Inject {@link M9_CSS} into `document.head` once, TAGGED as our own.
 *
 * Two rules, both load-bearing (same failure as taskboard's T-15, 2026-09-30 —
 * dsh 点名本 kit 的 6 处 React <style> 同病）:
 *
 *  1. **Never let React own the tag.** dsh's client module loader claims every
 *     untagged `<style>` in the document for whichever plugin module
 *     materializes next (`style:not([data-plugin])` → `data-plugin = id`), and
 *     deletes `style[data-plugin=<pkg>]` when that package unloads or hot
 *     reloads. A React-rendered tag has no `data-plugin`, so it gets claimed by
 *     a stranger and later deleted behind React's back — the fiber still
 *     believes the node exists and never re-adds it, silently losing the whole
 *     stylesheet. Our tag is therefore born with `data-plugin` +
 *     `data-plugin-css` (the shipped dsh packages' convention), so the loader
 *     never claims it and our own unload removes exactly ours.
 *  2. **Idempotent + self-healing.** Keyed by `data-plugin-css`, so a second
 *     call (every surface mount, the client plugin's apply) is a no-op; if the
 *     tag ever disappears the next call puts it back.
 *
 * @param doc - document to inject into; defaults to the browser document and
 *   is a no-op when there is none (SSR / plain Node).
 */
export function ensureMsg9Styles(doc?: StylesDocument | null): void {
  const target = doc !== undefined ? doc : typeof document === 'undefined' ? null : (document as unknown as StylesDocument)
  if (!target) return
  if (target.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`)) return
  const tag = target.createElement('style')
  tag.setAttribute('data-plugin', CLIENT_PLUGIN_ID)
  tag.setAttribute('data-plugin-css', CSS_TAG_ID)
  tag.textContent = M9_CSS
  target.head.appendChild(tag)
}
