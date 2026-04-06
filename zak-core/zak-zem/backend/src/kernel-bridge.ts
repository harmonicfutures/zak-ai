import fs from 'fs';
import path from 'path';
import { ZAKValidator } from '../../../src/kernel/validator';
import { ZAKCompiler } from '../../../src/kernel/compiler';
import { ZAKRunner, LLMEngineAdapter } from '../../../src/kernel/runner';

const SIGIL_DIR = path.join(__dirname, '../../../sigils/root');

export class KernelBridge {
  private static activeSigils: any[] = [];

  static async loadInitialSigils() {
    const rootPath = path.join(SIGIL_DIR, 'corp.root.v1.json');
    if (fs.existsSync(rootPath)) {
      const sigil = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
      this.activeSigils = [sigil];
      console.log('ZEM: Loaded root sigil.');
    }
  }

  static getActiveSigils() {
    return this.activeSigils;
  }

  static validateSigil(sigil: any) {
    return ZAKValidator.validate(sigil);
  }

  static async executeQuery(prompt: string, adapter: LLMEngineAdapter) {
    const correlationId = `zem-${Date.now()}`;
    const manifest = ZAKCompiler.compileContext(this.activeSigils, prompt);
    const result = await ZAKRunner.execute(adapter, manifest, prompt, correlationId);
    return { result, manifest };
  }

  static halt() {
    console.log('ZEM: KILL SWITCH ENGAGED. HALTING SYSTEM.');
    process.exit(0);
  }
}

