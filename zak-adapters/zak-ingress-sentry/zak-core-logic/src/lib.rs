pub fn analyze_packet(packet: &[u8]) -> bool {
    const MAGIC_ID: u32 = 0x5A414B00;
    const ZAK_SIZE: usize = 64;

    if packet.len() != ZAK_SIZE {
        return false;
    }

    if packet.len() < 4 {
        return false; // Not enough bytes for magic ID
    }

    let magic_bytes: [u8; 4] = [packet[0], packet[1], packet[2], packet[3]];
    let received_magic = u32::from_be_bytes(magic_bytes);

    if received_magic != MAGIC_ID {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_pulse() {
        let mut packet = [0u8; 64];
        // Simulate MAGIC_ID = 0x5A414B00
        packet[0] = 0x5A;
        packet[1] = 0x41;
        packet[2] = 0x4B;
        packet[3] = 0x00;
        assert_eq!(analyze_packet(&packet), true);
    }

    #[test]
    fn test_invalid_size() {
        let packet = [0u8; 65]; // Incorrect size
        assert_eq!(analyze_packet(&packet), false);
    }

    #[test]
    fn test_invalid_magic() {
        let mut packet = [0u8; 64];
        // Simulate wrong MAGIC_ID = 0xDEADBEEF
        packet[0] = 0xDE;
        packet[1] = 0xAD;
        packet[2] = 0xBE;
        packet[3] = 0xEF;
        assert_eq!(analyze_packet(&packet), false);
    }
}