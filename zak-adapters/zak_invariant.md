# ZAK Invariant Contract

The ZAK (Zero-Allocation Keep-Alive) logic is designed for extremely high-performance packet filtering and validation. Its core contract is defined by a strict set of invariants and limitations, ensuring predictable and efficient operation, particularly in kernel-level or embedded environments.

## Invariant Constraints

1.  **Input is a Fixed-Size Packet (64 bytes):** ZAK operates exclusively on network packets of a precise, predefined length of 64 bytes. Any deviation from this size results in immediate rejection.

2.  **Validation Must Be Stateless:** The `analyze_packet` function (or equivalent logic) relies solely on the current packet's contents. It does not maintain or depend on any prior state, global variables, or external context between packet validations.

3.  **Validation Must Be Deterministic:** Given the same input packet, the `analyze_packet` function will always produce the exact same output (pass or fail). There is no randomness, time-dependency, or external influence on the validation outcome.

4.  **No Heap Allocation on Reject Path:** When a packet is determined to be invalid, the processing path must explicitly avoid any dynamic memory allocation (e.g., `malloc`, `new`). This ensures minimal latency and avoids potential memory pressure or fragmentation in critical performance paths.

5.  **Reject Path Must Return No Response:** Upon rejecting a packet, the ZAK logic simply ceases processing or drops the packet. It does not generate error messages, logs, or any other form of explicit response to the sender. This design prevents denial-of-service attacks based on generating error responses.

6.  **Accept Path Only Signals Pass/Fail, No Side Effects:** When a packet is deemed valid, the ZAK logic's only direct output is a simple pass/fail signal. It does not modify the packet, interact with external systems, update internal state (beyond temporary CPU registers), or initiate any other side effects.

## What ZAK Will NEVER Do

ZAK is intentionally constrained to a very narrow purpose to maximize its efficiency and predictability. Therefore, ZAK will **NEVER** perform the following functions:

*   **No Identity Parsing or Management:** ZAK does not process user identities, authenticate users, or manage any form of identity tokens.
*   **No Cryptographic Negotiation or Encryption:** ZAK is not involved in establishing secure connections, encrypting data, or performing any cryptographic operations.
*   **No Session State Management:** ZAK does not track or maintain information about network sessions, connections, or user activity over time.
*   **No Protocol Deep Packet Inspection (beyond ZAK header):** While it inspects a fixed part of the packet for the Magic ID, it does not perform deep analysis of higher-layer protocols (e.g., TCP, UDP, HTTP headers or payloads).
*   **No Dynamic Rule Updates:** ZAK's validation logic is static and not designed for runtime modification of its rules or parameters.