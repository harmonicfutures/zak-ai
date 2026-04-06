# ZAK Ingress Sentry (eBPF)

> **CRITICAL ARCHITECTURAL BOUNDARY**: This directory contains ONLY the Rust/eBPF ingress kernel. Application adapters live at the repository root under `src/adapters`.

This is the high-performance XDP filter for the Zero Asset Kernel (ZAK). It drops malformed packets at the NIC driver level before they reach the OS network stack.

## Prerequisites

- Rust (nightly recommended for eBPF)
- `bpf-linker`: `cargo install bpf-linker`
- Linux Kernel 5.10+ (for XDP support)

## Build Sequence

### 1. Build the Kernel (Sentry)
This compiles the eBPF bytecode.

```bash
cd zak-sentry-ebpf
cargo build --release --target=bpfel-unknown-none -Z build-std=core
```

### 2. Build the User Loader
This compiles the userspace application that loads the eBPF program.

```bash
cd ../zak-sentry-user
cargo build --release
```

## Running the Sentry

The sentry requires `sudo` / `root` privileges to attach XDP programs to network interfaces.

```bash
# Replace 'lo' with your target interface (e.g., eth0)
sudo ../target/release/zak-sentry-loader --iface lo
```

## Verification (Pulse Test)

Use the provided Python script to emit raw UDP pulses that simulate ZAK signals.

```bash
# In a separate terminal
python3 pulse_test.py
```

- **Resonant Pulse**: Correct size (64b) and Magic ID. Sentry should log "Valid ZAK Keep-Alive".
- **Dissonant Pulse**: Invalid size or Magic. Sentry should log "Dropping".

## Line-Rate Benchmarking

To prove that the ZAK reject-path runs at NIC line rate, follow these protocols:

### 1. Userspace Micro-Benchmark
Verify the raw logic speed in userspace (simulated).
```bash
cd zak-sentry-user
cargo run --release -- --bench
```
*Target: >100 Million PPS per core.*

### 2. Kernel-Space Latency (bpftool)
Measure the actual execution time of the eBPF program in the kernel.
```bash
# Get the ID of the loaded zak_ingress program
sudo bpftool prog list

# Profile the program (requires kernel support)
sudo bpftool prog profile id <PROG_ID> run
```
*Target: Average run-time < 50ns.*

### 3. NIC Line-Rate Drop Test
Using a packet generator (like `pktgen` or `moongen`) on a sibling machine, flood the interface.
```bash
# Monitor drop rate on the interface
watch -n 1 "ip -s link show <INTERFACE>"
```
*Observation: The `rx_dropped` count should increment at the same rate as the incoming packet flood with near-zero CPU impact.*
