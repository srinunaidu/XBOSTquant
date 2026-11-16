import '../../public/robustness.js';
export const Robust = (typeof window !== 'undefined' ? (window as any).XBOST_ROBUST : (globalThis as any).XBOST_ROBUST) as any;
export default Robust;
