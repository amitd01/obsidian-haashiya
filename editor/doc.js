// doc.js — Margin's document format and its mapping to/from the editor DOM.
//
// A Margin file is plain Markdown plus two inline marks, so it stays readable anywhere:
//   {{original|other|>shown|~ai idea}}   inline alternates
//        '>' marks the version currently shown (default: the first, i.e. the original)
//        '~' marks a version suggested by AI (provenance is kept)
//        '|', '}' and '\' inside a version are backslash-escaped
//   ~~ghosted text~~                     dimmed "maybe cut" text, dropped from clean export
//   <!--stash "text"-->                  where a passage was stashed in the overflow (⌘J), carrying the
//                                        text as a JSON string so it can be put back. An HTML comment:
//                                        hidden by Markdown renderers, the text survives anywhere
// Everything after a line containing only OVERFLOW is the overflow panel's text.

export const OVERFLOW = '<!-- overflow -->';
export const ZW = /\u200B/g; // zero-width caret slots placed around non-editable alternates

/* ---------- whole document ---------- */

export function splitDoc(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const k = lines.findIndex(l => l.trim() === OVERFLOW);
  if (k < 0) return { body: md.replace(/\n+$/, ''), overflow: '' };
  return {
    body: lines.slice(0, k).join('\n').replace(/\n+$/, ''),
    overflow: lines.slice(k + 1).join('\n').trim(),
  };
}

export function joinDoc(body, overflow) {
  const b = body.replace(/\n+$/, '');
  return overflow.trim() ? `${b}\n\n${OVERFLOW}\n${overflow.trim()}\n` : `${b}\n`;
}

/* ---------- inline parsing: text -> nodes ---------- */

// Stash markers: JSON keeps quotes/newlines safe; "--" is escaped so the text can't close the comment.
const STASH = '<!--stash ';
const encStash = t => `${STASH}${JSON.stringify(t).replace(/--/g, '-\\u002d')}-->`;

const unesc = s => s.replace(/\\(.)/g, '$1');
const escOpt = s => s.replace(/[\\|}]/g, '\\$&').replace(/^[>~]/, '\\$&');

// Index of the next unescaped `tok` at or after `from`, or -1.
function findClose(s, from, tok) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s.startsWith(tok, j)) return j;
  }
  return -1;
}

function parseAlt(inner) {
  const raw = [];
  let cur = '';
  for (let j = 0; j < inner.length; j++) {
    if (inner[j] === '\\') { cur += inner[j] + (inner[j + 1] ?? ''); j++; continue; }
    if (inner[j] === '|') { raw.push(cur); cur = ''; continue; }
    cur += inner[j];
  }
  raw.push(cur);
  let shown = 0;
  const opts = raw.map((r, k) => {
    let j = 0, ai = false;
    while (r[j] === '>' || r[j] === '~') { if (r[j] === '>') shown = k; else ai = true; j++; }
    return { text: unesc(r.slice(j)), ai };
  });
  return { t: 'alt', opts, i: shown };
}

export function parseInline(s) {
  const out = [];
  let buf = '', i = 0;
  const flush = () => { if (buf) out.push({ t: 'text', v: buf }); buf = ''; };
  while (i < s.length) {
    if (s.startsWith('{{', i)) {
      const end = findClose(s, i + 2, '}}');
      if (end > 0) { flush(); out.push(parseAlt(s.slice(i + 2, end))); i = end + 2; continue; }
    }
    if (s.startsWith(STASH, i)) {
      const end = s.indexOf('-->', i);
      let text = null;
      try { text = JSON.parse(s.slice(i + STASH.length, end)); } catch { /* not ours: leave as text */ }
      if (end > 0 && typeof text === 'string') { flush(); out.push({ t: 'stash', text }); i = end + 3; continue; }
    }
    if (s.startsWith('~~', i)) {
      const end = s.indexOf('~~', i + 2);
      if (end > 0) { flush(); out.push({ t: 'ghost', kids: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    buf += s[i++];
  }
  flush();
  return out;
}

/* ---------- nodes -> DOM ---------- */

export function makeAlt(opts, i = 0) {
  const s = document.createElement('span');
  s.className = 'alt';
  s.contentEditable = 'false'; // versions are edited in the side panel, not inline
  setAlt(s, opts, i);
  return s;
}

// The stash marker: an empty, non-editable span (drawn by CSS) whose data-text is the stashed passage.
export function makeStash(text) {
  const s = document.createElement('span');
  s.className = 'stash';
  s.contentEditable = 'false';
  s.dataset.text = text;
  const preview = text.replace(/\s+/g, ' ');
  s.title = `Stashed: “${preview.length > 80 ? preview.slice(0, 80) + '…' : preview}” — click to put it back`;
  return s;
}

export const getAlt = s => ({ opts: JSON.parse(s.dataset.opts), i: +s.dataset.i });

export function setAlt(s, opts, i) {
  i = Math.min(Math.max(0, i), opts.length - 1);
  s.dataset.opts = JSON.stringify(opts);
  s.dataset.i = i;
  s.textContent = opts[i].text;
  s.dataset.dots = opts.length > 1 ? opts.map((_, k) => (k === i ? '●' : '○')).join('') : '';
  s.classList.toggle('variant', i > 0);   // showing something other than the original
  s.classList.toggle('single', opts.length < 2);
}

export function appendInline(el, nodes) {
  for (const n of nodes) {
    if (n.t === 'text') el.append(n.v);
    else if (n.t === 'alt') el.append(makeAlt(n.opts, n.i));
    else if (n.t === 'stash') el.append(makeStash(n.text));
    else { const g = document.createElement('span'); g.className = 'ghost'; appendInline(g, n.kids); el.append(g); }
  }
}

// Give the caret somewhere to land when an alternate starts or ends a line (WebKit quirk).
export function padLine(line) {
  if (!line) return;
  const solid = n => n?.classList?.contains('alt') || n?.classList?.contains('stash'); // caret can't land beside these
  if (solid(line.firstChild)) line.prepend('\u200B');
  if (solid(line.lastChild)) line.append('\u200B');
  line.querySelectorAll('br').forEach(br => { if (line.textContent.replace(ZW, '').length) br.remove(); });
  if (!line.firstChild) line.append(document.createElement('br'));
}

export function lineEl(text) {
  const d = document.createElement('div');
  appendInline(d, parseInline(text));
  padLine(d);
  return d;
}

export function renderBody(ed, body) {
  ed.replaceChildren(...body.split('\n').map(lineEl));
}

/* ---------- DOM -> text ---------- */

const isBlock = n => n.nodeType === 1 && /^(DIV|P|H\d|LI|UL|OL|BLOCKQUOTE|PRE)$/.test(n.nodeName);

// Serialize one container's inline content. mode: 'md' keeps marks, 'clean' resolves them.
function walk(el, mode) {
  let s = '';
  const kids = [...el.childNodes];
  kids.forEach((n, k) => {
    if (n.nodeType === 3) s += n.nodeValue;
    else if (n.nodeName === 'BR') { if (k < kids.length - 1) s += '\n'; }
    else if (isBlock(n)) s += (s ? '\n' : '') + walk(n, mode);
    else if (n.classList?.contains('alt')) {
      const { opts, i } = getAlt(n);
      s += mode === 'clean' || opts.length < 2
        ? opts[i].text
        : '{{' + opts.map((o, j) => (j === i && i > 0 ? '>' : '') + (o.ai ? '~' : '') + escOpt(o.text)).join('|') + '}}';
    } else if (n.classList?.contains('ghost')) s += mode === 'clean' ? '' : '~~' + walk(n, mode) + '~~';
    else if (n.classList?.contains('stash')) s += mode === 'clean' ? '' : encStash(n.dataset.text);
    else s += walk(n, mode); // flags and any stray inline element: keep the text
  });
  return s;
}

// Lines of a root container; tolerant of the shapes contenteditable produces.
function lines(root, mode) {
  const out = [];
  let cur = null;
  for (const n of root.childNodes) {
    if (isBlock(n)) { if (cur !== null) { out.push(cur); cur = null; } out.push(...walk(n, mode).split('\n')); }
    else if (n.nodeName === 'BR') { out.push(cur ?? ''); cur = null; }
    else cur = (cur ?? '') + walk({ childNodes: [n] }, mode);
  }
  if (cur !== null) out.push(cur);
  return out.map(l => l.replace(ZW, '').replace(/\u00A0/g, ' '));
}

const tidy = l => l.replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/ +([.,;:!?])/g, '$1').replace(/[ \t]+$/, '');

export const toMarkdown = ed => lines(ed, 'md').join('\n');
export const toClean = ed => lines(ed, 'clean').map(tidy).join('\n').replace(/\n{3,}/g, '\n\n').trim();
export const cleanText = node => tidy(walk(node, 'clean').replace(ZW, ''));
export function fragmentToMarkdown(frag) {
  const d = document.createElement('div');
  d.append(frag);
  return lines(d, 'md').join('\n');
}

/* ---------- Markdown styling while editing (display only — the text never changes) ----------
   Marks stay in the text but fade (.md-mark); content gets bold/italic/code/link styling.
   Decoration spans are unknown to walk(), so they serialize as their plain text. */

// One alternation per inline construct; order matters (** before *).
const INLINE = new RegExp([
  /(?<b>\*\*(?=\S)(?<bt>[^*]+?)(?<=\S)\*\*)/,
  /(?<i>(?<![*\w])\*(?=[^\s*])(?<it>[^*]+?)(?<=[^\s*])\*(?![*\w]))/,
  /(?<u>(?<!\w)_(?=\S)(?<ut>[^_]+?)(?<=\S)_(?!\w))/,
  /(?<c>`(?<ct>[^`]+)`)/,
  /(?<l>\[(?<lt>[^\]]+)\]\((?<lu>[^)\s]+)\))/,
].map(r => r.source).join('|'), 'g');
const PREFIX = /^(\s*)(#{1,6} |[-*+] |\d+\. |> )/;

const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };

// Classify each line (heading, list, quote, rule, table, code fence) for CSS.
function lineKind(text, inFence) {
  if (/^\s*```/.test(text)) return 'fence';
  if (inFence) return 'code';
  const h = text.match(/^(#{1,6}) /);
  if (h) return 'h h' + h[1].length;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) return 'hr';
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(text) && text.includes('|')) return 'tsep';
  if (/^\s*\|.*\|\s*$/.test(text)) return 'tr';
  if (/^\s*>/.test(text)) return 'quote';
  if (/^\s*([-*+]|\d+\.) /.test(text)) return 'li';
  return '';
}

// Fragment for one text node: faded marks + styled content.
function styleText(text, { first, kind }) {
  const frag = document.createDocumentFragment();
  let rest = text;
  if (first && kind !== 'code') {
    const m = rest.match(PREFIX);
    if (m) { frag.append(m[1], span('md-mark', m[2])); rest = rest.slice(m[0].length); }
  }
  if (kind === 'code' || kind === 'fence' || kind === 'hr' || kind === 'tsep') { frag.append(rest); return frag; }
  let last = 0;
  for (const m of rest.matchAll(INLINE)) {
    frag.append(rest.slice(last, m.index));
    const g = m.groups;
    if (g.b) frag.append(span('md-mark', '**'), span('md-b', g.bt), span('md-mark', '**'));
    else if (g.i) frag.append(span('md-mark', '*'), span('md-i', g.it), span('md-mark', '*'));
    else if (g.u) frag.append(span('md-mark', '_'), span('md-i', g.ut), span('md-mark', '_'));
    else if (g.c) frag.append(span('md-mark', '`'), span('md-code', g.ct), span('md-mark', '`'));
    else frag.append(span('md-mark', '['), span('md-link', g.lt), span('md-mark', `](${g.lu})`));
    last = m.index + m[0].length;
  }
  frag.append(rest.slice(last));
  if (kind === 'tr') { // fade table pipes
    const out = document.createDocumentFragment();
    for (const n of [...frag.childNodes]) {
      if (n.nodeType !== 3) { out.append(n); continue; }
      n.nodeValue.split(/(\|)/).forEach(p => out.append(p === '|' ? span('md-mark', '|') : p));
    }
    return out;
  }
  return frag;
}

export function undecorate(ed) {
  ed.querySelectorAll('[class^="md-"]').forEach(s => s.replaceWith(s.textContent));
  ed.normalize();
}

export function decorate(ed) {
  undecorate(ed);
  let inFence = false;
  for (const line of ed.children) {
    const text = line.textContent.replace(ZW, '');
    const kind = lineKind(text, inFence);
    if (kind === 'fence') inFence = !inFence;
    line.className = kind;
    // Plain text nodes only — alternates keep their own rendering.
    const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
      acceptNode: t => (t.parentElement.closest('.alt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    for (let t; (t = w.nextNode());) nodes.push(t);
    nodes.forEach((t, k) => {
      if (!t.nodeValue.replace(ZW, '')) return;
      const first = k === 0 || (k === 1 && !nodes[0].nodeValue.replace(ZW, ''));
      t.replaceWith(styleText(t.nodeValue, { first: first && t.parentNode === line, kind }));
    });
  }
}
