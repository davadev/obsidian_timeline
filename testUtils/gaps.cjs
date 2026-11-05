// Dev helper: node testUtils/gaps.cjs <path-substring> [--src] — lists uncovered
// statements/branches from coverage/coverage-final.json (run test:cov json first).
const fs = require("fs");
const c = require(process.cwd() + "/coverage/coverage-final.json");
const pat = process.argv[2] || "/src/";
const src = process.argv.includes("--src");
for (const [f, d] of Object.entries(c)) {
  if (!f.includes(pat)) continue;
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const un = new Set();
  for (const [k, n] of Object.entries(d.s)) if (!n) un.add(d.statementMap[k].start.line);
  const br = new Set();
  for (const [k, arr] of Object.entries(d.b)) arr.forEach((n, i) => { if (!n) br.add(d.branchMap[k].locations[i].start.line); });
  const all = [...new Set([...un, ...br])].sort((a, b) => a - b);
  if (!all.length) continue;
  console.log(f.split("/src/")[1], "stmts:", [...un].length, "branch-lines:", [...br].length);
  if (src) for (const l of all) console.log(`  ${l}${un.has(l) ? "S" : "B"}: ${(lines[l - 1] ?? "(line out of range)").trim().slice(0, 110)}`);
}
