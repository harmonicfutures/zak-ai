import struct
import timeit

# --- THE ZAK BRAIN (Replicating your Rust Logic) ---
def analyze_packet(packet: bytes) -> bool:
    # 1. Size Check (Must be exactly 64 bytes)
    if len(packet) != 64:
        return False

    # 2. Skip Ethernet Header (14 bytes)
    if len(packet) < 18: 
        return False

    # 3. Magic ID Check (0x5A414B00)
    magic_val = struct.unpack(">I", packet[14:18])[0]
    
    if magic_val == 0x5A414B00: # "ZAK\0"
        return True
    else:
        return False

# --- BENCHMARK CONFIGURATION ---
NUM_ITERATIONS = 1_000_000 # Run 1 million times for each scenario
PACKET_SIZE = 64 # bytes

# --- TEST PACKETS ---
# 14 bytes of padding (Ethernet) + "ZAK\0" + 46 bytes of padding
VALID_PACKET = b'\x00'*14 + b'\x5A\x41\x4B\x00' + b'\x00'*46
# 14 bytes padding + "DEAD" + 46 bytes padding
INVALID_MAGIC_PACKET = b'\x00'*14 + b'\xDE\xAD\xBE\xEF' + b'\x00'*46

def run_benchmark():
    print("--- STARTING ZAK LOGIC BENCHMARK ---\n")

    # Scenario 1: Best Case (Valid Packet)
    print(f"Benchmarking Best Case (Valid Packet) - {NUM_ITERATIONS:,} iterations...")
    best_case_time = timeit.timeit(
        "analyze_packet(VALID_PACKET)",
        globals=globals(),
        number=NUM_ITERATIONS
    )
    best_case_pps = NUM_ITERATIONS / best_case_time
    best_case_gbps = (best_case_pps * PACKET_SIZE * 8) / 1_000_000_000
    print(f"  Best Case PPS: {best_case_pps:,.0f}")
    print(f"  Theoretical Throughput: {best_case_gbps:.2f} Gbps\n")

    # Scenario 2: Worst Case (Invalid Magic)
    print(f"Benchmarking Worst Case (Invalid Magic) - {NUM_ITERATIONS:,} iterations...")
    worst_case_time = timeit.timeit(
        "analyze_packet(INVALID_MAGIC_PACKET)",
        globals=globals(),
        number=NUM_ITERATIONS
    )
    worst_case_pps = NUM_ITERATIONS / worst_case_time
    worst_case_gbps = (worst_case_pps * PACKET_SIZE * 8) / 1_000_000_000
    print(f"  Worst Case PPS: {worst_case_pps:,.0f}")
    print(f"  Theoretical Throughput: {worst_case_gbps:.2f} Gbps\n")

    print("--- BENCHMARK COMPLETE ---")

if __name__ == "__main__":
    run_benchmark()
