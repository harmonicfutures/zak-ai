# Draft test harness

Requires **Node.js 18+**. Check: `node --version`

If you see `SyntaxError: Unexpected identifier` on `import`, or registry build dies in `fdir`, you are on an old Node (e.g. 10.x). Install Node 20 LTS, then:

```bash
cd ../capability-registry && npm run build
cd ../draft-test-harness && npm install && npm start
```

Open http://localhost:3000/
