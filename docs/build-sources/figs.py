import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import os
D = r"C:\Users\satri\AppData\Local\Temp\claude\7f6d85dfeffc2f4c\521ec0ea-9b6d-4944-b29b-8b92aca1366f\scratchpad\doc"
BLUE, LIGHT, INK, GREY = '#4570B6', '#CAEBFB', '#231F20', '#6B6B6B'
plt.rcParams['font.family'] = 'DejaVu Sans'

def box(ax, x, y, w, h, title, lines=(), fc=LIGHT, ec=BLUE, tc=INK, fs=9.5):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.02,rounding_size=0.12', fc=fc, ec=ec, lw=1.4))
    ax.text(x + w / 2, y + h - 0.22, title, ha='center', va='top', fontsize=fs + 1, fontweight='bold', color=tc)
    for i, l in enumerate(lines):
        ax.text(x + w / 2, y + h - 0.62 - i * 0.30, l, ha='center', va='top', fontsize=fs - 1.5, color=tc)

def arrow(ax, a, b, text='', color=BLUE, style='-|>', rad=0):
    ax.add_patch(FancyArrowPatch(a, b, arrowstyle=style, mutation_scale=14, lw=1.6, color=color, connectionstyle=f'arc3,rad={rad}'))
    if text: ax.text((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.12, text, ha='center', fontsize=8, color=GREY)

# ---- 1. architecture
fig, ax = plt.subplots(figsize=(11, 7.2)); ax.set_xlim(0, 11); ax.set_ylim(0, 7.2); ax.axis('off')
box(ax, 0.2, 5.2, 3.0, 1.8, 'Browser (React 19 + Vite)', ['src/ui/*  pages and panels', 'Sequence Lab, Sample map,', 'Analysis, grids, record panel', 'no API keys, no secrets'], fc='#FFFFFF')
box(ax, 4.0, 5.2, 3.2, 1.8, 'HTTP API  (server/routes/*)', ['auth · core · records · science', 'ops · lab · geo', 'JSON + live events (SSE)', 'sessions, permissions, rate limits'])
box(ax, 8.0, 5.2, 2.8, 1.8, 'Engine', ['schema.ts  records.ts  query.ts', 'tables, fields, views, links', 'access.ts  audit.ts'], fc='#FFFFFF')
box(ax, 8.0, 2.9, 2.8, 1.8, 'SQLite  (node:sqlite)', ['data/vierstation.db', 'records · seq_versions · seq_ops', 'jobs · notifications · cache', 'raw sequences locked by triggers'], fc=BLUE, ec=INK, tc='white')
box(ax, 4.0, 2.9, 3.2, 1.8, 'Job queue  (jobs.ts)', ['durable, retries, progress, cancel', 'discovery/*  seqlab/*  geo/*', 'worker threads: MSA, trees, bootstrap'])
box(ax, 0.2, 2.9, 3.0, 1.8, 'Science modules', ['seqlab/  phylo/  analysis/', 'geo/  report/ (PDF)', 'shared/ (sequence, geo, filters)'], fc='#FFFFFF')
box(ax, 0.2, 0.3, 10.6, 1.9, 'Outbound data sources (server only, per-host rate limits, cached in SQLite)', ['NCBI (Entrez, BLAST, Taxonomy)  ·  UniProt  ·  AlphaFold DB  ·  InterPro  ·  RCSB PDB', 'PubChem  ·  ChEMBL  ·  BindingDB  ·  OpenStreetMap Nominatim  ·  (optional) MAFFT / MUSCLE / Clustal on the server PATH'], fc='#F4F8FD')
arrow(ax, (3.2, 6.1), (4.0, 6.1)); arrow(ax, (4.0, 5.8), (3.2, 5.8), color=GREY)
arrow(ax, (7.2, 6.1), (8.0, 6.1)); arrow(ax, (9.4, 5.2), (9.4, 4.7))
arrow(ax, (5.6, 5.2), (5.6, 4.7)); arrow(ax, (4.0, 3.8), (3.2, 3.8)); arrow(ax, (7.2, 3.8), (8.0, 3.8))
arrow(ax, (5.6, 2.9), (5.6, 2.2), 'fetch'); arrow(ax, (1.7, 2.9), (1.7, 2.2))
ax.text(5.5, 7.1, 'VierStation architecture – one Node process, one SQLite file', ha='center', fontsize=13, fontweight='bold', color=INK)
fig.savefig(os.path.join(D, 'fig_arch.png'), dpi=170, bbox_inches='tight', facecolor='white'); plt.close(fig)

# ---- 2. Sequence Lab workflow
fig, ax = plt.subplots(figsize=(11, 5.6)); ax.set_xlim(0, 11); ax.set_ylim(0, 5.6); ax.axis('off')
steps = [('Import', 'paste · FASTA\nFASTQ · AB1'), ('Clean', '9 operations\nundo / redo'), ('Merge', 'forward + reverse\n→ ONE new record'), ('BLAST', 'identity AND\ncoverage'), ('Relatives', 'from hits +\nspecies by name'), ('Outgroups', '≤ 5, reasons,\nyou accept'),
         ('Align', 'progressive /\niterative'), ('Tree', 'NJ UPGMA ME\nMP ML + bootstrap'), ('Identify', 'YOUR conclusion\n+ confidence')]
xs = [0.15 + i * 1.2 for i in range(9)]
for i, ((t, d), x) in enumerate(zip(steps, xs)):
    ax.add_patch(FancyBboxPatch((x, 3.5), 1.05, 1.5, boxstyle='round,pad=0.02,rounding_size=0.1', fc=BLUE if i in (2,) else LIGHT, ec=BLUE, lw=1.3))
    ax.text(x + 0.525, 4.85, t, ha='center', va='top', fontsize=9.5, fontweight='bold', color='white' if i == 2 else INK)
    ax.text(x + 0.525, 4.35, d, ha='center', va='top', fontsize=6.8, color='white' if i == 2 else INK)
    if i < 8: arrow(ax, (x + 1.05, 4.25), (x + 1.2, 4.25))
ax.add_patch(FancyBboxPatch((0.15, 1.9), 10.7, 1.2, boxstyle='round,pad=0.02,rounding_size=0.1', fc='#14295A', ec='#14295A'))
ax.text(5.5, 2.95, 'Operation log  (seq_ops)  –  every click is one row', ha='center', va='top', fontsize=10.5, fontweight='bold', color='white')
ax.text(5.5, 2.5, 'step · parameters · input/output version · tool · database + retrieval time · who · automatic? · status · warnings', ha='center', va='top', fontsize=8, color='#CAEBFB')
ax.text(5.5, 2.15, 'raw sequence = immutable (database triggers)   ·   cleaning = new versions   ·   re-run = new result, old one kept', ha='center', va='top', fontsize=8, color='#CAEBFB')
for x in xs: arrow(ax, (x + 0.525, 3.5), (x + 0.525, 3.1), color='#14295A', style='-')
ax.text(1.7, 1.45, 'generates ↓', fontsize=9, color=GREY)
for i, (t, x) in enumerate([('Change log\n(Markdown)', 0.4), ('Python script\n(.py)', 2.5), ('PDF report', 4.6), ('Tree: Newick / SVG / PNG', 6.5), ('Alignment · dataset\nFASTA · history JSON', 8.9)]):
    ax.add_patch(FancyBboxPatch((x, 0.15), 1.9, 0.95, boxstyle='round,pad=0.02,rounding_size=0.1', fc='white', ec=BLUE, lw=1.3))
    ax.text(x + 0.95, 0.62, t, ha='center', va='center', fontsize=8.5, color=INK)
ax.text(5.5, 5.5, 'Sequence Lab – from a raw read to a documented identification', ha='center', fontsize=13, fontweight='bold', color=INK)
fig.savefig(os.path.join(D, 'fig_lab.png'), dpi=170, bbox_inches='tight', facecolor='white'); plt.close(fig)

# ---- 3. precision scale
import json
P = [('exact', 'Exact (GPS point)', '#14295A', '± 50 m'), ('site', 'Site / locality', '#24427F', '± 1 km'), ('suburb', 'Suburb / district', '#35599F', '± 5 km'), ('city', 'City / town', '#4570B6', '± 25 km'), ('province', 'Province / state', '#86A9D9', '± 200 km'), ('country', 'Country', '#CAEBFB', '± 1000 km'), ('unknown', 'Unknown', '#EEF7FD', 'no usable place')]
fig, ax = plt.subplots(figsize=(11, 2.6)); ax.set_xlim(0, 11); ax.set_ylim(0, 2.6); ax.axis('off')
for i, (k, lab, col, rad) in enumerate(P):
    x = 0.6 + i * 1.5
    ax.add_patch(plt.Circle((x + 0.3, 1.55), 0.26 + 0.0 * i, fc=col, ec='#14295A', lw=1.6))
    ax.text(x + 0.3, 0.95, lab, ha='center', va='top', fontsize=8.3, fontweight='bold', color=INK)
    ax.text(x + 0.3, 0.55, rad, ha='center', va='top', fontsize=8, color=GREY)
ax.text(0.3, 2.45, 'dark navy = specific, nearly exact', fontsize=9, color='#14295A', va='top')
ax.text(10.7, 2.45, 'white = only a country (or nothing) is known', fontsize=9, color=GREY, ha='right', va='top')
fig.savefig(os.path.join(D, 'fig_precision.png'), dpi=170, bbox_inches='tight', facecolor='white'); plt.close(fig)
print('figs ok')
