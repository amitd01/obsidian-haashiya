// publish.js — shaping clean text for a publishing platform. Pure text in, text out; no AI.
// The writer's words are never changed — only structure the platform can't take is reshaped.

const strip = s => s.replace(/\*\*|__|[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isSep = l => /^\s*\|?\s*:?-{3,}/.test(l) && l.includes('|');

// Substack: title and subtitle are separate fields; tables don't paste.
// Returns { title, subtitle, body (Markdown), notes: [what changed or won't survive] }.
export function substack(clean) {
  const lines = clean.split('\n');
  const notes = [];
  const next = from => { let k = from; while (k < lines.length && !lines[k].trim()) k++; return k; };

  // Title: a leading "# " heading. Subtitle: the next line if it's a "## " heading or a wholly italic line.
  let title = '', subtitle = '', i = next(0);
  if (/^# /.test(lines[i] || '')) {
    title = strip(lines[i].slice(2));
    const j = next(i + 1);
    const sub = lines[j] || '';
    if (/^## /.test(sub) || /^(\*|_)(?!\*)[^*_].*\1$/.test(sub.trim())) { subtitle = strip(sub.replace(/^## /, '')); i = j; }
    lines.splice(0, i + 1);
  } else notes.push('No “# Title” at the top — type the title in Substack.');

  const out = [];
  let tables = 0, demoted = 0;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (/^\s*\|/.test(l) && isSep(lines[k + 1] || '')) {          // table → one bullet per row
      const head = cells(l);
      for (k += 2; k < lines.length && /^\s*\|/.test(lines[k]); k++) {
        const c = cells(lines[k]);
        out.push(`- **${c[0]}** — ` + c.slice(1).map((v, n) => `${head[n + 1] ? head[n + 1] + ': ' : ''}${v}`).join(' · '));
      }
      k--;
      tables++;
      continue;
    }
    if (/^# /.test(l)) demoted++;
    out.push(l.replace(/^# /, '## '));                             // the title owns the top level
  }
  if (tables) notes.push(`${tables} table${tables > 1 ? 's' : ''} turned into a list (Substack has no tables).`);
  const body = out.join('\n').replace(/^\n+/, '');
  if (/!\[[^\]]*\]\([^)]*\)/.test(body)) notes.push('Images don’t come across in a paste — upload them in Substack.');
  if (/\[\^[^\]]+\]/.test(body)) notes.push('Footnote marks stay as text — use Substack’s footnote button for real ones.');
  if (demoted) notes.push('Other top-level headings became “##”.');
  return { title, subtitle, body, notes };
}
