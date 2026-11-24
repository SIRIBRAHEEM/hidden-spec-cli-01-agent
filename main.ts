// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, in the order they applied. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Files: a file is its line break, its lines, and whether it ends    */
/* with a line break (SPEC.md section 3).                             */
/* ------------------------------------------------------------------ */

interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC.md section 5).                 */
/* ------------------------------------------------------------------ */

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndWs(line);
  return trimWs(line);
}

/** 0-based positions where O occurs in lines at the given tier, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const want = O.map((l) => tierKey(l, tier));
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== want[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2, or 0 only when strict) at which O occurs, with its positions. */
function findFirstTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, O, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line O[ctx]) or an added line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * Replace O at position `pos` by N. Context lines are written as the file's own matched lines; at tier 2
 * every other line of N is re-indented from O's first line to the file's first matched line.
 */
function spliceLines(fileLines: string[], O: string[], N: NewLine[], pos: number, tier: number): string[] {
  const out = fileLines.slice(0, pos);
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[pos]!);
    P = leadingWs(O[0]!);
  }
  for (const item of N) {
    if (item.ctx !== null) {
      out.push(fileLines[pos + item.ctx]!);
    } else {
      let t = item.text;
      if (tier === 2 && t !== '' && t.replace(/[ \t]/g, '') !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...fileLines.slice(pos + O.length));
  return out;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4).                              */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9).                                    */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6).                                 */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
  raw: string;
}

interface Hunk {
  oldStart: number;
  body: BodyLine[];
  O: string[];
  N: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastCtxOrPlusBackslash: boolean;
}

function finishHunk(oldStart: number, body: BodyLine[]): Hunk {
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      const j = O.length;
      O.push(bl.text);
      N.push({ text: bl.text, ctx: j });
    } else if (bl.kind === 'old') {
      O.push(bl.text);
    } else if (bl.kind === 'new') {
      N.push({ text: bl.text, ctx: null });
    }
  }
  let lastCtxOrPlusBackslash = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      lastCtxOrPlusBackslash = body[k + 1] !== undefined && body[k + 1]!.kind === 'backslash';
      break;
    }
  }
  return { oldStart, body, O, N, lastCtxOrPlusBackslash };
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pair: [string, string] | null;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

/** `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function normHeaderPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function normOtherPath(p: string): string | null {
  if (p === '/dev/null') return null;
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: Section | null = null;
  let curBody: BodyLine[] | null = null;
  let curOldStart = 0;

  const endBody = (): void => {
    if (sec !== null && curBody !== null) sec.hunks.push(finishHunk(curOldStart, curBody));
    curBody = null;
  };
  const endSection = (): void => {
    endBody();
    if (sec !== null) edits.push(sectionEdit(sec, strict));
    sec = null;
  };

  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (curBody !== null) {
      if (l.startsWith('diff --git ')) {
        endBody();
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        const kind: BodyLine['kind'] = l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : l[0] === '+' ? 'new' : 'backslash';
        curBody.push({ kind, text: l === '' ? '' : l.slice(1), raw: l });
        i++;
        continue;
      }
      endBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endSection();
      sec = { gitOld: m[1]!, gitNew: m[2]!, pair: null, renameOld: null, renameNew: null, isCreate: false, isDelete: false, hunks: [] };
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      curOldStart = parseInt(m[1]!, 10);
      curBody = [];
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && sec.hunks.length === 0 && sec.pair === null) {
        sec.pair = [headerPath(l), headerPath(lines[i + 1]!)];
        i += 2;
        continue;
      }
      endSection();
      sec = { gitOld: null, gitNew: null, pair: [headerPath(l), headerPath(lines[i + 1]!)], renameOld: null, renameNew: null, isCreate: false, isDelete: false, hunks: [] };
      i += 2;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        sec.renameOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  endSection();
  return edits;
}

/** Apply one hunk to a file's lines, at the occurrence nearest to A - 1 + d. */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): FileDoc {
  const O = hunk.O;
  const N = hunk.N;
  if (O.length > 0) {
    const found = findFirstTier(doc.lines, O, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.oldStart - 1 + d;
    let best = found.positions[0]!;
    for (const pos of found.positions) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const newLines = spliceLines(doc.lines, O, N, best, found.tier);
    let final = doc.final;
    if (best + O.length === doc.lines.length) final = !hunk.lastCtxOrPlusBackslash;
    return { br: doc.br, lines: newLines, final };
  }
  const at = Math.max(0, Math.min(hunk.oldStart + d, doc.lines.length));
  const ins = N.map((x) => x.text);
  const newLines = [...doc.lines.slice(0, at), ...ins, ...doc.lines.slice(at)];
  let final = doc.final;
  if (at === doc.lines.length) final = !hunk.lastCtxOrPlusBackslash;
  return { br: doc.br, lines: newLines, final };
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  let oldPath: string | null;
  let newPath: string | null;
  if (sec.pair !== null) {
    oldPath = normHeaderPath(sec.pair[0]);
    newPath = normHeaderPath(sec.pair[1]);
  } else {
    oldPath = sec.renameOld !== null ? normOtherPath(sec.renameOld) : sec.gitOld;
    newPath = sec.renameNew !== null ? normOtherPath(sec.renameNew) : sec.gitNew;
  }
  const isCreate = sec.isCreate || oldPath === null;
  const isDelete = !isCreate && (sec.isDelete || newPath === null);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const p = newPath;
      if (p === null) throw new Fail('missing', '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      for (const h of sec.hunks) for (const bl of h.body) if (bl.kind === 'new') added.push(bl.text);
      let noBreak = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.kind === 'new') {
            noBreak = body[k + 1] !== undefined && body[k + 1]!.kind === 'backslash';
            break outer;
          }
        }
      }
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath;
      if (p === null) throw new Fail('missing', '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      const text = tree.get(oldPath);
      if (text === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let doc = parseDoc(text);
      let d = 0;
      for (const h of sec.hunks) {
        doc = applyHunk(doc, h, d, strict, oldPath);
        d += h.N.length - h.O.length;
      }
      tree.now.set(oldPath, null);
      tree.now.set(newPath, renderDoc(doc));
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const p = oldPath ?? newPath;
    if (p === null) throw new Fail('missing', '');
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    let doc = parseDoc(text);
    let d = 0;
    for (const h of sec.hunks) {
      doc = applyHunk(doc, h, d, strict, p);
      d += h.N.length - h.O.length;
    }
    tree.now.set(p, renderDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7).                         */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
      j++;
    }
    if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
      k++;
    }
    if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let m = i - 1; m > prevEnd; m--) {
      const t = lines[m]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = k;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    i = k + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseDoc(text);
    const found = findFirstTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const N: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const newDocLines = spliceLines(doc.lines, oldLines, N, found.positions[0]!, found.tier);
    tree.now.set(path, renderDoc({ br: doc.br, lines: newDocLines, final: doc.final }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8).                                   */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NewLine[];
}

function chunkFromBody(anchor: string | null, eof: boolean, body: BodyLine[]): V4aChunk {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      const j = O.length;
      O.push(bl.text);
      N.push({ text: bl.text, ctx: j });
    } else if (bl.kind === 'old') {
      O.push(bl.text);
    } else if (bl.kind === 'new') {
      N.push({ text: bl.text, ctx: null });
    }
  }
  return { anchor, eof, O, N };
}

const V4A_SECTION_RE = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function isV4aSectionStart(l: string): boolean {
  return V4A_SECTION_RE.test(l);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const end = last;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < end) {
    while (i < end && blank(lines[i]!)) i++;
    if (i >= end) break;
    const l = lines[i]!;
    const m = V4A_SECTION_RE.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    if (kind === 'Add File') {
      i++;
      // Collect the section's raw lines, then drop the blank lines at its end.
      const raw: { text: string; no: number }[] = [];
      while (i < end && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (kind === 'Delete File') {
      i++;
      while (i < end && !isV4aSectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    // Update File
    const updateLine = i + 1;
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < end && !isV4aSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    let idx = 0;
    let moveTo: string | null = null;
    if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[idx]!.text.slice('*** Move to: '.length).trim();
      idx++;
    }
    const chunks: V4aChunk[] = [];
    let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
    let afterEof = false;
    const finishChunk = (): void => {
      if (cur !== null) chunks.push(chunkFromBody(cur.anchor, cur.eof, cur.body));
      cur = null;
    };
    while (idx < raw.length) {
      const sl = raw[idx]!.text;
      const no = raw[idx]!.no;
      if (sl.startsWith('@@')) {
        finishChunk();
        const anchor = sl.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        afterEof = false;
        idx++;
        continue;
      }
      if (sl.trim() === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${no}`);
        cur.eof = true;
        finishChunk();
        afterEof = true;
        idx++;
        continue;
      }
      if (sl === '' || sl[0] === ' ' || sl[0] === '-' || sl[0] === '+') {
        if (cur === null) {
          if (afterEof) throw new Exit2(`error: parse ${no}`);
          cur = { anchor: null, eof: false, body: [] };
        }
        const kind2: BodyLine['kind'] = sl === '' ? 'ctx' : sl[0] === ' ' ? 'ctx' : sl[0] === '-' ? 'old' : 'new';
        cur.body.push({ kind: kind2, text: sl === '' ? '' : sl.slice(1), raw: sl });
        idx++;
        continue;
      }
      throw new Exit2(`error: parse ${no}`);
    }
    finishChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyV4aChunk(doc: FileDoc, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { doc: FileDoc; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let foundAt: number | null = null;
    for (const t of tiers) {
      for (let i2 = cur; i2 < doc.lines.length; i2++) {
        if (tierKey(doc.lines[i2]!, t) === tierKey(chunk.anchor, t)) {
          foundAt = i2;
          break;
        }
      }
      if (foundAt !== null) break;
    }
    if (foundAt === null) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  const O = chunk.O;
  const N = chunk.N;
  if (O.length === 0) {
    const at = chunk.eof ? doc.lines.length : cur;
    const ins = N.map((x) => x.text);
    const newLines = [...doc.lines.slice(0, at), ...ins, ...doc.lines.slice(at)];
    return { doc: { br: doc.br, lines: newLines, final: doc.final }, cursor: at + ins.length };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let found: { tier: number; positions: number[] } | null = null;
  for (const t of tiers) {
    let positions = occurrences(doc.lines, O, t, cur);
    if (chunk.eof) positions = positions.filter((p) => p + O.length === doc.lines.length);
    if (positions.length > 0) {
      found = { tier: t, positions };
      break;
    }
  }
  if (found === null) throw new Fail('no-match', path);
  const pos = found.positions[0]!;
  const newLines = spliceLines(doc.lines, O, N, pos, found.tier);
  return { doc: { br: doc.br, lines: newLines, final: doc.final }, cursor: pos + N.length };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseDoc(text);
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4aChunk(doc, chunk, cursor, strict, path);
      doc = r.doc;
      cursor = r.cursor;
    }
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, renderDoc(doc));
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, renderDoc(doc));
    }
  };
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10).                            */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  const qualOld = new Set<string>();
  const qualNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      qualOld.add(o);
      qualNew.add(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  const sortedPaths = [...tree.now.keys()].sort(byteOrder);
  for (const p of sortedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null) {
      if (qualOld.has(p)) continue;
      rows.push({ key: p, line: `D ${p}` });
    } else if (was === null && now !== null) {
      if (qualNew.has(p)) continue;
      rows.push({ key: p, line: `A ${p}` });
    } else {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
