// ai.js — every prompt Margin sends. The rule throughout: AI suggests or selects; it never rewrites.
import { ai } from './host.js';

// Models sometimes wrap JSON in prose or code fences; take the first array we can find.
function list(s) {
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('The AI reply had no list in it — try again.');
  return JSON.parse(m[0]);
}

const ONLY_JSON = 'Reply with a JSON array and nothing else.';

export async function suggestAlternates(target, context, existing) {
  const out = await ai({
    system: `You help a writer weigh word choices. You never rewrite their text; you only offer drop-in alternatives. ${ONLY_JSON}`,
    prompt: `Paragraph:\n${context}\n\nTarget: "${target}"\nVersions already considered: ${JSON.stringify(existing)}\n\n` +
      'Give 4 new alternatives for the target that drop into the paragraph grammatically, keep the meaning, ' +
      "match the writer's tone, and stay close in length. Return a JSON array of strings.",
    maxTokens: 400,
  });
  return list(out).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}

const TRIM = { slight: 'about 10%', tighter: 'about 20–25%', half: 'about 50%' };

export async function trimCuts(text, level) {
  const out = await ai({
    system: `You are a careful editor. You never rewrite, reorder or add words; you only choose passages to delete so what remains still reads correctly. ${ONLY_JSON}`,
    prompt: `Shorten the text below by ${TRIM[level]} of its words, purely by deletion.\n` +
      'Return the passages to delete as a JSON array of strings. Copy each passage verbatim (same characters and punctuation), ' +
      'keep each within a single line, and make each long enough to be unique. Prefer redundant sentences, ' +
      'weak clauses, hedges and filler words. Never cut headings (lines starting with #).\n\n<text>\n' + text + '\n</text>',
    maxTokens: 2000,
  });
  return list(out).filter(x => typeof x === 'string' && x.trim());
}

const CHECKS = {
  convoluted: 'sentences that are convoluted, overloaded or hard to follow on first read',
  tone: "words or phrases that don't fit the piece's overall tone (for example jargon or ornate wording in plain writing)",
};

export async function check(text, kind) {
  const out = await ai({
    system: `You are a candid editor who points at problems without fixing them. ${ONLY_JSON}`,
    prompt: `Find ${CHECKS[kind]} in the text below. Return a JSON array of objects {"text": exact verbatim passage from a single line, "note": a short reason (max 12 words)}. ` +
      'Return at most 8 items; return [] if nothing stands out.\n\n<text>\n' + text + '\n</text>',
    maxTokens: 1500,
  });
  return list(out).filter(x => x && typeof x.text === 'string' && x.text.trim());
}

// ReduceSlop — ByLine's anti-slop rules (owner's article pipeline) plus common AI tells.
// Each hit comes back with plain replacements (shown as ✦ alternates, the original one ↑/↓ away)
// or "" when the words should simply go (ghosted, revivable). The writer decides by flipping or reviving.
const SLOP_RULES = `ByLine's hard-ban list:
- Decorative em-dashes, especially "it's not X — it's Y" or "— and that's the kicker" (genuine parenthetical asides are fine)
- Rhetorical questions used as transitions ("So what does this mean?", "Why does this matter?")
- "In a world where…" openers and variants; "Imagine if…" openers
- Performative sincerity: "let's be honest", "the truth is", "here's the thing", "the reality is"
- Stage-setters before a claim: "at its core", "fundamentally", "essentially"
- Staged escalation: "It's not just X. It's Y."
- Tricolons of rising emphasis ("faster, smarter, and changes everything"); smug parallel sentences ("The data is clear. The pattern is obvious.")
- Banned words: game-changer, paradigm shift, disrupt (for non-disruption), leverage (as a verb), unpacking, deep dive, double-click, "in today's … landscape", thought leader(ship), massive / huge / incredible (as analysis), robust, seamless, holistic, synergy, and "crucially" / "importantly" / "notably" opening a sentence
- Structural slop: opening with a definition; "In conclusion" / "To summarise"; question headings; a vague optimistic ending
Common AI tells:
- delve, tapestry, testament to, realm, landscape (as metaphor), navigate (as metaphor), embark, elevate, foster, unlock, harness, pivotal, crucial / vital (as filler), ever-evolving, fast-paced, cutting-edge, "plays a crucial role", "it's worth noting", "it is important to note", "at the end of the day", "in today's world", "when it comes to"
- "Not only X but also Y" used for emphasis; "From X to Y" range-padding; lists of three abstract nouns
- Empty intensifiers and hedges: very, really, truly, incredibly, extremely, quite, arguably, in many ways, essentially, basically, actually
- Throat-clearing openers and sign-offs that carry no information`;

export async function reduceSlop(text) {
  const out = await ai({
    system: `You are a blunt, thorough editor applying a house anti-slop list. You point at slop and offer plain, declarative drop-in replacements; the writer chooses. ${ONLY_JSON}`,
    prompt: `${SLOP_RULES}\n\nGo through the text below line by line and find EVERY instance — be thorough, a typical draft has several. ` +
      'Return a JSON array of objects {"text": exact verbatim passage from a single line (just the sloppy words, long enough to be unique; ' +
      'include adjacent punctuation/spaces only if they must go too), ' +
      '"note": which rule, max 10 words — say "load-bearing: argument may be weak" if the slop is doing the work of an argument, ' +
      '"options": 1–3 plain replacements that drop in grammatically and keep the meaning, best first — or [""] when the words should simply be deleted}. ' +
      'Do not overlap passages. At most 25 items; [] if the text is clean. Never flag headings for wording, only for being questions.\n\n<text>\n' + text + '\n</text>',
    maxTokens: 4000,
  });
  return list(out)
    .filter(x => x && typeof x.text === 'string' && x.text.trim())
    .map(x => {
      const raw = (Array.isArray(x.options) ? x.options : []).filter(o => typeof o === 'string');
      const options = raw.map(o => o.trim()).filter(Boolean);
      return { ...x, options, remove: !options.length && raw.length > 0 }; // [""] means: delete these words
    });
}
