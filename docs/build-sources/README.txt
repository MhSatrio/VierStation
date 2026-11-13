Sources that generate docs/VierStation_Documentation.docx (kept so the document can be rebuilt after the code changes).
  1. python inventory.py      -> files.json, routes.json (scans the repository)
  2. python figs.py           -> fig_*.png (architecture, lab workflow, precision scale)
  3. node ../../tests/e2e/docs-case.ts (from VierStation/) -> statistics screenshots + numbers (copy doc-case.json "out" to stats.json)
  4. npm install docx@9 && node build.js
Paths inside the scripts point at this machine's scratch folder; edit D / FIG / SHOT constants first. Screenshots come from tests/e2e/out/.
