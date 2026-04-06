import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { LayoutDashboard, Beaker, Power, ShieldCheck } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Workbench from './pages/Workbench';
import { useZEMStore } from './store';

const socket = io('http://localhost:3001');

const App: React.FC = () => {
  const { isHalted, activeTab, setActiveTab, setHalted } = useZEMStore();
  const [telemetry, setTelemetry] = useState<any>(null);

  useEffect(() => {
    socket.on('telemetry', (data) => setTelemetry(data));
    return () => { socket.off('telemetry'); };
  }, []);

  const handleHalt = async () => {
    if (confirm('CRITICAL: HALT SYSTEM? This will kill the kernel process.')) {
      await fetch('http://localhost:3001/api/system/halt', { method: 'POST' });
      setHalted(true);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="h-16 border-b border-slate-800 bg-zak-panel flex items-center px-6 justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${isHalted ? 'bg-zak-red animate-pulse' : 'bg-zak-green'}`} />
            <span className="font-bold tracking-tighter text-lg">ZAK KERNEL v1.0.1 (GOLD)</span>
          </div>
          <div className="h-6 w-px bg-slate-700" />
          <div className="text-xs text-slate-400">
            REPATRIATION INDEX: <span className="text-zak-green">100%</span>
          </div>
        </div>

        <nav className="flex gap-1 bg-black/40 p-1 rounded-lg border border-slate-800">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md transition-all ${activeTab === 'dashboard' ? 'bg-zak-panel text-zak-green' : 'text-slate-400 hover:text-white'}`}
          >
            <LayoutDashboard size={16} /> DASHBOARD
          </button>
          <button 
            onClick={() => setActiveTab('workbench')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md transition-all ${activeTab === 'workbench' ? 'bg-zak-panel text-zak-amber' : 'text-slate-400 hover:text-white'}`}
          >
            <Beaker size={16} /> WORKBENCH
          </button>
        </nav>

        <button 
          onClick={handleHalt}
          className="flex items-center gap-2 bg-zak-red/10 text-zak-red border border-zak-red/50 px-4 py-2 rounded hover:bg-zak-red hover:text-white transition-all font-bold"
        >
          <Power size={18} /> HALT SYSTEM
        </button>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6 overflow-hidden">
        {activeTab === 'dashboard' ? <Dashboard telemetry={telemetry} /> : <Workbench />}
      </main>
    </div>
  );
};

export default App;

