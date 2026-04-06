import React from 'react';
import { Shield, Lock, Activity } from 'lucide-react';

interface Props {
  sigil: any;
}

const SigilCard: React.FC<Props> = ({ sigil }) => {
  const isRoot = sigil.meta.id.includes('root');

  return (
    <div className={`p-4 rounded border ${isRoot ? 'border-zak-green/30 bg-zak-green/5' : 'border-slate-800 bg-zak-panel/30'} flex flex-col gap-3`}>
      <div className="flex justify-between items-start">
        <div className="flex flex-col">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-tighter">
            {isRoot ? 'ROOT CONTRACT' : 'TASK CONTRACT'}
          </span>
          <span className={`text-sm font-bold ${isRoot ? 'text-zak-green' : 'text-white'}`}>{sigil.meta.id}</span>
        </div>
        {isRoot ? <Lock size={16} className="text-zak-green" /> : <Activity size={16} className="text-zak-amber" />}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div className="flex flex-col">
          <span className="text-slate-600">TOPOLOGY</span>
          <span className="text-white uppercase">{sigil.body.geometry.topology}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-600">RESONANCE</span>
          <span className="text-white">{sigil.body.resonance.base_frequency}Hz</span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-600">ROUGHNESS</span>
          <span className="text-white">{sigil.body.material.roughness}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-600">VERSION</span>
          <span className="text-white">v{sigil.meta.version}</span>
        </div>
      </div>
    </div>
  );
};

export default SigilCard;

