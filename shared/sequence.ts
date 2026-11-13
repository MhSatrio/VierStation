// Pure sequence utilities shared by server (discovery, analysis, formulas) and client (previews).
// No dependencies. All functions are deterministic and tolerate lowercase / whitespace / FASTA headers.

export type SeqKind = 'dna' | 'rna' | 'protein' | 'unknown';

export interface FastaRecord {
  header: string;
  id: string;
  description: string;
  seq: string;
}

/** Parse FASTA text (one or many records). A bare sequence without a header is returned with id "sequence". */
export function parseFasta(text: string): FastaRecord[] {
  const out: FastaRecord[] = [];
  let header: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (header === null && buf.length === 0) return;
    const h = header ?? 'sequence';
    const sp = h.search(/\s/);
    out.push({
      header: h,
      id: sp < 0 ? h : h.slice(0, sp),
      description: sp < 0 ? '' : h.slice(sp + 1).trim(),
      seq: cleanSeq(buf.join('')),
    });
  };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('>')) {
      flush();
      header = line.slice(1).trim();
      buf = [];
    } else buf.push(line);
  }
  flush();
  return out.filter((r) => r.seq.length > 0);
}

/** Uppercase, strip whitespace, digits (GenBank-style numbering) and gaps/stop markers that are not residues. */
export function cleanSeq(s: string): string {
  return s.toUpperCase().replace(/[\s\d]/g, '').replace(/[^A-Z*\-]/g, '');
}

export function toFasta(id: string, seq: string, description = '', width = 70): string {
  const lines: string[] = [];
  for (let i = 0; i < seq.length; i += width) lines.push(seq.slice(i, i + width));
  return `>${id}${description ? ' ' + description : ''}\n${lines.join('\n')}\n`;
}

const DNA_CHARS = new Set('ACGTNRYKMSWBDHV'.split(''));
const PROTEIN_CHARS = new Set('ACDEFGHIKLMNPQRSTVWYBXZUO*'.split(''));

/**
 * Classify a sequence. Short ambiguous strings such as "ACGT" are DNA; a protein is declared only when it has residues
 * that are not nucleotide codes (E, F, I, L, P, Q ...) – we never guess protein from "ACGT"-only content.
 */
export function detectSeqKind(raw: string): SeqKind {
  const s = cleanSeq(raw).replace(/[-*]/g, '');
  if (s.length === 0) return 'unknown';
  let acgt = 0, u = 0, t = 0, n = 0, dnaOk = 0, protOk = 0;
  for (const ch of s) {
    if (ch === 'U') u++;
    if (ch === 'T') t++;
    if ('ACGTU'.includes(ch)) acgt++;
    if (ch === 'N') n++;
    if (DNA_CHARS.has(ch) || ch === 'U') dnaOk++;
    if (PROTEIN_CHARS.has(ch)) protOk++;
  }
  if (protOk / s.length < 0.95) return 'unknown';
  // Mostly nucleotide characters (allow some IUPAC ambiguity / N) -> nucleic acid
  if (dnaOk / s.length >= 0.97 && (acgt + n) / s.length >= 0.7) return u > 0 && t === 0 ? 'rna' : u > t ? 'rna' : 'dna';
  return 'protein';
}

const COMP: Record<string, string> = {
  A: 'T', T: 'A', G: 'C', C: 'G', U: 'A', N: 'N', R: 'Y', Y: 'R', K: 'M', M: 'K', S: 'S', W: 'W', B: 'V', V: 'B', D: 'H', H: 'D',
};
export function reverseComplement(seq: string): string {
  const s = cleanSeq(seq);
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) out += COMP[s[i]] ?? 'N';
  return out;
}
export const transcribe = (dna: string) => cleanSeq(dna).replace(/T/g, 'U');
export const reverseTranscribe = (rna: string) => cleanSeq(rna).replace(/U/g, 'T');

const BASES = 'TCAG';
const AA = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
const CODON: Record<string, string> = {};
for (let i = 0; i < 64; i++) CODON[BASES[(i >> 4) & 3] + BASES[(i >> 2) & 3] + BASES[i & 3]] = AA[i];
export const START_CODONS = new Set(['ATG']);

/** Translate in the given frame (0,1,2). Unknown codons (ambiguity codes) -> X. Stops are '*'. */
export function translate(seq: string, frame = 0, toStop = false): string {
  const s = cleanSeq(seq).replace(/U/g, 'T');
  let out = '';
  for (let i = frame; i + 2 < s.length; i += 3) {
    const aa = CODON[s.slice(i, i + 3)] ?? 'X';
    if (aa === '*' && toStop) break;
    out += aa;
  }
  return out;
}

export interface Orf {
  strand: '+' | '-';
  frame: number; // 0..2 within strand
  start: number; // 0-based nucleotide start on the ORIGINAL (forward) sequence, inclusive
  end: number; // exclusive
  aaLength: number;
  protein: string;
  startsWithMet: boolean;
  endsWithStop: boolean;
  /** true when the ORF runs off the end of the sequence (partial) */
  partial5: boolean;
  partial3: boolean;
}

/**
 * Six-frame ORF finder. An ORF is a stop-to-stop stretch that begins at the first ATG (complete) or at the
 * sequence/frame start (5' partial). Returns ORFs of at least `minAa` residues, longest first.
 */
export function findOrfs(seq: string, minAa = 30): Orf[] {
  const fwd = cleanSeq(seq).replace(/U/g, 'T');
  const L = fwd.length;
  const out: Orf[] = [];
  for (const strand of ['+', '-'] as const) {
    const s = strand === '+' ? fwd : reverseComplement(fwd);
    for (let frame = 0; frame < 3; frame++) {
      let segStart = frame; // start of current stop-free segment (nucleotide idx on s)
      const closeSeg = (segEnd: number, stopped: boolean) => {
        // protein over s[segStart, segEnd)
        const prot = translate(s.slice(segStart, segEnd), 0);
        const m = prot.indexOf('M');
        const coding = m >= 0 ? prot.slice(m) : prot;
        const aaStartOffset = m >= 0 ? m : 0;
        const aaLen = coding.length;
        if (aaLen < minAa) return;
        const nStart = segStart + aaStartOffset * 3;
        const nEnd = segStart + (aaStartOffset + aaLen) * 3 + (stopped ? 3 : 0);
        const startsWithMet = m >= 0;
        const partial5 = !startsWithMet;
        const partial3 = !stopped;
        let st: number, en: number;
        if (strand === '+') { st = nStart; en = Math.min(nEnd, L); }
        else { st = L - Math.min(nEnd, L); en = L - nStart; }
        out.push({ strand, frame, start: st, end: en, aaLength: aaLen, protein: coding, startsWithMet, endsWithStop: stopped, partial5, partial3 });
      };
      for (let i = frame; i + 2 < s.length; i += 3) {
        if (CODON[s.slice(i, i + 3)] === '*') {
          closeSeg(i, true);
          segStart = i + 3;
        }
      }
      closeSeg(segStart + Math.floor((s.length - segStart) / 3) * 3, false);
    }
  }
  return out.sort((a, b) => b.aaLength - a.aaLength);
}

export function gcContent(seq: string): number {
  const s = cleanSeq(seq).replace(/[^ACGTU]/g, '');
  if (!s.length) return 0;
  let gc = 0;
  for (const ch of s) if (ch === 'G' || ch === 'C') gc++;
  return gc / s.length;
}

const AA_MASS: Record<string, number> = {
  A: 71.03711, R: 156.10111, N: 114.04293, D: 115.02694, C: 103.00919, E: 129.04259, Q: 128.05858, G: 57.02146, H: 137.05891,
  I: 113.08406, L: 113.08406, K: 128.09496, M: 131.04049, F: 147.06841, P: 97.05276, S: 87.03203, T: 101.04768, W: 186.07931,
  Y: 163.06333, V: 99.06841, U: 150.95364, O: 237.14773,
};
/** Average-free monoisotopic-residue sum + water; returns Da. Ambiguous residues are skipped (and counted). */
export function proteinMass(seq: string): number {
  const s = cleanSeq(seq).replace(/[*\-]/g, '');
  let m = 18.01056;
  for (const ch of s) m += AA_MASS[ch] ?? 0;
  return m;
}

export function composition(seq: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ch of cleanSeq(seq)) out[ch] = (out[ch] ?? 0) + 1;
  return out;
}

/** Extract the NCBI-style accession from "gb|XYZ.1|", "ref|NM_000546.6|" or plain text. */
export function stripVersion(acc: string): string {
  return acc.replace(/\.\d+$/, '');
}

// ----- identifier recognisers used by the unified search & import -----
export const RE = {
  uniprot: /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?$/i,
  refseqNuc: /^(?:NC|NG|NM|NR|NT|NW|NZ|XM|XR|AC|AP)_[A-Z0-9]+(?:\.\d+)?$/i,
  refseqProt: /^(?:NP|XP|YP|WP|AP)_\d+(?:\.\d+)?$/i,
  genbankNuc: /^(?:[A-Z]{1}\d{5}|[A-Z]{2}\d{6}|[A-Z]{2}\d{8}|[A-Z]{4}\d{8,})(?:\.\d+)?$/i,
  pdb: /^[1-9][A-Za-z0-9]{3}$/,
  chembl: /^CHEMBL\d+$/i,
  inchiKey: /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/,
  inchi: /^InChI=1S?\//,
  pubchemCid: /^(?:CID:?\s*)?\d{1,9}$/i,
  geneId: /^(?:GeneID:?\s*)?\d{1,9}$/i,
  interpro: /^IPR\d{6}$/i,
  taxon: /^\d+$/,
  coords: /^(?:chr)?([A-Za-z0-9_.]+):(\d[\d,]*)(?:-|\.\.)(\d[\d,]*)(?::?([+-]))?$/,
};
