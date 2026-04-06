import express from "express";
import path from "path";
import fs from "fs";
import { ZAKRunner, LLMEngineAdapter } from "../kernel/runner";
import { ZAKCompiler } from "../kernel/compiler";
import { Sigil } from "../kernel/validator";
import { crypto } from "node:crypto";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- BOOTSTRAP: Load Sigils ---
const SIGIL_DIR = path.join(__dirname, "../../sigils/root");
const rootSigilPath = path.join(SIGIL_DIR, "corp.root.v1.json");

if (!fs.existsSync(rootSigilPath)) {
  console.error("CRITICAL: Root sigil not found. Run seed script first.");
  process.exit(1);
}

const rootSigil: Sigil = JSON.parse(fs.readFileSync(rootSigilPath, "utf8"));
const sigils = [rootSigil];

// --- ADAPTER: Simple Mock for Pilot UI ---
// In a real pilot, this would be LlamaCppAdapter or VLLMAdapter
const mockAdapter: LLMEngineAdapter = {
  async tokenize(text: string): Promise<number[]> {
    return text.split("").map((c) => c.charCodeAt(0));
  },
  async generate(prompt: string, options: any) {
    // Deterministic mock behavior for pilot UI testing
    const text = `[MOCK RESPONSE] 
I have analyzed your request: "${prompt.substring(0, 50)}...".
Based on the current manifest (Temperature: ${options.temperature}), 
the corporate response is ready. 
{ "status": "approved", "compliance": true }`;
    
    return {
      text,
      usage: { input: 0, output: text.length / 4 }
    };
  }
};

// --- EXECUTION ENDPOINT ---
app.post("/execute", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ ok: false, error: "Invalid prompt" });
  }

  const correlationId = `zak-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    // 1. Compile Context
    const manifest = ZAKCompiler.compileContext(sigils, prompt);

    // 2. Execute via Runner
    const result = await ZAKRunner.execute(mockAdapter, manifest, prompt, correlationId);

    // 3. Return sanitized result
    if (result.ok) {
      res.json({ ok: true, result: result.result });
    } else {
      res.json({ ok: false, refusal: result.refusal });
    }
  } catch (error) {
    console.error(`[SYSTEM ERROR] ${correlationId}:`, error);
    res.status(500).json({ ok: false, error: "Internal kernel error" });
  }
});

app.listen(PORT, () => {
  console.log(`=== ZAK PILOT UI SERVER STARTING ===`);
  console.log(`Endpoint: http://localhost:${PORT}`);
  console.log(`Mode: Deterministic / Zero-Memory`);
});

