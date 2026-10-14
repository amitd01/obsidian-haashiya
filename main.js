// Haashiya for Obsidian (FR-02, AD-034): opens a note in Haashiya's own editor, in an Obsidian tab.
//
// The editor (src/) runs unchanged in a same-origin iframe, one per tab, so each tab has its own page
// and app.js keeps its one-editor-per-page design. The frame element carries a bridge (below) that
// src/host.js finds as window.frameElement.haashiyaBridge; see host.js "embedded".
//   Obsidian → page: load(text, path) when the file (re)loads, theme(name) when the theme changes.
//   page → Obsidian: changed(text) to save, request() for AI calls, keys it doesn't use.
// API keys live in Obsidian's secret storage and never enter the page: requests carry a slot that
// request() fills in, and only for that provider's own server.
//
// build.sh bundles this file with the editor (dist/editor.html, inlined) into dist/main.js,
// because Obsidian installs a plugin as just main.js + manifest.json + styles.css.
import { Plugin, TextFileView, MarkdownView, Platform, requestUrl } from 'obsidian';
import EDITOR from './dist/editor.html';

const VIEW = 'haashiya';
const SLOT = '{{haashiya-key}}'; // = KEY_SLOT in src/host.js
// Where each provider's key may be sent. 'compat' is the user's own server (its URL is set in Settings).
const HOSTS = { anthropic: 'api.anthropic.com', openai: 'api.openai.com', gemini: 'generativelanguage.googleapis.com' };
const secretId = p => `haashiya-${p}-key`; // secret ids: lowercase, digits and dashes

// macOS: the Haashiya app keeps each provider's key in the login keychain (src-tauri main.rs SERVICE,
// providers.rs account()). Without -w, `security` only reports that the item exists: no prompt. With -w it
// reads the key, and macOS asks the user once; the key is then copied into Obsidian's secret storage, so
// it never asks again (and "Allow" is enough — "Always Allow" would open the item to anything using `security`).
const APP_SERVICE = 'com.amitdas.margin';
function fromApp(p, read = false) {
  if (!Platform.isMacOS) return Promise.resolve(null);
  const args = ['find-generic-password', '-s', APP_SERVICE, '-a', `${p}-api-key`, ...(read ? ['-w'] : [])];
  return new Promise(done => require('child_process').execFile('/usr/bin/security', args, { timeout: 120e3 },
    (err, out) => done(err ? null : read ? out.trim() || null : true)));
}

class HaashiyaView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.page = null;  // the editor's handlers, once its script has run
    this.shown = null; // the text the page holds: what it was last sent, or last sent us
  }
  getViewType() { return VIEW; }
  getDisplayText() { return this.file?.basename ?? 'Haashiya'; }
  getIcon() { return 'feather'; }

  async onOpen() {
    this.addAction('file-text', 'Open as Markdown', () => this.plugin.switchTo(this.leaf, 'markdown'));
    const frame = this.contentEl.createEl('iframe', { cls: 'haashiya-frame' });
    frame.haashiyaBridge = this.bridge(); // before srcdoc, so the page's first script finds it
    frame.srcdoc = EDITOR;
    this.registerEvent(this.app.workspace.on('css-change', () => this.page?.theme(this.theme())));
  }

  bridge() {
    const secrets = this.app.secretStorage;
    return {
      attach: handlers => {
        this.page = handlers;
        handlers.theme(this.theme());
        if (this.file) handlers.load((this.shown = this.data), this.file.path);
      },
      changed: text => { this.data = this.shown = text; this.requestSave(); },
      save: text => { this.data = this.shown = text; return this.save(); }, // ⌘S: write now
      // true: Obsidian holds a key; 'app': only the Haashiya app does (used, and copied over, on first need).
      hasKey: async p => (secrets.getSecret(secretId(p)) ? true : (await fromApp(p)) ? 'app' : false),
      setKey: (p, key) => (key ? secrets.setSecret(secretId(p), key) : secrets.deleteSecret(secretId(p))),
      request: req => this.plugin.request(req),
      // Shortcuts the editor doesn't use (⌘P, ⌘O…): replay them here so Obsidian's hotkeys still work.
      key: k => document.dispatchEvent(new KeyboardEvent('keydown', { ...k, bubbles: true, cancelable: true })),
    };
  }

  theme() { return document.body.classList.contains('theme-dark') ? 'dark' : 'light'; }

  // TextFileView: Obsidian reads this.data to save, and calls setViewData when the file loads or
  // changes on disk (it has already set this.data by then, so compare with what the page holds).
  // Text the page just sent is not sent back: reloading would reset its undo history.
  getViewData() { return this.data; }
  setViewData(data, clear) {
    this.data = data;
    if (!this.page || !this.file || (!clear && data === this.shown)) return;
    this.page.load((this.shown = data), this.file.path);
  }
  clear() { this.data = ''; this.shown = null; }
}

export default class HaashiyaPlugin extends Plugin {
  onload() {
    this.registerView(VIEW, leaf => new HaashiyaView(leaf, this));

    this.addCommand({
      id: 'open-in-haashiya',
      name: 'Open current note in Haashiya',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) this.switchTo(view.leaf, VIEW);
        return true;
      },
    });
    this.addCommand({
      id: 'open-as-markdown',
      name: 'Open current note as Markdown',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(HaashiyaView);
        if (!view?.file) return false;
        if (!checking) this.switchTo(view.leaf, 'markdown');
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
      if (file?.extension !== 'md') return;
      menu.addItem(item => item.setTitle('Open in Haashiya').setIcon('feather').onClick(async () => {
        if (leaf?.view?.file === file) return this.switchTo(leaf, VIEW);
        const tab = this.app.workspace.getLeaf('tab');
        await tab.setViewState({ type: VIEW, state: { file: file.path }, active: true });
      }));
    }));
  }

  // Same tab, same file, other editor.
  async switchTo(leaf, type) {
    const file = leaf.view.file;
    if (leaf.view instanceof TextFileView) await leaf.view.save(); // nothing typed is lost in the switch
    await leaf.setViewState({ type, state: { file: file.path }, active: true });
  }

  // The Haashiya app's key for provider p, copied into secret storage the first time (see fromApp).
  async keyFromApp(p) {
    const key = await fromApp(p, true);
    if (key) this.app.secretStorage.setSecret(secretId(p), key);
    return key;
  }

  // An AI call from the page: fill in the key (only for that provider's server) and send it with
  // Obsidian's requestUrl, which has no CORS limits. Resolves to { status, json } like host.js expects.
  async request(req) {
    const { provider, url, headers = {} } = req;
    const allowed = provider === 'compat' || (HOSTS[provider] && new URL(url).hostname === HOSTS[provider]);
    if (!allowed) throw new Error(`Haashiya won't send a ${provider} request to ${new URL(url).host}`);
    const usesKey = Object.values(headers).some(v => String(v).includes(SLOT));
    const saved = this.app.secretStorage.getSecret(secretId(provider));
    let r = await this.send(req, saved || (usesKey && (await this.keyFromApp(provider))) || '');
    // Key rejected, and the Haashiya app holds a different one (the key was changed there): take it, try once more.
    if ((r.status === 401 || r.status === 403) && usesKey && saved && (await fromApp(provider))) {
      const fresh = await this.keyFromApp(provider);
      if (fresh && fresh !== saved) r = await this.send(req, fresh);
    }
    return r;
  }

  async send({ url, headers = {}, body = null }, key) {
    const filled = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v).replace(SLOT, key)]));
    const r = await requestUrl({
      url,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json', ...filled } : filled,
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });
    let json = {};
    try { json = r.json; } catch { /* not JSON: host.js reports the HTTP status */ }
    return { status: r.status, json };
  }
}
