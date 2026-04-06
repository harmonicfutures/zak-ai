use anyhow::Context;
use aya::programs::{Xdp, XdpFlags};
use aya::{include_bytes_aligned, Ebpf};
use aya_log::EbpfLogger;
use clap::Parser;
use log::{info, warn};
use tokio::signal;
use std::time::Instant;
use zak_core_logic;

#[derive(Debug, Parser)]
struct Opt {
    #[clap(short, long, default_value = "eth0")]
    iface: String,

    #[clap(short, long)]
    bench: bool,
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let opt = Opt::parse();

    env_logger::init();

    if opt.bench {
        run_userspace_benchmark();
        return Ok(());
    }

    // Bump RLIMIT_MEMLOCK to allow BPF programs to load maps and programs.
    if let Err(e) = rlimit::setrlimit(rlimit::Resource::MEMLOCK, rlimit::INFINITY, rlimit::INFINITY) {
        warn!("remove limit on locked memory failed, load may fail: {}", e);
    }

    #[cfg(debug_assertions)]
    let mut bpf = Ebpf::load(include_bytes_aligned!(
        "../../target/bpfel-unknown-none/debug/zak-sentry"
    ))?;
    #[cfg(not(debug_assertions))]
    let mut bpf = Ebpf::load(include_bytes_aligned!(
        "../../target/bpfel-unknown-none/release/zak-sentry"
    ))?;

    if let Err(e) = EbpfLogger::init(&mut bpf) {
        warn!("failed to initialize eBPF logger: {}", e);
    }

    let program: &mut Xdp = bpf.program_mut("zak_ingress").context("program not found")?.try_into()?;
    program.load()?;
    
    program.attach(&opt.iface, XdpFlags::default())
        .context(format!("failed to attach xdp program to interface: {}", opt.iface))?;

    info!("ZAK Sentry Loader active on interface: {}", opt.iface);
    info!("Waiting for Ctrl+C...");

    signal::ctrl_c().await.context("failed to listen for event")?;

    info!("Exiting...");

    Ok(())
}

fn run_userspace_benchmark() {
    const ITERATIONS: u64 = 10_000_000;
    let mut packet = [0u8; 64];
    packet[0] = 0xDE; // Invalid Magic (The "Cheap No" path)
    packet[1] = 0xAD;
    packet[2] = 0xBE;
    packet[3] = 0xEF;

    println!("--- ZAK USERSPACE LOGIC BENCHMARK ---");
    println!("Benchmarking 'Cheap No' (Reject Path) for {} iterations...", ITERATIONS);

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let _ = zak_core_logic::analyze_packet(core::hint::black_box(&packet));
    }
    let duration = start.elapsed();
    
    let pps = (ITERATIONS as f64) / duration.as_secs_f64();
    let nanosec_per_op = duration.as_nanos() as f64 / ITERATIONS as f64;

    println!("  Total Time:   {:?}", duration);
    println!("  Average Time: {:.2} ns/op", nanosec_per_op);
    println!("  Throughput:   {:.2} Million PPS", pps / 1_000_000.0);
    println!("--------------------------------------");
}
