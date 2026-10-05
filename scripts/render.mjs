// Renders the bridge's Discord payloads (cards, notes, the reason form) as Discord-like HTML, for scripts/preview.mjs and
// scripts/demo.mjs. Static HTML and inline CSS only: no script, no font, no image, no network. Times show in UTC.

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const hhmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);
const relative = (sec, now) => {
  const min = Math.round((sec * 1000 - now) / 60_000);
  const n = Math.abs(min);
  const text = n < 60 ? `${n} minute${n === 1 ? '' : 's'}` : `${Math.round(n / 60)} hour${Math.round(n / 60) === 1 ? '' : 's'}`;
  return min >= 0 ? `in ${text}` : `${text} ago`;
};
/** Discord's `f` style: the date and the time, "4 October 2026 14:52" (in UTC here). */
const full = (sec) => `${new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} ${hhmm(sec)}`;
/** Discord markdown, as far as the bridge uses it: escapes, bold and timestamps. Mentions stay as text, as in an embed. */
export const md = (text, now) => esc(text)
  .replace(/\\(&lt;|&gt;|&amp;|.)/g, (_, c) => `&#${c.startsWith('&') ? { '&lt;': 60, '&gt;': 62, '&amp;': 38 }[c] : c.codePointAt(0)};`)
  .replace(/&lt;t:(\d+):t&gt;/g, (_, s) => `<time>${hhmm(s)}</time>`)
  .replace(/&lt;t:(\d+):f&gt;/g, (_, s) => `<time>${full(s)}</time>`)
  .replace(/&lt;t:(\d+):R&gt;/g, (_, s) => `<time>${relative(s, now)}</time>`)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const STYLE = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger' };
const rows = (components) => components.map((r) => `<div class="row">${r.components.map((b) =>
  `<button class="${STYLE[b.style]}"${b.disabled ? ' disabled' : ''} title="${esc(b.custom_id)}">${esc(b.label)}</button>`).join('')}</div>`).join('');
const head = (now) => `<span class="av">sb</span><div class="body"><div class="meta"><b>sage bridge</b> <span class="app">APP</span> · ${hhmm(now / 1000)}</div>`;
/** A message of the bridge: its text, its card (an embed) and its buttons, each when it has one. */
export const message = ({ content, embeds: [e] = [], components = [] }, now) => `<div class="msg">${head(now)}${content ? `<div>${md(content, now)}</div>` : ''}${e ? `
  <div class="embed" style="border-color:#${e.color.toString(16).padStart(6, '0')}"><div class="title">${esc(e.title)}</div><div class="desc">${md(e.description, now)}</div>
  ${(e.fields ?? []).map((f) => `<div class="field"><div class="fname">${esc(f.name)}</div><div class="fvalue">${md(f.value, now)}</div></div>`).join('')}
  ${e.footer ? `<div class="footer">${esc(e.footer.text)}</div>` : ''}</div>` : ''}${rows(components)}</div></div>`;
/** A private note: only the person who pressed sees it. */
export const noteHtml = (n, now) => `<div class="msg eph">${head(now)}
  <div class="ephnote">Only you can see this · Dismiss message</div><div>${md(n.content, now)}</div>${rows(n.components ?? [])}</div></div>`;
export const modalHtml = (m) => `<div class="modal"><h3>${esc(m.title)}</h3>${m.components.map(({ components: [i] }) =>
  `<label>${esc(i.label)}<textarea placeholder="${esc(i.placeholder)}" maxlength="${i.max_length}"></textarea></label>`).join('')}<div class="mbtns"><span>Cancel</span><button class="primary">Submit</button></div></div>`;
export const CSS = `
  body { margin: 0; background: #313338; color: #dbdee1; font: 15px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  .banner { background: #f0b232; color: #1e1f22; font-weight: 600; padding: 6px 16px; font-size: 13px; }
  section { padding: 16px 24px 20px; border-bottom: 1px solid #1e1f22; max-width: 860px; }
  h2 { font-size: 15px; margin: 0 0 2px; color: #f2f3f5; } .about { color: #949ba4; font-size: 13px; margin: 0 0 12px; }
  .msg { display: flex; gap: 12px; margin-top: 10px; } .av { flex: none; width: 40px; height: 40px; border-radius: 50%; background: #5865f2; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
  .body { min-width: 0; flex: 1; } .meta { color: #949ba4; font-size: 12px; margin-bottom: 4px; } .meta b { color: #f2f3f5; font-size: 15px; }
  .app { background: #5865f2; color: #fff; font-size: 10px; border-radius: 3px; padding: 0 4px; vertical-align: middle; }
  .embed { background: #2b2d31; border-left: 4px solid; border-radius: 4px; padding: 10px 14px 10px 12px; max-width: 560px; }
  .title { font-weight: 600; color: #f2f3f5; margin-bottom: 6px; } .desc { font-size: 14px; white-space: pre-wrap; }
  .field { margin-top: 10px; } .fname { font-weight: 600; color: #f2f3f5; font-size: 14px; } .fvalue { font-size: 14px; white-space: pre-wrap; }
  .footer { color: #949ba4; font-size: 12px; margin-top: 10px; } time { background: #404249; border-radius: 3px; padding: 0 2px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; } button { border: 0; border-radius: 3px; padding: 6px 14px; font: inherit; font-size: 14px; color: #fff; }
  button:disabled { opacity: .5; } .primary { background: #5865f2; } .secondary { background: #4e5058; } .success { background: #248046; } .danger { background: #da373c; }
  .eph { background: rgba(88,101,242,.08); border-left: 2px solid #5865f2; padding: 6px 8px; } .ephnote { color: #949ba4; font-size: 12px; margin-bottom: 4px; }
  .modal { background: #313338; border: 1px solid #1e1f22; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 16px; max-width: 440px; margin-top: 12px; }
  .modal h3 { margin: 0 0 12px; color: #f2f3f5; font-size: 18px; } label { display: block; font-size: 12px; font-weight: 600; color: #b5bac1; text-transform: uppercase; }
  textarea { display: block; width: 100%; box-sizing: border-box; min-height: 72px; margin-top: 6px; background: #1e1f22; color: #dbdee1; border: 0; border-radius: 3px; padding: 8px; font: inherit; font-size: 14px; text-transform: none; }
  .mbtns { display: flex; justify-content: flex-end; gap: 16px; align-items: center; margin-top: 14px; color: #dbdee1; }
`;
