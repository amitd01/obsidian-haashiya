// host.js — the only module that knows where Margin runs.
// Inside the Mac/Windows app (Tauri): files via native dialogs, API key in the OS keychain,
// AI calls made from Rust so the key never touches the page.
// In a plain browser: file picker + download, key in localStorage, direct API call.
// Embedded in another app (the Obsidian plugin, obsidian/main.js): the page lives in a same-origin iframe
// whose element carries a bridge. The parent owns the file and the API keys and makes the AI calls.

const invoke = window.__TAURI__?.core?.invoke;
export const native = !!invoke;
// frameElement is null at the top level and for cross-origin parents, so only a real host finds a bridge.
const bridge = !native && (() => { try { return window.frameElement?.haashiyaBridge; } catch { return null; } })();
export const embedded = !!bridge;
// Embedded: the page never sees a key. Requests carry this slot and the parent fills it in (obsidian/main.js).
export const KEY_SLOT = '{{haashiya-key}}';
// This window. Every document has its own window in the app; the browser has just 'main'.
const win = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow();
export const windowLabel = win?.label ?? 'main';
// What Rust asked this window to do when it made it: { path }, { action: 'open' } or { restore: true }.
export const init = window.__MARGIN_INIT__ || {};
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

// localStorage can throw (private mode etc.) — never let that break the editor.
export const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  keys: prefix => { try { return Object.keys(localStorage).filter(k => k.startsWith(prefix)); } catch { return []; } },
};

const call = (cmd, args) => invoke(cmd, args).catch(e => { throw new Error(String(e?.message ?? e)); });
export const basename = p => (p || 'Untitled.md').split(/[\\/]/).pop();

/* ---------- files ---------- */
// Every open returns { path, name, text, imported }:
//   Markdown → path set, saved back in place.  Everything else → path null, imported as an untitled draft.

const isMarkdown = n => /\.(md|markdown)$/i.test(n);
const stem = n => n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

// Browser fallback for a File object (picker or drop). Word import needs the app.
export async function fromFile(f) {
  if (/\.(docx|rtf|html?|pdf)$/i.test(f.name)) throw new Error('Word, RTF, HTML and PDF import work in the Mac app');
  if (!/\.(md|markdown|txt)$/i.test(f.name)) throw new Error('Margin can open .md, .txt, .docx, .rtf, .html and .pdf files');
  const md = isMarkdown(f.name);
  return { path: md ? f.name : null, name: stem(f.name), text: (await f.text()).replace(/\r\n?/g, '\n'), imported: !md };
}

export function openDoc() {
  if (native) return call('open_doc');
  return new Promise((resolve, reject) => {
    const input = document.getElementById('filepick');
    input.value = '';
    input.onchange = () => (input.files[0] ? fromFile(input.files[0]).then(resolve, reject) : resolve(null));
    input.click();
  });
}

export const openPath = path => call('open_path', { path });

// Returns the saved path, or null if the user cancelled. path=null forces "Save As"; suggest names the file.
export async function saveDoc(path, text, suggest = null) {
  if (native) return call('save_doc', { path, text, suggest });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = path ? basename(path) : `${suggest || 'Untitled'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  return a.download;
}

// "save" | "discard" | "cancel"
export function askUnsaved(name) {
  if (native) return call('ask_unsaved', { name });
  return Promise.resolve(confirm(`Discard unsaved changes to “${name}”?`) ? 'discard' : 'cancel');
}

/* ---------- native glue: Finder, menu, drag & drop, recents ---------- */

export const takePending = () => (native ? call('take_pending') : Promise.resolve([]));
export const setRecent = paths => (native ? call('set_recent', { paths }).catch(() => {}) : Promise.resolve());
// Subscribe to an event sent to THIS window (or to every window); a no-op in the browser.
export const on = (event, fn) => win?.listen(event, e => fn(e.payload));

// path tells Rust which file this window holds, so opening it elsewhere just focuses this window.
export function setTitle(t, path = null) {
  document.title = t;
  if (native) call('set_title', { title: t, path }).catch(() => {});
}

/* ---------- embedded (Obsidian) ----------
   attach({ load(text, path), theme(name) }): the parent calls these when its file (re)loads or its theme changes.
   pushText(text): the document changed; the parent saves it to its file (autosave). saveNow(text): ⌘S. Keys the page doesn't use go to the
   parent too, so the host app's own shortcuts (command palette, quick switcher) still work from inside the editor. */

export const attach = handlers => bridge?.attach(handlers);
export const pushText = text => bridge?.changed(text);
// ⌘S: hand over the text and write the file now, instead of on Obsidian's own schedule.
export const saveNow = text => bridge?.save(text);
export const forwardKey = e => bridge?.key?.({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });

/* ---------- windows (app only) ---------- */

// A new window: { path } opens a file there, { action: 'open' } shows the Open dialog, { label } restores one.
export const openWindow = ({ label = null, path = null, action = null } = {}) => call('open_window', { label, path, action });
// Bring forward the window that already shows path. false = none does (always false in the browser).
export const focusDoc = path => (native && path ? call('focus_doc', { path }) : Promise.resolve(false));
export const closeWindow = () => call('close_window');

/* ---------- version history ----------
   App: snapshot files in the app data folder (Rust, history.rs). Browser: the last 30 in localStorage.
   Versions are listed newest first as { at (ms), bytes }. */

const webHist = {
  key: path => `margin.hist.${path}`,
  all(path) { try { return JSON.parse(store.get(this.key(path)) || '[]'); } catch { return []; } },
  add(path, text) {
    const all = this.all(path);
    if (all[0]?.text === text) return false;
    all.unshift({ at: Math.max(Date.now(), (all[0]?.at ?? 0) + 1), text });
    store.set(this.key(path), JSON.stringify(all.slice(0, 30)));
    return true;
  },
};
export const historyAdd = (path, text) => (native ? call('history_add', { path, text }) : Promise.resolve(webHist.add(path, text)));
export const historyList = path => (native ? call('history_list', { path })
  : Promise.resolve(webHist.all(path).map(v => ({ at: v.at, bytes: v.text.length }))));
export async function historyGet(path, at) {
  if (native) return call('history_get', { path, at });
  const v = webHist.all(path).find(v => v.at === at);
  if (!v) throw new Error('That version is no longer available');
  return v.text;
}

/* ---------- AI (FR-01): any provider, one model for every feature ----------
   App: keys in the OS keychain, calls made by Rust (src-tauri/src/providers.rs).
   Browser: keys in localStorage, the same wire formats mirrored below — keep the two in step. */

export const PROVIDERS = {
  anthropic: { name: 'Anthropic (Claude)', company: 'Anthropic', keyHint: 'sk-ant-…' },
  openai: { name: 'OpenAI', company: 'OpenAI', keyHint: 'sk-…' },
  gemini: { name: 'Google Gemini', company: 'Google', keyHint: 'AIza…' },
  compat: { name: 'OpenAI-compatible server', company: null, keyHint: 'only if the server needs one' },
};
// Anthropic keeps the pre-0.7 storage names (margin.model, margin.key, margin.aiConsent) so settings carry over.
export const perProvider = (name, p) => (p === 'anthropic' ? name : `${name}.${p}`);
export const getProvider = () => (PROVIDERS[store.get('margin.provider')] ? store.get('margin.provider') : 'anthropic');
export const getModel = p => store.get(perProvider('margin.model', p)) || (p === 'anthropic' ? DEFAULT_MODEL : '');
export const getBaseUrl = () => store.get('margin.baseUrl') || '';
// Who receives the text, for the permission dialog: a company, or the custom server's host.
export function recipient(p = getProvider()) {
  if (PROVIDERS[p].company) return PROVIDERS[p].company;
  try { return `the server at ${new URL(getBaseUrl()).host}`; } catch { return 'your custom server'; }
}

export const setKey = (p, key) => (native ? call('set_api_key', { provider: p, key })
  : embedded ? Promise.resolve(bridge.setKey(p, key || ''))
  : Promise.resolve(store.set(perProvider('margin.key', p), key || null)));
export const hasKey = p => (native ? call('has_api_key', { provider: p })
  : embedded ? Promise.resolve(bridge.hasKey(p))
  : Promise.resolve(!!store.get(perProvider('margin.key', p))));
// Browser: the key itself. Embedded: the slot the parent fills in, if it holds a key ('app': the Mac app's). '' = no key.
const storedKey = async p => (embedded ? ((await hasKey(p)) ? KEY_SLOT : '') : store.get(perProvider('margin.key', p)) || '');

// Thinking models spend output tokens before answering; same allowance as providers.rs THINKING_ROOM.
const ROOM = 8000;
const NOT_TEXT = /embedding|tts|whisper|dall-e|moderation|audio|realtime|transcribe|image|search|davinci|babbage|computer-use/;
const oaBase = (p, url) => {
  if (p === 'openai') return 'https://api.openai.com/v1';
  const u = (url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) throw new Error('Set the server URL in Settings (⌘,), e.g. http://localhost:11434/v1');
  return u;
};
const bearer = key => (key ? { authorization: `Bearer ${key}` } : {});
const ANTHROPIC_HEADERS = key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

// Browser only: { url, headers, body } for a chat, and how to read the reply as [text, stop reason].
function wire(p, { baseUrl, key, system, prompt, model, maxTokens }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  if (p === 'anthropic') return {
    url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_HEADERS(key),
    body: { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] },
    read: j => [(j.content || []).map(b => b.text || '').join(''), j.stop_reason],
  };
  if (p === 'gemini') return {
    url: `${GEMINI}/${model.replace(/^models\//, '')}:generateContent`, headers: { 'x-goog-api-key': key },
    body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens + ROOM } },
    read: j => [(j.candidates?.[0]?.content?.parts || []).map(b => b.text || '').join(''), j.candidates?.[0]?.finishReason],
  };
  // OpenAI renamed the cap to max_completion_tokens; compatible servers mostly know only max_tokens.
  const cap = p === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  return {
    url: `${oaBase(p, baseUrl)}/chat/completions`, headers: bearer(key),
    body: { model, messages, [cap]: maxTokens + ROOM },
    read: j => [j.choices?.[0]?.message?.content || '', j.choices?.[0]?.finish_reason],
  };
}

// GET (no body) or POST JSON; resolves to the reply's JSON. Embedded, the parent sends it (no CORS there)
// and fills in the key; p names the provider so the parent only sends a key to that provider's server.
async function fetchJson(url, headers, body, p) {
  let r;
  try {
    if (embedded) r = await bridge.request({ provider: p, url, headers, body });
    else {
      const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) } : { headers });
      r = { status: res.status, json: await res.json().catch(() => ({})) };
    }
  } catch (e) { throw new Error(`Couldn't reach the AI server: ${e.message}`); }
  const j = r.json || {};
  if (r.status < 200 || r.status >= 300) throw new Error(j.error?.message || (typeof j.error === 'string' && j.error) || `AI request failed (HTTP ${r.status})`);
  return j;
}

export async function ai({ system, prompt, maxTokens = 1024 }) {
  const p = getProvider(), model = getModel(p), baseUrl = getBaseUrl();
  if (native) return call('ai', { provider: p, baseUrl, system, prompt, model, maxTokens });
  if (!model.trim()) throw new Error('Pick a model in Settings (⌘,).');
  const key = await storedKey(p);
  if (!key && p !== 'compat') throw new Error('No API key yet — open Settings (⌘,).');
  const w = wire(p, { baseUrl, key, system, prompt, model, maxTokens });
  const [text, stop] = w.read(await fetchJson(w.url, w.headers, w.body, p));
  if (!text.trim() && ['length', 'max_tokens', 'MAX_TOKENS'].includes(stop)) {
    throw new Error('The model used up its token budget before answering — try another model in Settings.');
  }
  return text;
}

// Model ids for the Settings picker, in the provider's order. key: typed but not saved yet (optional).
export async function listModels(p, baseUrl, key = '') {
  if (native) return call('list_models', { provider: p, baseUrl, key: key || null });
  key = key || (await storedKey(p));
  if (!key && p !== 'compat') throw new Error('Add a key to list models');
  if (p === 'gemini') {
    const j = await fetchJson(`${GEMINI}?pageSize=1000`, { 'x-goog-api-key': key }, null, p);
    return (j.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  }
  const j = p === 'anthropic'
    ? await fetchJson('https://api.anthropic.com/v1/models?limit=100', ANTHROPIC_HEADERS(key), null, p)
    : await fetchJson(`${oaBase(p, baseUrl)}/models`, bearer(key), null, p);
  return (j.data || []).map(m => m.id).filter(id => p !== 'openai' || !NOT_TEXT.test(id));
}
