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

function deny(error) {
  return { ok: false, error, outcome: "denied" };
}

function executeSearchFiles(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const workspaceSnapshot = payload && typeof payload === "object" ? payload.workspace_snapshot : null;

  if (!capabilityRequest || typeof capabilityRequest !== "object") {
    return deny("missing_capability_request");
  }
  if (!workspaceSnapshot || typeof workspaceSnapshot !== "object") {
    return deny("missing_workspace_snapshot");
  }

  const input = capabilityRequest.input;
  const query = input && typeof input === "object" ? input.query : null;
  const files = Array.isArray(workspaceSnapshot.files) ? workspaceSnapshot.files : null;

  if (typeof query !== "string" || query.trim().length === 0) {
    return deny("invalid_search_query");
  }
  if (!files || !files.every((item) => typeof item === "string")) {
    return deny("invalid_workspace_files");
  }

  const needle = query.trim().toLowerCase();
  const matches = files.filter((path) => path.toLowerCase().includes(needle));

  return {
    ok: true,
    outcome: "success",
    output: {
      capability: "search_files",
      authorityContextId:
        typeof workspaceSnapshot.authority_context_id === "string"
          ? workspaceSnapshot.authority_context_id
          : null,
      workspaceName:
        typeof workspaceSnapshot.workspace_name === "string"
          ? workspaceSnapshot.workspace_name
          : null,
      query,
      matches,
    },
  };
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
    const requestedCapability =
      env.payload
      && typeof env.payload === "object"
      && env.payload.capability_request
      && typeof env.payload.capability_request === "object"
      && typeof env.payload.capability_request.capability === "string"
        ? env.payload.capability_request.capability
        : null;

    let out;
    if (requestedCapability === "search_files") {
      out = executeSearchFiles(env.payload);
    } else {
      out = {
        ok: true,
        outcome: "success",
        output: {
          correlationId,
          intentId: env.intentId,
          receivedPayload: env.payload,
          gold_dist_validator_present: goldArtifactPresent,
        },
      };
    }
    if (out.ok) {
      out.digest = { nonceHash, routePlanHash: nonceHash };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  });
}

main();
