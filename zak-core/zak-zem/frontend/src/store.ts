import { create } from 'zustand';

interface ZEMState {
  isHalted: boolean;
  activeTab: 'dashboard' | 'workbench';
  logs: Array<{ id: string; type: 'success' | 'refusal'; message: string; timestamp: number }>;
  setHalted: (halted: boolean) => void;
  setActiveTab: (tab: 'dashboard' | 'workbench') => void;
  addLog: (log: { type: 'success' | 'refusal'; message: string }) => void;
}

export const useZEMStore = create<ZEMState>((set) => ({
  isHalted: false,
  activeTab: 'dashboard',
  logs: [],
  setHalted: (halted) => set({ isHalted: halted }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  addLog: (log) => set((state) => ({
    logs: [{ ...log, id: Math.random().toString(36).substr(2, 9), timestamp: Date.now() }, ...state.logs].slice(0, 50)
  })),
}));

