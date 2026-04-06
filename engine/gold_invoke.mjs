#!/usr/bin/env node
/**
 * Dumb Gold invoke gate: reads JSON { envelope, correlationId } from stdin,
 * links to ZAK-Gold artifacts on disk (no policy). Emits one JSON line to stdout.
 */
"use strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";

function canonical(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort(), 0);
}

function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", () => {
    let body;
    try {
      body = JSON.parse(stdin);
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: "invalid_json", outcome: "denied" }) + "\n"
      );
      process.exit(1);
      return;
    }
    const env = body.envelope;
    const correlationId = body.correlationId || "proxy";
    if (!env || typeof env.intentId !== "string") {
      process.stdout.write(
        JSON.stringify({ ok: false, error: "invalid_envelope", outcome: "denied" }) + "\n"
      );
      process.exit(1);
      return;
    }
    const gold = process.env.ZAKAI_GOLD || "";
    const canon = canonical({ intentId: env.intentId, payload: env.payload });
    const nonceHash = crypto.createHash("sha256").update(canon, "utf8").digest("hex");
    let goldArtifactPresent = false;
    try {
      const v = path.join(gold, "dist", "kernel", "validator.js");
      goldArtifactPresent = fs.existsSync(v);
    } catch (_) {}
    const out = {
      ok: true,
      outcome: "success",
      digest: { nonceHash, routePlanHash: nonceHash },
      output: {
        correlationId,
        intentId: env.intentId,
        receivedPayload: env.payload,
        gold_dist_validator_present: goldArtifactPresent,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  });
}

main();
