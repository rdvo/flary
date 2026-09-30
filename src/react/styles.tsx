import * as React from "react";

/** Scoped Markdown defaults, independent of Tailwind or a global stylesheet. */
export const flaryMarkdownStyles = `
.flary-markdown{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;font:inherit;line-height:1.65;color:inherit}
.flary-markdown *{box-sizing:border-box}
.flary-markdown>:first-child{margin-top:0}.flary-markdown>:last-child{margin-bottom:0}
.flary-markdown p{margin:.75em 0}
.flary-markdown h1,.flary-markdown h2,.flary-markdown h3,.flary-markdown h4,.flary-markdown h5,.flary-markdown h6{margin:1.35em 0 .5em;font-weight:650;line-height:1.3;letter-spacing:-.015em;text-wrap:balance}
.flary-markdown h1{font-size:1.5em}.flary-markdown h2{font-size:1.3em}.flary-markdown h3{font-size:1.15em}.flary-markdown h4,.flary-markdown h5,.flary-markdown h6{font-size:1em}
.flary-markdown strong,.flary-markdown [data-streamdown="strong"]{font-weight:650}
.flary-markdown ul,.flary-markdown ol{margin:.75em 0;padding-left:1.5em;list-style-position:outside}.flary-markdown ul{list-style-type:disc}.flary-markdown ol{list-style-type:decimal}
.flary-markdown li{padding:0;margin:.3em 0}.flary-markdown li>p{margin:.4em 0}.flary-markdown li>ul,.flary-markdown li>ol{margin:.35em 0}.flary-markdown input[type="checkbox"]{margin-right:.5em;accent-color:var(--flary-accent,#1769e0)}
.flary-markdown a{color:var(--flary-accent,#1769e0);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}.flary-markdown a:hover{text-decoration-thickness:2px}
.flary-markdown blockquote{margin:1em 0;padding:.6em 1em;border:1px solid var(--flary-line,#d9dde1);border-radius:8px;background:var(--flary-code,#f7f8f9);color:var(--flary-muted,#687078);font-style:normal}.flary-markdown blockquote>:first-child{margin-top:0}.flary-markdown blockquote>:last-child{margin-bottom:0}
.flary-markdown hr{margin:1.5em 0;border:0;border-top:1px solid var(--flary-line,#d9dde1)}
.flary-markdown code{font-family:var(--flary-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:.88em;font-variant-ligatures:none}
.flary-markdown [data-streamdown="inline-code"]{padding:.12em .35em;border-radius:4px;background:var(--flary-code,#f7f8f9);color:inherit;white-space:break-spaces}
.flary-markdown [data-streamdown="code-block"]{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:0;width:100%;min-width:0;margin:1em 0;padding:0;overflow:hidden;border:1px solid var(--flary-line,#d9dde1);border-radius:10px;background:var(--flary-code,#f7f8f9);contain-intrinsic-size:none!important;content-visibility:visible!important}
.flary-markdown [data-streamdown="code-block-header"]{grid-area:1/1;display:flex;align-items:center;min-height:42px;padding:0 12px;border-bottom:1px solid var(--flary-line,#d9dde1);font:500 12px/1.4 var(--flary-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--flary-muted,#687078)}
.flary-markdown [data-streamdown="code-block-header"]>span{margin:0;text-transform:lowercase}
.flary-markdown [data-streamdown="code-block-header"]+div{grid-area:1/1;position:relative;top:auto;z-index:1;display:flex;align-items:center;justify-content:flex-end;margin:0;padding:0 6px;pointer-events:none}
.flary-markdown [data-streamdown="code-block-actions"]{display:flex;gap:4px;align-items:center;padding:0;border:0;border-radius:0;background:transparent;backdrop-filter:none;pointer-events:auto}
.flary-markdown button{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;padding:6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--flary-muted,#687078);font:inherit;cursor:pointer}
.flary-markdown button:hover{border-color:var(--flary-line,#d9dde1);background:var(--flary-panel,#fff);color:inherit}.flary-markdown button:disabled{opacity:.45;cursor:default}.flary-markdown button svg{display:block;flex-shrink:0}
.flary-markdown :is(button,a):focus-visible{outline:2px solid var(--flary-accent,#1769e0);outline-offset:2px}
.flary-markdown [data-streamdown="code-block-body"]{grid-area:2/1;min-width:0;overflow:auto;padding:14px;border:0;border-radius:0;background:transparent;font-size:inherit;overscroll-behavior:contain}
.flary-markdown pre{max-width:100%;margin:0;overflow:auto;white-space:pre;tab-size:2;text-align:left;line-height:1.6}
.flary-markdown pre code{display:block;padding:0;background:transparent;white-space:pre;overflow-wrap:normal;word-break:normal}
.flary-markdown pre code>span{display:block;min-height:1.6em}.flary-markdown pre code span[style]{color:var(--sdm-c,inherit);background:var(--sdm-tbg,transparent)}
.flary-markdown [data-streamdown="table-wrapper"]{display:flex;flex-direction:column;gap:8px;max-width:100%;min-width:0;margin:1em 0;padding:0;border:0;border-radius:0;background:transparent}
.flary-markdown [data-streamdown="table-wrapper"]>div{max-width:100%;overflow:auto;border:1px solid var(--flary-line,#d9dde1);border-radius:8px}
.flary-markdown [data-streamdown="table-wrapper"]>div:first-child:not(:last-child){display:flex;justify-content:flex-end;gap:4px;overflow:visible;border:0}
.flary-markdown table{width:100%;border-collapse:collapse;font-size:.92em;line-height:1.5}.flary-markdown th,.flary-markdown td{padding:9px 12px;border-bottom:1px solid var(--flary-line,#d9dde1);text-align:start;vertical-align:top}.flary-markdown th{background:var(--flary-code,#f7f8f9);font-weight:650}.flary-markdown tr:last-child td{border-bottom:0}
.flary-markdown :is(th,td) [data-streamdown="inline-code"]{white-space:nowrap;overflow-wrap:normal}
.flary-markdown img{display:block;max-width:100%;height:auto;border-radius:8px}
@media(prefers-reduced-motion:reduce){.flary-markdown *{animation:none!important;transition:none!important}}
`;

/** Small, token-driven defaults. Product apps can override every class. */
export const flaryReactStyles = `
${flaryMarkdownStyles}
.flary-artifact{margin:12px 0;overflow:hidden;border:1px solid var(--flary-line,#d9dde1);border-radius:14px;background:var(--flary-panel,#fff)}.flary-artifact__header{display:flex;align-items:center;min-height:40px;padding:8px 12px;border-bottom:1px solid var(--flary-line,#d9dde1);font-size:12px;font-weight:700}.flary-artifact__frame{display:block;width:100%;height:var(--flary-artifact-height);border:0;background:white}
.flary-user-input{display:grid;gap:12px;margin:12px 0;padding:14px;border:1px solid var(--flary-line,#d9dde1);border-radius:14px;background:var(--flary-panel,#fff)}.flary-user-input fieldset{min-width:0;margin:0;padding:0;border:0}.flary-user-input legend{display:grid;gap:3px;margin-bottom:9px}.flary-user-input legend span{color:var(--flary-muted,#687078);font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.flary-user-input__options{display:grid;gap:7px}.flary-user-input__options>label{display:flex;gap:9px;align-items:flex-start;padding:9px;border:1px solid var(--flary-line,#d9dde1);border-radius:10px;cursor:pointer}.flary-user-input__options strong,.flary-user-input__options small{display:block}.flary-user-input__options small{margin-top:2px;color:var(--flary-muted,#687078)}.flary-user-input__other{display:grid!important}.flary-user-input__other-label{font-size:11px;font-weight:700}.flary-user-input__other input{width:100%;min-height:38px;border:1px solid var(--flary-line,#d9dde1);border-radius:8px;padding:7px 9px;font:inherit}.flary-user-input>button{justify-self:start;min-height:38px;border:0;border-radius:9px;background:var(--flary-accent,#1769e0);color:white;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer}.flary-user-input :focus-visible{outline:3px solid color-mix(in srgb,var(--flary-accent,#1769e0) 28%,transparent);outline-offset:2px}.flary-secret-input{display:grid;gap:10px;margin:12px 0;padding:14px;border:1px solid var(--flary-line,#d9dde1);border-radius:14px;background:var(--flary-panel,#fff)}.flary-secret-input label{display:grid;gap:5px}.flary-secret-input label span{color:var(--flary-muted,#687078);font-size:12px}.flary-secret-input input{min-height:40px;border:1px solid var(--flary-line,#d9dde1);border-radius:8px;padding:8px 10px;font:inherit}.flary-secret-input button{justify-self:start;min-height:38px;border:0;border-radius:9px;background:var(--flary-accent,#1769e0);color:#fff;padding:8px 14px;font:inherit;font-weight:700}.flary-secret-input-required p{margin:0;color:var(--flary-muted,#687078)}@media(prefers-reduced-motion:reduce){.flary-markdown *{animation:none!important;transition:none!important}}
`;

export function FlaryReactStyles() {
  return <style data-flary-react-styles="">{flaryReactStyles}</style>;
}
