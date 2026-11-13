// Small Airtable-style formula language: {Field Name}, numbers, "strings", + - * / & = != <> < > <= >=, function calls.
// Pure and sandboxed: no eval, no property access. Includes scientific helpers (GC, REVCOMP, TRANSLATE, MW ...).
import { cleanSeq, gcContent, proteinMass, reverseComplement, transcribe, translate } from './sequence.ts';

type Tok =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'ref'; v: string } | { t: 'id'; v: string }
  | { t: 'op'; v: string } | { t: '(' } | { t: ')' } | { t: ',' };

export type Node =
  | { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'ref'; name: string }
  | { k: 'un'; op: string; a: Node } | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new Error('Unclosed { in formula');
      out.push({ t: 'ref', v: src.slice(i + 1, j).trim() });
      i = j + 1; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) j++; s += src[j++]; }
      if (j >= src.length) throw new Error('Unclosed string in formula');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number at ${i}`);
      out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0].toUpperCase() }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>', '=='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/&=<>^'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { out.push({ t: '(' }); i++; continue; }
    if (c === ')') { out.push({ t: ')' }); i++; continue; }
    if (c === ',') { out.push({ t: ',' }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

export function parseFormula(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (t: Tok | undefined, ...ops: string[]) => t?.t === 'op' && ops.includes(t.v);
  function parseConcat(): Node {
    let a = parseCmp();
    while (isOp(peek(), '&')) { next(); a = { k: 'bin', op: '&', a, b: parseCmp() }; }
    return a;
  }
  function parseCmp(): Node {
    let a = parseAdd();
    while (isOp(peek(), '=', '==', '!=', '<>', '<', '>', '<=', '>=')) {
      const op = (next() as { v: string }).v;
      a = { k: 'bin', op, a, b: parseAdd() };
    }
    return a;
  }
  function parseAdd(): Node {
    let a = parseMul();
    while (isOp(peek(), '+', '-')) { const op = (next() as { v: string }).v; a = { k: 'bin', op, a, b: parseMul() }; }
    return a;
  }
  function parseMul(): Node {
    let a = parsePow();
    while (isOp(peek(), '*', '/')) { const op = (next() as { v: string }).v; a = { k: 'bin', op, a, b: parsePow() }; }
    return a;
  }
  function parsePow(): Node {
    const a = parseUnary();
    if (isOp(peek(), '^')) { next(); return { k: 'bin', op: '^', a, b: parsePow() }; }
    return a;
  }
  function parseUnary(): Node {
    if (isOp(peek(), '-')) { next(); return { k: 'un', op: '-', a: parseUnary() }; }
    if (isOp(peek(), '+')) { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary(): Node {
    const t = next();
    if (!t) throw new Error('Unexpected end of formula');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'ref') return { k: 'ref', name: t.v };
    if (t.t === '(') { const e = parseConcat(); if (next()?.t !== ')') throw new Error('Missing )'); return e; }
    if (t.t === 'id') {
      if (peek()?.t === '(') {
        next();
        const args: Node[] = [];
        if (peek()?.t !== ')') {
          for (;;) { args.push(parseConcat()); if (peek()?.t === ',') { next(); continue; } break; }
        }
        if (next()?.t !== ')') throw new Error(`Missing ) after ${t.v}(`);
        return { k: 'call', name: t.v, args };
      }
      if (t.v === 'TRUE') return { k: 'num', v: 1 };
      if (t.v === 'FALSE') return { k: 'num', v: 0 };
      throw new Error(`Unknown name ${t.v}; use {Field Name} to reference a field`);
    }
    throw new Error('Unexpected token in formula');
  }
  const ast = parseConcat();
  if (p < toks.length) throw new Error('Unexpected input after end of formula');
  return ast;
}

/** All field names a formula depends on (used for dependency ordering and cycle detection). */
export function formulaRefs(node: Node, out = new Set<string>()): Set<string> {
  if (node.k === 'ref') out.add(node.name);
  else if (node.k === 'un') formulaRefs(node.a, out);
  else if (node.k === 'bin') { formulaRefs(node.a, out); formulaRefs(node.b, out); }
  else if (node.k === 'call') node.args.forEach((a) => formulaRefs(a, out));
  return out;
}

export type FVal = string | number | boolean | null | FVal[];

const flat = (v: FVal): FVal[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);
const num = (v: FVal): number => {
  if (Array.isArray(v)) return v.length ? num(v[0]) : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  const n = Number(v);
  return Number.isNaN(n) ? NaN : n;
};
const str = (v: FVal): string => {
  if (Array.isArray(v)) return v.map(str).join(', ');
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};
const truthy = (v: FVal): boolean => {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v !== '' && v.toLowerCase() !== 'false';
  return Boolean(v);
};
const nums = (args: FVal[]): number[] => args.flatMap(flat).filter((x) => x !== null && x !== '').map(num).filter((n) => !Number.isNaN(n));
const date = (v: FVal): Date => new Date(typeof v === 'number' ? v : str(v));
const UNIT_MS: Record<string, number> = { milliseconds: 1, seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5 };

type Fn = (a: FVal[]) => FVal;
const FUNCS: Record<string, Fn> = {
  AND: (a) => a.every(truthy), OR: (a) => a.some(truthy), NOT: (a) => !truthy(a[0]),
  BLANK: () => null, ISBLANK: (a) => a[0] === null || a[0] === '' || (Array.isArray(a[0]) && a[0].length === 0),
  CONCAT: (a) => a.map(str).join(''), LEN: (a) => str(a[0]).length, UPPER: (a) => str(a[0]).toUpperCase(), LOWER: (a) => str(a[0]).toLowerCase(),
  TRIM: (a) => str(a[0]).trim(), LEFT: (a) => str(a[0]).slice(0, num(a[1])), RIGHT: (a) => { const s = str(a[0]); const n = num(a[1]); return n <= 0 ? '' : s.slice(-n); },
  MID: (a) => str(a[0]).substr(Math.max(0, num(a[1]) - 1), num(a[2])), FIND: (a) => str(a[1]).indexOf(str(a[0])) + 1,
  SUBSTITUTE: (a) => str(a[0]).split(str(a[1])).join(str(a[2])),
  ROUND: (a) => { const p = a[1] === undefined ? 0 : num(a[1]); const f = 10 ** p; return Math.round(num(a[0]) * f) / f; },
  ABS: (a) => Math.abs(num(a[0])), FLOOR: (a) => Math.floor(num(a[0])), CEIL: (a) => Math.ceil(num(a[0])), SQRT: (a) => Math.sqrt(num(a[0])),
  POWER: (a) => num(a[0]) ** num(a[1]), LOG: (a) => (a[1] === undefined ? Math.log10(num(a[0])) : Math.log(num(a[0])) / Math.log(num(a[1]))),
  SUM: (a) => nums(a).reduce((x, y) => x + y, 0), AVG: (a) => { const n = nums(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : null; },
  MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : null; }, MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : null; },
  COUNT: (a) => nums(a).length, COUNTA: (a) => a.flatMap(flat).filter((x) => x !== null && x !== '').length,
  JOIN: (a) => flat(a[0]).map(str).join(a[1] === undefined ? ', ' : str(a[1])),
  TODAY: () => new Date().toISOString().slice(0, 10), NOW: () => new Date().toISOString(),
  YEAR: (a) => date(a[0]).getUTCFullYear(), MONTH: (a) => date(a[0]).getUTCMonth() + 1, DAY: (a) => date(a[0]).getUTCDate(),
  DATEDIFF: (a) => { const u = UNIT_MS[(a[2] === undefined ? 'days' : str(a[2])).toLowerCase()] ?? 864e5; return Math.round((date(a[0]).getTime() - date(a[1]).getTime()) / u); },
  DATEADD: (a) => { const u = UNIT_MS[(a[2] === undefined ? 'days' : str(a[2])).toLowerCase()] ?? 864e5; return new Date(date(a[0]).getTime() + num(a[1]) * u).toISOString().slice(0, 10); },
  // scientific helpers
  SEQLEN: (a) => cleanSeq(str(a[0])).replace(/[^A-Z]/g, '').length,
  GC: (a) => Math.round(gcContent(str(a[0])) * 10000) / 10000,
  REVCOMP: (a) => reverseComplement(str(a[0])),
  TRANSCRIBE: (a) => transcribe(str(a[0])),
  TRANSLATE: (a) => translate(str(a[0]), a[1] === undefined ? 0 : num(a[1])),
  MW: (a) => Math.round(proteinMass(str(a[0])) * 100) / 100,
};

export interface EvalCtx { get(name: string): FVal }

export function evalNode(n: Node, ctx: EvalCtx): FVal {
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'ref': return ctx.get(n.name);
    case 'un': return -num(evalNode(n.a, ctx));
    case 'bin': {
      const a = evalNode(n.a, ctx), b = evalNode(n.b, ctx);
      switch (n.op) {
        case '+': return num(a) + num(b);
        case '-': return num(a) - num(b);
        case '*': return num(a) * num(b);
        case '/': { const d = num(b); return d === 0 ? '#DIV/0' : num(a) / d; }
        case '^': return num(a) ** num(b);
        case '&': return str(a) + str(b);
        case '=': case '==': return cmp(a, b) === 0;
        case '!=': case '<>': return cmp(a, b) !== 0;
        case '<': return cmp(a, b) < 0;
        case '>': return cmp(a, b) > 0;
        case '<=': return cmp(a, b) <= 0;
        case '>=': return cmp(a, b) >= 0;
      }
      throw new Error(`Unknown operator ${n.op}`);
    }
    case 'call': {
      if (n.name === 'IF') { // lazy branches
        const c = truthy(evalNode(n.args[0], ctx));
        return c ? (n.args[1] ? evalNode(n.args[1], ctx) : true) : n.args[2] ? evalNode(n.args[2], ctx) : null;
      }
      if (n.name === 'SWITCH') {
        const v = evalNode(n.args[0], ctx);
        for (let i = 1; i + 1 < n.args.length; i += 2) if (cmp(v, evalNode(n.args[i], ctx)) === 0) return evalNode(n.args[i + 1], ctx);
        return n.args.length % 2 === 0 ? evalNode(n.args[n.args.length - 1], ctx) : null;
      }
      const f = FUNCS[n.name];
      if (!f) throw new Error(`Unknown function ${n.name}`);
      return f(n.args.map((a) => evalNode(a, ctx)));
    }
  }
}

function cmp(a: FVal, b: FVal): number {
  const A = Array.isArray(a) ? str(a) : a, B = Array.isArray(b) ? str(b) : b;
  if (typeof A === 'number' && typeof B === 'number') return A - B;
  if ((typeof A === 'number' && B === null) || (A === null && typeof B === 'number')) return num(A) - num(B);
  const sa = str(A), sb = str(B);
  const na = Number(sa), nb = Number(sb);
  if (sa !== '' && sb !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export interface FormulaResult { value: FVal; error?: string }

export function runFormula(src: string, ctx: EvalCtx): FormulaResult {
  try {
    const v = evalNode(parseFormula(src), ctx);
    if (typeof v === 'number' && !Number.isFinite(v)) return { value: '#NUM' };
    return { value: v };
  } catch (e) {
    return { value: '#ERROR', error: (e as Error).message };
  }
}

/** Validate without evaluating – used by the field editor for instant feedback. */
export function checkFormula(src: string): string | null {
  try { parseFormula(src); return null; } catch (e) { return (e as Error).message; }
}
