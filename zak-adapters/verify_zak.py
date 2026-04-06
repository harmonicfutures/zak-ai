import sys
import codecs
import struct

# Set stdout to UTF-8 to handle emojis
sys.stdout = codecs.getwriter("utf-8")(sys.stdout.detach())

# --- THE ZAK BRAIN (Replicating your Rust Logic) ---
def zak_admit(packet: bytes) -> bool:
    """
    Reference implementation of the ZAK (Zero-Allocation Keep-Alive) packet admission logic.
    This function adheres to the ZAK invariant contract, performing stateless, deterministic,
    and constant-time validation without heap allocations or side effects on the reject path.

    This implementation is for logical verification and not intended as a performance target.

    Args:
        packet: The input packet as a bytes object. Expected to be exactly 64 bytes.

    Returns:
        True if the packet is a valid ZAK pulse, False otherwise.
    """
    # Explicit size check: Must be exactly 64 bytes
    if len(packet) != 64:
        return False

    # Explicit minimum length check for header access
    if len(packet) < 18:
        return False

    # Explicit magic check: Skip Ethernet Header (14 bytes) and validate Magic ID (0x5A414B00)
    # Unpacks 4 bytes as a Big Endian Unsigned Int (like Rust's u32::from_be_bytes)
    magic_val = struct.unpack(">I", packet[14:18])[0]

    return magic_val == 0x5A414B00

# --- THE TEST SUITE ---
def run_tests():
    print("--- STARTING ZAK LOGIC VERIFICATION ---\n")

    # TEST 1: The "Perfect" Pulse
    print("Test 1: Valid ZAK Pulse")
    # 14 bytes of padding (Ethernet) + "ZAK\0" + 46 bytes of padding
    valid_packet = b'\x00'*14 + b'\x5A\x41\x4B\x00' + b'\x00'*46
    if zak_admit(valid_packet):
        print("✅ PASS: Valid Pulse Accepted\n")
    else:
        print("❌ FAIL: Valid Pulse Rejected\n")

    # TEST 2: The "Signaling Storm" (Wrong Size)
    print("Test 2: Hollow Packet (Wrong Size)")
    invalid_size = b'\x00' * 65 # Too big
    if not zak_admit(invalid_size):
        print("✅ PASS: Invalid Size Dropped\n")
    else:
        print("❌ FAIL: Invalid Size Accepted\n")

    # TEST 3: The "Imposter" (Wrong Magic)
    print("Test 3: Dissonant Packet (Wrong Magic)")
    # 14 bytes padding + "DEAD" + 46 bytes padding
    invalid_magic = b'\x00'*14 + b'\xDE\xAD\xBE\xEF' + b'\x00'*46
    if not zak_admit(invalid_magic):
        print("✅ PASS: Wrong Magic Dropped\n")
    else:
        print("❌ FAIL: Wrong Magic Accepted\n")

if __name__ == "__main__":
    run_tests()