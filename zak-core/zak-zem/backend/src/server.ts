import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { getSystemStats } from './system-stats';
import { KernelBridge } from './kernel-bridge';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// --- MOCK ADAPTER FOR ZEM ---
const mockAdapter = {
  async tokenize(text: string) { return text.split('').map(c => c.charCodeAt(0)); },
  async generate(prompt: string, options: any) {
    return { 
      text: `[ZEM SIMULATION] Response to: ${prompt}`,
      usage: { input: 10, output: 20 }
    };
  }
};

// --- API ENDPOINTS ---

app.get('/api/system/status', (req, res) => {
  res.json(getSystemStats());
});

app.post('/api/system/halt', (req, res) => {
  KernelBridge.halt();
  res.json({ status: 'halted' });
});

app.get('/api/sigils', (req, res) => {
  res.json(KernelBridge.getActiveSigils());
});

app.post('/api/sigils/upload', (req, res) => {
  const sigil = req.body;
  const validation = KernelBridge.validateSigil(sigil);
  if (validation.valid) {
    res.json({ ok: true, message: 'Sigil Validated' });
  } else {
    res.status(400).json({ ok: false, error: validation.reason });
  }
});

app.post('/api/execute', async (req, res) => {
  const { prompt } = req.body;
  const data = await KernelBridge.executeQuery(prompt, mockAdapter);
  res.json(data);
});

// --- WEBSOCKET TELEMETRY ---

io.on('connection', (socket) => {
  console.log('ZEM: UI Connected');
  
  const statsInterval = setInterval(() => {
    socket.emit('telemetry', getSystemStats());
  }, 1000);

  socket.on('disconnect', () => {
    clearInterval(statsInterval);
  });
});

const PORT = 3001;
KernelBridge.loadInitialSigils().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`ZEM Backend running on http://localhost:${PORT}`);
  });
});

