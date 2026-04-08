import { startHttpAdapter, HttpZakAdapter } from "./adapters/http";
import { SentryZakAdapter } from "./adapters/sentry";
import type { KernelRuntime, ExecutionEnvelope, KernelResult } from "./contracts/kernel";
import { ProxyKernelClient } from "./proxy";

// Re-export adapters for library usage
export { HttpZakAdapter } from "./adapters/http";
export { SentryZakAdapter } from "./adapters/sentry";
export { KERNEL_CONNECTION_LOST, ProxyKernelClient } from "./proxy";

// Fail closed when the constitutional proxy is unavailable. The browser/host shell
// must not silently downgrade to a mock runtime and pretend execution happened.
const unavailableKernel: KernelRuntime = {
  execute: async <I, O>(envelope: ExecutionEnvelope<I, O>): Promise<KernelResult<O>> => {
    return {
      outcome: "denied",
      error:
        "Constitutional proxy runtime is unavailable. Set ZAK_PROXY_PORT and related proxy env before executing capabilities.",
      output: {
        intentId: envelope.intentId,
        receivedPayload: envelope.payload,
      } as O,
    };
  }
};

function kernelRuntimeForAdapterType(adapterType: string): KernelRuntime {
  /** Red-team / CI: orchestrator sets ``ZAK_NEGATIVE_EDGE_TEST=1`` to force an allowlist deny. */
  const negativeTest = process.env.ZAK_NEGATIVE_EDGE_TEST === "1";
  const routing =
    adapterType === "sentry"
      ? {
          fromModule: negativeTest
            ? "evil/not-in-dependency-map"
            : "adapters/sentry/adapter",
          toModule: "kernel/runner",
        }
      : {
          fromModule: negativeTest
            ? "evil/not-in-dependency-map"
            : "adapters/http/adapter",
          toModule: "kernel/runner",
        };
  return new ProxyKernelClient(unavailableKernel, routing);
}

// --- STARTUP LOGIC ---
/**
 * The Pilot can run in different modes depending on the deployment target.
 */
const ADAPTER_TYPE = process.env.ADAPTER_TYPE || "http";

function bootstrap() {
    console.log(`Starting ZAK Adapter: ${ADAPTER_TYPE}`);
    if (ProxyKernelClient.isProxyEnabled()) {
      console.log("Proxy enabled");
      console.log(
        `ZAK proxy enabled: ${process.env.ZAK_PROXY_HOST || "127.0.0.1"}:${process.env.ZAK_PROXY_PORT}`
      );
    }

    const kernel = kernelRuntimeForAdapterType(ADAPTER_TYPE);

    if (ADAPTER_TYPE === "http") {
        const adapter = new HttpZakAdapter(kernel);
        const PORT = Number(process.env.PORT) || 8080;
        startHttpAdapter(adapter, PORT);
    } 
    
    if (ADAPTER_TYPE === "sentry") {
        const adapter = new SentryZakAdapter(kernel);
        console.log("ZAK Ingress Sentry (XDP) Adapter active.");
        console.log("Mitigating Signaling Storms via high-performance packet filtering.");
        // In a real XDP environment, this would initialize the eBPF loader.
    }
}

// Only bootstrap if run directly (not as a module)
if (require.main === module) {
    bootstrap();
}
