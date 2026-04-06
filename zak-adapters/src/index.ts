import { startHttpAdapter, HttpZakAdapter } from "./adapters/http";
import { SentryZakAdapter } from "./adapters/sentry";
import type { KernelRuntime, ExecutionEnvelope, KernelResult } from "./contracts/kernel";
import { ProxyKernelClient } from "./proxy";

// Re-export adapters for library usage
export { HttpZakAdapter } from "./adapters/http";
export { SentryZakAdapter } from "./adapters/sentry";
export { KERNEL_CONNECTION_LOST, ProxyKernelClient } from "./proxy";

// --- MOCK KERNEL RUNTIME FOR PILOT ---
// In a real deployment, the actual Kernel instance is injected here.
// For the standalone adapter pilot, we use a compliant mock that demonstrates
// the interface without importing the sovereign core.
const mockKernel: KernelRuntime = {
  execute: async <I, O>(envelope: ExecutionEnvelope<I, O>): Promise<KernelResult<O>> => {
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 10));

    // Return a dummy result
    return {
      outcome: "success",
      digest: {
        nonceHash: "mock-nonce-hash-1234",
        routePlanHash: "mock-route-hash-5678"
      },
      output: { 
          msg: "Pilot Execution Successful", 
          receivedPayload: envelope.payload 
      } as O
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
  return new ProxyKernelClient(mockKernel, routing);
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
