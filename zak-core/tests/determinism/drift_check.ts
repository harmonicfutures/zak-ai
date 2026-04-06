import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { ZAKCompiler } from "../../src/kernel/compiler";
import { Sigil } from "../../src/kernel/validator";

const sigilPath = path.join(__dirname, "../../sigils/root/corp.root.v1.json");
const sigil = JSON.parse(fs.readFileSync(sigilPath, "utf8")) as Sigil;
const prompt = "How do I optimize corporate tax structure?";

console.log("=== ZAK DETERMINISM DRIFT CHECK ===");
console.log(`Sigil: ${sigil.meta.id} v${sigil.meta.version}`);
console.log(`Runs: 1000`);

const hashes = new Set<string>();

for (let i = 0; i < 1000; i++) {
  const manifest = ZAKCompiler.compileContext([sigil], prompt);
  const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  hashes.add(hash);
}

console.log(`Unique Hashes: ${hashes.size}`);

if (hashes.size === 1) {
  const finalHash = Array.from(hashes)[0];
  console.log(`SUCCESS: Identity confirmed. Hash: ${finalHash}`);
  
  const manifestPath = path.join(__dirname, "manifest_hashes.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    sigil_id: sigil.meta.id,
    sigil_version: sigil.meta.version,
    manifest_hash: finalHash,
    timestamp: Date.now()
  }, null, 2));
} else {
  console.error("FAILURE: Non-deterministic drift detected!");
  process.exit(1);
}

