# Draft test harness

Requires **Node.js 18+**. Check: `node --version`

If you see `SyntaxError: Unexpected identifier` on `import`, or registry build dies in `fdir`, you are on an old Node (e.g. 10.x). Install Node 20 LTS, then:

```bash
cd ../capability-registry && npm run build
cd ../draft-test-harness && npm install && npm start
```

Open http://localhost:3000/

## LLM: OpenAI vs OpenRouter

- **OpenRouter (good for free/test):** set `OPENROUTER_API_KEY` in `ZAKAI/.env` **or** `draft-test-harness/.env` (harness file overrides the root on duplicate keys). Or copy `sample.env` → `.env`. Default model: `openrouter/free`.
- **OpenAI:** leave `OPENROUTER_API_KEY` unset and set `OPENAI_API_KEY` (Responses API for JSON where supported).

`dotenv` loads `.env` automatically when you `npm start` / `node server.js`.
