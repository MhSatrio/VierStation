const fs = require('fs');
const path = require('path');
const L = require('./lib.js');
const { D, BLUE, INK, GREY, NAVY, FONT, H1, H2, P, small, bullets, table, image, spacer } = L;
const { Document, Packer, Paragraph, TextRun, TableOfContents, Header, Footer, PageNumber, AlignmentType, LevelFormat, HeadingLevel, ImageRun, BorderStyle } = D;

const files = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));
const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'routes.json'), 'utf8'));
const OVERRIDE = {
  'server/config.ts': 'All settings and environment variables, data folder, master key.', 'server/db.ts': 'SQLite connection, schema creation and numbered migrations (incl. the Sequence Lab tables and the immutability triggers).',
  'server/exporter.ts': 'CSV / JSON export of table data.', 'server/http.ts': 'HTTP server helpers: routing table, request parsing, validation (`str`, `int`, `oneOf`), cookies, rate limiting.', 'server/index.ts': 'Server start-up: loads routes, jobs and modules, serves the built client and the API.',
  'server/notify.ts': 'Creates in-app notifications and optional e-mail.', 'server/util.ts': 'Small helpers: ids, time, JSON, password hashing (scrypt), encryption of secrets.',
  'server/routes/auth.ts': 'Register, login, logout, who-am-I.', 'server/routes/core.ts': 'Workspaces, projects, members, tables, fields, views, templates.', 'server/routes/ops.ts': 'Jobs, notifications, automations, audit, settings.', 'server/routes/records.ts': 'Query, create, update, bulk edit, comments, export, files.',
  'server/routes/science.ts': 'Fetch from databases, BLAST of sequences, discovery pipelines, structures, analyses.', 'shared/world-110m.json': 'Country outlines and centres for the globe and offline country lookup (Natural Earth, public domain).',
  'src/App.tsx': 'Application root: login gate, shell and the page router.', 'src/main.tsx': 'Browser entry point.', 'src/lib/data.ts': 'Client-side helpers for query specifications and table data.', 'src/lib/router.tsx': 'Tiny router: paths, query parameters, navigation.',
  'src/ui/Analysis.tsx': 'Analysis page: choose records, run, show results, export code.', 'src/ui/Auth.tsx': 'Login and registration screens.', 'src/ui/Automations.tsx': 'Automations list and editor.', 'src/ui/Cells.tsx': 'How each field type is displayed and edited in a grid cell.',
  'src/ui/FieldEditor.tsx': 'Add/edit field dialogs and the Fields manager.', 'src/ui/GraphView.tsx': 'Relationship graph view.', 'src/ui/Grid.tsx': 'The spreadsheet-style grid.', 'src/ui/Jobs.tsx': 'Jobs list and Notifications page.',
  'src/ui/Overview.tsx': 'Home page: start-with-an-accession box and the research pipeline overview.', 'src/ui/Projects.tsx': 'Projects and Databases pages (create tables, templates).', 'src/ui/RecordPanel.tsx': 'Record side panel with fields, Discover buttons, links, provenance and comments.',
  'src/ui/Redirects.tsx': 'Redirects from /kind/… and /record/… to the right table.', 'src/ui/SearchModal.tsx': 'Global search (Ctrl K).', 'src/ui/Settings.tsx': 'Workspace settings and members.', 'src/ui/Shell.tsx': 'Sidebar, top bar and page frame.',
  'src/ui/TablePage.tsx': 'A table: header buttons, views, toolbar, import dialog.', 'src/ui/Toolbar.tsx': 'Filter, sort, group, fields and search controls.', 'src/ui/Views.tsx': 'Kanban, gallery, calendar and list views.', 'src/ui/common.tsx': 'Shared UI pieces: modal, spinner, chips, menus, evidence tags, date helpers.',
  'src/ui/lab/useLab.tsx': 'Lab context, data-loading hook, job runner and section frame.',
  'tests/analysis.test.ts': 'Analysis algorithms against independent references and executed Python exports.', 'tests/discovery.test.ts': 'Discovery pipeline against recorded real API responses.', 'tests/engine.test.ts': 'Tables, fields, queries, permissions.', 'tests/jobs.test.ts': 'Job queue, retries, automations, notifications.',
  'tests/phylo.test.ts': 'Tree methods, distances, likelihood, bootstrap.', 'tests/seqlab-formats.test.ts': 'AB1 / FASTQ / FASTA readers (AB1 compared with Biopython).', 'tests/seqlab-merge.test.ts': 'Forward + reverse merge, merged-record flow, Python parity.', 'tests/seqlab-msa.test.ts': 'Multiple alignment engines.',
  'tests/seqlab-select.test.ts': 'Relatives/outgroup selection rules, hit ranking, tree reading.', 'tests/seqlab.test.ts': 'The whole Sequence Lab against the synthetic NCBI, incl. exported scripts.', 'tests/shared.test.ts': 'Shared libraries (sequence tools, filters, formulas, CSV).', 'tests/e2e/dbg.ts': 'Scratch script for debugging browser tests.',
};
const GROUPS = [['server/', 'server/ (top level)'], ['server/routes/', 'server/routes/'], ['server/integrations/', 'server/integrations/'], ['server/discovery/', 'server/discovery/'], ['server/seqlab/', 'server/seqlab/'], ['server/phylo/', 'server/phylo/'], ['server/analysis/', 'server/analysis/'], ['server/geo/', 'server/geo/'], ['server/report/', 'server/report/'], ['shared/', 'shared/'], ['src/lib/', 'src/lib/'], ['src/ui/lab/', 'src/ui/lab/'], ['src/ui/', 'src/ui/'], ['src/', 'src/ (root)'], ['scripts/', 'scripts/'], ['tests/e2e/', 'tests/e2e/'], ['tests/live/', 'tests/live/'], ['tests/perf/', 'tests/perf/'], ['tests/', 'tests/']];
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
const inv = [];
for (const [dir, title] of GROUPS) {
  const items = files.filter((f) => dirOf(f.path) === dir);
  if (!items.length) continue;
  inv.push(D.HeadingLevel && new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: `${title}  (${items.length} files)`, font: FONT })] }));
  inv.push(...table(['File', 'Lines', 'What it is'], items.map((f) => [f.path.slice(dir.length), String(f.lines), (OVERRIDE[f.path] ?? f.what ?? '').replace(/^[-–]\s*/, '').slice(0, 260) || '—']), [3.2, 1.2, 9], { size: 16, mono: [0] }));
}
const glossary = [
  ['Accession', 'A database identifier such as NM_000546 (RefSeq) or KX000001.1 (GenBank). The part after the dot is the version.'],
  ['Alignment', 'Lining up sequences so that matching positions are in the same column; gaps (–) stand for insertions/deletions.'],
  ['Ambiguity code (IUPAC)', 'A letter meaning “one of several bases”: R = A/G, Y = C/T, N = any base …'],
  ['Amplicon', 'The stretch of DNA copied by PCR and sequenced; forward and reverse reads cover it from both ends.'],
  ['BLAST', 'Basic Local Alignment Search Tool: finds database sequences similar to yours. Megablast is the fast, high-identity mode; blastn is more sensitive.'],
  ['Bootstrap', 'Re-building the tree from re-sampled alignment columns; the percentage says how often a branch re-appeared. Not the probability that the branch is true.'],
  ['Coverage (query)', 'The share of YOUR sequence that the BLAST alignment spans.'],
  ['Consensus', 'One sequence made from several; here the result of merging forward and reverse reads.'],
  ['E-value', 'How many matches this good are expected by chance in a database of that size; smaller is better.'],
  ['Evidence class', 'How a link between two records is known: database-annotated, sequence-inferred or user-supplied.'],
  ['Forward / reverse read', 'Sanger sequencing of the same DNA from the two ends; the reverse read is the reverse complement of the forward direction.'],
  ['Geocoding', 'Turning a place name into coordinates.'],
  ['Identity', 'The share of matching positions inside the aligned part (BLAST counts N as a mismatch).'],
  ['Ingroup / outgroup', 'The sequences of interest and their relatives / a more distant sequence used to place the root of the tree.'],
  ['Job', 'A background task with progress, retries and a log.'],
  ['Marker', 'The gene region used for identification (ITS, COI, 16S, rbcL …).'],
  ['Newick', 'A text format for trees, readable by most tree programs.'],
  ['Operation log', 'The per-sequence record of every step (`seq_ops`), the source of the change log, script and PDF.'],
  ['Parsimony-informative site', 'An alignment column with at least two different bases each in at least two sequences; only these carry information for parsimony.'],
  ['Phred quality (Q)', 'Q = −10·log10(error probability): Q20 = 1 % chance the base is wrong, Q30 = 0.1 %.'],
  ['Precision (location)', 'How exactly the place of a sample is known (exact … country).'],
  ['Provenance', 'Where a record came from: database, accession, query, time.'],
  ['Raw sequence', 'The sequence exactly as imported; immutable.'],
  ['Region (aligned)', 'The part of a reference record that BLAST aligned to your sequence.'],
  ['Rooting', 'Choosing where the oldest ancestor of the tree is: by outgroup, by midpoint, or not at all.'],
  ['SSE', 'Server-Sent Events: the one-way live channel from server to browser.'],
  ['Version (sequence)', 'A saved state of a sequence; each cleaning step creates one.'],
];

const cover = [
  new Paragraph({ spacing: { before: 1800, after: 200 }, children: [new ImageRun({ type: 'png', data: fs.readFileSync('C:/Users/satri/OneDrive/Dokumen/Claude Set/VierStation/public/brand/icon-512.png'), transformation: { width: 96, height: 96 }, altText: { title: 'VierApparatus icon', description: 'VierApparatus icon', name: 'icon' } })] }),
  new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: 'VierStation', font: FONT, size: 72, bold: true, color: INK })] }),
  new Paragraph({ spacing: { after: 360 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BLUE, space: 8 } }, children: [new TextRun({ text: 'Documentation – structure, files, licences and step-by-step use', font: FONT, size: 32, color: BLUE })] }),
  P('Scientific research workspace of VierApparatus: relational research data, public-database connections, the Sequence Lab (DNA identification, alignment, phylogenetics, PDF/Python/tree export) and the sample map.', { size: 24 }),
  spacer(),
  ...table(['Item', 'Detail'], [
    ['Version', '0.1 – state of 5 November 2026'],
    ['Contents', 'How it works · which file to edit · licence and originality audit · case studies (DNA identification, sample map, DNA→protein pipeline, statistics and correlations, protein sequences, automations) · troubleshooting · file inventory · API routes · glossary'],
    ['Size of the code base', '146 files, about 22,000 lines (TypeScript, TSX, Python); 142 backend tests, 13 + 10 browser tests'],
    ['How to read the screenshots', 'Each case study says whether its data is a **real run**, **recorded API data**, **synthetic test data** or **illustrative data**.'],
    ['Open the contents', 'Right-click the table of contents in Word and choose “Update field” if the page numbers are missing.'],
  ], [2.2, 10], { size: 19 }).slice(0, 1),
];

const doc = new Document({
  creator: 'VierStation', title: 'VierStation documentation', description: 'Structure, files, licences and step-by-step use of VierStation',
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: INK } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 36, bold: true, color: BLUE }, paragraph: { spacing: { before: 120, after: 200 }, keepNext: true, outlineLevel: 0, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLUE, space: 4 } } } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 28, bold: true, color: NAVY }, paragraph: { spacing: { before: 320, after: 120 }, keepNext: true, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 23, bold: true, color: BLUE }, paragraph: { spacing: { before: 220, after: 80 }, keepNext: true, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }, { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1000, hanging: 270 } } } }] },
      { reference: 'num', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } }, run: { bold: true, color: BLUE } } }] },
    ],
  },
  sections: [
    { properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1200, left: 1440, right: 1440 } } }, children: [...cover] },
    {
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1200, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C9D3E0', space: 4 } }, children: [new TextRun({ text: 'VierStation documentation', font: FONT, size: 16, color: GREY })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Page ', font: FONT, size: 16, color: GREY }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: GREY }), new TextRun({ text: ' of ', font: FONT, size: 16, color: GREY }), new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: GREY })] })] }) },
      children: [
        new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLUE, space: 4 } }, children: [new TextRun({ text: 'Contents', font: FONT, size: 36, bold: true, color: BLUE })] }),
        new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
        ...require('./part1.js'), ...require('./part2.js'), ...require('./part3.js'),
        H1('Appendix A  Every source file'),
        P('Generated from the repository: path (relative to `VierStation/`), number of lines and the file’s own header comment (or a short description where the file has none). Test fixtures, build output and data folders are not listed.'),
        ...inv,
        H1('Appendix B  Every API route'),
        P('All 145 endpoints of the server. `:id` marks a variable part. All routes except registration/login require a logged-in session; permissions are checked inside each handler.'),
        ...table(['Method', 'Path', 'Defined in'], routes.map(([f, m, p]) => [m, p, `server/routes/${f}`]), [1.3, 8, 3.4], { size: 16, mono: [1] }),
        H1('Appendix C  Glossary'),
        ...table(['Term', 'Meaning'], glossary, [3.2, 10], { size: 18 }),
      ],
    },
  ],
});
Packer.toBuffer(doc).then((b) => { const out = path.join(__dirname, 'VierStation_Documentation.docx'); fs.writeFileSync(out, b); console.log('written', out, Math.round(b.length / 1024), 'KB'); });
