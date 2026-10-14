// preview.js — read-only "reading view": the clean text (alternates resolved, ghosts dropped)
// rendered as formatted Markdown. Small on purpose: headings, paragraphs, lists, quotes, rules,
// code, tables, bold/italic/code/links. No dependencies.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  const code = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`); // protect code spans
  s = s.replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
       .replace(/(?<![*\w])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![*\w])/g, '<em>$1</em>')
       .replace(/(?<!\w)_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '<em>$1</em>')
       .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${/^(https?:|mailto:)/.test(u) ? u : '#'}" target="_blank">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
}

const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isSep = l => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l) && l.includes('|');

export function render(md) {
  const lines = md.split('\n'), out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*```/.test(l)) {                                   // fenced code
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`); i++; continue;
    }
    const h = l.match(/^(#{1,6}) (.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(l) && isSep(lines[i + 1] || '')) {     // table: header, separator, rows
      const head = cells(l).map(c => `<th>${inline(c)}</th>`).join('');
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(`<tr>${cells(lines[i]).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`);
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`); continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${render(q.join('\n'))}</blockquote>`); continue;
    }
    if (/^\s*([-*+]|\d+\.) /.test(l)) { const r = list(lines, i); out.push(r.html); i = r.next; continue; }
    out.push(`<p>${inline(l)}</p>`); i++;                       // paragraph: one per line (Margin's model)
  }
  return out.join('\n');
}

// Nested lists by indentation.
function list(lines, i) {
  const indent = l => l.match(/^\s*/)[0].length;
  const base = indent(lines[i]);
  const ordered = /^\s*\d+\./.test(lines[i]);
  const items = [];
  const same = l => /^\s*\d+\./.test(l) === ordered; // a switch between - and 1. starts a new list
  while (i < lines.length && /^\s*([-*+]|\d+\.) /.test(lines[i]) && indent(lines[i]) >= base) {
    if (indent(lines[i]) === base && !same(lines[i])) break;
    if (indent(lines[i]) > base) { const r = list(lines, i); items[items.length - 1] += r.html; i = r.next; continue; }
    items.push(inline(lines[i].replace(/^\s*([-*+]|\d+\.) /, '')));
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.map(x => `<li>${x}</li>`).join('')}</${tag}>`, next: i };
}
