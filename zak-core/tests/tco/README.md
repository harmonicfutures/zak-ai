# ZAK TCO & Energy Instrumentation

This module provides mechanical proof of the economic advantage of local ZAK deployment vs. Cloud LLM providers.

## How to use

1. Run a sample workload via the ZAK Runner.
2. Execute the TCO calculator:
   ```bash
   python tests/tco/watt_calculator.py
   ```

## Metrics Tracked

- **Watt Draw**: Real-time power consumption during inference.
- **KWh**: Energy consumed per request.
- **TCO per 1M Tokens**: The final economic metric compared against cloud pricing (e.g., GPT-4o).

## Why this matters

By proving a cost of <$0.50 per 1M tokens (electricity only), ZAK eliminates the variable-cost risk of cloud scaling.

