import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSeq, composition, detectSeqKind, findOrfs, gcContent, parseFasta, proteinMass, reverseComplement, toFasta, translate, RE } from '../shared/sequence.ts';
import { checkFormula, runFormula } from '../shared/formula.ts';
import { matchCondition, matchGroup, sortKey, compareKeys } from '../shared/filters.ts';
import { parseDelimited } from '../shared/csv.ts';
import type { Field } from '../shared/types.ts';

test('FASTA parsing handles multi-record, wrapped lines, bare sequence and CRLF', () => {
  const r = parseFasta('>seq1 first one\r\nACGT\r\nacgt\r\n>seq2\nTTTT\n\n');
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].id, r[0].description, r[0].seq], ['seq1', 'first one', 'ACGTACGT']);
  assert.equal(parseFasta('ACGTNN')[0].id, 'sequence');
  assert.equal(parseFasta('').length, 0);
  assert.equal(toFasta('x', 'A'.repeat(150), 'd').split('\n').length, 5);
});

test('sequence type detection never calls ACGT-only text a protein', () => {
  assert.equal(detectSeqKind('ACGTACGTTAGC'), 'dna');
  assert.equal(detectSeqKind('ACGUACGUUAGC'), 'rna');
  assert.equal(detectSeqKind('MEEPQSDPSVEPPLSQETFSDLWKLLPENN'), 'protein');
  assert.equal(detectSeqKind('ACGTNNNNRYACGT'), 'dna'); // IUPAC ambiguity codes
  assert.equal(detectSeqKind('12345 !!!'), 'unknown');
  assert.equal(detectSeqKind(''), 'unknown');
});

test('translation, reverse complement, GC, mass', () => {
  assert.equal(translate('ATGGCCATTGTAATGGGCCGCTGA'), 'MAIVMGR*');
  assert.equal(translate('ATGGCCTAAGGG', 0, true), 'MA');
  assert.equal(translate('ATGNNNTAA'), 'MX*');
  assert.equal(reverseComplement('ATGC'), 'GCAT');
  assert.equal(reverseComplement(reverseComplement('GATTACAN')), 'GATTACAN');
  assert.equal(gcContent('GGCC'), 1);
  assert.equal(gcContent('ATAT'), 0);
  assert.ok(Math.abs(proteinMass('GG') - (2 * 57.02146 + 18.01056)) < 1e-6);
  assert.deepEqual(composition('AAC'), { A: 2, C: 1 });
});

test('ORF finder locates a forward ORF and a reverse-strand ORF with correct coordinates and partial flags', () => {
  const orf = 'ATG' + 'GCC'.repeat(40) + 'TAA';
  const seq = 'CCCGG' + orf + 'TTTGG';
  const f = findOrfs(seq, 30).find((o) => o.startsWithMet && o.endsWithStop)!;
  assert.equal(f.strand, '+'); assert.equal(f.aaLength, 41); assert.ok(f.startsWithMet && f.endsWithStop);
  assert.equal(seq.slice(f.start, f.end), orf);
  const r = findOrfs(reverseComplement(seq), 30).find((o) => o.startsWithMet && o.endsWithStop)!;
  assert.equal(r.strand, '-'); assert.equal(r.aaLength, 41);
  assert.equal(reverseComplement(reverseComplement(seq).slice(r.start, r.end)), orf);
  const partial = findOrfs('GCC'.repeat(60), 30)[0];
  assert.ok(partial.partial3 && partial.partial5);
});

test('identifier recognisers', () => {
  assert.ok(RE.uniprot.test('P04637')); assert.ok(RE.uniprot.test('A0A024R161')); assert.ok(RE.uniprot.test('P04637-2'));
  assert.ok(!RE.uniprot.test('TP53'));
  assert.ok(RE.refseqNuc.test('NM_000546.6')); assert.ok(RE.refseqProt.test('NP_000537.3'));
  assert.ok(RE.inchiKey.test('KTUFNOKKBVMGRW-UHFFFAOYSA-N')); assert.ok(RE.chembl.test('CHEMBL941'));
  assert.ok(RE.coords.test('NC_000017.11:7668402-7687550'));
  assert.equal(cleanSeq(' acg t\n1 2'), 'ACGT');
});

const ctx = (vals: Record<string, any>) => ({ get: (n: string) => vals[n] ?? null });
test('formula engine: arithmetic, strings, IF, references, scientific helpers', () => {
  assert.equal(runFormula('1 + 2 * 3 - 4 / 2', ctx({})).value, 5);
  assert.equal(runFormula('2 ^ 3 ^ 2', ctx({})).value, 512);
  assert.equal(runFormula('-{a} + 10', ctx({ a: 4 })).value, 6);
  assert.equal(runFormula('"x" & {a} & \'y\'', ctx({ a: 1 })).value, 'x1y');
  assert.equal(runFormula('IF({a} > 3, "big", "small")', ctx({ a: 5 })).value, 'big');
  assert.equal(runFormula('IF({a} > 3, "big")', ctx({ a: 1 })).value, null);
  assert.equal(runFormula('ROUND(3.14159, 2)', ctx({})).value, 3.14);
  assert.equal(runFormula('SUM({v})', ctx({ v: [1, 2, 3] })).value, 6);
  assert.equal(runFormula('1 / 0', ctx({})).value, '#DIV/0');
  assert.equal(runFormula('GC({s})', ctx({ s: 'GGCCAATT' })).value, 0.5);
  assert.equal(runFormula('REVCOMP({s})', ctx({ s: 'AACG' })).value, 'CGTT');
  assert.equal(runFormula('TRANSLATE({s})', ctx({ s: 'ATGGCC' })).value, 'MA');
  assert.equal(runFormula('SEQLEN({s})', ctx({ s: 'AC GT' })).value, 4);
  assert.equal(runFormula('SWITCH({a}, 1, "one", 2, "two", "many")', ctx({ a: 2 })).value, 'two');
  assert.equal(runFormula('DATEDIFF("2026-03-10", "2026-03-01")', ctx({})).value, 9);
});

test('formula engine is a sandbox: unknown names/functions error rather than execute', () => {
  assert.equal(runFormula('constructor', ctx({})).value, '#ERROR');
  assert.equal(runFormula('process.exit()', ctx({})).value, '#ERROR');
  assert.equal(runFormula('FOO(1)', ctx({})).value, '#ERROR');
  assert.ok(checkFormula('1 +'));
  assert.ok(checkFormula('{unclosed'));
  assert.equal(checkFormula('{a} + 1'), null);
});

const F = (type: Field['type'], extra: Partial<Field> = {}): Field => ({ id: 'f', tableId: 't', name: 'F', type, options: {}, position: 0, ...extra });
test('filter operators by field type', () => {
  assert.ok(matchCondition({ field: 'f', op: 'gt', value: 5 }, 10, F('number')));
  assert.ok(!matchCondition({ field: 'f', op: 'gt', value: 5 }, null, F('number')));
  assert.ok(matchCondition({ field: 'f', op: 'contains', value: 'p53' }, 'Cellular tumor antigen P53', F('text')));
  assert.ok(matchCondition({ field: 'f', op: 'isEmpty' }, '', F('text')));
  assert.ok(matchCondition({ field: 'f', op: 'isEmpty' }, [], F('relation')));
  const sel = F('multiSelect', { options: { choices: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] } });
  assert.ok(matchCondition({ field: 'f', op: 'hasAny', value: ['b'] }, ['a', 'b'], sel));
  assert.ok(matchCondition({ field: 'f', op: 'hasAll', value: ['a', 'b'] }, ['a', 'b'], sel));
  assert.ok(matchCondition({ field: 'f', op: 'hasNone', value: ['c'] }, ['a'], sel));
  assert.ok(matchCondition({ field: 'f', op: 'isTrue' }, true, F('checkbox')));
  assert.ok(matchCondition({ field: 'f', op: 'before', value: '2026-05-01' }, '2026-04-30', F('date')));
  assert.ok(matchCondition({ field: 'f', op: 'is', value: '2026-04-30' }, '2026-04-30T12:00:00Z', F('date')));
  assert.ok(matchCondition({ field: 'f', op: 'is', value: 'r1' }, [{ id: 'r1', name: 'x' }], F('relation')));
  const fields = new Map([['f', F('number')]]);
  assert.ok(matchGroup({ mode: 'or', items: [{ field: 'f', op: 'lt', value: 2 }, { field: 'f', op: 'gt', value: 8 }] }, () => 9, fields));
  assert.ok(!matchGroup({ mode: 'and', items: [{ field: 'f', op: 'lt', value: 2 }, { field: 'f', op: 'gt', value: 8 }] }, () => 9, fields));
  assert.ok(matchGroup({ mode: 'and', items: [] }, () => 1, fields));
});

test('sorting: numbers numeric, natural text order, empties last in both directions', () => {
  const keys = [sortKey(10, F('number')), sortKey(2, F('number')), sortKey(null, F('number'))];
  assert.deepEqual([...keys].sort((a, b) => compareKeys(a, b, 'asc')), [2, 10, null]);
  assert.deepEqual([...keys].sort((a, b) => compareKeys(a, b, 'desc')), [10, 2, null]);
  const names = ['gene10', 'gene2', 'Gene1'].map((s) => sortKey(s, F('text')));
  assert.deepEqual(names.sort((a, b) => compareKeys(a, b, 'asc')), ['gene1', 'gene2', 'gene10']);
});

test('CSV parser: quotes, embedded commas/newlines, escaped quotes, BOM, TSV autodetect', () => {
  assert.deepEqual(parseDelimited('﻿a,b\n"x,1","he said ""hi"""\n"multi\nline",z\r\n'), [['a', 'b'], ['x,1', 'he said "hi"'], ['multi\nline', 'z']]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('a,b\n\n\n1,2'), [['a', 'b'], ['1', '2']]);
});
