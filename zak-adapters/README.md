# ZAK HTTP Pilot Adapter

This is the standard HTTP interface for piloting the Zero Asset Kernel (ZAK). It provides a stateless computation service that holds no customer data, stores nothing, requires no schema changes, and can be removed without residue.

## Repository Structure

The `zak-adapters` repository contains two parallel, decoupled systems:

### System A: Application Adapters (TypeScript/Node.js)
Located at the root of the repository.
- `src/adapters/`: Application-layer logic for bridging external protocols (HTTP, etc.) to the ZAK kernel.
- `src/index.ts`: Application entry point.
- `package.json`, `tsconfig.json`: Node.js project configuration.

### System B: Ingress Kernel (Rust/eBPF)
Located in the `zak-ingress-sentry/` directory.
- `zak-core-logic/`: The ONLY location for ZAK invariant logic.
- `zak-sentry-ebpf/`: eBPF/XDP kernel-space program.
- `zak-sentry-user/`: Userspace loader for the eBPF program.
- `Cargo.toml`: Rust workspace configuration.

**Note**: These systems are conceptually and technically distinct. The Ingress Kernel operates at the network driver level (L2/L3), while the Application Adapters operate at the application layer (L7).

## The Pilot Value Proposition

ZAK adapters are designed for "containment break" architecture. This adapter:
- **Holds No Data**: Payloads are processed in-memory and emitted immediately.
- **Stores Nothing**: No database connections, no file writes, no local logs.
- **Zero Residue**: Shutting down the container removes all traces of execution history.

## Security Posture

This adapter aligns with Zero Trust and strict procurement requirements:
- **No Inbound Auth**: Authentication is handled upstream (API Gateway / IAM).
- **No Outbound Calls**: The adapter does not reach out to external services.
- **No Long-Lived Memory**: Request context is destroyed immediately after response.
- **No PII Storage**: Personal data never lands on disk.

## Fintech & Regulated Use

This adapter is hardened for financial environments:
1. **Audit Traceability**: Structured JSON audit events are emitted to `stdout`. Logs are never buffered or stored locally.
2. **Correlation ID**: Enforced `X-Correlation-ID` header for end-to-end traceability. Auto-generated if missing.
3. **Numeric Precision**: Floating-point values (`number`) are **strictly rejected** at ingress to prevent precision errors. Monetary values must be provided as strings (decimals) or BigInts (minor units).

## API Surface

The adapter exposes a minimal surface area:

### `POST /zak/execute`
Executes a kernel intent.

**Headers:**
- `Content-Type: application/json`
- `X-Correlation-ID: <uuid>` (optional, generated if missing)

**Body:**
```json
{
  "intentId": "payment-123",
  "payload": {
    "amount": "100.00",
    "currency": "USD"
  }
}
```

**Response (200 OK):**
```json
{
  "outcome": "success",
  "digest": { ... },
  "output": { ... }
}
```

### `GET /zak/health`
Liveness check. Returns `200 OK`.

## Installation

### Option A: Docker (Recommended)
Best for platform teams. No volumes required.

```bash
docker build -t zak-http-adapter .
docker run -p 8080:8080 zak-http-adapter
```

### Option B: Node.js Binary
Best for VM/Bare-metal pilots.

```bash
npm install
npm run build
npm start
```

