import socket
import struct
import time

# CONFIG
TARGET_IP = "127.0.0.1" # Change to target machine IP if testing across network
TARGET_PORT = 8080      # Port doesn't matter for XDP, but needed for socket
MAGIC_ID = 0x5A414B00
ZAK_SIZE = 64

def send_pulse(is_resonant=True):
    # Create a raw UDP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    
    if is_resonant:
        print(f"[*] Sending RESONANT Pulse ({ZAK_SIZE} bytes)...")
        # Structure: Magic (4) + Timestamp (8) + Padding (52) = 64 bytes
        # !I = Big Endian Unsigned Int (Matches u32::from_be_bytes in Rust)
        payload = struct.pack("!I", MAGIC_ID) + b'\x00' * 60
    else:
        print(f"[*] Sending DISSONANT Pulse (Bad Size/Magic)...")
        # Wrong magic, wrong size
        payload = b'\xDE\xAD\xBE\xEF' * 2

    try:
        sock.sendto(payload, (TARGET_IP, TARGET_PORT))
        print(" -> Pulse Emitted.")
    except Exception as e:
        print(f" -> Error: {e}")

if __name__ == "__main__":
    # 1. Send a Good Pulse (Should see "Valid ZAK Keep-Alive" in Loader logs)
    send_pulse(is_resonant=True)
    
    time.sleep(1)
    
    # 2. Send a Bad Pulse (Should see "Dropping" in Loader logs)
    send_pulse(is_resonant=False)

