import React from 'react';
import GPUMonitor from '../components/GPUMonitor';
import SigilCard from '../components/SigilCard';
import AuditTerminal from '../components/AuditTerminal';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Plus } from 'lucide-react';

interface Props {
  telemetry: any;
}

const Dashboard: React.FC<Props> = ({ telemetry }) => {
  const { data: sigils } = useQuery({
    queryKey: ['sigils'],
    queryFn: () => axios.get('http://localhost:3001/api/sigils').then(res => res.data)
  });

  return (
    <div className="h-full grid grid-cols-12 gap-6">
      {/* Col 1: Physics */}
      <div className="col-span-3 h-full">
        <GPUMonitor data={telemetry} />
      </div>

      {/* Col 2: The Law */}
      <div className="col-span-4 h-full flex flex-col gap-4">
        <div className="bg-black/20 border border-slate-800 p-4 rounded-lg flex flex-col gap-4 flex-1">
          <div className="flex justify-between items-center border-b border-slate-800 pb-2">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
              The Law (Sigils)
            </h3>
            <button className="text-[10px] bg-zak-amber text-black font-bold px-2 py-1 rounded flex items-center gap-1 hover:opacity-80 transition-all">
              <Plus size={10} /> INJECT SIGIL
            </button>
          </div>
          
          <div className="flex flex-col gap-3 overflow-y-auto">
            {sigils?.map((sigil: any) => (
              <SigilCard key={sigil.meta.id} sigil={sigil} />
            ))}
          </div>
        </div>
      </div>

      {/* Col 3: The Shield */}
      <div className="col-span-5 h-full">
        <AuditTerminal />
      </div>
    </div>
  );
};

export default Dashboard;

