import React from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useZEMStore } from '../store';

const AuditTerminal: React.FC = () => {
  const { logs } = useZEMStore();

  return (
    <div className="bg-black border border-slate-800 rounded-lg flex flex-col h-full overflow-hidden">
      <div className="p-2 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
        <span className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-2">
          <ShieldCheck size={12} /> Audit Stream
        </span>
        <span className="text-[10px] text-zak-red animate-pulse">LIVE</span>
      </div>
      
      <div className="flex-1 p-3 overflow-y-auto font-mono text-[11px] flex flex-col gap-2 terminal-scroll">
        {logs.length === 0 && <div className="text-slate-700 italic">Listening for kernel events...</div>}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2">
            <span className="text-slate-600">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
            <span className={log.type === 'success' ? 'text-zak-green' : 'text-zak-red'}>
              {log.type === 'success' ? 'RUN_COMPLETED' : 'RUN_REFUSED'}
            </span>
            <span className="text-slate-400">|</span>
            <span className="text-slate-300 truncate">{log.message}</span>
          </div>
        ))}
      </div>

      <div className="p-2 border-t border-slate-800 bg-zak-panel/20 text-[10px] flex justify-between">
        <span className="text-slate-500">THREATS BLOCKED TODAY: <span className="text-zak-red font-bold">14</span></span>
        <span className="text-slate-500">KERNEL_HASH: ee3607e1...</span>
      </div>
    </div>
  );
};

export default AuditTerminal;

