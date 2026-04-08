#!/usr/bin/env node
/**
 * Dumb Gold invoke gate: reads JSON { envelope, correlationId } from stdin,
 * links to ZAK-Gold artifacts on disk (no policy). Emits one JSON line to stdout.
 */
"use strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

function canonical(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort(), 0);
}

function deny(error) {
  return { ok: false, error, outcome: "denied" };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capabilitiesRoot = path.join(repoRoot, "capabilities");
const compilerCliPath = path.join(repoRoot, "capability-compiler", "dist", "cli.js");
const vitestCliPath = path.join(repoRoot, "capability-compiler", "node_modules", "vitest", "vitest.mjs");

function capabilityVersionDir(capabilityId, version) {
  return path.join(capabilitiesRoot, capabilityId, version);
}

function safeExec(file, args, cwd) {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return {
      ok: false,
      error: `${stdout}${stderr}`.trim() || String(error),
    };
  }
}

function extractChatContent(message) {
  if (!message || message.content == null) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
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

function executeReadFile(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const workspaceFile = payload && typeof payload === "object" ? payload.workspace_file : null;

  if (!capabilityRequest || typeof capabilityRequest !== "object") {
    return deny("missing_capability_request");
  }
  if (!workspaceFile || typeof workspaceFile !== "object") {
    return deny("missing_workspace_file");
  }

  const input = capabilityRequest.input;
  const requestedPath = input && typeof input === "object" ? input.path : null;
  const actualPath = typeof workspaceFile.path === "string" ? workspaceFile.path : null;
  const content = typeof workspaceFile.content === "string" ? workspaceFile.content : null;

  if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
    return deny("invalid_read_path");
  }
  if (requestedPath !== actualPath) {
    return deny("workspace_file_path_mismatch");
  }
  if (content === null) {
    return deny("invalid_workspace_file_content");
  }

  return {
    ok: true,
    outcome: "success",
    output: {
      capability: "read_file",
      authorityContextId:
        typeof workspaceFile.authority_context_id === "string"
          ? workspaceFile.authority_context_id
          : null,
      workspaceName:
        typeof workspaceFile.workspace_name === "string"
          ? workspaceFile.workspace_name
          : null,
      path: actualPath,
      content,
    },
  };
}

function executeListFiles(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const workspaceSnapshot = payload && typeof payload === "object" ? payload.workspace_snapshot : null;

  if (!capabilityRequest || typeof capabilityRequest !== "object") {
    return deny("missing_capability_request");
  }
  if (!workspaceSnapshot || typeof workspaceSnapshot !== "object") {
    return deny("missing_workspace_snapshot");
  }

  const files = Array.isArray(workspaceSnapshot.files) ? workspaceSnapshot.files : null;
  if (!files || !files.every((item) => typeof item === "string")) {
    return deny("invalid_workspace_files");
  }

  return {
    ok: true,
    outcome: "success",
    output: {
      capability: "list_files",
      authorityContextId:
        typeof workspaceSnapshot.authority_context_id === "string"
          ? workspaceSnapshot.authority_context_id
          : null,
      workspaceName:
        typeof workspaceSnapshot.workspace_name === "string"
          ? workspaceSnapshot.workspace_name
          : null,
      files,
    },
  };
}

function executeCommitEdit(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const input = capabilityRequest && typeof capabilityRequest === "object" ? capabilityRequest.input : null;

  const pathRef = input && typeof input === "object" ? input.path : null;
  const content = input && typeof input === "object" ? input.content : null;
  const surfaceId = input && typeof input === "object" ? input.surface_id : null;

  if (typeof pathRef !== "string" || pathRef.trim().length === 0) {
    return deny("invalid_commit_path");
  }
  if (typeof content !== "string") {
    return deny("invalid_commit_content");
  }
  if (typeof surfaceId !== "string" || surfaceId.trim().length === 0) {
    return deny("invalid_surface_id");
  }

  const payloadHash = `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
  const issuedAt = Date.now();

  return {
    ok: true,
    outcome: "success",
    output: {
      capability: "commit_edit",
      authorization: {
        authorization_id: `auth_${issuedAt}_${Math.random().toString(36).slice(2, 8)}`,
        execution_receipt_hash: "",
        surface_id: surfaceId,
        capability: "commit_edit",
        resource_ref: pathRef,
        payload_hash: payloadHash,
        issued_at: issuedAt,
        expires_at: issuedAt + 30000,
        signature: "zakai-runtime-signature-pending",
      },
    },
  };
}

function executeWriteWorksheet(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const input = capabilityRequest && typeof capabilityRequest === "object" ? capabilityRequest.input : null;

  const capabilityId = input && typeof input === "object" ? input.capability_id : null;
  const version = input && typeof input === "object" ? input.version : null;
  const worksheetContent = input && typeof input === "object" ? input.worksheet_content : null;
  const overwrite = input && typeof input === "object" ? input.overwrite === true : false;

  if (typeof capabilityId !== "string" || capabilityId.trim().length === 0) {
    return deny("invalid_capability_id");
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    return deny("invalid_capability_version");
  }
  if (!worksheetContent || typeof worksheetContent !== "object" || Array.isArray(worksheetContent)) {
    return deny("invalid_worksheet_content");
  }

  const targetDir = capabilityVersionDir(capabilityId, version);
  const targetPath = path.join(targetDir, "worksheet.yaml");
  const existed = fs.existsSync(targetPath);
  if (existed && !overwrite) {
    return {
      ok: true,
      outcome: "success",
      output: {
        written_path: targetPath,
        capability_id: capabilityId,
        version,
        overwritten: false,
      },
    };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(worksheetContent, null, 2)}\n`, "utf8");

  return {
    ok: true,
    outcome: "success",
    output: {
      written_path: targetPath,
      capability_id: capabilityId,
      version,
      overwritten: existed,
    },
  };
}

function executeCompileCapability(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const input = capabilityRequest && typeof capabilityRequest === "object" ? capabilityRequest.input : null;

  const capabilityId = input && typeof input === "object" ? input.capability_id : null;
  const version = input && typeof input === "object" ? input.version : null;
  const nestedVersion = input && typeof input === "object" ? input.nested_version === true : false;
  const outDir = input && typeof input === "object" && typeof input.out_dir === "string"
    ? input.out_dir
    : "../capabilities";

  if (typeof capabilityId !== "string" || capabilityId.trim().length === 0) {
    return deny("invalid_capability_id");
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    return deny("invalid_capability_version");
  }
  if (!fs.existsSync(compilerCliPath)) {
    return deny("compiler_cli_missing");
  }

  const worksheetPath = path.join(capabilityVersionDir(capabilityId, version), "worksheet.yaml");
  if (!fs.existsSync(worksheetPath)) {
    return {
      ok: true,
      outcome: "success",
      output: {
        success: false,
        capability_id: capabilityId,
        version,
        error: "worksheet_missing",
      },
    };
  }

  const outputBase = path.resolve(path.dirname(compilerCliPath), outDir);
  const args = [compilerCliPath, "compile", worksheetPath, "--out", outputBase];
  if (nestedVersion) {
    args.push("--nested-version");
  }
  const compileRun = safeExec(process.execPath, args, repoRoot);
  if (!compileRun.ok) {
    return {
      ok: true,
      outcome: "success",
      output: {
        success: false,
        capability_id: capabilityId,
        version,
        error: compileRun.error,
      },
    };
  }

  const outDirPath = nestedVersion
    ? path.join(outputBase, capabilityId, version)
    : path.join(outputBase, capabilityId);
  const definitionHashPath = path.join(outDirPath, "definition.hash");
  const emittedFiles = fs.existsSync(outDirPath)
    ? fs.readdirSync(outDirPath).map((file) => path.join(outDirPath, file))
    : [];

  return {
    ok: true,
    outcome: "success",
    output: {
      success: true,
      capability_id: capabilityId,
      version,
      definition_hash: fs.existsSync(definitionHashPath)
        ? fs.readFileSync(definitionHashPath, "utf8").trim()
        : undefined,
      emitted_files: emittedFiles,
    },
  };
}

function executeCapabilityTest(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const input = capabilityRequest && typeof capabilityRequest === "object" ? capabilityRequest.input : null;

  const capabilityId = input && typeof input === "object" ? input.capability_id : null;
  const version = input && typeof input === "object" ? input.version : null;
  const attemptNumber = input && typeof input === "object" ? input.attempt_number : null;

  if (typeof capabilityId !== "string" || capabilityId.trim().length === 0) {
    return deny("invalid_capability_id");
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    return deny("invalid_capability_version");
  }
  if (typeof attemptNumber !== "number" || !Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 3) {
    return deny("invalid_attempt_number");
  }
  if (!fs.existsSync(vitestCliPath)) {
    return deny("vitest_cli_missing");
  }

  const specPath = path.join(capabilityVersionDir(capabilityId, version), "test.spec.ts");
  if (!fs.existsSync(specPath)) {
    return {
      ok: true,
      outcome: "success",
      output: {
        passed: false,
        capability_id: capabilityId,
        version,
        attempt_number: attemptNumber,
        definition_hash_verified: false,
        golden_input_validated: false,
        self_correction_possible: attemptNumber < 3,
        halt: attemptNumber >= 3,
        error_output: "test_spec_missing",
      },
    };
  }

  const testRun = safeExec(process.execPath, [vitestCliPath, "run", specPath], repoRoot);
  const passed = testRun.ok;
  return {
    ok: true,
    outcome: "success",
    output: {
      passed,
      capability_id: capabilityId,
      version,
      definition_hash_verified: passed,
      golden_input_validated: passed,
      attempt_number: attemptNumber,
      error_output: passed ? undefined : testRun.error,
      self_correction_possible: !passed && attemptNumber < 3,
      halt: !passed && attemptNumber >= 3,
    },
  };
}

function executeProposeMembraneAdmission(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  const input = capabilityRequest && typeof capabilityRequest === "object" ? capabilityRequest.input : null;

  const capabilityId = input && typeof input === "object" ? input.capability_id : null;
  const version = input && typeof input === "object" ? input.version : null;
  const definitionHash = input && typeof input === "object" ? input.definition_hash : null;
  const testReceiptId = input && typeof input === "object" ? input.test_receipt_id : null;
  const compileReceiptId = input && typeof input === "object" ? input.compile_receipt_id : null;
  const justification = input && typeof input === "object" ? input.justification : null;

  if (
    typeof capabilityId !== "string" || capabilityId.trim().length === 0
    || typeof version !== "string" || version.trim().length === 0
    || typeof definitionHash !== "string" || definitionHash.trim().length === 0
    || typeof testReceiptId !== "string" || testReceiptId.trim().length === 0
    || typeof compileReceiptId !== "string" || compileReceiptId.trim().length === 0
    || typeof justification !== "string" || justification.trim().length === 0
  ) {
    return deny("invalid_proposal_input");
  }

  const proposalsDir = path.join(repoRoot, "engine", "proposals");
  fs.mkdirSync(proposalsDir, { recursive: true });

  const proposedAt = Date.now();
  const proposalId = `proposal_${proposedAt}_${Math.random().toString(36).slice(2, 8)}`;
  const proposal = {
    proposal_id: proposalId,
    capability_id: capabilityId,
    version,
    definition_hash: definitionHash,
    test_receipt_id: testReceiptId,
    compile_receipt_id: compileReceiptId,
    justification,
    status: "pending_human_seal",
    proposed_at: proposedAt,
    signature: crypto.createHash("sha256").update(canonical({
      capabilityId,
      version,
      definitionHash,
      testReceiptId,
      compileReceiptId,
      justification,
      proposedAt,
    }), "utf8").digest("hex"),
  };
  const proposalReceiptPath = path.join(proposalsDir, `${proposalId}.json`);
  fs.writeFileSync(proposalReceiptPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

  return {
    ok: true,
    outcome: "success",
    output: {
      proposal_id: proposalId,
      capability_id: capabilityId,
      version,
      definition_hash: definitionHash,
      proposal_receipt_path: proposalReceiptPath,
      status: "pending_human_seal",
      proposed_at: proposedAt,
    },
  };
}

async function executeConversationRespond(payload) {
  const capabilityRequest = payload && typeof payload === "object" ? payload.capability_request : null;
  if (!capabilityRequest || typeof capabilityRequest !== "object") {
    return deny("missing_capability_request");
  }

  const input = capabilityRequest.input;
  const prompt = input && typeof input === "object" ? input.prompt : null;
  const history = input && typeof input === "object" && Array.isArray(input.history) ? input.history : [];

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return deny("invalid_prompt");
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openRouterKey && !openAiKey) {
    return deny("llm_credentials_missing");
  }

  const systemPrompt =
    typeof process.env.ZAKAI_SYSTEM_PROMPT === "string" && process.env.ZAKAI_SYSTEM_PROMPT.trim().length > 0
      ? process.env.ZAKAI_SYSTEM_PROMPT.trim()
      : "You are ZAKAI inside the governed runtime. Answer directly, conversationally, and concisely. Do not claim to have executed tools unless the runtime executed them.";

  const priorMessages = history
    .filter((entry) => entry && typeof entry === "object")
    .flatMap((entry) => {
      const role = entry.role === "assistant" ? "assistant" : "user";
      const content = typeof entry.content === "string" ? entry.content : "";
      return content.trim().length > 0 ? [{ role, content }] : [];
    });

  const useOpenRouter = Boolean(openRouterKey);
  const url = useOpenRouter
    ? `${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`
    : "https://api.openai.com/v1/chat/completions";
  const model = useOpenRouter
    ? (process.env.OPENROUTER_MODEL ?? "openrouter/free")
    : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${useOpenRouter ? openRouterKey : openAiKey}`,
      ...(useOpenRouter
        ? {
            "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ?? "https://github.com/harmonicfutures/zak-ai",
            "X-Title": process.env.OPENROUTER_APP_TITLE ?? "ZAKAI-runtime",
          }
        : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...priorMessages,
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return deny(`llm_http_${res.status}${text ? `:${text.slice(0, 160)}` : ""}`);
  }

  const json = await res.json();
  const text = extractChatContent(json?.choices?.[0]?.message);
  if (!text || text.trim().length === 0) {
    return deny("empty_model_output");
  }

  return {
    ok: true,
    outcome: "success",
    output: {
      capability: "conversation.respond",
      reply: text.trim(),
      provider: useOpenRouter ? "openrouter" : "openai",
      model,
    },
  };
}

function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", async () => {
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
    } else if (requestedCapability === "list_files") {
      out = executeListFiles(env.payload);
    } else if (requestedCapability === "zak.dev.write_worksheet") {
      out = executeWriteWorksheet(env.payload);
    } else if (requestedCapability === "zak.dev.compile") {
      out = executeCompileCapability(env.payload);
    } else if (requestedCapability === "zak.dev.test_runner") {
      out = executeCapabilityTest(env.payload);
    } else if (requestedCapability === "zak.dev.propose_membrane_admission") {
      out = executeProposeMembraneAdmission(env.payload);
    } else if (requestedCapability === "commit_edit") {
      out = executeCommitEdit(env.payload);
    } else if (requestedCapability === "read_file") {
      out = executeReadFile(env.payload);
    } else if (requestedCapability === "conversation.respond") {
      out = await executeConversationRespond(env.payload);
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
