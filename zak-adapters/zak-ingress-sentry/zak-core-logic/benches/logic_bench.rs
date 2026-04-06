use criterion::{black_box, criterion_group, criterion_main, Criterion};
use zak_core_logic::analyze_packet;

fn bench_zak_logic(c: &Criterion) {
    let mut group = c.benchmark_group("ZAK Core Logic");
    
    // 64-byte payload with valid magic
    let mut valid_packet = [0u8; 64];
    valid_packet[0] = 0x5A;
    valid_packet[1] = 0x41;
    valid_packet[2] = 0x4B;
    valid_packet[3] = 0x00;

    // 64-byte payload with invalid magic (The "Cheap No")
    let mut invalid_magic = [0u8; 64];
    invalid_magic[0] = 0xDE;
    invalid_magic[1] = 0xAD;
    invalid_magic[2] = 0xBE;
    invalid_magic[3] = 0xEF;

    // Invalid size payload
    let invalid_size = [0u8; 32];

    group.bench_function("Accept Path (Valid Magic)", |b| {
        b.iter(|| analyze_packet(black_box(&valid_packet)))
    });

    group.bench_function("Reject Path (Invalid Magic)", |b| {
        b.iter(|| analyze_packet(black_box(&invalid_magic)))
    });

    group.bench_function("Reject Path (Invalid Size)", |b| {
        b.iter(|| analyze_packet(black_box(&invalid_size)))
    });

    group.finish();
}

criterion_group!(benches, bench_zak_logic);
criterion_main!(benches);

