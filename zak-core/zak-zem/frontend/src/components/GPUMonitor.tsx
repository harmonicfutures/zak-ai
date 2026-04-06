import React from 'react';
import { Gauge, Zap, Thermometer, Database } from 'lucide-react';

interface Props {
  data: any;
}

const GPUMonitor: React.FC<Props> = ({ data }) => {
  if (!data) return <div className="animate-pulse bg-slate-800 h-64 rounded border border-slate-700" />;

  const { gpu } = data;

  return (
    <div className="bg-black/20 border border-slate-800 p-4 rounded-lg flex flex-col gap-6">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest border-b border-slate-800 pb-2 flex items-center gap-2">
        <Gauge size={14} /> Hardware Physics
      </h3>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="p-3 bg-zak-panel/50 border border-slate-800 rounded">
          <div className="text-[10px] text-slate-500 mb-1 flex items-center gap-1"><Zap size={10}/> GPU LOAD</div>
          <div className="text-2xl font-bold text-zak-green">{gpu.load}%</div>
          <div className="w-full bg-slate-800 h-1 mt-2 rounded-full overflow-hidden">
            <div className="bg-zak-green h-full" style={{ width: `${gpu.load}%` }} />
          </div>
        </div>

        <div className="p-3 bg-zak-panel/50 border border-slate-800 rounded">
          <div className="text-[10px] text-slate-500 mb-1 flex items-center gap-1"><Database size={10}/> VRAM</div>
          <div className="text-2xl font-bold text-zak-amber">{gpu.vram_used}GB <span className="text-sm text-slate-600">/ {gpu.vram_total}GB</span></div>
        </div>

        <div className="p-3 bg-zak-panel/50 border border-slate-800 rounded">
          <div className="text-[10px] text-slate-500 mb-1">POWER DRAW</div>
          <div className="text-2xl font-bold text-white">{gpu.power_draw}W</div>
        </div>

        <div className="p-3 bg-zak-panel/50 border border-slate-800 rounded">
          <div className="text-[10px] text-slate-500 mb-1 flex items-center gap-1"><Thermometer size={10}/> CORE TEMP</div>
          <div className="text-2xl font-bold text-zak-red">{gpu.temp}°C</div>
        </div>
      </div>
    </div>
  );
};

export default GPUMonitor;

