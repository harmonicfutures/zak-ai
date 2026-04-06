import { resolve } from "node:path";
import { compileWorksheetFile, verifyCompiledCapabilities } from "./emit";

function usage(): never {
  console.error(`cap-compile — capability worksheet compiler

Usage:
  cap-compile compile <worksheet.yaml> [--out <dir>] [--nested-version]
  cap-compile verify <capabilities-parent-dir>

  --out             Parent directory for capability trees (default: ./capabilities)
  --nested-version  Emit to <out>/<capability>/<version>/ (multi-version id)

Rule: registry artifacts are emitted only by this tool.
`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length < 2) usage();
  const cmd = argv[0];
  if (cmd === "verify") {
    const dir = resolve(argv[1]!);
    verifyCompiledCapabilities(dir);
    console.error(`verify ok: ${dir}`);
    return;
  }
  if (cmd !== "compile") usage();

  let out = resolve(process.cwd(), "capabilities");
  let nestedVersion = false;
  const pathIdx = argv.findIndex((a) => a === "--out");
  if (pathIdx !== -1) {
    out = resolve(argv[pathIdx + 1] || "");
    if (!argv[pathIdx + 1]) usage();
    argv.splice(pathIdx, 2);
  }
  const nestIdx = argv.findIndex((a) => a === "--nested-version");
  if (nestIdx !== -1) {
    nestedVersion = true;
    argv.splice(nestIdx, 1);
  }
  const sheet = argv[1];
  if (!sheet || argv[2]) usage();

  compileWorksheetFile(resolve(sheet), { outBase: out, nestedVersionLayout: nestedVersion });
  console.error(`compiled → ${out}`);
}

main();
