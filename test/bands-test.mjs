// Rating bands: one colour scale across every rating on every page.
// Uses the real functions sliced out of the userscript.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../recut.user.js', import.meta.url));
const LINES = fs.readFileSync(PATH, 'utf8').split(/\r?\n/);

function balanced(text) {
  let d = 0, tick = 0;
  for (const ch of text) {
    if (ch === '`') tick ^= 1;
    if (tick) continue;
    if (ch === '(' || ch === '{' || ch === '[') d++;
    else if (ch === ')' || ch === '}' || ch === ']') d--;
  }
  return d === 0 && tick === 0;
}

function sliceDecl(name) {
  const fnHead = new RegExp('^  (?:async )?function ' + name + '\\(');
  const constHead = new RegExp('^  const ' + name + '\\b');
  const i = LINES.findIndex((l) => fnHead.test(l) || constHead.test(l));
  if (i < 0) throw new Error('not found: ' + name);
  if (fnHead.test(LINES[i])) {
    for (let j = i + 1; j < LINES.length; j++) if (LINES[j] === '  }') return LINES.slice(i, j + 1).join('\n');
    throw new Error('no end for ' + name);
  }
  for (let j = i; j < Math.min(i + 200, LINES.length); j++) {
    const text = LINES.slice(i, j + 1).join('\n');
    if (LINES[j].trimEnd().endsWith(';') && balanced(text)) return text;
  }
  throw new Error('no end for const ' + name);
}

const NAMES = ['RATING_BANDS', 'ratingBand', 'THIN_VOTES', 'ratingClasses',
  'compactNum', 'countText', 'bandedCountText'];
const M = new Function(NAMES.map(sliceDecl).join('\n\n')
  + '\nreturn {ratingBand, ratingClasses, THIN_VOTES, countText, bandedCountText};')();

let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

console.log('[boundaries on the 0-10 IMDb scale]');
const cases10 = [
  [10, 'rb-top'], [8.9, 'rb-top'], [8.0, 'rb-top'],
  [7.9, 'rb-high'], [7.0, 'rb-high'],
  [6.9, 'rb-mid'], [6.0, 'rb-mid'],
  [5.9, 'rb-low'], [1.2, 'rb-low'], [0, 'rb-low']
];
for (const [v, want] of cases10) check(`${v}/10 -> ${want}`, M.ratingBand(v, 10) === want, M.ratingBand(v, 10));

console.log('\n[other scales normalise to the same bands]');
check('Metascore 92 -> top', M.ratingBand(92, 100) === 'rb-top');
check('Metascore 65 -> mid', M.ratingBand(65, 100) === 'rb-mid');
check('Metascore 38 -> low', M.ratingBand(38, 100) === 'rb-low');
check('Tomatometer 91% -> top', M.ratingBand(91, 100) === 'rb-top');
check('Letterboxd 4.4/5 -> top', M.ratingBand(4.4, 5) === 'rb-top', M.ratingBand(4.4, 5));
check('Letterboxd 3.2/5 -> mid', M.ratingBand(3.2, 5) === 'rb-mid', M.ratingBand(3.2, 5));
check('Letterboxd 2.5/5 -> low', M.ratingBand(2.5, 5) === 'rb-low');

console.log('\n[the red band lines up with Rotten Tomatoes\u2019 own fresh/rotten split]');
check('59% is rotten AND red', M.ratingBand(59, 100) === 'rb-low');
check('60% is fresh AND not red', M.ratingBand(60, 100) !== 'rb-low', M.ratingBand(60, 100));

console.log('\n[missing values produce no class at all]');
for (const v of [undefined, null, NaN, Infinity, 'eight', {}]) {
  check(`${JSON.stringify(v) || String(v)} -> ""`, M.ratingBand(v, 10) === '' && M.ratingClasses(v, 10, 100) === '');
}

console.log('\n[thin-vote dimming so a 9.8 from 14 votes cannot outshout a classic]');
check('9.8 from 14 votes is dimmed', M.ratingClasses(9.8, 10, 14) === 'rb-top rb-thin', M.ratingClasses(9.8, 10, 14));
check('8.9 from 2.2M votes is not', M.ratingClasses(8.9, 10, 2236310) === 'rb-top', M.ratingClasses(8.9, 10, 2236310));
check(`exactly ${M.THIN_VOTES} votes is not dimmed`, M.ratingClasses(7.5, 10, M.THIN_VOTES) === 'rb-high');
check(`${M.THIN_VOTES - 1} votes is dimmed`, M.ratingClasses(7.5, 10, M.THIN_VOTES - 1) === 'rb-high rb-thin');
check('an unknown vote count is not dimmed', M.ratingClasses(7.5, 10, undefined) === 'rb-high');
check('zero votes is not dimmed (no data, not thin data)', M.ratingClasses(7.5, 10, 0) === 'rb-high');

console.log('\n[every band has a colour defined in both themes]');
const css = fs.readFileSync(PATH, 'utf8');
for (const band of ['top', 'high', 'mid', 'low']) {
  const light = new RegExp('--rb-' + band + ':\\s*#').test(css);
  const cls = new RegExp('\\.rb-' + band + '\\s*\\{').test(css);
  const tile = new RegExp('\\.imdbc-score\\.rb-' + band + '\\s+\\.val').test(css);
  check(`rb-${band}: variable, class and tile rule all present`, light && cls && tile, `var=${light} class=${cls} tile=${tile}`);
}
const darkBlock = css.slice(css.indexOf('html.imdbc-on.imdbc-dark'));
check('dark theme redefines all four', ['top', 'high', 'mid', 'low'].every((b) => darkBlock.includes('--rb-' + b + ':')));

console.log('\n[a count under a score reads the same way whatever site it came from]');
// The strip used to print IMDb's "2.2M votes" beside Rotten Tomatoes' own
// "250,000+ Ratings" and Letterboxd's "3.3M ratings" - three number styles and
// two capitalisations across one row of tiles.
check('votes are compacted', M.countText(2236430, 'votes') === '2.2M votes', M.countText(2236430, 'votes'));
check('small counts are left alone', M.countText(271, 'critics') === '271 critics', M.countText(271, 'critics'));
check('no count yields nothing, so the caller can fall back',
  M.countText(0, 'votes') === '' && M.countText(undefined, 'votes') === '' && M.countText(null, 'votes') === '');

check("RT's banded phrase is compacted and lowercased",
  M.bandedCountText('250,000+ Ratings', 'ratings') === '250K+ ratings', M.bandedCountText('250,000+ Ratings', 'ratings'));
check('the + is kept, because the number is a floor not a total',
  M.bandedCountText('2,500,000+ Ratings', 'ratings') === '2.5M+ ratings', M.bandedCountText('2,500,000+ Ratings', 'ratings'));
check('a banded phrase with no leading number is refused, not mangled',
  M.bandedCountText('Fewer than 50 Ratings', 'ratings') === '', M.bandedCountText('Fewer than 50 Ratings', 'ratings'));
for (const bad of ['', null, undefined, 'abc', '0 Ratings']) {
  check(`${JSON.stringify(bad) || String(bad)} -> ""`, M.bandedCountText(bad, 'ratings') === '');
}

console.log('\n[the band colours the score, never the count beside it]');
// "6.4 4.4K" in one green read as two ratings side by side.
check('a neutral rule claims every .rt small',
  /:where\(#imdbc-root\) \.rt small \{[^}]*color: var\(--imdbc-faint\)/.test(css),
  (css.match(/\.rt small \{[^}]*\}/) || ['(no rule)'])[0].replace(/\s+/g, ' '));
// A margin is not a word break: with the space removed the count sat against
// the score with no character between them, so it copied and read aloud as
// "9.33.2M".
check('the count is separated by a real space, not only a margin',
  css.includes('<small> ${compactNum('),
  (css.match(/<small>.{0,20}/) || ['(none)'])[0]);
check('no .rt small rule leans on a margin for that gap',
  !/\.rt small \{[^}]*margin-left/.test(css));
// <small> is relative, so the same count rendered at a different size in a
// credit row than in a result row. One size, stated once.
check('every count renders at one size, whatever row it sits in',
  /\.rt small \{[^}]*font-size: var\(--fs-/.test(css),
  (css.match(/\.rt small \{[^}]*\}/) || ['(no rule)'])[0].replace(/\s+/g, ' '));
check('no band rule paints a whole .rt subtree with no exemption',
  !/\.rb-(top|high|mid|low) \*/.test(css));
// Every vote count on the site is the same grey, including the two that sit on
// the ratings page one above the other.
for (const sel of ['.imdbc-hrow .ct', '.imdbc-hcountry .ct']) {
  const rule = new RegExp(sel.replace(/\./g, '\\.') + ' \\{[^}]*\\}').exec(css);
  check(`${sel} uses the shared count grey`,
    !!rule && /--imdbc-faint/.test(rule[0]), rule ? rule[0].replace(/\s+/g, ' ') : '(missing)');
}

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
