import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Runtime bundle measurement for proxy registration (same algorithm as engine oracle).
 * tsup emits a single dist/index.js; at runtime __dirname is dist/, so the bundle is ./index.js.
 */
export function adapterBundleSha256(): string {
  const bundlePath = path.join(__dirname, "index.js");
  const data = fs.readFileSync(bundlePath);
  return "sha256:" + crypto.createHash("sha256").update(data).digest("hex");
}
