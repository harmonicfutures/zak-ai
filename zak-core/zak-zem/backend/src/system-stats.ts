export interface SystemStats {
  gpu: {
    load: number;
    vram_used: number;
    vram_total: number;
    power_draw: number;
    temp: number;
  };
  kernel: {
    status: 'active' | 'stopped';
    repatriation_index: number;
    threats_blocked_today: number;
  };
}

export function getSystemStats(): SystemStats {
  // In a real environment, this would run nvidia-smi and parse the output
  // For the pilot, we simulate realistic telemetry within safety bands.
  return {
    gpu: {
      load: Math.floor(Math.random() * 20) + 10, // 10-30% idle
      vram_used: 12,
      vram_total: 24,
      power_draw: Math.floor(Math.random() * 50) + 150, // 150-200W
      temp: Math.floor(Math.random() * 5) + 60, // 60-65C
    },
    kernel: {
      status: 'active',
      repatriation_index: 100,
      threats_blocked_today: 14,
    }
  };
}

