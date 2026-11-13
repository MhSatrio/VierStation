// Export-to-code (FR-1.26): Python / R / Julia scripts that reproduce the analysis from the exact inputs and parameters used.
// Each script embeds the data, states the algorithm and any known differences from VierStation's built-in implementation.
import type { AnalysisInput, AnalysisType, Params } from './compute.ts';
import { seqParams } from './compute.ts';

export type Lang = 'python' | 'r' | 'julia';
export interface CodeSpec { type: AnalysisType; name: string; params: Params; input: AnalysisInput; result?: any; createdAt: string }

const q = (s: string) => JSON.stringify(s);
const numOrNa = (v: number | null, na: string) => (v === null || v === undefined ? na : String(v));
const header = (c: string, spec: CodeSpec, notes: string[]) => [
  `${c} VierStation analysis export – ${spec.name}`,
  `${c} Analysis type : ${spec.type}`,
  `${c} Created       : ${spec.createdAt}`,
  `${c} Parameters    : ${JSON.stringify(spec.params)}`,
  ...notes.map((n) => `${c} Note          : ${n}`),
  `${c} The data below are the exact inputs used by VierStation.`,
].join('\n');

export function generateCode(lang: Lang, spec: CodeSpec): string {
  const gen = { python, r, julia }[lang];
  return gen(spec);
}

// ================= Python =================
function pyAligner(st: 'dna' | 'protein', p: ReturnType<typeof seqParams>): string {
  return [
    'aligner = Align.PairwiseAligner()',
    `aligner.mode = ${q(p.mode)}`,
    ...(st === 'protein' ? ['aligner.substitution_matrix = substitution_matrices.load("BLOSUM62")'] : [`aligner.match_score = ${p.match}`, `aligner.mismatch_score = ${p.mismatch}`]),
    `aligner.open_gap_score = ${-p.gapOpen}   # score of the first gap position`,
    `aligner.extend_gap_score = ${-p.gapExtend}  # score of each further gap position`,
  ].join('\n');
}
const pySeqs = (spec: CodeSpec) => `SEQUENCES = {\n${(spec.input.sequences ?? []).map((s) => `    ${q(s.label)}: ${q(s.seq)},`).join('\n')}\n}`;
const pyMatrix = (spec: CodeSpec) => {
  const m = spec.input.matrix!;
  return [
    `row_labels = ${JSON.stringify(m.rowLabels)}`,
    `col_names = ${JSON.stringify(m.colNames)}`,
    `values = [`, ...m.values.map((r) => `    [${r.map((v) => numOrNa(v, 'None')).join(', ')}],`), `]`,
    'df = pd.DataFrame(values, index=row_labels, columns=col_names, dtype=float)  # None -> NaN',
    ...(m.groups ? [`groups = ${JSON.stringify(m.groups)}  # ${m.groupName}`] : []),
  ].join('\n');
};

function python(spec: CodeSpec): string {
  const st = spec.input.seqType ?? 'dna';
  const p = seqParams(st, spec.params);
  const h = (notes: string[] = []) => header('#', spec, notes);
  switch (spec.type) {
    case 'alignment': {
      const n = spec.input.sequences?.length ?? 0;
      if (n === 2 && spec.params.mode !== 'msa') return `${h(['Biopython PairwiseAligner reproduces the score; VierStation scores N as 0 and may report a different co-optimal alignment.'])}
# pip install biopython
from Bio import Align
from Bio.Align import substitution_matrices

${pySeqs(spec)}
${pyAligner(st, p)}

(label_a, a), (label_b, b) = SEQUENCES.items()
alignment = aligner.align(a, b)[0]
print(f"Score: {alignment.score}")
print(f"{label_a} vs {label_b}")
print(alignment)
`;
      return `${h(['Star multiple alignment: pairwise alignments to the centre sequence merged with "once a gap, always a gap". Co-optimal pairwise alignments can differ from VierStation\'s.'])}
# pip install biopython
from Bio import Align
from Bio.Align import substitution_matrices

${pySeqs(spec)}
${pyAligner(st, { ...p, mode: 'global' })}

labels = list(SEQUENCES)
seqs = [SEQUENCES[k].replace("-", "") for k in labels]
n = len(seqs)
totals = [0.0] * n
for i in range(n):
    for j in range(i + 1, n):
        s = aligner.score(seqs[i], seqs[j])
        totals[i] += s
        totals[j] += s
centre = totals.index(max(totals))            # centre = highest summed pairwise score
c = seqs[centre]
pair = {}
for i in range(n):
    if i != centre:
        aln = aligner.align(c, seqs[i])[0]
        pair[i] = (str(aln[0]), str(aln[1]))     # aligned centre, aligned sequence

ins = [0] * (len(c) + 1)                        # gap columns needed before each centre position
ins_per = {}
for i, (ac, _) in pair.items():
    arr = [0] * (len(c) + 1); pos = 0
    for ch in ac:
        if ch == "-": arr[pos] += 1
        else: pos += 1
    ins_per[i] = arr
    ins = [max(x, y) for x, y in zip(ins, arr)]

rows = []
for i in range(n):
    out = ""
    if i == centre:
        for t in range(len(c) + 1):
            out += "-" * ins[t] + (c[t] if t < len(c) else "")
    else:
        ac, ai = pair[i]; k = 0
        for t in range(len(c) + 1):
            got = ""
            while k < len(ac) and ac[k] == "-":
                got += ai[k]; k += 1
            out += got + "-" * (ins[t] - ins_per[i][t])
            if t < len(c):
                out += ai[k]; k += 1
    rows.append(out)

width = max(len(l) for l in labels)
for l, r in zip(labels, rows):
    print(f"{l:<{width}}  {r}")
`;
    }
    case 'comparison': {
      const useK = spec.result?.method === 'kmer' || spec.params.method === 'kmer' || (spec.input.sequences?.length ?? 0) > 40;
      const k = spec.result?.k ?? (Number(spec.params.k) || (st === 'dna' ? 6 : 3));
      return useK ? `${h([`Alignment-free: cosine similarity of ${k}-mer count vectors.`])}
import numpy as np, pandas as pd
from collections import Counter

${pySeqs(spec)}
K = ${k}
labels = list(SEQUENCES)

def profile(s):
    s = s.replace("-", "")
    return Counter(s[i:i + K] for i in range(len(s) - K + 1))

def cosine(a, b):
    dot = sum(v * b.get(k, 0) for k, v in a.items())
    na = sum(v * v for v in a.values()) ** 0.5
    nb = sum(v * v for v in b.values()) ** 0.5
    return dot / (na * nb) if na and nb else 0.0

prof = [profile(SEQUENCES[l]) for l in labels]
M = pd.DataFrame([[1.0 if i == j else cosine(prof[i], prof[j]) for j in range(len(labels))] for i in range(len(labels))], index=labels, columns=labels)
print(M.round(3))
` : `${h(['Identity = identical aligned positions / length of the shorter sequence, from a global alignment.'])}
# pip install biopython pandas
import pandas as pd
from Bio import Align
from Bio.Align import substitution_matrices

${pySeqs(spec)}
${pyAligner(st, { ...p, mode: 'global' })}

labels = list(SEQUENCES)
M = pd.DataFrame(1.0, index=labels, columns=labels)
for i, a in enumerate(labels):
    for j in range(i + 1, len(labels)):
        b = labels[j]
        aln = aligner.align(SEQUENCES[a], SEQUENCES[b])[0]
        x, y = str(aln[0]), str(aln[1])
        ident = sum(1 for u, v in zip(x, y) if u == v and u != "-")
        M.loc[a, b] = M.loc[b, a] = ident / min(len(SEQUENCES[a]), len(SEQUENCES[b]))
print(M.round(3))
`;
    }
    case 'phylogeny': {
      const rows = spec.result?.alignedRows ?? [];
      const labels = spec.result?.labels ?? (spec.input.sequences ?? []).map((s) => s.label);
      const method = spec.result?.method ?? (spec.params.method === 'upgma' ? 'upgma' : 'nj');
      return `${h(['Starts from the multiple alignment VierStation computed (embedded), so the tree is reproducible without re-aligning.'])}
# pip install biopython
from math import log
from Bio.Phylo.TreeConstruction import DistanceMatrix, DistanceTreeConstructor
from Bio import Phylo

labels = ${JSON.stringify(labels)}
aligned = ${JSON.stringify(rows)}
SEQ_TYPE = ${q(st)}

def distance(a, b):                      # Jukes-Cantor (DNA) / Poisson-style (protein); gap columns skipped pairwise
    cols = diff = 0
    for x, y in zip(a, b):
        if x == "-" or y == "-": continue
        cols += 1; diff += x != y
    if not cols: return 3.0
    p = diff / cols
    if SEQ_TYPE == "dna":
        x = 1 - 4 / 3 * p; return 3.0 if x <= 0.01 else -0.75 * log(x)
    x = 1 - 20 / 19 * p; return 3.0 if x <= 0.01 else -0.95 * log(x)

n = len(labels)
lower = [[distance(aligned[i], aligned[j]) for j in range(i)] + [0.0] for i in range(n)]
dm = DistanceMatrix(labels, lower)
tree = DistanceTreeConstructor().${method === 'upgma' ? 'upgma' : 'nj'}(dm)
Phylo.draw_ascii(tree)
Phylo.write(tree, "tree.nwk", "newick")
`;
    }
    case 'heatmap': {
      const scale = ['row', 'column'].includes(spec.params.scale) ? spec.params.scale : 'none';
      return `${h(['Rows/columns are ordered by average-linkage clustering of Euclidean distance (VierStation orders leaves with UPGMA; ordering of equal-distance branches may differ).'])}
# pip install pandas numpy scipy matplotlib
import numpy as np, pandas as pd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.cluster.hierarchy import linkage, leaves_list

${pyMatrix(spec)}
SCALE = ${q(scale)}      # none | row | column
if SCALE == "column":
    df = (df - df.mean()) / df.std(ddof=1).replace(0, np.nan)
elif SCALE == "row":
    df = df.sub(df.mean(axis=1), axis=0).div(df.std(axis=1, ddof=1).replace(0, np.nan), axis=0)
filled = df.fillna(0)
if ${spec.params.clusterRows !== false ? 'True' : 'False'} and len(filled) >= 3:
    filled = filled.iloc[leaves_list(linkage(filled.values, "average"))]
if ${spec.params.clusterCols !== false ? 'True' : 'False'} and filled.shape[1] >= 3:
    filled = filled.iloc[:, leaves_list(linkage(filled.values.T, "average"))]
plt.figure(figsize=(8, 6)); plt.imshow(filled.values, aspect="auto", cmap="viridis"); plt.colorbar(label=SCALE + "-scaled value" if SCALE != "none" else "value")
plt.yticks(range(len(filled)), filled.index); plt.xticks(range(filled.shape[1]), filled.columns, rotation=90); plt.tight_layout(); plt.savefig("heatmap.png", dpi=200)
`;
    }
    case 'pca': {
      const k = Math.min(Number(spec.params.components) || 5, (spec.input.matrix?.colNames.length ?? 2), (spec.input.matrix?.values.length ?? 3) - 1);
      return `${h(['Missing values are replaced by the column mean; component signs are fixed so the largest absolute loading is positive. Uses numpy only.'])}
# pip install pandas numpy
import numpy as np, pandas as pd

${pyMatrix(spec)}
SCALE = ${spec.params.scale !== false ? 'True' : 'False'}
N_COMPONENTS = ${k}
X = df.fillna(df.mean()).values.astype(float)
X = X - X.mean(axis=0)
if SCALE:
    sd = X.std(axis=0, ddof=1); sd[sd == 0] = 1
    X = X / sd
vals, vecs = np.linalg.eigh(np.cov(X, rowvar=False))
order = np.argsort(vals)[::-1]
vals, vecs = vals[order], vecs[:, order]
for j in range(vecs.shape[1]):                      # sign convention
    if vecs[np.argmax(np.abs(vecs[:, j])), j] < 0:
        vecs[:, j] = -vecs[:, j]
scores = X @ vecs[:, :N_COMPONENTS]
print("Explained variance ratio:", (vals[:N_COMPONENTS] / vals.sum()).round(4))
print(pd.DataFrame(scores, index=df.index, columns=[f"PC{i + 1}" for i in range(N_COMPONENTS)]).round(4))
`;
    }
    case 'statistics': {
      return `${h()}
# pip install pandas scipy
import pandas as pd
from scipy import stats

${pyMatrix(spec)}
print(df.describe().T)
print(df.corr(method=${q(spec.params.correlation === 'spearman' ? 'spearman' : 'pearson')}).round(4))
${spec.input.matrix?.groups ? `
levels = sorted(set(g for g in groups if g is not None))
if len(levels) == 2:
    a = df[[g == levels[0] for g in groups]]
    b = df[[g == levels[1] for g in groups]]
    for col in df.columns:
        t, p = stats.ttest_ind(a[col].dropna(), b[col].dropna(), equal_var=False)   # Welch
        print(f"{col}: t={t:.4f} p={p:.4g}")
` : ''}`;
    }
  }
}

// ================= R =================
const rVec = (xs: (number | null)[]) => `c(${xs.map((v) => numOrNa(v, 'NA')).join(', ')})`;
function rMatrix(spec: CodeSpec): string {
  const m = spec.input.matrix!;
  return [
    `col_names <- c(${m.colNames.map(q).join(', ')})`, `row_labels <- c(${m.rowLabels.map(q).join(', ')})`,
    `m <- matrix(c(${m.values.flat().map((v) => numOrNa(v, 'NA')).join(', ')}), nrow = ${m.values.length}, byrow = TRUE, dimnames = list(row_labels, col_names))`,
    ...(m.groups ? [`groups <- c(${m.groups.map((g) => (g === null ? 'NA' : q(g))).join(', ')})  # ${m.groupName}`] : []),
  ].join('\n');
}
const rSeqs = (spec: CodeSpec) => `seqs <- c(\n${(spec.input.sequences ?? []).map((s) => `  ${q(s.label)} = ${q(s.seq)}`).join(',\n')}\n)`;

function r(spec: CodeSpec): string {
  const st = spec.input.seqType ?? 'dna';
  const p = seqParams(st, spec.params);
  const h = (notes: string[] = []) => header('#', spec, notes);
  const aln = (mode: string) => `# Biostrings gap cost = gapOpening + k * gapExtension, so opening ${p.gapOpen} / extension ${p.gapExtend} become ${p.gapOpen - p.gapExtend} / ${p.gapExtend}
${st === 'protein' ? 'sm <- "BLOSUM62"' : `sm <- nucleotideSubstitutionMatrix(match = ${p.match}, mismatch = ${p.mismatch}, baseOnly = FALSE)`}
align_pair <- function(a, b) pairwiseAlignment(a, b, type = ${q(mode)}, substitutionMatrix = sm, gapOpening = ${p.gapOpen - p.gapExtend}, gapExtension = ${p.gapExtend})`;
  switch (spec.type) {
    case 'alignment':
      return `${h(['Pairwise alignment reproduces VierStation scores. For >2 sequences VierStation uses a star alignment; this script aligns every sequence to all others pairwise – use msa::msa() or DECIPHER for a full MSA.'])}
# BiocManager::install("Biostrings")
library(Biostrings)

${rSeqs(spec)}
${aln(p.mode)}

labels <- names(seqs)
for (i in seq_along(labels)) for (j in seq_along(labels)) if (j > i) {
  res <- align_pair(seqs[[i]], seqs[[j]])
  cat(sprintf("%s vs %s  score = %s  identity = %.1f%%\\n", labels[i], labels[j], score(res), pid(res)))
  print(res)
}
`;
    case 'comparison':
      return `${h(['Identity = identical aligned positions / length of the shorter sequence (global alignment).'])}
library(Biostrings)

${rSeqs(spec)}
${aln('global')}
labels <- names(seqs)
M <- matrix(1, length(seqs), length(seqs), dimnames = list(labels, labels))
for (i in seq_along(seqs)) for (j in seq_along(seqs)) if (j > i) {
  res <- align_pair(seqs[[i]], seqs[[j]])
  M[i, j] <- M[j, i] <- nmatch(res) / min(nchar(seqs[[i]]), nchar(seqs[[j]]))
}
print(round(M, 3))
`;
    case 'phylogeny': {
      const rows = spec.result?.alignedRows ?? [];
      const labels = spec.result?.labels ?? [];
      return `${h(['Starts from the multiple alignment VierStation computed (embedded).'])}
# install.packages(c("ape", "phangorn"))
library(ape)

labels <- c(${labels.map(q).join(', ')})
aligned <- c(${rows.map(q).join(', ')})
seq_type <- ${q(st)}
dist_pair <- function(a, b) {
  x <- strsplit(a, "")[[1]]; y <- strsplit(b, "")[[1]]
  ok <- x != "-" & y != "-"
  if (!any(ok)) return(3)
  p <- mean(x[ok] != y[ok])
  if (seq_type == "dna") { z <- 1 - 4/3 * p; if (z <= 0.01) 3 else -0.75 * log(z) }
  else { z <- 1 - 20/19 * p; if (z <= 0.01) 3 else -0.95 * log(z) }
}
n <- length(labels)
D <- matrix(0, n, n, dimnames = list(labels, labels))
for (i in 1:n) for (j in 1:n) if (i != j) D[i, j] <- dist_pair(aligned[i], aligned[j])
tree <- ${spec.params.method === 'upgma' ? 'phangorn::upgma(as.dist(D))' : 'nj(as.dist(D))'}
plot(tree); write.tree(tree, "tree.nwk")
`;
    }
    case 'heatmap': {
      const scale = ['row', 'column'].includes(spec.params.scale) ? spec.params.scale : 'none';
      return `${h()}
${rMatrix(spec)}
scale_mode <- ${q(scale)}
if (scale_mode == "column") m <- scale(m)
if (scale_mode == "row") m <- t(scale(t(m)))
m[is.na(m)] <- 0
hc <- function(d) hclust(d, method = "average")
heatmap(m, Rowv = ${spec.params.clusterRows !== false ? 'as.dendrogram(hc(dist(m)))' : 'NA'}, Colv = ${spec.params.clusterCols !== false ? 'as.dendrogram(hc(dist(t(m))))' : 'NA'}, scale = "none", col = hcl.colors(50, "viridis"), margins = c(8, 8))
`;
    }
    case 'pca':
      return `${h(['Missing values are replaced by the column mean.'])}
${rMatrix(spec)}
for (j in seq_len(ncol(m))) m[is.na(m[, j]), j] <- mean(m[, j], na.rm = TRUE)
fit <- prcomp(m, center = TRUE, scale. = ${spec.params.scale !== false ? 'TRUE' : 'FALSE'})
print(summary(fit))
print(round(fit$x[, 1:min(${Number(spec.params.components) || 5}, ncol(fit$x))], 4))
biplot(fit)
`;
    case 'statistics':
      return `${h()}
${rMatrix(spec)}
print(summary(as.data.frame(m)))
print(round(cor(m, use = "pairwise.complete.obs", method = ${q(spec.params.correlation === 'spearman' ? 'spearman' : 'pearson')}), 4))
${spec.input.matrix?.groups ? `lv <- sort(unique(groups[!is.na(groups)]))
if (length(lv) == 2) for (col in colnames(m)) {
  a <- m[which(groups == lv[1]), col]; b <- m[which(groups == lv[2]), col]
  print(c(col, t.test(a, b, var.equal = FALSE)$p.value))      # Welch
}
` : ''}`;
  }
}

// ================= Julia =================
const jlMatrix = (spec: CodeSpec) => {
  const m = spec.input.matrix!;
  return [
    `col_names = [${m.colNames.map(q).join(', ')}]`, `row_labels = [${m.rowLabels.map(q).join(', ')}]`,
    `X = Union{Missing,Float64}[${m.values.map((r) => r.map((v) => numOrNa(v, 'missing')).join(' ')).join('; ')}]`,
    ...(m.groups ? [`groups = [${m.groups.map((g) => (g === null ? 'missing' : q(g))).join(', ')}]  # ${m.groupName}`] : []),
  ].join('\n');
};

function julia(spec: CodeSpec): string {
  const st = spec.input.seqType ?? 'dna';
  const p = seqParams(st, spec.params);
  const h = (notes: string[] = []) => header('#', spec, notes);
  const seqs = `seqs = [\n${(spec.input.sequences ?? []).map((s) => `    (${q(s.label)}, ${q(s.seq)}),`).join('\n')}\n]`;
  const model = st === 'protein'
    ? `model = AffineGapScoreModel(BLOSUM62, gap_open = ${-(p.gapOpen - p.gapExtend)}, gap_extend = ${-p.gapExtend})   # gap cost = open + k*extend`
    : `model = AffineGapScoreModel(match = ${p.match}, mismatch = ${p.mismatch}, gap_open = ${-(p.gapOpen - p.gapExtend)}, gap_extend = ${-p.gapExtend})`;
  const seqCtor = st === 'protein' ? 'AminoAcidSequence' : 'LongDNA{4}';
  switch (spec.type) {
    case 'alignment': case 'comparison': {
      return `${h(['Pairwise alignment of every pair with BioAlignments.jl. VierStation uses a star MSA for >2 sequences; Julia has no standard MSA package, so pairwise results are reported.'])}
# using Pkg; Pkg.add(["BioAlignments", "BioSequences"])
using BioAlignments, BioSequences

${seqs}
${model}

for i in 1:length(seqs), j in (i + 1):length(seqs)
    res = pairalign(${p.mode === 'local' && spec.type === 'alignment' ? 'LocalAlignment' : 'GlobalAlignment'}(), ${seqCtor}(seqs[i][2]), ${seqCtor}(seqs[j][2]), model)
    aln = alignment(res)
    println(seqs[i][1], " vs ", seqs[j][1], "  score = ", score(res))
    ${spec.type === 'comparison' ? 'println("  identical positions: ", count_matches(aln))' : 'println(aln)'}
end
`;
    }
    case 'phylogeny': {
      const rows = spec.result?.alignedRows ?? [];
      const labels = spec.result?.labels ?? [];
      return `${h(['Computes the same corrected distances from the embedded alignment and builds a UPGMA tree with Clustering.jl. Neighbor-joining has no standard Julia package – use the Python or R script for NJ.'])}
# using Pkg; Pkg.add("Clustering")
using Clustering

labels = [${labels.map(q).join(', ')}]
aligned = [${rows.map(q).join(', ')}]
seq_type = ${q(st)}

function dist(a, b)
    cols = diff = 0
    for (x, y) in zip(a, b)
        (x == '-' || y == '-') && continue
        cols += 1; diff += x != y
    end
    cols == 0 && return 3.0
    p = diff / cols
    seq_type == "dna" ? (z = 1 - 4/3 * p; z <= 0.01 ? 3.0 : -0.75 * log(z)) : (z = 1 - 20/19 * p; z <= 0.01 ? 3.0 : -0.95 * log(z))
end
n = length(labels)
D = [i == j ? 0.0 : dist(aligned[i], aligned[j]) for i in 1:n, j in 1:n]
tree = hclust(D, linkage = :average)    # UPGMA
println(tree.merges); println(tree.heights)
`;
    }
    case 'heatmap':
      return `${h()}
# using Pkg; Pkg.add(["Plots", "Statistics", "Clustering", "Distances"])
using Plots, Statistics, Clustering, Distances

${jlMatrix(spec)}
M = coalesce.(X, NaN)
scale_mode = ${q(['row', 'column'].includes(spec.params.scale) ? spec.params.scale : 'none')}
zs(v) = (s = std(filter(!isnan, v)); (v .- mean(filter(!isnan, v))) ./ (s == 0 ? 1 : s))
scale_mode == "column" && (M = hcat([zs(M[:, j]) for j in 1:size(M, 2)]...))
scale_mode == "row" && (M = vcat([zs(M[i, :])' for i in 1:size(M, 1)]...))
M[isnan.(M)] .= 0
ro = ${spec.params.clusterRows !== false ? 'hclust(pairwise(Euclidean(), M, dims = 1), linkage = :average).order' : '1:size(M, 1)'}
co = ${spec.params.clusterCols !== false ? 'hclust(pairwise(Euclidean(), M, dims = 2), linkage = :average).order' : '1:size(M, 2)'}
heatmap(col_names[co], row_labels[ro], M[ro, co]); savefig("heatmap.png")
`;
    case 'pca':
      return `${h(['Missing values are replaced by the column mean.'])}
# using Pkg; Pkg.add(["MultivariateStats", "Statistics"])
using MultivariateStats, Statistics

${jlMatrix(spec)}
M = coalesce.(X, NaN)
for j in 1:size(M, 2); c = M[:, j]; c[isnan.(c)] .= mean(filter(!isnan, c)); end
${spec.params.scale !== false ? 'M = (M .- mean(M, dims = 1)) ./ std(M, dims = 1)' : 'M = M .- mean(M, dims = 1)'}
model = fit(PCA, M'; maxoutdim = ${Number(spec.params.components) || 5}, pratio = 1.0)
println("Explained variance: ", principalvars(model) ./ tvar(model))
println(predict(model, M'))'
`;
    case 'statistics':
      return `${h()}
# using Pkg; Pkg.add(["Statistics", "StatsBase", "HypothesisTests"])
using Statistics, StatsBase${spec.input.matrix?.groups ? ', HypothesisTests' : ''}

${jlMatrix(spec)}
for (j, name) in enumerate(col_names)
    v = collect(skipmissing(X[:, j]))
    println(name, ": n=", length(v), " mean=", mean(v), " sd=", std(v), " median=", median(v))
end
M = coalesce.(X, NaN)
println(cor(M${spec.params.correlation === 'spearman' ? ' |> x -> mapslices(tiedrank, x, dims = 1)' : ''}))   # NaN where a column has missing values
${spec.input.matrix?.groups ? `lv = sort(unique(skipmissing(groups)))
if length(lv) == 2
    for (j, name) in enumerate(col_names)
        a = collect(skipmissing(X[findall(g -> !ismissing(g) && g == lv[1], groups), j]))
        b = collect(skipmissing(X[findall(g -> !ismissing(g) && g == lv[2], groups), j]))
        println(name, ": p = ", pvalue(UnequalVarianceTTest(a, b)))
    end
end
` : ''}`;
  }
}
