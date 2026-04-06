#![no_std]
#![no_main]

use aya_bpf::{
    macros::xdp,
    bindings::xdp_action,
    programs::XdpContext,
};
use aya_log_ebpf::info;
use zak_core_logic;

#[xdp]
pub fn zak_ingress(ctx: XdpContext) -> u32 {
    match try_zak_ingress(ctx) {
        Ok(ret) => ret,
        Err(_) => xdp_action::XDP_ABORTED,
    }
}

const ZAK_PAYLOAD_LEN: usize = 64;
const ETH_OFFSET: usize = 14;
const UDP_OFFSET: usize = 14 + 20 + 8; // Eth + IP + UDP

fn try_zak_ingress(ctx: XdpContext) -> Result<u32, u32> {
    let data = ctx.data();
    let data_end = ctx.data_end();

    // 1. Try UDP-encapsulated ZAK payload (Offset 42)
    if let Some(payload) = extract_payload(data, data_end, UDP_OFFSET) {
        if zak_core_logic::analyze_packet(payload) {
            info!(&ctx, "ZAK Sentry: Valid UDP Signal. Passing.");
            return Ok(xdp_action::XDP_PASS);
        }
    }

    // 2. Try Ethernet-only ZAK payload (Offset 14)
    if let Some(payload) = extract_payload(data, data_end, ETH_OFFSET) {
        if zak_core_logic::analyze_packet(payload) {
            info!(&ctx, "ZAK Sentry: Valid L2 Signal. Passing.");
            return Ok(xdp_action::XDP_PASS);
        }
    }

    // Default: If it's not a valid ZAK packet at known offsets, drop it.
    // This follows the strict Zero Access Kernel (ZAK) invariant.
    info!(&ctx, "ZAK Sentry: No valid ZAK signal found. Dropping.");
    Ok(xdp_action::XDP_DROP)
}

#[inline(always)]
fn extract_payload<'a>(data: usize, data_end: usize, offset: usize) -> Option<&'a [u8]> {
    if data + offset + ZAK_PAYLOAD_LEN <= data_end {
        Some(unsafe { core::slice::from_raw_parts((data + offset) as *const u8, ZAK_PAYLOAD_LEN) })
    } else {
        None
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { core::hint::unreachable_unchecked() }
}
