/** The host page shell. The UI itself is built by dist/harness.js (src/harness). */
export function harnessPage(viewParam: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>genui dev</title>
    <style>${CSS}</style>
  </head>
  <body>
    <div id="app" data-view-url="/?${viewParam}"></div>
    <script type="module" src="/__genui/harness.js"></script>
  </body>
</html>
`;
}

const CSS = `
:root { color-scheme: light; --line: #e4e2da; --muted: #6b6a64; --accent: #2f6feb; --bad: #c2410c; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1c1b18; }
* { box-sizing: border-box; }
body { margin: 0; background: #fbfaf7; }
#app { display: grid; grid-template-columns: 340px 1fr; height: 100vh; }
aside { border-right: 1px solid var(--line); overflow-y: auto; background: #fff; }
header { display: flex; align-items: baseline; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: #fff; z-index: 1; }
header b { font-size: 14px; }
header .name { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
.pill { margin-left: auto; font-size: 11px; padding: 1px 8px; border-radius: 99px; background: #e7f5ea; color: #1f7a36; }
.pill.off { background: #fdeee6; color: var(--bad); }
section { padding: 12px 14px; border-bottom: 1px solid var(--line); }
h2 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; align-items: center; gap: 8px; }
h2 .tabs { margin-left: auto; text-transform: none; letter-spacing: 0; }
.tabs button { border: 0; background: none; padding: 0 4px; color: var(--muted); cursor: pointer; font: inherit; font-size: 12px; }
.tabs button[aria-pressed="true"] { color: #1c1b18; font-weight: 600; }
label.field { display: block; margin-bottom: 10px; }
label.field > span { display: block; font-weight: 500; margin-bottom: 3px; }
label.field > span i { font-style: normal; color: var(--muted); font-weight: 400; }
label.field small { display: block; color: var(--muted); margin-top: 2px; }
input[type=text], input[type=number], select, textarea { width: 100%; font: inherit; padding: 5px 7px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: inherit; }
textarea { font-family: ui-monospace, monospace; font-size: 12px; min-height: 64px; resize: vertical; }
textarea.big { min-height: 180px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.row > label { display: flex; align-items: center; gap: 4px; }
.row select, .row input[type=number] { width: auto; }
button.primary, button.secondary { font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--accent); }
button.primary { background: var(--accent); color: #fff; }
button.secondary { background: #fff; color: var(--accent); }
.error { color: var(--bad); font-size: 12px; margin: 4px 0 0; white-space: pre-wrap; }
aside .tool { border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin-bottom: 8px; }
aside .tool code { font-weight: 600; }
.hint { color: var(--muted); margin: 0; }
main { display: grid; grid-template-rows: 1fr minmax(140px, 32%); min-height: 0; }
#chat { overflow: auto; padding: 24px; background: #f5f4ef; color-scheme: light; }
#chat.dark { background: #1f1e1d; color-scheme: dark; }
#chat .frame { margin: 0 auto; }
#chat .bubble { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
#chat.dark .bubble { color: #a3a29d; }
#chat iframe { display: block; width: 100%; border: 0; height: 120px; }
#chat.fullscreen { position: fixed; inset: 0; z-index: 10; padding: 0; }
#chat.fullscreen .frame { max-width: none !important; height: 100%; }
#chat.fullscreen iframe { height: 100% !important; }
#log { border-top: 1px solid var(--line); overflow: auto; background: #fff; font-family: ui-monospace, monospace; font-size: 12px; }
#log .bar { position: sticky; top: 0; background: #fff; display: flex; padding: 6px 12px; border-bottom: 1px solid var(--line); font-family: ui-sans-serif, system-ui, sans-serif; }
#log .bar button { margin-left: auto; border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; }
#log .entry { display: grid; grid-template-columns: 64px 150px 1fr; gap: 8px; padding: 3px 12px; border-bottom: 1px solid #f3f2ee; }
#log .entry time { color: var(--muted); }
#log .entry b { font-weight: 600; }
#log .entry.model b, #log .entry.message b { color: #7c3aed; }
#log .entry.tool b { color: var(--accent); }
#log .entry.warn b { color: var(--bad); }
#log .entry pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
`;
