import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log("====================================================");
console.log("   ZAK CORE: FINAL GOLD MASTER VERIFICATION");
console.log("====================================================");

const run = (cmd: string, name: string) => {
  console.log(`\n[RUNNING] ${name}...`);
  try {
    const output = execSync(cmd, { stdio: 'pipe' }).toString();
    console.log(`[PASS] ${name}`);
    return { name, pass: true, output };
  } catch (err: any) {
    console.log(`[FAIL] ${name}`);
    console.error(err.stderr?.toString() || err.message);
    return { name, pass: false, output: err.stderr?.toString() || err.message };
  }
};

const results = [
  run('npm test', 'Unit Tests'),
  run('npx ts-node tests/red-team/simulate_attack.ts', 'Red-Team Safety Simulation'),
  run('npx ts-node tests/determinism/drift_check.ts', '1000-Run Determinism Proof'),
  run('python tests/tco/watt_calculator.py', 'TCO / Energy Instrumentation'),
];

console.log("\n====================================================");
console.log("   VERIFICATION SUMMARY");
console.log("====================================================");

let allPass = true;
results.forEach(r => {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name.padEnd(30)} [${r.pass ? 'PASS' : 'FAIL'}]`);
  if (!r.pass) allPass = false;
});

const reportPath = path.join(__dirname, '../VERIFICATION_REPORT.json');
fs.writeFileSync(reportPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  status: allPass ? "GOLD_MASTER_VERIFIED" : "FAILURE",
  kernel_version: "1.0.1",
  results
}, null, 2));

console.log(`\nDetailed report written to: ${reportPath}`);

if (allPass) {
  console.log("\n🏁 SYSTEM SEALED: ZAK CORE IS READY FOR DEPLOYMENT.");
  process.exit(0);
} else {
  console.log("\n⚠️  CRITICAL: SYSTEM INTEGRITY FAULT DETECTED.");
  process.exit(1);
}

