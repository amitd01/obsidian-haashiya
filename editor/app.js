// app.js — Margin's editor: wires the page, the document format (doc.js), AI (ai.js) and the host (host.js).
import * as Doc from './doc.js';
import * as Host from './host.js';
import * as AI from './ai.js';
import * as Preview from './preview.js';
import * as Sound from './sound.js';
import * as Publish from './publish.js';

const $ = s => document.querySelector(s);
const ed = $('#ed'), side = $('#side'), overflowEl = $('#overflow'), menu = $('#menu');
// path: the .md file on disk (null = untitled). suggest: name of an imported file, used for its first save.
// snapAt: when the last version-history snapshot was taken.
const state = { path: null, suggest: null, dirty: false, hover: null, current: null, tab: 'alts', snapAt: 0 };
// Crash-safe copy of this window's document. The first window keeps the original key, so drafts
// from before multi-window still restore; other windows add their label.
const DRAFT = Host.windowLabel === 'main' ? 'margin.draft' : `margin.draft.${Host.windowLabel}`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const WELCOME = `# {{The obvious, the easy and the possible|>The clear, the easy and the achievable|Three possibilities}}

Welcome to Margin. Words with a wavy underline hold {{alternates|other versions|~competing drafts}}. Hover one and press ↑ or ↓ to try each version in place, or click it to edit the list.

Select any text and press ⌘D to give it alternates, or right-click for AI suggestions. Dimmed text is ghosted: ~~still here, easy to ignore, and one right-click away from coming back.~~

Press ⌘G to ghost a selection and ⌘J to stash it in the overflow panel. Drop a Markdown, text or Word file on this window to open it. The Lab trims with AI, and the trim only dims; it never rewrites you. ⇧⌘C copies a clean version, ready for Substack or LinkedIn.

${Doc.OVERFLOW}
Spare paragraphs live here. They are saved with the document but left out of clean copies.`;

/* =========================================================================
   Document lifecycle
   ========================================================================= */

function load(md, path = null, suggest = null) {
  const { body, overflow } = Doc.splitDoc(md);
  Doc.renderBody(ed, body);
  overflowEl.value = overflow;
  state.path = path;
  state.suggest = suggest;
  state.current = null;
  state.snapAt = Date.now();
  clearFlags();                    // Lab findings belong to the previous document
  document.body.classList.remove('reading');
  hist.reset();
  renderAltPane();
  refresh();
  setDirty(false);
}

const serialize = () => Doc.joinDoc(Doc.toMarkdown(ed), overflowEl.value);

const docName = () => (state.path ? Host.basename(state.path) : state.suggest ? `${state.suggest} (imported)` : 'Untitled');

function setDirty(d) {
  state.dirty = d;
  const name = docName();
  $('#file').textContent = name + (d ? ' •' : '');
  Host.setTitle(`${name}${d ? ' — Edited' : ''}`, state.path);
}

// An untouched window (nothing opened, nothing typed) can take the next file instead of opening another.
const pristine = () => !state.path && !state.suggest && !state.dirty;

// Word count, Markdown styling, and the empty-editor guard.
function refresh() {
  if (!ed.firstChild) ed.append(Doc.lineEl(''));
  const sel = getSel();            // styling re-wraps text nodes; the selection survives by text offset
  Doc.decorate(ed);
  setSel(sel);
  const n = Doc.toClean(ed).split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  $('#count').textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;
}

// Called after every change: history, counts, dirty flag, autosave.
function changed(record = true) {
  if (record) hist.record();
  refresh();
  if (!side.hidden && state.tab === 'overflow') renderStashes();
  setDirty(true);
  scheduleSave();
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // Embedded (Obsidian): the parent owns the file and saves it; no draft of our own.
    if (Host.embedded) { Host.pushText(serialize()); setDirty(false); return snapshot(); }
    // Crash-safe draft in every mode; real file autosave only in the app with a known path.
    Host.store.set(DRAFT, JSON.stringify({ md: serialize(), path: state.path, suggest: state.suggest, dirty: state.dirty }));
    if (Host.native && state.path && state.dirty) {
      try { await Host.saveDoc(state.path, serialize()); setDirty(false); persistDraftClean(); snapshot(); }
      catch (e) { toast(e); }
    }
  }, 1200);
}
const persistDraftClean = () => Host.embedded || Host.store.set(DRAFT, JSON.stringify({ md: serialize(), path: state.path, suggest: state.suggest, dirty: false }));

// Before the document is replaced: write a named file, or ask about an unsaved draft. false = abort.
async function settle() {
  if (!state.dirty) return true;
  if (state.path && Host.native) return save();
  if (!Doc.toClean(ed).trim()) return true;
  const choice = await Host.askUnsaved(docName());
  return choice === 'save' ? save(true) : choice === 'discard';
}

// Show an opened file. Markdown is edited in place; text/Word arrive as an untitled draft.
function applyOpened(d) {
  if (!d) return;
  load(d.text, d.path, d.imported ? d.name : null);
  if (d.imported) {
    setDirty(true);
    scheduleSave(); // keep the import safe in the draft store until it's saved
    // PDF import is under review: say so every time, and leave the warning up long enough to read.
    if (/\.pdf$/i.test(d.file || '')) toast(`Imported “${d.name}” from PDF — this feature is under review and results may be erratic: check the text against the original. ⌘S saves it as Markdown.`, 9000);
    else toast(`Imported “${d.name}” as a new draft — ⌘S saves it as Markdown`);
  } else {
    remember(d.path);
    persistDraftClean();
    snapshot(true); // the file as it was opened: always something to go back to
  }
}

// In the app each document gets its own window; an untouched window is reused.
// In a browser there is one page, so the document is replaced (after settle()).
async function openFile() {
  try {
    if (!Host.native) { if (await settle()) applyOpened(await Host.openDoc()); return; }
    const d = await Host.openDoc();
    if (!d || (await Host.focusDoc(d.path))) return;
    if (pristine()) applyOpened(d);
    else await Host.openWindow({ path: d.file });
  } catch (e) { toast(e); }
}

// From Finder, drag-and-drop or Open Recent.
async function openPath(path) {
  if (Host.native) {
    try {
      if (await Host.focusDoc(path)) return;
      if (!pristine()) return await Host.openWindow({ path });
    } catch (e) { return toast(e); }
  }
  if (!(await settle())) return;
  try { applyOpened(await Host.openPath(path)); }
  catch (e) {
    toast(e);
    if (recent().includes(path)) { // moved, deleted, or no longer accessible: drop it from Open Recent
      const list = recent().filter(p => p !== path);
      Host.store.set('margin.recent', JSON.stringify(list));
      Host.setRecent(list);
    }
  }
}

async function save(as = false) {
  try {
    const p = await Host.saveDoc(as ? null : state.path, serialize(), state.suggest);
    if (!p) return false;
    state.path = p;
    state.suggest = null;
    remember(p);
    setDirty(false);
    persistDraftClean();
    snapshot(true);
    return true;
  } catch (e) { toast(e); return false; }
}

async function newDoc() {
  if (Host.native) return Host.openWindow().catch(toast); // ⌘N normally goes straight to Rust; this is the fallback
  if (!(await settle())) return;
  load('');
  Host.store.set('margin.last', null);
  ed.focus();
}

/* ---------- recent files (File ▸ Open Recent) ---------- */

function recent() {
  try { return JSON.parse(Host.store.get('margin.recent') || '[]'); } catch { return []; }
}
function remember(path) {
  Host.store.set('margin.last', path);
  const list = [path, ...recent().filter(p => p !== path)].slice(0, 10);
  Host.store.set('margin.recent', JSON.stringify(list));
  Host.setRecent(list);
}
function clearRecent() {
  Host.store.set('margin.recent', '[]');
  Host.setRecent([]);
}

/* =========================================================================
   Undo / redo — snapshots of the Markdown, so custom DOM edits undo cleanly
   ========================================================================= */

const hist = {
  undo: [], redo: [], last: '', caret: null,
  reset() { this.undo = []; this.redo = []; this.last = Doc.toMarkdown(ed); this.caret = null; },
  record() {
    const md = Doc.toMarkdown(ed);
    if (md !== this.last) {
      this.undo.push({ md: this.last, caret: this.caret });
      if (this.undo.length > 500) this.undo.shift();
      this.redo = [];
      this.last = md;
    }
    this.caret = getCaret();
  },
  step(from, to) {
    clearTimeout(typingTimer);
    this.record();
    const s = from.pop();
    if (!s) return;
    to.push({ md: this.last, caret: getCaret() });
    Doc.renderBody(ed, s.md);
    this.last = s.md;
    this.caret = s.caret;
    setCaret(s.caret);
    renderAltPane();
    changed(false);
  },
};
const undo = () => hist.step(hist.undo, hist.redo);
const redo = () => hist.step(hist.redo, hist.undo);

// A DOM position as {line, off} (text offset within the line): survives re-rendering and re-styling.
function toPoint(node, offset) {
  const line = lineOf(node);
  if (!line) return null;
  const r = document.createRange();
  r.setStart(line, 0);
  r.setEnd(node, offset);
  return { line: [...ed.children].indexOf(line), off: r.toString().length };
}

function fromPoint(p) {
  const line = p && ed.children[p.line];
  if (!line) return null;
  let left = p.off;
  const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let t; (t = w.nextNode());) {
    if (left <= t.length) {
      const alt = t.parentElement.closest('.alt');
      return alt ? [alt.parentNode, [...alt.parentNode.childNodes].indexOf(alt) + 1] : [t, left];
    }
    left -= t.length;
  }
  return [line, line.childNodes.length];
}

// Whole selection (anchor + focus) — null when it isn't in the editor, so we never steal focus.
function getSel() {
  const s = getSelection();
  if (!s.rangeCount || !ed.contains(s.anchorNode)) return null;
  return { a: toPoint(s.anchorNode, s.anchorOffset), f: toPoint(s.focusNode, s.focusOffset) };
}
function setSel(sel) {
  const a = sel && fromPoint(sel.a), f = sel && fromPoint(sel.f);
  if (a && f) getSelection().setBaseAndExtent(a[0], a[1], f[0], f[1]);
}
const getCaret = () => getSel()?.a ?? null;
const setCaret = c => { const p = fromPoint(c); if (p) setSel({ a: c, f: c }); };
const placeRange = r => { const s = getSelection(); s.removeAllRanges(); s.addRange(r); };

/* =========================================================================
   Selection helpers
   ========================================================================= */

const lineOf = n => { while (n && n.parentNode !== ed) n = n.parentNode; return n || null; };
const closest = (n, sel) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.(sel) || null;

function selectionRange() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  return ed.contains(r.commonAncestorContainer) ? r : null;
}

// Pull range ends out of the editor root and away from half-selected alternates.
function normalizeRange(r) {
  if (r.startContainer === ed) { const l = ed.childNodes[r.startOffset]; if (l) r.setStart(l, 0); }
  if (r.endContainer === ed) { const l = ed.childNodes[r.endOffset - 1]; if (l) r.setEnd(l, l.childNodes.length); }
  // A triple-click selection ends at offset 0 of the next line: keep it on its own line.
  const sl = lineOf(r.startContainer), el2 = lineOf(r.endContainer);
  if (sl && el2 && sl !== el2 && r.endOffset === 0 && r.toString().endsWith('\n') === false) {
    const pre = document.createRange(); pre.setStart(el2, 0); pre.setEnd(r.endContainer, 0);
    if (!pre.toString()) r.setEnd(sl, sl.childNodes.length);
  }
  const a = closest(r.startContainer, '.alt'); if (a) r.setStartBefore(a);
  const b = closest(r.endContainer, '.alt'); if (b) r.setEndAfter(b);
  return r;
}

// Split a range into one sub-range per line (wrapping spans can't cross lines).
function perLine(r) {
  const first = lineOf(r.startContainer), last = lineOf(r.endContainer);
  if (!first || !last) return [];
  const kids = [...ed.children], out = [];
  for (let k = kids.indexOf(first); k <= kids.indexOf(last); k++) {
    const sub = document.createRange();
    sub.selectNodeContents(kids[k]);
    if (kids[k] === first) sub.setStart(r.startContainer, r.startOffset);
    if (kids[k] === last) sub.setEnd(r.endContainer, r.endOffset);
    if (sub.toString().replace(Doc.ZW, '').trim()) out.push(sub);
  }
  return out;
}

function unwrap(n) {
  const p = n.parentNode;
  n.replaceWith(...n.childNodes);
  p?.normalize();
}

/* =========================================================================
   Alternates
   ========================================================================= */

function addAlternates(r = selectionRange()) {
  if (!r || r.collapsed) {
    if (state.hover) return openAlt(state.hover);
    return toast('Select a word, phrase or paragraph first');
  }
  normalizeRange(r);
  if (lineOf(r.startContainer) !== lineOf(r.endContainer)) return toast('Alternates work within one paragraph');
  const only = r.cloneContents();
  if (only.querySelector?.('.alt')) {
    const a = closest(r.startContainer.childNodes?.[r.startOffset] || r.startContainer, '.alt');
    if (a && r.toString().replace(Doc.ZW, '').trim() === a.textContent.trim()) return openAlt(a); // selected exactly one
    return toast('That selection already contains alternates');
  }
  const text = r.toString().replace(Doc.ZW, '');
  if (!text.trim()) return;
  const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
  r.deleteContents();
  const span = Doc.makeAlt([{ text: text.trim(), ai: false }]);
  const frag = document.createDocumentFragment();
  if (lead) frag.append(lead);
  frag.append(span);
  if (trail) frag.append(trail);
  r.insertNode(frag);
  Doc.padLine(lineOf(span));
  changed();
  openAlt(span);
  return span;
}

function openAlt(s) {
  state.current = s;
  showTab('alts');
  renderAltPane();
}

function useOpt(s, k) {
  const { opts } = Doc.getAlt(s);
  Doc.setAlt(s, opts, k);
  fixArticle(s);
  changed();
  side.querySelectorAll('.opt').forEach((row, j) => row.classList.toggle('on', j === k));
}

function cycle(s, dir) {
  const { opts, i } = Doc.getAlt(s);
  if (opts.length < 2) return;
  Doc.setAlt(s, opts, (i + dir + opts.length) % opts.length);
  fixArticle(s);
  changed();
  if (state.current === s) renderAltPane();
}

// Keep "a"/"an" right when the word after it changes.
function fixArticle(s) {
  const prev = s.previousSibling;
  if (!prev || prev.nodeType !== 3) return;
  const m = prev.nodeValue.match(/(^|[\s(“"'])(a|an|A|An)(\s+)$/);
  if (!m) return;
  const w = s.textContent.trim().toLowerCase();
  const vowelSound = /^(hour|honest|honou?r|heir)/.test(w) || (/^[aeiou]/.test(w) && !/^(uni|use|usu|eu|one\b|once)/.test(w));
  let art = vowelSound ? 'an' : 'a';
  if (m[2][0] === 'A') art = art[0].toUpperCase() + art.slice(1);
  prev.nodeValue = prev.nodeValue.slice(0, prev.nodeValue.length - m[2].length - m[3].length) + art + m[3];
}

function collapseAlt(s) {
  const { opts, i } = Doc.getAlt(s);
  const line = lineOf(s);
  s.replaceWith(opts[i].text);
  line?.normalize();
  if (state.current === s) state.current = null;
  renderAltPane();
  changed();
}

function removeOpt(s, k) {
  const { opts, i } = Doc.getAlt(s);
  opts.splice(k, 1);
  if (opts.length === 1) { Doc.setAlt(s, opts, 0); return collapseAlt(s); }
  if (!opts.length) return collapseAlt(s);
  Doc.setAlt(s, opts, k < i ? i - 1 : k === i ? 0 : i);
  fixArticle(s);
  changed();
  renderAltPane();
}

async function aiAlternates(s) {
  if (!s || !(await aiAllowed())) return;
  openAlt(s);
  busy('Asking for alternatives…');
  try {
    const a = Doc.getAlt(s);
    const got = await AI.suggestAlternates(a.opts[a.i].text, Doc.cleanText(lineOf(s)), a.opts.map(o => o.text));
    const now = Doc.getAlt(s);
    const seen = new Set(now.opts.map(o => o.text.toLowerCase()));
    for (const t of got) if (!seen.has(t.toLowerCase())) { now.opts.push({ text: t, ai: true }); seen.add(t.toLowerCase()); }
    Doc.setAlt(s, now.opts, now.i);
    changed();
    renderAltPane();
  } catch (e) { toast(e); }
  finally { busy(); }
}

function renderAltPane() {
  const pane = side.querySelector('[data-pane=alts]');
  ed.querySelectorAll('.alt.focus').forEach(x => x.classList.remove('focus'));
  const s = state.current;
  if (!s || !ed.contains(s)) {
    state.current = null;
    pane.innerHTML = '<h3>Alternates</h3><p class="hint">Select text and press <kbd>⌘D</kbd> to give it alternates. ' +
      'Hover any underlined text and press <kbd>↑</kbd> <kbd>↓</kbd> to try each version in place.</p>';
    return;
  }
  s.classList.add('focus');
  const { opts, i } = Doc.getAlt(s);
  pane.replaceChildren(el('h3', null, 'Alternates'));
  opts.forEach((o, k) => {
    const row = el('div', 'opt' + (k === i ? ' on' : ''));
    const mark = el('button', 'mark', o.ai ? '✦' : '•');
    mark.title = (o.ai ? 'Suggested by AI' : 'Written by you') + (k === 0 ? ' · original' : '') + ' — click to show';
    const ta = el('textarea');
    ta.value = o.text;
    ta.rows = 1;
    ta.onfocus = () => { if (+s.dataset.i !== k) useOpt(s, k); };
    ta.oninput = () => {
      const a = Doc.getAlt(s);
      a.opts[k].text = ta.value;
      Doc.setAlt(s, a.opts, a.i);
      fit(ta);
      setDirty(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => changed(), 400);
    };
    const del = el('button', 'del', '×');
    del.title = 'Remove this version';
    mark.onclick = () => useOpt(s, k);
    del.onclick = () => removeOpt(s, k);
    row.append(mark, ta, del);
    pane.append(row);
    requestAnimationFrame(() => fit(ta));
  });
  const add = el('input');
  add.id = 'addOpt';
  add.placeholder = 'Add another version  ↵';
  add.onkeydown = e => {
    if (e.key !== 'Enter' || !add.value.trim()) return;
    const a = Doc.getAlt(s);
    a.opts.push({ text: add.value.trim(), ai: false });
    Doc.setAlt(s, a.opts, a.opts.length - 1);
    fixArticle(s);
    changed();
    renderAltPane();
    $('#addOpt').focus();
  };
  const row = el('div', 'row');
  const sug = el('button', null, '✦ Suggest with AI'); sug.onclick = () => aiAlternates(s);
  const keep = el('button', null, 'Keep shown version'); keep.onclick = () => collapseAlt(s);
  keep.title = 'Remove the alternates and keep the version currently shown';
  row.append(sug, keep);
  pane.append(add, row, el('p', 'legend', '• written by you   ✦ suggested by AI'));
}

const fit = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };

/* =========================================================================
   Ghost, overflow, paste
   ========================================================================= */

function ghostToggle(r = selectionRange()) {
  if (!r) return;
  const g = closest(r.startContainer, '.ghost');
  if (g && (r.collapsed || g.contains(r.endContainer))) return revive(g);
  if (r.collapsed) return toast('Select the text you want to ghost');
  normalizeRange(r);
  for (const sub of perLine(r).reverse()) {
    const span = el('span', 'ghost');
    span.append(sub.extractContents());
    span.querySelectorAll('.ghost').forEach(unwrap); // no ghosts inside ghosts
    sub.insertNode(span);
  }
  getSelection().removeAllRanges();
  changed();
}

function revive(g) { unwrap(g); changed(); }

function stash(r = selectionRange()) {
  if (!r || r.collapsed) return toast('Select the text you want to stash');
  normalizeRange(r);
  const md = Doc.fragmentToMarkdown(r.cloneContents()).trim();
  if (!md) return;
  r.deleteContents();
  // The passage lives in a quiet marker where it was (listed under Overflow ▸ Stashed); click it to put it back.
  r.insertNode(Doc.makeStash(md));
  [...ed.children].forEach(Doc.padLine);
  showTab('overflow');
  changed();
  toast('Stashed — put it back from the ⤶ marker or the Overflow panel');
}

// Keep a stashed passage as a free note, and drop its place in the text.
function stashToNotes(m) {
  overflowEl.value = (overflowEl.value.trim() ? overflowEl.value.trimEnd() + '\n\n' : '') + m.dataset.text;
  m.remove();
  changed();
  toast('Moved to notes');
}

// Overflow panel: one entry per ⤶ marker in the text. Click to see where it came from; Put back returns it.
function renderStashes() {
  const list = $('#stashes');
  list.replaceChildren(...[...ed.querySelectorAll('.stash')].map(m => {
    const li = el('li'), text = m.dataset.text.replace(/\s+/g, ' ');
    const back = el('button', null, 'Put back');
    back.onclick = e => { e.stopPropagation(); putBack(m); };
    li.append(el('q', null, text.length > 110 ? text.slice(0, 110) + '…' : text), back);
    li.title = 'Show where it came from';
    li.onclick = () => { m.scrollIntoView({ block: 'center', behavior: 'smooth' }); m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 1200); };
    return li;
  }));
  list.hidden = $('#stashHead').hidden = !list.children.length;
}

// Put a stashed passage back where its marker is. (Files stashed by an early 0.6.1 build also kept a
// copy in the notes; it's removed if still there word for word — an edited copy is left alone.)
// Done on the Markdown so multi-paragraph passages land as proper lines; ⌘Z undoes it.
function putBack(m) {
  const text = m.dataset.text, SLOT = '\uE000';
  m.replaceWith(SLOT);
  const md = Doc.toMarkdown(ed), at = md.indexOf(SLOT);
  // The stash kept the passage without its surrounding spaces; restore one where words would touch.
  const pad = (a, b) => (a && b && !/\s/.test(a) && !/\s/.test(b) && !/[.,;:!?)\]”’]/.test(b) && !/[(\[“‘]/.test(a) ? ' ' : '');
  const back = pad(md[at - 1], text[0]) + text + pad(text.at(-1), md[at + 1]);
  Doc.renderBody(ed, md.replace(SLOT, back));
  const k = overflowEl.value.indexOf(text);
  if (k >= 0) overflowEl.value = (overflowEl.value.slice(0, k) + overflowEl.value.slice(k + text.length)).replace(/\n{3,}/g, '\n\n').trim();
  changed();
  renderAltPane();
  const line = ed.children[md.slice(0, at).split('\n').length - 1];
  line?.scrollIntoView({ block: 'center' });
  line?.classList.add('flash');
  setTimeout(() => line?.classList.remove('flash'), 1200);
  toast('Put back');
}

// Paste as text, understanding Margin's own marks (so stashed text comes back intact).
function pasteText(text) {
  let r = selectionRange();
  if (!r) return;
  if (!r.collapsed) { normalizeRange(r); r.deleteContents(); }
  let line = lineOf(r.startContainer);
  if (!line) { line = Doc.lineEl(''); ed.append(line); r = document.createRange(); r.setStart(line, 0); }
  const tail = document.createRange();
  tail.setStart(r.startContainer, r.startOffset);
  tail.setEnd(line, line.childNodes.length);
  const rest = tail.extractContents();
  const parts = text.replace(/\r\n?/g, '\n').split('\n');
  Doc.appendInline(line, Doc.parseInline(parts[0]));
  let last = line;
  for (const p of parts.slice(1)) { const d = Doc.lineEl(p); last.after(d); last = d; }
  const caret = document.createRange();
  caret.selectNodeContents(last);
  caret.collapse(false);
  const marker = document.createTextNode('');
  last.append(marker);
  last.append(rest);
  [line, last].forEach(Doc.padLine);
  caret.setStartBefore(marker.parentNode ? marker : last);
  caret.collapse(true);
  placeRange(caret);
  changed();
}

/* =========================================================================
   Lab — AI trims (dim, never rewrite) and checks (highlight, never fix)
   ========================================================================= */

// Wrap the first plain-text occurrence of each passage. Skips text already inside marks.
function markPassages(items, make) {
  Doc.undecorate(ed); // styling splits text nodes; passages must match across them
  let n = 0;
  for (const item of items) {
    const needle = (typeof item === 'string' ? item : item.text).trim();
    if (!needle) continue;
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, {
      acceptNode: t => (t.parentElement.closest('.alt,.ghost,.flag') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let t; (t = w.nextNode());) {
      const k = t.nodeValue.indexOf(needle);
      if (k < 0) continue;
      const r = document.createRange();
      r.setStart(t, k);
      r.setEnd(t, k + needle.length);
      const span = make(item);
      span.append(r.extractContents());
      r.insertNode(span);
      n++;
      break;
    }
  }
  return n;
}

async function trim(level) {
  const text = Doc.toClean(ed);
  if (!text) return toast('Nothing to trim yet');
  if (!(await aiAllowed())) return;
  busy('Trimming…');
  try {
    const before = count();
    const cuts = await AI.trimCuts(text, level);
    const n = markPassages(cuts, () => el('span', 'ghost trim'));
    changed();
    const pct = before ? Math.round((1 - count() / before) * 100) : 0;
    toast(n ? `Dimmed ${n} passage${n > 1 ? 's' : ''} (~${pct}% shorter). Accept, or right-click to revive.` : 'No cuts suggested');
  } catch (e) { toast(e); }
  finally { busy(); }
}
const count = () => Doc.toClean(ed).split(/\s+/).filter(Boolean).length;

function acceptCuts() {
  const cuts = ed.querySelectorAll('.ghost.trim');
  if (!cuts.length) return toast('No AI cuts to accept');
  cuts.forEach(c => c.remove());
  // Tidy the seams the cuts leave behind.
  const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  ed.normalize();
  for (let t; (t = w.nextNode());) t.nodeValue = t.nodeValue.replace(/(\S) {2,}/g, '$1 ').replace(/ +([.,;:!?])/g, '$1');
  changed();
}

function reviveCuts() { ed.querySelectorAll('.ghost.trim').forEach(unwrap); changed(); }

async function runCheck(kind) {
  const text = Doc.toClean(ed);
  if (!text || !(await aiAllowed())) return;
  clearFlags();
  busy('Reading…');
  try {
    const found = kind === 'slop' ? await AI.reduceSlop(text) : await AI.check(text, kind);
    const list = $('#findings');
    markPassages(found, it => {
      const s = el('span', 'flag');
      s.title = it.note || '';
      if (it.options?.length) s.dataset.fix = JSON.stringify(it.options); // ReduceSlop's replacements
      if (it.remove) s.dataset.remove = '1';                                // ReduceSlop: these words should go
      return s;
    });
    if (kind === 'slop') return applySlop(list);
    refresh(); // restore styling (flags don't change the file, so no changed())
    list.replaceChildren();
    ed.querySelectorAll('.flag').forEach(f => {
      const li = el('li');
      li.append(el('q', null, f.textContent.length > 90 ? f.textContent.slice(0, 90) + '…' : f.textContent), el('span', null, f.title));
      li.onclick = () => { f.scrollIntoView({ block: 'center', behavior: 'smooth' }); f.classList.add('flash'); setTimeout(() => f.classList.remove('flash'), 1200); };
      list.append(li);
    });
    $('#clearFlags').hidden = !list.children.length;
    if (!list.children.length) toast('Nothing stood out');
  } catch (e) { toast(e); }
  finally { busy(); }
}

// ReduceSlop applies its findings at once, reversibly: a replacement makes the passage an alternate with the
// cleanest ✦ version shown (your original stays first, one ↑/↓ away); words that should simply go are ghosted
// with the AI-cut tint (revive, or Accept cuts). One ⌘Z undoes the whole pass. Hits with no fix stay highlighted.
function applySlop(list) {
  let alts = 0, cuts = 0;
  const done = [];
  ed.querySelectorAll('.flag[data-fix], .flag[data-remove]').forEach(f => {
    const note = f.title;
    let node;
    if (f.dataset.remove) {
      node = el('span', 'ghost trim');
      node.append(...f.childNodes);
      cuts++;
    } else {
      const opts = [{ text: f.textContent, ai: false }, ...JSON.parse(f.dataset.fix).map(t => ({ text: t, ai: true }))];
      node = Doc.makeAlt(opts, 1);
      alts++;
    }
    node.title = note;
    f.replaceWith(node);
    if (node.classList.contains('alt')) Doc.padLine(lineOf(node));
    done.push([node, note]);
  });
  changed();
  list.replaceChildren();
  for (const [node, note] of [...done, ...[...ed.querySelectorAll('.flag')].map(f => [f, f.title])]) {
    const li = el('li'), t = node.textContent;
    li.append(el('q', null, t.length > 90 ? t.slice(0, 90) + '…' : t), el('span', null, note));
    li.onclick = () => { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1200); };
    list.append(li);
  }
  $('#clearFlags').hidden = !ed.querySelector('.flag');
  toast(alts || cuts
    ? `ReduceSlop: ${alts} cleaner ✦ version${alts === 1 ? '' : 's'} shown, ${cuts} cut${cuts === 1 ? '' : 's'} dimmed — ↑/↓ on one to see yours; ⌘Z undoes all`
    : list.children.length ? 'Highlighted slop with no clean fix — rewrite those yourself' : 'No slop found', 6000);
}

// A ReduceSlop highlight becomes an alternate: your words shown, the AI's replacements (✦) one ↑/↓ away.
function flagToAlt(f) {
  const opts = [{ text: f.textContent, ai: false }, ...JSON.parse(f.dataset.fix).map(t => ({ text: t, ai: true }))];
  const s = Doc.makeAlt(opts, 0);
  f.replaceWith(s);
  Doc.padLine(lineOf(s));
  changed();
  openAlt(s);
}

function clearFlags() {
  ed.querySelectorAll('.flag').forEach(unwrap);
  $('#findings').replaceChildren();
  $('#clearFlags').hidden = true;
}

/* =========================================================================
   Version history — whole-document snapshots of saved files (stored by host.js, never in the file).
   Taken when a file opens, on every ⌘S, at most every 10 minutes of autosaving, and before a restore.
   ========================================================================= */

const SNAP_EVERY = 10 * 60e3;

async function snapshot(force = false) {
  if (!state.path || (!force && Date.now() - state.snapAt < SNAP_EVERY)) return;
  state.snapAt = Date.now();
  try { await Host.historyAdd(state.path, serialize()); } catch { /* history is a bonus; saving already worked */ }
  if (!side.hidden && state.tab === 'history') renderHistory();
}

const when = ms => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

async function renderHistory() {
  const list = $('#versions');
  if (!state.path) return list.replaceChildren(el('li', 'empty', 'Save this document to start keeping versions.'));
  const versions = await Host.historyList(state.path).catch(() => []);
  if (!versions.length) return list.replaceChildren(el('li', 'empty', 'No versions yet — one is kept each time you save.'));
  list.replaceChildren(...versions.map((v, k) => {
    const li = el('li');
    li.append(el('b', null, when(v.at)), el('span', null, k === 0 ? 'latest' : `${Math.max(1, Math.round(v.bytes / 1024))} KB`));
    li.onclick = () => viewVersion(v.at);
    return li;
  }));
}

// Line diff by longest common subsequence: [{ t: 'same' | 'old' | 'new', text, j }],
// where j is the line in the current document the entry sits at.
// Within each run of changes, the k-th old line is paired with the k-th new one (pair = its line).
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push({ t: 'same', text: a[i++], j: j++ }); }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) out.push({ t: 'old', text: a[i++], j });
    else out.push({ t: 'new', text: b[j], j: j++ });
  }
  let olds = [], news = [];
  const pairUp = () => { olds.forEach((o, k) => { if (news[k]) o.pair = news[k].j; }); olds = []; news = []; };
  for (const d of out) d.t === 'same' ? pairUp() : (d.t === 'old' ? olds : news).push(d);
  pairUp();
  return out;
}

// Show a version in the reading area, against the current text: lines that are only in the old
// version are highlighted with "Bring back"; lines written since are shown struck through.
async function viewVersion(at) {
  let md;
  try { md = await Host.historyGet(state.path, at); } catch (e) { return toast(e); }
  const cur = Doc.toMarkdown(ed).split('\n');
  const view = $('#preview');
  view.className = 'versions';
  const head = el('div', 'version-bar');
  const restore = el('button', 'primary', 'Restore this version'), back = el('button', null, 'Back to writing');
  restore.onclick = () => restoreVersion(md);
  back.onclick = () => toggleRead(false);
  head.append(el('span', null, `Version from ${when(at)}. Highlighted lines are not in your current text.`), restore, back);
  view.replaceChildren(head);
  for (const d of diffLines(Doc.splitDoc(md).body.split('\n'), cur)) {
    const line = Doc.lineEl(d.text);
    line.classList.add('v-' + (d.text.trim() ? d.t : 'same')); // blank lines never shout
    if (d.t === 'old' && d.text.trim()) {
      const b = el('button', 'bring', 'Bring back');
      b.onclick = () => bringBack(d, cur);
      line.append(b);
    }
    view.append(line);
  }
  document.body.classList.add('reading');
  $('#readBtn').setAttribute('aria-pressed', true);
}

// Whole version back. The current text is snapshotted first and ⌘Z undoes it: nothing is lost.
async function restoreVersion(md) {
  await snapshot(true);
  const { body, overflow } = Doc.splitDoc(md);
  Doc.renderBody(ed, body);
  overflowEl.value = overflow;
  toggleRead(false);
  renderAltPane();
  changed();
  toast('Version restored — ⌘Z undoes it');
}

// One old line back. If it was rewritten (paired with a current line) it comes back as an alternate
// of that line — hover and ↑/↓ to compare — otherwise it is re-inserted where it used to be.
const PREFIX = /^(#{1,6} |[-*+] |\d+\. |> )?/;
function bringBack(d, cur) {
  const now = d.pair != null ? cur[d.pair] : null;
  const [pre] = d.text.match(PREFIX), [preNow] = now?.match(PREFIX) ?? [''];
  const plain = t => t && !/\{\{|~~/.test(t);
  let line;
  if (now != null && plain(d.text) && plain(now) && pre === preNow && now.slice(pre.length).trim()) {
    line = el('div');
    line.append(pre, Doc.makeAlt([{ text: now.slice(pre.length), ai: false }, { text: d.text.slice(pre.length), ai: false }], 0));
    Doc.padLine(line);
    ed.children[d.pair].replaceWith(line);
    toast('Brought back as an alternate — hover it and press ↑ or ↓');
  } else {
    line = Doc.lineEl(d.text);
    ed.insertBefore(line, ed.children[d.j] || null);
    toast('Line brought back');
  }
  toggleRead(false);
  changed();
  line.scrollIntoView({ block: 'center' });
  line.classList.add('flash');
  setTimeout(() => line.classList.remove('flash'), 1200);
}

/* =========================================================================
   Look & sound: editor font, ink colour, typing sounds, typewriter mode (⇧⌘T)
   ========================================================================= */

const LOOK = { font: 'serif', ink: 'default', sound: 'off', volume: '0.8', scale: 'major', tonic: 'C' };
const look = k => Host.store.get(`margin.${k}`) || LOOK[k];

function applyLook() {
  const root = document.documentElement.dataset;
  root.font = look('font');
  root.ink = look('ink');
  Sound.setVolume(look('volume'));
  Sound.setMusic(look('scale'), look('tonic'));
}
function setLook(k, v) {
  Host.store.set(`margin.${k}`, v === LOOK[k] ? null : v);
  applyLook();
}

// Typewriter mode = typewriter font + typewriter sound. Toggling off returns to what you had.
function toggleTypewriter() {
  const on = look('font') === 'typewriter' && look('sound') === 'typewriter';
  if (on) {
    let prev = {};
    try { prev = JSON.parse(Host.store.get('margin.beforeTypewriter') || '{}'); } catch {}
    setLook('font', prev.font && prev.font !== 'typewriter' ? prev.font : LOOK.font);
    setLook('sound', prev.sound && prev.sound !== 'typewriter' ? prev.sound : LOOK.sound);
  } else {
    Host.store.set('margin.beforeTypewriter', JSON.stringify({ font: look('font'), sound: look('sound') }));
    setLook('font', 'typewriter');
    setLook('sound', 'typewriter');
  }
  toast(on ? 'Typewriter mode off' : 'Typewriter mode — ⇧⌘T to leave', 1600);
}
applyLook();

/* =========================================================================
   UI chrome: side panel, context menu, toast, settings
   ========================================================================= */

function showTab(name) {
  state.tab = name;
  if (name === 'history') renderHistory();
  if (name === 'overflow') renderStashes();
  side.hidden = false;
  side.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== name));
  document.querySelectorAll('#bar [data-tab]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === name));
}
function toggleSide(name = state.tab) {
  if (!side.hidden && state.tab === name) {
    side.hidden = true;
    document.querySelectorAll('#bar [data-tab]').forEach(b => b.setAttribute('aria-pressed', false));
  } else showTab(name);
}

function showMenu(x, y, items) {
  menu.replaceChildren();
  items.forEach(it => {
    if (!it) { if (menu.lastChild && menu.lastChild.nodeName !== 'HR') menu.append(el('hr')); return; }
    const [label, fn, key] = it;
    const b = el('button', null, label);
    if (key) b.append(el('kbd', null, key));
    b.onmousedown = e => e.preventDefault(); // keep the text selection alive
    b.onclick = () => { hideMenu(); fn(); };
    menu.append(b);
  });
  if (menu.lastChild?.nodeName === 'HR') menu.lastChild.remove();
  menu.hidden = false;
  const { innerWidth: W, innerHeight: H } = window, m = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, W - m.width - 8) + 'px';
  menu.style.top = Math.min(y, H - m.height - 8) + 'px';
}
const hideMenu = () => (menu.hidden = true);

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = String(msg?.message ?? msg);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const busy = (msg = '') => { $('#status').textContent = msg; document.body.style.cursor = msg ? 'progress' : ''; };

// Put formatted text (HTML) and plain text (the Markdown) on the clipboard together: rich editors —
// Substack, Medium, Google Docs, Mail — take the formatting; plain-text boxes take the Markdown.
async function copyRich(md, html = Preview.render(md)) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([md], { type: 'text/plain' }),
    })]);
  } catch { // older WebKit: copy a rendered, selected element (still carries HTML)
    const box = el('div');
    box.innerHTML = html;
    box.style.cssText = 'position:fixed;left:-9999px;white-space:pre-wrap';
    document.body.append(box);
    const r = document.createRange(); r.selectNodeContents(box); placeRange(r);
    document.execCommand('copy');
    box.remove();
    ed.focus();
  }
}
const copyPlain = text => navigator.clipboard.writeText(text).catch(() => copyRich(text, text));

async function copyClean() {
  await copyRich(Doc.toClean(ed));
  toast('Clean text copied with formatting — alternates resolved, ghosts and overflow left out');
}

// Lab ▸ FormatSubstack: title, subtitle and body to paste into Substack's three fields.
function formatSubstack() {
  const s = Publish.substack(Doc.toClean(ed));
  const box = $('#publish');
  const row = (label, text, copy) => {
    const r = el('div', 'pub');
    const b = el('button', null, `Copy ${label}`);
    b.disabled = !text;
    b.onclick = async () => { await copy(); toast(`${label[0].toUpperCase() + label.slice(1)} copied — paste it into Substack`); };
    r.append(b, el('span', null, text || '—'));
    return r;
  };
  box.replaceChildren(
    row('title', s.title, () => copyPlain(s.title)),
    row('subtitle', s.subtitle, () => copyPlain(s.subtitle)),
    row('body', `${s.body.split(/\s+/).filter(Boolean).length.toLocaleString()} words, formatted`, () => copyRich(s.body)),
  );
  if (s.notes.length) {
    const ul = el('ul', 'notes');
    s.notes.forEach(n => ul.append(el('li', null, n)));
    box.append(ul);
  }
}

// The provider shown in Settings. Switching it only changes the dialog; Save makes it the one AI uses.
let shown = { provider: 'anthropic', hasKey: false };
let modelsAsk = 0; // newest model-list request; older answers are dropped

async function showProvider(p) {
  shown = { provider: p, hasKey: false };
  $('#providerInput').value = p;
  $('#baseUrlRow').hidden = p !== 'compat';
  $('#baseUrlInput').value = Host.getBaseUrl();
  $('#keyInput').value = '';
  $('#keyInput').placeholder = Host.PROVIDERS[p].keyHint;
  $('#modelInput').value = Host.getModel(p);
  $('#keyNote').textContent = (Host.native ? 'Stored in your system keychain. '
    : Host.embedded ? 'Stored in Obsidian’s secret storage. ' : 'Stored in this browser only. ') +
    'Used only for AI suggestions, trims and checks.';
  const has = await Host.hasKey(p).catch(() => false);
  if (shown.provider !== p) return;
  shown.hasKey = has;
  if (has) $('#keyInput').placeholder = '•••••••• (saved — type to replace)';
  refreshModels();
}

// Fill the model picker from the provider's own list (typed key first, else the saved one).
async function refreshModels() {
  const ask = ++modelsAsk, p = shown.provider, note = $('#modelNote');
  const key = $('#keyInput').value.trim();
  $('#modelList').replaceChildren();
  if (!key && !shown.hasKey && p !== 'compat') { note.textContent = 'Add a key to see the models it offers.'; return; }
  if (p === 'compat' && !$('#baseUrlInput').value.trim()) { note.textContent = 'Add the server URL to see its models.'; return; }
  note.textContent = 'Looking up models…';
  try {
    const ids = await Host.listModels(p, $('#baseUrlInput').value, key);
    if (ask !== modelsAsk) return;
    const cur = $('#modelInput').value.trim();
    ids.sort((a, b) => (b === cur) - (a === cur)); // the current choice first
    $('#modelList').replaceChildren(...ids.map(id => el('option', null, id)));
    note.textContent = ids.length ? `${ids.length} models available — pick one or type an id.` : 'No models listed — type a model id.';
  } catch (e) {
    if (ask === modelsAsk) note.textContent = `Type a model id (couldn't list models: ${e.message})`;
  }
}

async function openSettings() {
  for (const k of Object.keys(LOOK)) $(`#${k}Input`).value = look(k);
  showProvider(Host.getProvider());
  $('#settings').showModal();
}
$('#providerInput').onchange = e => showProvider(e.target.value);
$('#keyInput').onchange = refreshModels;
$('#baseUrlInput').onchange = refreshModels;
$('#settings').addEventListener('close', async () => {
  const dlg = $('#settings');
  if (dlg.returnValue !== 'save') return;
  try {
    const p = $('#providerInput').value;
    const key = $('#keyInput').value.trim();
    if (key) await Host.setKey(p, key);
    Host.store.set('margin.provider', p === 'anthropic' ? null : p);
    if (p === 'compat') Host.store.set('margin.baseUrl', $('#baseUrlInput').value.trim() || null);
    const model = $('#modelInput').value.trim();
    Host.store.set(Host.perProvider('margin.model', p), model && !(p === 'anthropic' && model === Host.DEFAULT_MODEL) ? model : null);
    toast('Settings saved');
  } catch (e) { toast(e); }
});
// Look & sound apply (and are kept) as soon as they change — you see the choice before closing.
for (const k of Object.keys(LOOK)) $(`#${k}Input`).onchange = e => {
  setLook(k, e.target.value);
  if (k !== 'font' && k !== 'ink') Sound.keystroke(look('sound'), 'Enter'); // a sample: ↵ plays the most characteristic sound
};
$('#clearKey').onclick = async () => {
  const p = shown.provider;
  await Host.setKey(p, '');
  Host.store.set(Host.perProvider('margin.aiConsent', p), null); // AI permission is asked again with a new key
  $('#settings').close();
  toast(`${Host.PROVIDERS[p].name} key removed`);
};

/* =========================================================================
   Events
   ========================================================================= */

let typingTimer;
ed.addEventListener('input', () => {
  setDirty(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => changed(), 400);
});
ed.addEventListener('beforeinput', e => {
  if (e.inputType === 'historyUndo') { e.preventDefault(); undo(); }
  if (e.inputType === 'historyRedo') { e.preventDefault(); redo(); }
  // Native rich-text formatting (menus, Touch Bar) would insert <b>/<i> that can't be saved — use marks.
  if (e.inputType === 'formatBold') { e.preventDefault(); toggleMark('**'); }
  if (e.inputType === 'formatItalic') { e.preventDefault(); toggleMark('*'); }
  if (e.inputType.startsWith('format')) e.preventDefault();
});
ed.addEventListener('paste', e => { e.preventDefault(); pasteText(e.clipboardData.getData('text/plain')); });
ed.addEventListener('mouseover', e => { state.hover = e.target.closest?.('.alt') || null; });
ed.addEventListener('mouseleave', () => { state.hover = null; });
ed.addEventListener('click', e => {
  const a = e.target.closest('.alt'), m = e.target.closest('.stash');
  if (a) openAlt(a);
  if (m) putBack(m);
});

ed.addEventListener('contextmenu', e => {
  e.preventDefault();
  const r = selectionRange();
  const saved = r && r.cloneRange();
  const alt = e.target.closest('.alt'), ghost = e.target.closest('.ghost'), slop = e.target.closest('.flag[data-fix]');
  const hasSel = saved && !saved.collapsed && saved.toString().replace(Doc.ZW, '').trim();
  const items = [];
  if (alt) items.push(['Edit alternates', () => openAlt(alt)], ['✦ AI alternates', () => aiAlternates(alt)], ['Keep shown version', () => collapseAlt(alt)], null);
  if (ghost) items.push(['Revive', () => revive(ghost)], null);
  const mark = e.target.closest('.stash');
  if (mark) items.push(['Put back stashed text', () => putBack(mark)], ['Move to notes', () => stashToNotes(mark)], null);
  if (slop) items.push(['✦ Cleaner versions', () => flagToAlt(slop)], ['Dismiss highlight', () => { unwrap(slop); refresh(); }], null);
  if (hasSel && !alt) items.push(
    ['Bold', () => { placeRange(saved); toggleMark('**'); }, '⌘B'],
    ['Italic', () => { placeRange(saved); toggleMark('*'); }, '⌘I'], null,
    ['Add alternates', () => addAlternates(saved), '⌘D'],
    ['✦ AI alternates for selection', () => aiAlternates(addAlternates(saved))],
    ['Ghost it', () => ghostToggle(saved), '⌘G'],
    ['Stash in overflow', () => stash(saved), '⌘J'], null);
  items.push(['Copy clean text', copyClean, '⇧⌘C']);
  showMenu(e.clientX, e.clientY, items);
});
document.addEventListener('mousedown', e => { if (!menu.contains(e.target)) hideMenu(); });
$('#page').addEventListener('scroll', hideMenu);

overflowEl.addEventListener('input', () => { setDirty(true); scheduleSave(); });

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  const inEditor = ed.contains(document.activeElement) || document.activeElement === ed;
  if (inEditor && !mod && !e.isComposing) Sound.keystroke(look('sound'), e.key, e.code);
  // Hover an alternate and press ↑/↓ to try each version in place.
  if (state.hover && !mod && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !side.contains(document.activeElement)) {
    e.preventDefault();
    return cycle(state.hover, e.key === 'ArrowUp' ? -1 : 1);
  }
  if (e.key === 'Escape') {
    hideMenu();
    if (Host.init.action === 'notes') return closeWindow(); // the What's New window: Esc closes it
    if (document.body.classList.contains('reading')) toggleRead(false);
  }
  if (!mod) return;
  // ⌥ changes e.key on a Mac (⌥2 → ™), so headings and zoom use the physical key (e.code).
  if (inEditor && e.altKey && /^Digit[0-6]$/.test(e.code)) { e.preventDefault(); return setHeading(+e.code.slice(5)); }
  const z = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0 }[e.code];
  if (z !== undefined && !e.altKey && !e.shiftKey) { e.preventDefault(); return zoom(z); }
  // In the app, ⌘N/⌘O/⌘S belong to the native File menu; embedded, to the host app; in a browser the page handles them.
  const files = Host.native || Host.embedded ? {} : { o: openFile, s: () => save(e.shiftKey), n: newDoc };
  const keys = { ...files, ',': openSettings, '\\': () => toggleSide() };
  if (e.shiftKey && k === 'c') keys.c = copyClean;
  if (e.shiftKey && k === 'p') keys.p = () => toggleRead();
  if (e.shiftKey && k === 't') keys.t = toggleTypewriter;
  if (inEditor) Object.assign(keys, { b: () => toggleMark('**'), i: () => toggleMark('*'), d: () => addAlternates(), g: () => ghostToggle(), j: () => stash(), z: e.shiftKey ? redo : undo, y: redo });
  const f = keys[k];
  if (f) { e.preventDefault(); f(); }
  // Embedded: letter/digit shortcuts we don't use belong to the host app (Obsidian's ⌘P, ⌘O…). Editing keys
  // stay here: copy/paste/select all/undo, and anything that isn't one character (⌘←, ⌘⌫, Ctrl+arrows).
  else if (Host.embedded && k.length === 1 && !/[cvxazy]/.test(k)) { e.preventDefault(); Host.forwardKey(e); }
});

document.querySelectorAll('#bar [data-tab]').forEach(b => (b.onclick = () => toggleSide(b.dataset.tab)));
$('#settingsBtn').onclick = openSettings;
document.querySelectorAll('[data-trim]').forEach(b => (b.onclick = () => trim(b.dataset.trim)));
document.querySelectorAll('[data-check]').forEach(b => (b.onclick = () => runCheck(b.dataset.check)));
$('#acceptCuts').onclick = acceptCuts;
$('#reviveCuts').onclick = reviveCuts;
$('#clearFlags').onclick = clearFlags;
$('#substackBtn').onclick = formatSubstack;

/* ---------- formatting: ⌘B / ⌘I, headings, zoom ----------
   Margin's files are Markdown, so formatting means adding or removing marks in the text
   (** for bold, * for italic, # for headings). Styling then makes them look right. */

// Selection as plain-text offsets within one line, trimmed of surrounding spaces.
function lineSelection() {
  const sel = getSel();
  if (!sel || sel.a.line !== sel.f.line) return null;
  const line = ed.children[sel.a.line];
  const text = line.textContent;
  let a = Math.min(sel.a.off, sel.f.off), b = Math.max(sel.a.off, sel.f.off);
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return { n: sel.a.line, line, text, a, b };
}

// Insert / delete plain text at line offsets (marks are plain text, so this is all formatting needs).
function insertAt(n, off, str) {
  const p = fromPoint({ line: n, off });
  const r = document.createRange();
  r.setStart(p[0], p[1]);
  r.insertNode(document.createTextNode(str));
}
function deleteAt(n, from, to) {
  const a = fromPoint({ line: n, off: from }), b = fromPoint({ line: n, off: to });
  const r = document.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], b[1]);
  r.deleteContents();
}

// Toggle ** (bold) or * (italic) around the selection. Star runs are counted so that
// italic and bold can be combined (***both***) and removed independently.
function toggleMark(mark) {
  const s = lineSelection();
  if (!s) return toast('Formatting works within one paragraph');
  const { n, text } = s;
  let { a, b } = s;
  const run = (i, step) => { let k = 0; while (text[i + k * step] === '*') k++; return k; };
  // If the marks are inside the selection ("**word**" selected), step inside them.
  const inner = Math.min(run(a, 1), run(b - 1, -1));
  if (inner && b - a > 2 * inner) { a += inner; b -= inner; }
  const before = run(a - 1, -1), after = run(b, 1);
  const has = mark === '**' ? before >= 2 && after >= 2 : before % 2 === 1 && after % 2 === 1;
  const len = mark.length;
  if (has) {                      // remove: delete the closing mark first so offsets before it stay valid
    deleteAt(n, b, b + len);
    deleteAt(n, a - len, a);
    a -= len; b -= len;
  } else {                        // add (empty selection: insert a pair and type between them)
    insertAt(n, b, mark);
    insertAt(n, a, mark);
    a += len; b += len;
  }
  changed();
  setSel({ a: { line: n, off: a }, f: { line: n, off: b } });
}

// ⌥⌘1–3: heading level for every line in the selection; ⌥⌘0 (or the same level again) → normal text.
function setHeading(level) {
  const sel = getSel();
  if (!sel) return;
  const [first, last] = [sel.a.line, sel.f.line].sort((x, y) => x - y);
  let shift = 0;
  for (let n = first; n <= last; n++) {
    const line = ed.children[n];
    const cur = line.textContent.match(/^(\u200B?)(#{1,6} )?/);
    const old = cur[2] || '';
    const want = level && old !== '#'.repeat(level) + ' ' ? '#'.repeat(level) + ' ' : '';
    const at = cur[1].length;
    if (old) deleteAt(n, at, at + old.length);
    if (want) insertAt(n, at, want);
    if (n === sel.a.line) shift = want.length - old.length;
  }
  changed();
  const move = p => ({ line: p.line, off: Math.max(0, p.off + (p.line === sel.a.line ? shift : 0)) });
  setSel({ a: move(sel.a), f: move(sel.f) });
}

// ⌘+ / ⌘− / ⌘0: page zoom (display only, remembered).
function zoom(step) {
  const z = step === 0 ? 1 : Math.min(1.6, Math.max(0.7, (+Host.store.get('margin.zoom') || 1) + step * 0.1));
  Host.store.set('margin.zoom', z.toFixed(1));
  document.documentElement.style.setProperty('--zoom', z.toFixed(1));
  toast(`Zoom ${Math.round(z * 100)}%`, 900);
}
document.documentElement.style.setProperty('--zoom', Host.store.get('margin.zoom') || 1);

/* ---------- AI permission (App Store guideline 5.1.2(i)): ask once before any text leaves the Mac ----------
   Once per provider, naming who receives the text. A custom server is remembered by its host,
   so pointing Margin at a different server asks again. */

function aiAllowed() {
  const p = Host.getProvider(), to = Host.recipient(p);
  const name = Host.perProvider('margin.aiConsent', p), yes = p === 'compat' ? to : 'yes';
  if (Host.store.get(name) === yes) return Promise.resolve(true);
  const dlg = $('#consent');
  dlg.querySelectorAll('.aiTo').forEach(e => { e.textContent = to; });
  dlg.querySelector('.aiVia').textContent = Host.PROVIDERS[p].name;
  return new Promise(resolve => {
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'allow';
      if (ok) Host.store.set(name, yes);
      resolve(ok);
    }, { once: true });
    dlg.showModal();
  });
}

/* ---------- reading view (⇧⌘P): clean text rendered as formatted Markdown ---------- */

function toggleRead(on = document.body.classList.contains('reading') === false) {
  if (on) { $('#preview').className = ''; $('#preview').innerHTML = Preview.render(Doc.toClean(ed)); }
  document.body.classList.toggle('reading', on);
  $('#readBtn').setAttribute('aria-pressed', on);
  if (!on) ed.focus();
}
$('#readBtn').onclick = () => toggleRead();

/* ---------- What's new: src/RELEASE_NOTES.md, once per change ----------
   The first "## " section is the latest version. What you've seen is remembered as that version plus a
   fingerprint of its text (margin.notesSeen), so the notes come back after a fresh install, an update,
   or new items added to the same version. Help ▸ What's New / Settings show them any time.
   In the app they get their own window (titled What's New, opened after start-up has restored your
   windows), so they never borrow a document's name or vanish when a document loads. In the browser
   there is one page: they show in its reading view. */

// FNV-1a over the text — a short, stable fingerprint (tests compute the same one).
const fingerprint = s => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36);

async function whatsNew(force = false) {
  let md;
  try { const r = await fetch('RELEASE_NOTES.md'); if (!r.ok) return; md = await r.text(); } catch { return; }
  const latest = md.match(/^## (\S+)\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!latest) return;
  const version = latest[1], seen = `${version}#${fingerprint(latest[2].trim())}`;
  if (!force && Host.store.get('margin.notesSeen') === seen) return;
  Host.store.set('margin.notesSeen', seen);
  const own = Host.init.action === 'notes';            // this window exists only to show the notes
  if (Host.native && !own) return Host.openWindow({ action: 'notes' }).catch(toast);
  const view = $('#preview'), head = el('div', 'version-bar'), back = el('button', 'primary', own ? 'Close' : 'Start writing');
  back.onclick = () => (own ? closeWindow() : toggleRead(false));
  head.append(el('span', null, own ? `Margin ${version}` : `Margin ${version} — Esc to return to your document`), back);
  if (own) { $('#file').textContent = 'What’s New'; Host.setTitle('What’s New'); document.body.classList.add('notes-window'); }
  view.className = 'notes';
  view.innerHTML = Preview.render(md.replace(/<!--[\s\S]*?-->/g, ''));
  view.prepend(head);
  document.body.classList.add('reading');
  $('#readBtn').setAttribute('aria-pressed', true);
}
$('#whatsNewBtn').onclick = () => { $('#settings').close(); whatsNew(true); };

/* ---------- opening files from outside: native menu, Finder, drag & drop ---------- */

const dropping = on => document.body.classList.toggle('dropping', on);

async function listenNative() {
  const menu = { new: newDoc, open: openFile, save: () => save(), save_as: () => save(true), clear_recent: clearRecent, whats_new: () => whatsNew(true) };
  await Promise.all([
    Host.on('menu', id => menu[id]?.()),
    Host.on('open-path', openPath), // Finder "Open With" and Open Recent
    Host.on('close-requested', closeWindow),
    Host.on('tauri://drag-enter', () => dropping(true)),
    Host.on('tauri://drag-leave', () => dropping(false)),
    Host.on('tauri://drag-drop', p => { dropping(false); if (p?.paths?.[0]) openPath(p.paths[0]); }),
  ]);
}

// The window's close button: settle the document first (save, or ask about an unsaved draft).
// A closed window's draft is forgotten; a window still open at Quit keeps it, and comes back next launch.
async function closeWindow() {
  try {
    if (!(await settle())) return;   // "Cancel": the window stays
    Host.store.set(DRAFT, null);
  } catch { /* never trap a window open; the draft stays in storage */ }
  Host.closeWindow();
}

if (!Host.native && !Host.embedded) { // browser: HTML5 drag & drop (in the app, Tauri delivers drops as paths instead)
  addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dropping(true); } });
  addEventListener('dragleave', e => { if (!e.relatedTarget) dropping(false); });
  addEventListener('drop', async e => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    dropping(false);
    if (!(await settle())) return;
    try { applyOpened(await Host.fromFile(f)); } catch (err) { toast(err); }
  });
}

/* =========================================================================
   Start-up. Each window restores its own draft or file. The first window also
   brings back the other windows open at last quit, or (if it was alone) the last file;
   a file that launched the app from Finder wins over the last file.
   ========================================================================= */

(async function start() {
  document.execCommand('defaultParagraphSeparator', false, 'div');
  if (Host.embedded) return startEmbedded();
  const read = k => { try { return JSON.parse(Host.store.get(k) || 'null'); } catch { return null; } };
  const first = Host.windowLabel === 'main';
  // Drafts of other windows left from last session (app only): the first window reopens them.
  const others = first && Host.native ? Host.store.keys('margin.draft.') : [];
  let rec = read(DRAFT);
  if (!rec && others.length) { const k = others.shift(); rec = read(k); Host.store.set(k, null); } // adopt one
  // Listen before asking for pending files, so nothing sent from here on is missed.
  let pending = [];
  if (Host.native) { await listenNative(); pending = await Host.takePending(); }
  const last = first && !others.length && !pending.length ? Host.store.get('margin.last') : null;
  const path = rec?.path || last;
  if (rec?.dirty) { load(rec.md, rec.path, rec.suggest); setDirty(true); }
  else if (Host.native && path) {
    try { applyOpened(await Host.openPath(path)); } catch { load(first ? WELCOME : ''); }
  } else if (rec?.md) load(rec.md, rec.path, rec.suggest);
  else load(first && !pending.length && !Host.init.path ? WELCOME : '');
  renderAltPane();
  ed.focus();
  window.margin = { serialize, load, applyOpened, state, toClean: () => Doc.toClean(ed), diffLines, substack: Publish.substack }; // handy for debugging and tests
  // ?demo: the editor embedded on the website — straight to the welcome document, no release notes.
  const notes = () => { if (first && !new URLSearchParams(location.search).has('demo')) whatsNew(); };
  if (Host.init.action === 'notes') return whatsNew(true);   // the What's New window itself
  if (!Host.native) return notes();
  Host.setRecent(recent());
  for (const k of others) await Host.openWindow({ label: k.slice('margin.draft.'.length) }).catch(() => {});
  for (const p of [Host.init.path, ...pending].filter(Boolean)) await openPath(p);
  if (Host.init.action === 'open') openFile();
  notes(); // last, so its window opens on top of everything start-up restored
})();

// Embedded (Obsidian): one tab, one vault file. The parent sends the file now and again whenever it changes
// on disk; text we pushed ourselves is not sent back. path is the vault path (it keys version history).
function startEmbedded() {
  load('');
  window.margin = { serialize, load, state, toClean: () => Doc.toClean(ed) };
  Host.attach({
    load(text, path) { load(text, path); snapshot(true); },
    theme: name => (document.documentElement.dataset.theme = name),
  });
}
