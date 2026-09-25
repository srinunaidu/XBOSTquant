/* XBOST Quant Engine — resample, indicators, backtest, metrics (shared by UI + Worker) */
(function (root) {
'use strict';

function emptyData(){return {t:new Float64Array(0),o:new Float64Array(0),h:new Float64Array(0),l:new Float64Array(0),c:new Float64Array(0),v:new Float64Array(0),symbol:null,layout:'empty'};}

function parseDateFlex(s){
  // accepts: epoch ms/s, ISO, 'YYYY-MM-DD HH:MM:SS', YYYYMMDD, DD-MM-YYYY etc.
  if(s==null)return NaN;
  s=String(s).trim();
  if(/^\d{13,}$/.test(s))return +s; // epoch ms
  if(/^\d{10}$/.test(s)&&+s>946684800&&+s<4102444800)return +s*1000; // epoch s (also matches YYYYMMDD range? no: YYYYMMDD 20150101 < 946684800? 20150101 < 946684800 yes! safe)
  if(/^\d{8}$/.test(s)){ // YYYYMMDD → IST midnight
    const y=+s.slice(0,4),m=+s.slice(4,6),d=+s.slice(6,8);
    if(m>=1&&m<=12&&d>=1&&d<=31)return Date.UTC(y,m-1,d)-IST_OFFSET_MS;
    return NaN;
  }
  const hasTZ=/([Zz]|[+-]\d{2}:?\d{2})$/.test(s);
  const p=Date.parse(s.replace(' ', 'T'));
  if(isNaN(p))return NaN;
  return hasTZ?p:istFromNaive(p); // naive stamps are IST wall-clock, not host-local
}
function parseTimeFlex(s){
  const m=/^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s||'').trim());
  if(!m)return null;
  return {h:+m[1],min:+m[2],s:+(m[3]||0)};
}

// Intelligent multi-format OHLCV ingest. Handles, among others:
//   date,open,high,low,close,volume                      (headered)
//   SYMBOL,YYYYMMDD,HH:MM,O,H,L,C,VOLUME,OI              (headerless futures)
//   datetime,open,high,low,close,volume                  (combined stamp)
//   date,symbol,strike,otype,expiry,O,H,L,C,volume        (multi-contract options)
// Extra columns (symbol, expiry, OI, …) are detected and ignored — OHLCV only.
// CRITICAL: files mixing several contracts are SPLIT per contract
// (parseCSVAll); parseCSV returns the largest contract only and flags the rest.
function sniffTable(text) {
  const lines = text.split(/\r?\n/);
  const grid=[];
  for (let i=0;i<lines.length;i++) {
    const ln = lines[i].trim();
    if (ln) grid.push(ln.split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')));
  }
  if (!grid.length) return null;
  // ---- header sniff: >=2 known words and mostly non-numeric ----
  const first = grid[0];
  const known = first.filter(c=>/^(symbol|scrip|instrument|ticker|date|datetime|timestamp|time|day|expiry|open|high|low|close|settle|ltp|volume|vol|qty|quantity|oi|openinterest|open_interest|chginoi|strike|otype)$/i.test(c)).length;
  const numeric = first.filter(c=>c!==''&&isFinite(+c)).length;
  let header=null, start=0, layout='positional';
  if (known>=2 && numeric<first.length/2){ header=first.map(s=>s.toLowerCase()); start=1; layout='header'; }
  const HF=(re)=>header?header.findIndex(x=>re.test(x)):-1;
  const col={symI:-1, dtI:-1, dateI:-1, timeI:-1, oI:-1, hI:-1, lI:-1, cI:-1, vI:-1, strikeI:-1, otypeI:-1, expiryI:-1};
  if (header) {
    col.symI=HF(/^(symbol|scrip|instrument|ticker)$/);
    col.dtI=HF(/^(datetime|timestamp)$/);
    col.dateI=col.dtI>=0?-1:HF(/^(date|day)$/);
    col.timeI=col.dtI>=0?-1:HF(/^(time)$/);
    col.strikeI=HF(/^(strike|strikeprice|strike_price)$/);
    col.otypeI=HF(/^(otype|optiontype|option_type|cp|callput)$/);
    col.expiryI=HF(/^(expiry|expiration|maturity)$/);
    // guard: a lone 'time' column holding full stamps (e.g. '2024-01-01 09:15')
    col.oI=HF(/^open$/); col.hI=HF(/^high$/); col.lI=HF(/^low$/); col.cI=HF(/^(close|settle|ltp)$/);
    col.vI=HF(/^(volume|vol|qty|quantity|traded)$/);
    if (col.oI<0||col.hI<0||col.lI<0||col.cI<0) return null; // not OHLCV at all
  } else {
    // ---- positional inference from the first data rows ----
    const probe=grid.slice(0,Math.min(50,grid.length));
    const nCols=Math.max(...probe.map(r=>r.length));
    const colKind=[];
    for(let c=0;c<nCols;c++){
      let str=0,dtm=0,date8=0,tm=0,num=0,tot=0;
      for(const r of probe){
        const v=r[c]; if(v==null||v==='')continue; tot++;
        if(/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)){tm++;continue;}
        if(/^\d{8}$/.test(v)&&parseDateFlex(v)&&parseDateFlex(v)>0){date8++;continue;}
        if(/[-/:]/.test(v)&&isFinite(parseDateFlex(v))){dtm++;continue;}
        if(isFinite(+v)){num++;continue;}
        str++;
      }
      colKind.push(tot?(str/tot>0.5?'STR':dtm/tot>0.5?'DT':date8/tot>0.5?'D8':tm/tot>0.5?'TM':num/tot>0.5?'NUM':'MIX'):'EMPTY');
    }
    col.symI=colKind.findIndex(k=>k==='STR');
    col.dtI=colKind.findIndex(k=>k==='DT');
    if(col.dtI<0){ col.dateI=colKind.findIndex(k=>k==='D8'); col.timeI=colKind.findIndex(k=>k==='TM'); }
    // OHLCV = NUM columns after the stamp columns; volume = next NUM after close
    const nums=[];
    for(let c=0;c<nCols;c++)if(colKind[c]==='NUM')nums.push(c);
    const ordered=nums.filter(c=>c>Math.max(col.symI,col.dtI,col.dateI,col.timeI,-1));
    const use=ordered.length>=5?ordered:nums.slice(-5);
    if(use.length<4)return null;
    col.oI=use[0];col.hI=use[1];col.lI=use[2];col.cI=use[3];col.vI=use.length>4?use[4]:-1;
  }
  layout=(header?('header['+header.slice(0,9).join(',')+']'):'positional')
    +(col.symI>=0?'+SYM':'')+(col.dtI>=0?'+DT':(col.dateI>=0?'+D':'')+(col.timeI>=0?'+T':''));
  return {grid, start, layout, col};
}
function symLabel(s){
  return String(s||'').split(/[_.\-\s]+/)[0].toUpperCase().slice(0,20)||'DATA';
}
function parseExpiryFlex(s){
  // Expiry stamps: 29SEP2026 / 29-Sep-2026 / 2026-09-29 / epoch s|ms.
  if(s==null||s==='')return NaN;
  const t=String(s).trim().toUpperCase();
  if(/^\d+$/.test(t)){ const v=+t; return v<1e12?v*1000:v; }
  const m=t.match(/^(\d{1,2})[-\s]?([A-Z]{3})[-\s]?(\d{2,4})$/);
  if(m){
    const mon={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11}[m[2]];
    if(mon==null)return NaN;
    let y=+m[3]; if(y<100)y+=2000;
    return new Date(y,mon,+m[1]).getTime();
  }
  const v=Date.parse(t);
  return isNaN(v)?NaN:v;
}
function extractRows(grid, start, col, onlySym){
  // onlySym: exact raw symbol value to keep (null = keep all rows)
  const T=[],O=[],H=[],L=[],C=[],V=[],SYM=[],STRIKE=[],OTYPE=[],EXP=[];
  for (let i=start;i<grid.length;i++) {
    const p = grid[i];
    if (p.length < 4) continue;
    const rawSym=(col.symI>=0&&p[col.symI])?String(p[col.symI]).trim().toUpperCase():'';
    if(onlySym!=null&&rawSym!==onlySym)continue;
    let t=NaN;
    if (col.dtI>=0) t=parseDateFlex(p[col.dtI]);
    else if (col.dateI>=0){
      const base=parseDateFlex(p[col.dateI]);
      if(col.timeI>=0){const tm=parseTimeFlex(p[col.timeI]); if(isNaN(base)||!tm){t=NaN;}else{const bp=istParts(base);t=Date.UTC(bp.y,bp.mo,bp.day,tm.h,tm.min,tm.s)-IST_OFFSET_MS;}}
      else t=base;
    }
    else if (col.timeI>=0){
      // lone time column: only usable if it carries a full stamp (has a date part)
      t=/[-/]/.test(p[col.timeI]||'')?parseDateFlex(p[col.timeI]):NaN;
    }
    else t=+p[0]; // last resort: epoch in first column
    const o=+(p[col.oI]??NaN),h2=+(p[col.hI]??NaN),l2=+(p[col.lI]??NaN),c2=+(p[col.cI]??NaN),v=+(p[col.vI]??0);
    if (!isFinite(o)||!isFinite(h2)||!isFinite(l2)||!isFinite(c2)||!isFinite(t)) continue;
    T.push(t);O.push(o);H.push(h2);L.push(l2);C.push(c2);V.push(v||0);SYM.push(rawSym);
    STRIKE.push(col.strikeI>=0?+(p[col.strikeI]??NaN):NaN);
    const ot=col.otypeI>=0?String(p[col.otypeI]||'').trim().toUpperCase():'';
    OTYPE.push(/^(C|CE|CALL)$/.test(ot)?'CE':/^(P|PE|PUT)$/.test(ot)?'PE':'');
    EXP.push(col.expiryI>=0?parseExpiryFlex(p[col.expiryI]):NaN);
  }
  return {T,O,H,L,C,V,SYM,STRIKE,OTYPE,EXP};
}
function toData(R){
  const n=R.T.length, idx=new Array(n);
  for(let i=0;i<n;i++) idx[i]=i;
  idx.sort((a,b)=>R.T[a]-R.T[b]);
  const out={t:new Float64Array(n),o:new Float64Array(n),h:new Float64Array(n),l:new Float64Array(n),c:new Float64Array(n),v:new Float64Array(n),symbol:null,layout:''};
  for(let i=0;i<n;i++){const j=idx[i];out.t[i]=R.T[j];out.o[i]=R.O[j];out.h[i]=R.H[j];out.l[i]=R.L[j];out.c[i]=R.C[j];out.v[i]=R.V[j];}
  return out;
}
function parseCSV(text) {
  const tab=sniffTable(text);
  if(!tab)return emptyData();
  const R=extractRows(tab.grid, tab.start, tab.col, null);
  if(!R.T.length)return emptyData();
  if(tab.col.symI<0){
    const out=toData(R);out.layout=tab.layout;return out;
  }
  // multi-contract file: keep the LARGEST contract only (flag the rest loudly)
  const counts={};
  for(const s of R.SYM)counts[s]=(counts[s]||0)+1;
  const keys=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
  const keep=keys[0]||'';
  const F={T:[],O:[],H:[],L:[],C:[],V:[],SYM:[],STRIKE:[],OTYPE:[],EXP:[]};
  for(let i=0;i<R.T.length;i++)if(R.SYM[i]===keep){F.T.push(R.T[i]);F.O.push(R.O[i]);F.H.push(R.H[i]);F.L.push(R.L[i]);F.C.push(R.C[i]);F.V.push(R.V[i]);F.SYM.push(R.SYM[i]);F.STRIKE.push(R.STRIKE[i]);F.OTYPE.push(R.OTYPE[i]);F.EXP.push(R.EXP[i]);}
  const out=toData(F);
  out.symbol=symLabel(keep);
  out.layout=tab.layout;
  out.contract=contractOf(F);
  if(keys.length>1)out.mixed={contracts:keys.length, kept:keep, keptRows:F.T.length, dropped:R.T.length-F.T.length};
  return out;
}
// Split a (possibly multi-contract) file into one pure dataset per contract,
// largest first. Single-symbol files return exactly one entry.
// Contract-level meta for one (already single-contract) row set: strike /
// option type / expiry taken from the first row carrying them. Futures and
// plain equity files yield {strike:null,...} — callers must null-check.
function contractOf(F){
  const c={strike:null, otype:'', expiry:'', expiryMs:NaN};
  for(let i=0;i<(F.T||[]).length;i++){
    if(c.strike==null&&isFinite(F.STRIKE[i]))c.strike=F.STRIKE[i];
    if(!c.otype&&F.OTYPE[i])c.otype=F.OTYPE[i];
    if(!isFinite(c.expiryMs)&&isFinite(F.EXP[i])){c.expiryMs=F.EXP[i];c.expiry=new Date(F.EXP[i]).toISOString().slice(0,10);}
    if(c.strike!=null&&c.otype&&isFinite(c.expiryMs))break;
  }
  return c;
}
function parseCSVAll(text) {
  const tab=sniffTable(text);
  if(!tab)return [];
  if(tab.col.symI<0){
    const R=extractRows(tab.grid, tab.start, tab.col, null);
    if(!R.T.length)return [];
    const out=toData(R);out.layout=tab.layout;return [{symbol:null, full:'', d:out}];
  }
  const R=extractRows(tab.grid, tab.start, tab.col, null);
  const groups={};
  for(let i=0;i<R.T.length;i++){(groups[R.SYM[i]||''] = groups[R.SYM[i]||''] || []).push(i);}
  const keys=Object.keys(groups).sort((a,b)=>groups[b].length-groups[a].length);
  return keys.map(k=>{
    const F={T:[],O:[],H:[],L:[],C:[],V:[],SYM:[],STRIKE:[],OTYPE:[],EXP:[]};
    for(const i of groups[k]){F.T.push(R.T[i]);F.O.push(R.O[i]);F.H.push(R.H[i]);F.L.push(R.L[i]);F.C.push(R.C[i]);F.V.push(R.V[i]);F.SYM.push(R.SYM[i]);F.STRIKE.push(R.STRIKE[i]);F.OTYPE.push(R.OTYPE[i]);F.EXP.push(R.EXP[i]);}
    const out=toData(F);
    out.symbol=symLabel(k);
    out.layout=tab.layout;
    out.contract=contractOf(F);
    return {symbol:out.symbol, full:k, d:out};
  });
}

function resample(d, tfMin) {
  tfMin=Math.max(1,Math.round(tfMin));
  if (tfMin===1) return d;
  const n=d.t.length, ms=tfMin*60000;
  // align buckets to 09:15 IST session grid: bucket = floor((t - sessionStart)/ms)? simpler: floor(t/ms)
  const T=[],O=[],H=[],L=[],C=[],V=[];
  let bt=-1,bo=0,bh=-Infinity,bl=Infinity,bc=0,bv=0;
  for(let i=0;i<n;i++){
    const b=Math.floor(d.t[i]/ms);
    if(b!==bt){
      if(bt!==-1){T.push(bt*ms);O.push(bo);H.push(bh);L.push(bl);C.push(bc);V.push(bv);}
      bt=b;bo=d.o[i];bh=d.h[i];bl=d.l[i];bc=d.c[i];bv=d.v[i];
    } else {
      if(d.h[i]>bh)bh=d.h[i];
      if(d.l[i]<bl)bl=d.l[i];
      bc=d.c[i];bv+=d.v[i];
    }
  }
  if(bt!==-1){T.push(bt*ms);O.push(bo);H.push(bh);L.push(bl);C.push(bc);V.push(bv);}
  const m=T.length;
  return {t:Float64Array.from(T),o:Float64Array.from(O),h:Float64Array.from(H),l:Float64Array.from(L),c:Float64Array.from(C),v:Float64Array.from(V)};
}

// ---------- indicators (Float64Array in/out, NaN for warmup) ----------
function sma(src, p){
  const n=src.length,out=new Float64Array(n).fill(NaN);
  let s=0;
  for(let i=0;i<n;i++){s+=src[i];if(i>=p)s-=src[i-p];if(i>=p-1)out[i]=s/p;}
  return out;
}
function ema(src,p){
  const n=src.length,out=new Float64Array(n).fill(NaN);
  const k=2/(p+1);let e=0;
  for(let i=0;i<n;i++){if(i<p-1){e+=src[i];if(i===p-2){}continue;}if(i===p-1){e=(e+src[i])/p;out[i]=e;continue;}e=src[i]*k+e*(1-k);out[i]=e;}
  return out;
}
function wma(src,p){
  // O(n) rolling WMA: W[i] = W[i-1] + p*x[i] - S[i-1], S = rolling window sum
  const n=src.length,out=new Float64Array(n).fill(NaN);
  p=Math.max(1,Math.round(p));
  const den=p*(p+1)/2;
  let S=0,W=0;
  for(let i=0;i<n;i++){
    const x=src[i];
    if(i<p){S+=x;W+=(i+1)*x;if(i===p-1)out[i]=W/den;}
    else{W+=p*x-S;S+=x-src[i-p];out[i]=W/den;}
  }
  return out;
}
function hma(src,p){
  const n=src.length, hp=Math.max(2,Math.round(Math.sqrt(p)));
  const w1=wma(src,Math.max(1,Math.floor(p/2))), w2=wma(src,p);
  const diff=new Float64Array(n);
  for(let i=0;i<n;i++)diff[i]=(isNaN(w1[i])||isNaN(w2[i]))?NaN:2*w1[i]-w2[i];
  // WMA of diff then? use wma ignoring NaN prefix
  const valid=[];const idx=[];
  for(let i=0;i<n;i++)if(!isNaN(diff[i])){valid.push(diff[i]);idx.push(i);}
  const w=wma(Float64Array.from(valid),hp);
  const out=new Float64Array(n).fill(NaN);
  for(let k=0;k<valid.length;k++)out[idx[k]]=w[k];
  return out;
}
function dema(src,p){
  const e1=ema(src,p),e2=ema(e1.map(v=>isNaN(v)?0:v),p);
  // fix warmup: recompute properly
  const n=src.length,out=new Float64Array(n).fill(NaN);
  for(let i=0;i<n;i++){if(isNaN(e1[i]))continue;out[i]=2*e1[i]-e2[i];}
  return out;
}
function rsi(close,p){
  const n=close.length,out=new Float64Array(n).fill(NaN);
  let g=0,l=0;
  for(let i=1;i<n;i++){
    const ch=close[i]-close[i-1];
    const gain=ch>0?ch:0,loss=ch<0?-ch:0;
    if(i<=p){g+=gain;l+=loss;if(i===p){const rs=l===0?100:g/Math.max(l,1e-12);out[i]=100-100/(1+rs);}continue;}
    g=(g*(p-1)+gain)/p;l=(l*(p-1)+loss)/p;
    const rs=l===0?100:g/Math.max(l,1e-12);
    out[i]=100-100/(1+rs);
  }
  return out;
}
function atr(h,l,c,p){
  const n=c.length,out=new Float64Array(n).fill(NaN);
  let a=0;
  for(let i=0;i<n;i++){
    const tr=i===0?h[i]-l[i]:Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    if(i<p){a+=tr;if(i===p-1)out[i]=a/p;continue;}
    a=(a*(p-1)+tr)/p;out[i]=a;
  }
  return out;
}
function macd(close,fast,slow,sig){
  const ef=ema(close,fast),es=ema(close,slow);
  const n=close.length,line=new Float64Array(n).fill(NaN);
  for(let i=0;i<n;i++)if(!isNaN(ef[i])&&!isNaN(es[i]))line[i]=ef[i]-es[i];
  const valid=[],idx=[];
  for(let i=0;i<n;i++)if(!isNaN(line[i])){valid.push(line[i]);idx.push(i);}
  const se=ema(Float64Array.from(valid),sig);
  const signal=new Float64Array(n).fill(NaN),hist=new Float64Array(n).fill(NaN);
  for(let k=0;k<valid.length;k++){signal[idx[k]]=se[k];hist[idx[k]]=valid[k]-se[k];}
  return {line,signal,hist};
}
function bollinger(close,p,mult){
  const m=sma(close,p),n=close.length;
  const up=new Float64Array(n).fill(NaN),lo=new Float64Array(n).fill(NaN);
  let s=0,s2=0;
  for(let i=0;i<n;i++){
    s+=close[i];s2+=close[i]*close[i];
    if(i>=p){s-=close[i-p];s2-=close[i-p]*close[i-p];}
    if(i>=p-1){const mean=s/p;const va=Math.max(0,s2/p-mean*mean);const sd=Math.sqrt(va);up[i]=mean+mult*sd;lo[i]=mean-mult*sd;}
  }
  return {mid:m,up,lo};
}
function keltner(h,l,c,emaP,atrP,mult){
  const mid=ema(c,emaP),a=atr(h,l,c,atrP),n=c.length;
  const up=new Float64Array(n).fill(NaN),lo=new Float64Array(n).fill(NaN);
  for(let i=0;i<n;i++)if(!isNaN(mid[i])&&!isNaN(a[i])){up[i]=mid[i]+mult*a[i];lo[i]=mid[i]-mult*a[i];}
  return {mid,up,lo};
}
function stoch(h,l,c,kP,dP){
  const n=c.length,k=new Float64Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(i<kP-1)continue;
    let hh=-Infinity,ll=Infinity;
    for(let j=i-kP+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}
    k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;
  }
  const d=sma(k.map(v=>isNaN(v)?50:v),dP);
  return {k,d};
}
function supertrend(h,l,c,atrP,mult){
  const n=c.length,a=atr(h,l,c,atrP);
  const st=new Float64Array(n).fill(NaN),dir=new Int8Array(n);
  let ub=0,lb=0,prevClose=c[0],prevUb=0,prevLb=0,prevDir=1;
  for(let i=0;i<n;i++){
    if(isNaN(a[i])){dir[i]=1;continue;}
    const hl2=(h[i]+l[i])/2;
    ub=hl2+mult*a[i];lb=hl2-mult*a[i];
    if(i>0){
      if(prevClose>prevUb)ub=Math.min(ub,prevUb);else ub=ub;
      if(prevClose<prevLb)lb=Math.max(lb,prevLb);
      let dirc=prevDir;
      if(c[i]>prevUb)dirc=1;else if(c[i]<prevLb)dirc=-1;
      dir[i]=dirc;
      st[i]=dirc===1?lb:ub;
      prevUb=ub;prevLb=lb;prevDir=dirc;prevClose=c[i];
    } else {dir[i]=1;st[i]=lb;prevUb=ub;prevLb=lb;prevClose=c[i];}
  }
  return {st,dir};
}
function adx(h,l,c,p){
  const n=c.length,plus=new Float64Array(n),minus=new Float64Array(n),trA=new Float64Array(n);
  for(let i=1;i<n;i++){
    const up=h[i]-h[i-1],dn=l[i-1]-l[i];
    plus[i]=up>dn&&up>0?up:0;minus[i]=dn>up&&dn>0?dn:0;
    trA[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
  }
  const out=new Float64Array(n).fill(NaN);
  let sp=0,sm=0,st=0;
  for(let i=1;i<n;i++){sp+=plus[i];sm+=minus[i];st+=trA[i];
    if(i===p){sp/=p;sm/=p;st/=p;}
    else if(i>p){sp=(sp*(p-1)+plus[i])/p;sm=(sm*(p-1)+minus[i])/p;st=(st*(p-1)+trA[i])/p;}
    else continue;
    const pdm=st===0?0:100*sp/st, mdm=st===0?0:100*sm/st;
    const dx=(pdm+mdm)===0?0:100*Math.abs(pdm-mdm)/(pdm+mdm);
    if(i===p)out[i]=dx;
    else if(i>p){ // smooth DX
      out[i]=(out[i-1]*(p-1)+dx)/p;
    }
  }
  return out;
}
function vwapSeries(d){
  const n=d.c.length,out=new Float64Array(n).fill(NaN);
  let pv=0,vv=0,day='';
  const fmt=t=>istDayKey(t);
  for(let i=0;i<n;i++){
    const dd=fmt(d.t[i]);
    if(dd!==day){day=dd;pv=0;vv=0;}
    const tp=(d.h[i]+d.l[i]+d.c[i])/3;
    pv+=tp*d.v[i];vv+=d.v[i];
    out[i]=vv>0?pv/vv:tp;
  }
  return out;
}
function chandeKroll(h,l,c,p,mult){
  // Long stop = highest high of p bars - mult*ATR; Short stop = lowest low + mult*ATR
  const n=c.length,a=atr(h,l,c,p);
  const ls=new Float64Array(n).fill(NaN),ss=new Float64Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(i<p-1||isNaN(a[i]))continue;
    let hh=-Infinity,ll=Infinity;
    for(let j=i-p+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}
    ls[i]=hh-mult*a[i];ss[i]=ll+mult*a[i];
  }
  return {longStop:ls,shortStop:ss};
}
function pocSeries(d,lookback){
  const n=d.c.length,out=new Float64Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    const s=Math.max(0,i-lookback+1);
    // volume-less windows carry no information -> NaN (never a fake POC)
    let wv=0;
    for(let j=s;j<=i;j++)wv+=d.v[j]||0;
    if(wv<=0){out[i]=NaN;continue;}
    // 24 bins over window range
    let mn=Infinity,mx=-Infinity;
    for(let j=s;j<=i;j++){if(d.l[j]<mn)mn=d.l[j];if(d.h[j]>mx)mx=d.h[j];}
    if(!(mx>mn)) {out[i]=d.c[i];continue;}
    const B=24,bins=new Float64Array(B),w=(mx-mn)/B;
    for(let j=s;j<=i;j++){
      const tp=(d.h[j]+d.l[j]+d.c[j])/3;
      let b=Math.floor((tp-mn)/w);if(b<0)b=0;if(b>=B)b=B-1;
      bins[b]+=d.v[j]||1;
    }
    let bi=0;for(let b=1;b<B;b++)if(bins[b]>bins[bi])bi=b;
    out[i]=mn+(bi+0.5)*w;
  }
  return out;
}

// ---------- proprietary-style indicators (rare in retail screeners) ----------
function kama(close, erP, fast, slow){
  // Kaufman Adaptive MA — efficiency-ratio driven, fast in trends, slow in chop
  const n=close.length,out=new Float64Array(n).fill(NaN);
  erP=Math.max(2,Math.round(erP));fast=Math.max(1,Math.round(fast));slow=Math.max(fast+1,Math.round(slow));
  const fsc=2/(fast+1), ssc=2/(slow+1);
  let k=0;
  for(let i=0;i<n;i++){
    if(i<erP)continue;
    if(i===erP){let s=0;for(let j=i-erP+1;j<=i;j++)s+=close[j];k=s/erP;out[i]=k;continue;}
    const change=Math.abs(close[i]-close[i-erP]);
    let vol=0;for(let j=i-erP+1;j<=i;j++)vol+=Math.abs(close[j]-close[j-1]);
    const er=vol===0?0:change/vol;
    const sc=Math.pow(er*(fsc-ssc)+ssc,2);
    k=k+sc*(close[i]-k);out[i]=k;
  }
  return out;
}
function fisherTransform(h,l,c,p){
  // Fisher Transform of median price — sharp major turning-point signals
  const n=c.length,out=new Float64Array(n).fill(NaN);
  p=Math.max(2,Math.round(p));
  let prev=0;
  for(let i=0;i<n;i++){
    if(i<p-1)continue;
    let hh=-Infinity,ll=Infinity;
    for(let j=i-p+1;j<=i;j++){const m=(h[j]+l[j])/2;if(m>hh)hh=m;if(m<ll)ll=m;}
    let v=hh===ll?0:2*(((h[i]+l[i])/2-ll)/(hh-ll)-0.5);
    v=Math.max(-0.999,Math.min(0.999,v));
    const f=0.5*Math.log((1+v)/Math.max(1e-9,1-v))+0.5*prev;
    prev=f;out[i]=f;
  }
  return out;
}
function ttmSqueeze(h,l,c,bbP,bbM,kcP,kcM){
  // Bollinger-inside-Keltner squeeze + momentum; signal fires on squeeze release
  const b=bollinger(c,bbP,bbM), k=keltner(h,l,c,kcP,kcP,kcM);
  const n=c.length, mom=new Float64Array(n).fill(NaN), fire=new Int8Array(n);
  const hl2=new Float64Array(n);
  for(let i=0;i<n;i++)hl2[i]=(h[i]+l[i])/2;
  const base=sma(hl2,kcP);
  for(let i=0;i<n;i++){
    if(isNaN(b.up[i])||isNaN(k.up[i])||isNaN(base[i]))continue;
    const on=(b.lo[i]>k.lo[i]&&b.up[i]<k.up[i])?1:0;
    mom[i]=c[i]-base[i];
    fire[i]=(i>0&&!on&&((b.lo[i-1]>k.lo[i-1]&&b.up[i-1]<k.up[i-1])?1:0))?1:0;
  }
  return {mom,fire};
}
function connorsRSI(c, rsiP, streakP, rankP){
  // Connors RSI = mean(RSI(period), RSI(streak), PercentRank) — short-horizon mean reversion
  const n=c.length;
  const r=rsi(c,Math.max(2,Math.round(rsiP)));
  const streak=new Float64Array(n);
  let s=0;
  for(let i=1;i<n;i++){
    if(c[i]>c[i-1])s=s>0?s+1:1;
    else if(c[i]<c[i-1])s=s<0?s-1:-1;
    else s=0;
    streak[i]=s;
  }
  const rs=rsi(streak,Math.max(2,Math.round(streakP)));
  rankP=Math.max(5,Math.round(rankP));
  const pr=new Float64Array(n).fill(NaN);
  for(let i=1;i<n;i++){
    if(i<rankP)continue;
    const cur=c[i]-c[i-1];
    let cnt=0;
    for(let j=i-rankP+1;j<=i;j++)if((c[j]-c[j-1])<cur)cnt++;
    pr[i]=cnt/rankP*100;
  }
  const out=new Float64Array(n).fill(NaN);
  for(let i=0;i<n;i++)if(!isNaN(r[i])&&!isNaN(rs[i])&&!isNaN(pr[i]))out[i]=(r[i]+rs[i]+pr[i])/3;
  return out;
}

// ---------- institutional order flow & smart money ----------
function vwapBands(d, sd1, sd2){
  // Session VWAP ± sd1·σ / ± sd2·σ, σ = expanding session std of typical price
  const n=d.c.length, vwap=new Float64Array(n).fill(NaN);
  const up1=new Float64Array(n).fill(NaN), lo1=new Float64Array(n).fill(NaN);
  const up2=new Float64Array(n).fill(NaN), lo2=new Float64Array(n).fill(NaN);
  let pv=0,vv=0,day='',sn=0,sm=0,sm2=0;
  const fmt=t=>new Date(t).toDateString();
  for(let i=0;i<n;i++){
    const dd=fmt(d.t[i]);
    if(dd!==day){day=dd;pv=0;vv=0;sn=0;sm=0;sm2=0;}
    const tp=(d.h[i]+d.l[i]+d.c[i])/3;
    pv+=tp*d.v[i];vv+=d.v[i];
    sn++;sm+=tp;sm2+=tp*tp;
    if(vv<=0)continue;
    const vw=pv/vv, va=Math.max(0,sm2/sn-(sm/sn)*(sm/sn)), sd=Math.sqrt(va);
    vwap[i]=vw;up1[i]=vw+sd1*sd;lo1[i]=vw-sd1*sd;up2[i]=vw+sd2*sd;lo2[i]=vw-sd2*sd;
  }
  return {vwap,up1,lo1,up2,lo2};
}
function cvdSeries(d){
  // Cumulative Volume Delta (tick-rule proxy), reset each session
  const n=d.c.length,out=new Float64Array(n).fill(NaN);
  let cum=0,day='';
  const fmt=t=>istDayKey(t);
  for(let i=0;i<n;i++){
    const dd=fmt(d.t[i]);
    if(dd!==day){day=dd;cum=0;}
    cum+=(d.c[i]>=d.o[i]?1:-1)*(d.v[i]||0);
    out[i]=cum;
  }
  return out;
}
function fvgZones(d, maxZones, mitAge){
  // Fair Value Gaps: bull gap when low[i] > high[i-2]; zone=[high[i-2], low[i]].
  // Returns per-bar bias: +1 inside live bull zone, -1 inside live bear zone.
  const n=d.c.length, bias=new Int8Array(n), bullN=new Int8Array(n);
  maxZones=Math.max(1,Math.round(maxZones));mitAge=Math.max(5,Math.round(mitAge));
  const zones=[]; // {dir:1|-1, top, bot, born}
  for(let i=0;i<n;i++){
    if(i>=2){
      if(d.l[i]>d.h[i-2])zones.push({dir:1,top:d.l[i],bot:d.h[i-2],born:i});
      else if(d.h[i]<d.l[i-2])zones.push({dir:-1,top:d.l[i-2],bot:d.h[i],born:i});
      while(zones.length>maxZones)zones.shift();
    }
    let b=0;
    for(let z=zones.length-1;z>=0;z--){
      const zn=zones[z];
      if(i-zn.born>mitAge){zones.splice(z,1);continue;}
      if(zn.dir===1&&d.c[i]<zn.bot){zones.splice(z,1);continue;} // fully mitigated
      if(zn.dir===-1&&d.c[i]>zn.top){zones.splice(z,1);continue;}
      if(b===0){
        if(zn.dir===1&&d.l[i]<=zn.top&&d.l[i]>=zn.bot)b=1; // tap into bull zone
        else if(zn.dir===-1&&d.h[i]>=zn.bot&&d.h[i]<=zn.top)b=-1;
      }
    }
    bias[i]=b;bullN[i]=zones.length;
  }
  return {bias,zoneCount:bullN};
}
function choppiness(h,l,c,p){
  // Choppiness Index: 100·log10(ΣATR(n) / (maxH−minL)) / log10(n); >~61.8 = range
  const n=c.length,out=new Float64Array(n).fill(NaN);
  p=Math.max(2,Math.round(p));
  for(let i=0;i<n;i++){
    if(i<p)continue;
    let hh=-Infinity,ll=Infinity,atrSum=0;
    for(let j=i-p+1;j<=i;j++){
      if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];
      atrSum+=j===0?h[j]-l[j]:Math.max(h[j]-l[j],Math.abs(h[j]-c[j-1]),Math.abs(l[j]-c[j-1]));
    }
    const rng=hh-ll;
    out[i]=rng>0?100*Math.log10((atrSum/p)/rng)/Math.log10(p):50;
  }
  return out;
}
function cyberCycle(src, alpha){
  // Ehlers 2-pole Butterworth: smooth + high-pass recursion isolates the cycle
  const n=src.length,out=new Float64Array(n).fill(NaN);
  alpha=Math.min(0.5,Math.max(0.01,alpha));
  const k1=(1-alpha/2)*(1-alpha/2), k2=2*(1-alpha), k3=-(1-alpha)*(1-alpha);
  let p0=0,p1=0,p2=0,p3=0,sm1=0,sm2=0,c1=0,c2=0;
  for(let i=0;i<n;i++){
    const price=src[i];
    p3=p2;p2=p1;p1=p0;p0=price;
    const sm=(p0+2*p1+2*p2+p3)/6;
    const cyc=k1*(sm-2*sm1+sm2)+k2*c1+k3*c2;
    sm2=sm1;sm1=sm;c2=c1;c1=cyc;
    if(i>=7)out[i]=cyc; // recursion needs a few bars to settle
  }
  return out;
}
// ---------- Regime-first DSP (Ehlers): Hilbert dominant cycle + InstantTrend ----------
// All outputs causal (bar i uses only bars ≤ i). NaN = warmup.
function hilbertDC(close){
  // Ehlers Hilbert-Transformer dominant cycle. period ∈ [6,50] clamped with
  // rate limiting (1.5×/0.67× per bar) + 0.25/0.75 smoothing, exactly per the
  // reference formulation (fixed coefficients — no time-growing factors).
  const n=close.length, period=new Float64Array(n).fill(NaN), mode=new Int8Array(n);
  const sm=new Float64Array(n), det=new Float64Array(n);
  const I1=new Float64Array(n), Q1=new Float64Array(n);
  const jI=new Float64Array(n), jQ=new Float64Array(n);
  const I2=new Float64Array(n).fill(0), Q2=new Float64Array(n).fill(0);
  const Re=new Float64Array(n).fill(0), Im=new Float64Array(n).fill(0);
  let prevPeriod=0;
  for(let i=0;i<n;i++){
    sm[i]=i>=3?(close[i]+2*close[i-1]+2*close[i-2]+close[i-3])/6:close[i];
    if(i<6)continue;
    det[i]=0.0962*sm[i]+0.5769*sm[i-2]-0.5769*sm[i-4]-0.0962*sm[i-6];
    Q1[i]=0.0962*det[i]+0.5769*det[i-2]-0.5769*det[i-4]-0.0962*det[i-6];
    I1[i]=det[i-3];
    jI[i]=0.0962*I1[i]+0.5769*I1[i-2]-0.5769*I1[i-4]-0.0962*I1[i-6];
    jQ[i]=0.0962*Q1[i]+0.5769*Q1[i-2]-0.5769*Q1[i-4]-0.0962*Q1[i-6];
    const i2v=I1[i]-jQ[i], q2v=Q1[i]+jI[i];
    I2[i]=0.2*i2v+0.8*I2[i-1]; Q2[i]=0.2*q2v+0.8*Q2[i-1];
    Re[i]=0.2*(I2[i]*I2[i-1]+Q2[i]*Q2[i-1])+0.8*Re[i-1];
    Im[i]=0.2*(I2[i]*Q2[i-1]-Q2[i]*I2[i-1])+0.8*Im[i-1];
    if(Re[i]!==0&&Im[i]!==0){
      let p=6.2831853/Math.atan(Im[i]/Re[i]);
      if(p>1.5*prevPeriod&&prevPeriod>0)p=1.5*prevPeriod;
      if(p<0.67*prevPeriod&&prevPeriod>0)p=0.67*prevPeriod;
      p=Math.min(50,Math.max(6,p));
      p=0.25*p+0.75*(prevPeriod||p);
      period[i]=p;prevPeriod=p;
      mode[i]=Math.abs(p-(period[i-1]||p))<2?1:0; // 1 = stable cycle (trendable), 0 = shifting
    }
  }
  return {period,mode};
}
function itrend(close, alpha){
  // Ehlers Instantaneous Trendline: high-pass → SuperSmoother → 4-bar average.
  // trend = zero-lag line, trigger = its 1-bar lag; direction = trend vs trigger.
  const n=close.length, trend=new Float64Array(n).fill(NaN), trig=new Float64Array(n).fill(NaN);
  alpha=Math.min(0.3,Math.max(0.01,alpha==null?0.07:alpha));
  const a1=(1-alpha/2)*(1-alpha/2), b1=2*(1-alpha), c1=(1-alpha)*(1-alpha), k=(1+a1-b1-c1)/4;
  const hp=new Float64Array(n), ss=new Float64Array(n);
  const sa=Math.exp(-1.414*3.14159/10), sb=2*sa*Math.cos(1.414*3.14159/10), sc=sa*sa, ck=(1+sb+sc)/4;
  for(let i=0;i<n;i++){
    hp[i]=i>=2?k*(close[i]-2*close[i-1]+close[i-2])+b1*hp[i-1]-c1*hp[i-2]:0;
    ss[i]=i>=2?ck*(hp[i]+hp[i-1])+sb*ss[i-1]-sc*ss[i-2]:0;
    if(i>=3){trend[i]=(ss[i]+2*ss[i-1]+ss[i-2])/4;trig[i]=(ss[i-1]+2*ss[i-2]+(i>=3?ss[i-3]:ss[i-2]))/4;}
  }
  return {trend,trig};
}
function adaptivePeriod(base, cycle, min, max){
  // Cycle-adaptive lookback: len = clamp(round(cycle/2)). Falls back to base
  // when no cycle estimate exists. Zero free parameters beyond base.
  if(cycle==null||isNaN(cycle)||cycle<4)return Math.round(base);
  return Math.max(min,Math.min(max,Math.round(cycle/2)));
}
function vwma(close, vol, p){
  // Volume-Weighted MA: Σ(price·vol)/Σvol over p bars
  const n=close.length,out=new Float64Array(n).fill(NaN);
  p=Math.max(1,Math.round(p));
  let pv=0,vv=0;
  for(let i=0;i<n;i++){
    pv+=close[i]*vol[i];vv+=vol[i];
    if(i>=p){pv-=close[i-p]*vol[i-p];vv-=vol[i-p];}
    if(i>=p-1)out[i]=vv>0?pv/vv:close[i];
  }
  return out;
}
function cmo(close, p){
  // Chande Momentum Oscillator: 100·(Σup−Σdn)/(Σup+Σdn) over p bars
  const n=close.length,out=new Float64Array(n).fill(NaN);
  p=Math.max(2,Math.round(p));
  for(let i=0;i<n;i++){
    if(i<p)continue;
    let up=0,dn=0;
    for(let j=i-p+1;j<=i;j++){
      const ch=close[j]-close[j-1];
      if(ch>0)up+=ch;else dn-=ch;
    }
    out[i]=(up+dn)>0?100*(up-dn)/(up+dn):0;
  }
  return out;
}
function aroon(h, l, c, p){
  // Aroon Up/Down/Oscillator: time since highest high / lowest low
  const n=c.length, up=new Float64Array(n).fill(NaN), dn=new Float64Array(n).fill(NaN), osc=new Float64Array(n).fill(NaN);
  p=Math.max(2,Math.round(p));
  for(let i=0;i<n;i++){
    if(i<p-1)continue;
    let hi=-Infinity,li=Infinity,ji=i,ki=i;
    for(let j=i-p+1;j<=i;j++){if(h[j]>hi){hi=h[j];ji=j;}if(l[j]<li){li=l[j];ki=j;}}
    up[i]=100*(p-(i-ji))/p;dn[i]=100*(p-(i-ki))/p;osc[i]=up[i]-dn[i];
  }
  return {up,dn,osc};
}

// ---------- signals ----------
function buildSignals(d, cfg){
  // cfg: {indicator, params:{}}
  const n=d.c.length;
  const pos=new Int8Array(n); // 1 long, -1 short, 0 flat
  const ind=cfg.indicator, P=cfg.params||{};
  let overlay={}, osc={};
  if(ind==='EMA'||ind==='SMA'||ind==='HMA'||ind==='DEMA'){
    const per=P.period||21;
    const ma=ind==='EMA'?ema(d.c,per):ind==='SMA'?sma(d.c,per):ind==='HMA'?hma(d.c,per):dema(d.c,per);
    overlay={ma};
    for(let i=0;i<n;i++){if(isNaN(ma[i]))continue;pos[i]=d.c[i]>ma[i]?1:-1;}
  } else if(ind==='Bollinger'){
    const b=bollinger(d.c,P.period||20,P.mult||2);
    overlay={mid:b.mid,up:b.up,lo:b.lo};
    for(let i=0;i<n;i++){if(isNaN(b.up[i]))continue;if(d.c[i]<b.lo[i])pos[i]=1;else if(d.c[i]>b.up[i])pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='Keltner'){
    const k=keltner(d.h,d.l,d.c,P.emaPeriod||20,P.atrPeriod||14,P.mult||2);
    overlay={mid:k.mid,up:k.up,lo:k.lo};
    for(let i=0;i<n;i++){if(isNaN(k.up[i]))continue;if(d.c[i]<k.lo[i])pos[i]=1;else if(d.c[i]>k.up[i])pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='RSI'){
    const r=rsi(d.c,P.period||14),os=P.oversold??30,ob=P.overbought??70;
    osc={rsi:r};
    for(let i=0;i<n;i++){if(isNaN(r[i]))continue;if(r[i]<os)pos[i]=1;else if(r[i]>ob)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='MACD'){
    const m=macd(d.c,P.fast||12,P.slow||26,P.signal||9);
    osc={macdLine:m.line,macdSig:m.signal,macdHist:m.hist};
    for(let i=0;i<n;i++){if(isNaN(m.line[i])||isNaN(m.signal[i]))continue;pos[i]=m.line[i]>m.signal[i]?1:-1;}
  } else if(ind==='VWAP'){
    const v=vwapSeries(d);
    overlay={vwap:v};
    for(let i=0;i<n;i++)pos[i]=d.c[i]>v[i]?1:-1;
  } else if(ind==='SuperTrend'){
    const s=supertrend(d.h,d.l,d.c,P.atrPeriod||10,P.mult||3);
    overlay={st:s.st};
    for(let i=0;i<n;i++){if(isNaN(s.st[i]))continue;pos[i]=s.dir[i];}
  } else if(ind==='ADX'){
    const a=adx(d.h,d.l,d.c,P.adxPeriod||14),e=ema(d.c,P.maPeriod||50),th=P.threshold||20;
    osc={adx:a};overlay={adxMa:e};
    for(let i=0;i<n;i++){if(isNaN(a[i])||isNaN(e[i]))continue;if(a[i]<th){pos[i]=i>0?pos[i-1]:0;}else pos[i]=d.c[i]>e[i]?1:-1;}
  } else if(ind==='Stochastic'){
    const s=stoch(d.h,d.l,d.c,P.k||14,P.d||3),os=P.oversold??20,ob=P.overbought??80;
    osc={stochK:s.k,stochD:s.d};
    for(let i=0;i<n;i++){if(isNaN(s.k[i])||isNaN(s.d[i]))continue;if(s.k[i]<os&&s.k[i]>s.d[i])pos[i]=1;else if(s.k[i]>ob&&s.k[i]<s.d[i])pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='ChandeKroll'){
    const ck=chandeKroll(d.h,d.l,d.c,P.period||10,P.mult||3);
    overlay={ckLong:ck.longStop,ckShort:ck.shortStop};
    for(let i=0;i<n;i++){if(isNaN(ck.longStop[i]))continue;if(d.c[i]>ck.shortStop[i])pos[i]=-1;else if(d.c[i]<ck.longStop[i])pos[i]=1;else pos[i]=i>0?pos[i-1]:0;
      // corrected: break above short-stop => short? Actually CK: long stop trails below; price below long stop => exit/flip short
      if(d.c[i]<ck.longStop[i])pos[i]=-1;else if(d.c[i]>ck.shortStop[i])pos[i]=1;
    }
  } else if(ind==='POC'){
    const poc=pocSeries(d,P.lookback||50);
    overlay={poc};
    for(let i=0;i<n;i++){if(isNaN(poc[i]))continue;pos[i]=d.c[i]>poc[i]?1:-1;}
  } else if(ind==='KAMA'){
    const k=kama(d.c,P.erPeriod||10,P.fast||2,P.slow||30);
    overlay={ma:k};
    for(let i=0;i<n;i++){if(isNaN(k[i]))continue;pos[i]=d.c[i]>k[i]?1:-1;}
  } else if(ind==='Fisher'){
    const f=fisherTransform(d.h,d.l,d.c,P.period||10);
    osc={fisher:f};
    for(let i=0;i<n;i++){if(isNaN(f[i]))continue;pos[i]=f[i]>0?1:-1;}
  } else if(ind==='Squeeze'){
    const sq=ttmSqueeze(d.h,d.l,d.c,P.bbPeriod||20,P.bbMult||2,P.kcPeriod||20,P.kcMult||1.5);
    osc={sqzMom:sq.mom};
    let dir=0;
    for(let i=0;i<n;i++){
      if(isNaN(sq.mom[i]))continue;
      if(sq.fire[i])dir=sq.mom[i]>0?1:-1; // squeeze released: trade the momentum burst
      pos[i]=dir;
    }
  } else if(ind==='CRSI'){
    const cr=connorsRSI(d.c,P.rsiPeriod||3,P.streakPeriod||2,P.rankPeriod||100);
    const os=P.oversold??30, ob=P.overbought??70;
    osc={crsi:cr};
    for(let i=0;i<n;i++){if(isNaN(cr[i]))continue;if(cr[i]<os)pos[i]=1;else if(cr[i]>ob)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='VWAPBands'){
    const vb=vwapBands(d,P.sd1??1,P.sd2??2);
    overlay={vwap:vb.vwap,up:vb.up1,lo:vb.lo1};
    osc={vwapUp2:vb.up2,vwapLo2:vb.lo2};
    for(let i=0;i<n;i++){if(isNaN(vb.up1[i]))continue;if(d.c[i]<vb.lo1[i])pos[i]=1;else if(d.c[i]>vb.up1[i])pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='CVD'){
    const L=Math.max(5,Math.round(P.lookback||40));
    const cv=cvdSeries(d);
    osc={cvd:cv};
    // divergence scanner: price undercuts trailing low while CVD holds above its value there
    for(let i=0;i<n;i++){
      if(isNaN(cv[i])||i<L)continue;
      let mi=i-1;
      for(let j=Math.max(1,i-L+1);j<i;j++)if(d.c[j]<d.c[mi])mi=j;
      if(d.c[i]<d.c[mi]&&cv[i]>cv[mi])pos[i]=1;
      else {
        let mx=i-1;
        for(let j=Math.max(1,i-L+1);j<i;j++)if(d.c[j]>d.c[mx])mx=j;
        if(d.c[i]>d.c[mx]&&cv[i]<cv[mx])pos[i]=-1;
        else pos[i]=i>0?pos[i-1]:0;
      }
    }
  } else if(ind==='FVG'){
    const fz=fvgZones(d,P.maxZones||5,P.mitAge||60);
    osc={fvgBias:Array.from(fz.bias)};
    for(let i=0;i<n;i++)pos[i]=fz.bias[i]; // +1 tap bull zone, -1 tap bear zone, else flat
  } else if(ind==='HilbertDC'){
    // Dominant-cycle overlay: cycle period + trend/cycle mode. Directional
    // companion is ITrend; this leg alone holds flat (overlay only).
    const hc=hilbertDC(d.c);
    overlay={cyclePeriod:hc.period,cycleMode:Array.from(hc.mode)};
    for(let i=0;i<n;i++){if(isNaN(hc.period[i]))continue;pos[i]=0;}
  } else if(ind==='ITrend'){
    // Ehlers InstantTrend: long when zero-lag line > its trigger.
    const t=itrend(d.c,P.alpha??0.07);
    overlay={itrend:t.trend,itrigger:t.trig};
    for(let i=0;i<n;i++){if(isNaN(t.trend[i])||isNaN(t.trig[i]))continue;pos[i]=t.trend[i]>t.trig[i]?1:-1;}
  } else if(ind==='AdaptRSI'){
    // Cycle-adaptive RSI: length = clamp(round(cycle/2)) from Hilbert DC,
    // gated to range/cycle mode (mode==0); holds last pos otherwise.
    const hc=hilbertDC(d.c);
    const ra=new Float64Array(n).fill(NaN);
    osc={rsi:ra};
    const os=P.oversold??30, ob=P.overbought??70, base=P.baseLen||14;
    for(let i=0;i<n;i++){
      if(i<30)continue; // Hilbert settle quarantine (period estimates unreliable before bar 30)
      const cyc=isNaN(hc.period[i])?null:hc.period[i];
      const len=cyc==null?Math.round(base):Math.max(2,Math.min(50,Math.round(cyc/2)));
      if(i<len)continue;
      // Wilder RSI at adaptive length, computed causally on the window
      let g=0,l=0;
      for(let j=i-len+1;j<=i;j++){const ch=d.c[j]-d.c[j-1];if(ch>0)g+=ch;else l-=ch;}
      const rs=l===0?100:g/Math.max(l,1e-12);
      ra[i]=100-100/(1+rs);
      if(hc.mode[i]===0){pos[i]=i>0?pos[i-1]:0;continue;}
      if(ra[i]<os)pos[i]=1;else if(ra[i]>ob)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='AdaptBB'){
    // Cycle-adaptive Bollinger: length follows the dominant cycle; %B
    // extremes faded only in cycle mode, trend bars hold.
    const hc=hilbertDC(d.c), base=P.baseLen||20, mult=P.mult||2;
    for(let i=0;i<n;i++){
      if(i<30)continue; // Hilbert settle quarantine (period estimates unreliable before bar 30)
      const cyc=isNaN(hc.period[i])?null:hc.period[i];
      const len=cyc==null?Math.round(base):Math.max(10,Math.min(50,Math.round(cyc)));
      if(i<len)continue;
      if(cyc!=null&&hc.mode[i]===0){pos[i]=i>0?pos[i-1]:0;continue;}
      let s=0,s2=0;
      for(let j=i-len+1;j<=i;j++){s+=d.c[j];s2+=d.c[j]*d.c[j];}
      const m=s/len, sd=Math.sqrt(Math.max(0,s2/len-m*m));
      const up=m+mult*sd, lo=m-mult*sd;
      const pb=(d.c[i]-lo)/Math.max(1e-12,up-lo);
      if(pb>0.8)pos[i]=-1;else if(pb<0.2)pos[i]=1;else pos[i]=i>0?pos[i-1]:0;
    }
    overlay={adBBLen:base,adBBMult:mult};
  } else if(ind==='Regime'){
    // Volatility gate: trend-follow EMA only when Choppiness < gate, else flat
    const ch=choppiness(d.h,d.l,d.c,P.chopPeriod||14);
    const e=ema(d.c,P.maPeriod||30), gate=P.gate??61.8;
    osc={chop:ch};overlay={adxMa:e};
    for(let i=0;i<n;i++){
      if(isNaN(ch[i])||isNaN(e[i]))continue;
      pos[i]=ch[i]<gate?(d.c[i]>e[i]?1:-1):0;
    }
  } else if(ind==='Chop'){
    // Standalone consolidation filter: EMA bias only in trend regime, flat in chop
    const ch=choppiness(d.h,d.l,d.c,P.chopPeriod||14);
    const e=ema(d.c,P.maPeriod||30), gate=P.gate??61.8;
    osc={chop:ch};overlay={adxMa:e};
    for(let i=0;i<n;i++){
      if(isNaN(ch[i])||isNaN(e[i]))continue;
      pos[i]=ch[i]<gate?(d.c[i]>e[i]?1:-1):0;
    }
  } else if(ind==='Cyber'){
    // Ehlers cycle zero-cross: cyclical turning-point system
    const cy=cyberCycle(d.c,P.alpha||0.07);
    osc={cyber:cy};
    for(let i=0;i<n;i++){if(isNaN(cy[i]))continue;pos[i]=cy[i]>0?1:-1;}
  } else if(ind==='VWMA'){
    const v=vwma(d.c,d.v,P.period||20);
    overlay={ma:v};
    for(let i=0;i<n;i++){if(isNaN(v[i]))continue;pos[i]=d.c[i]>v[i]?1:-1;}
  } else if(ind==='CMO'){
    const cm=cmo(d.c,P.period||9);
    const os=P.oversold??-50, ob=P.overbought??50;
    osc={cmo:cm};
    for(let i=0;i<n;i++){if(isNaN(cm[i]))continue;if(cm[i]<os)pos[i]=1;else if(cm[i]>ob)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='Aroon'){
    const ar=aroon(d.h,d.l,d.c,P.period||25), lv=P.level||0;
    osc={aroon:ar.osc};
    for(let i=0;i<n;i++){if(isNaN(ar.osc[i]))continue;if(ar.osc[i]>lv)pos[i]=1;else if(ar.osc[i]<-lv)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;}
  } else if(ind==='SqueezeBreak'){
    // P1: squeeze release + volume spike entries; Chande-Kroll structural stops
    // (exit mode 'ck' reads ckPeriod/ckMult via exitOptsFromParams).
    const per=P.period||20;
    const sq=ttmSqueeze(d.h,d.l,d.c,per,P.bbMult||2,per,P.kcMult||1.5);
    const vb=sma(d.v,20);
    const vm=P.volMult||2;
    // volume-less files: total session volume is 0 -> bypass the spike gate (pure squeeze)
    let noVol=true;
    for(let i=0;i<n;i++)if(d.v[i]>0){noVol=false;break;}
    osc={sqzMom:sq.mom};
    let dir=0;
    for(let i=0;i<n;i++){
      if(isNaN(sq.mom[i])||isNaN(vb[i]))continue;
      if(sq.fire[i]&&(noVol||d.v[i]>vm*vb[i]))dir=sq.mom[i]>0?1:-1;
      pos[i]=dir;
    }
  } else if(ind==='TrendRegime'){
    // P2: chop gate (<55 typical) + SuperTrend bias + MACD-hist trigger; muted otherwise
    const ch=choppiness(d.h,d.l,d.c,P.chopPeriod||14);
    const st=supertrend(d.h,d.l,d.c,10,P.stMult||3);
    const mc=macd(d.c,P.macdFast||12,26,9), gate=P.gate??55;
    osc={chop:ch,macdHist:mc.hist};overlay={st:st.st};
    for(let i=0;i<n;i++){
      if(isNaN(ch[i])||isNaN(st.st[i])||isNaN(mc.hist[i]))continue;
      if(ch[i]<gate&&st.dir[i]===1&&mc.hist[i]>0)pos[i]=1;
      else if(ch[i]<gate&&st.dir[i]===-1&&mc.hist[i]<0)pos[i]=-1;
      else pos[i]=0;
    }
  } else if(ind==='VWAPRev'){
    // P3: fade the 1σ→2σ stretch only when CMO shows exhaustion
    const vb=vwapBands(d,P.sd1??1.5,P.sd2??2);
    const cm=cmo(d.c,P.cmoPeriod||5);
    const os=P.cmoOS??-50, ob=P.cmoOB??50;
    overlay={vwap:vb.vwap,up:vb.up1,lo:vb.lo1};osc={cmo:cm};
    for(let i=0;i<n;i++){
      if(isNaN(vb.up1[i])||isNaN(cm[i]))continue;
      if(d.c[i]<vb.lo1[i]&&d.c[i]>vb.lo2[i]&&cm[i]<os)pos[i]=1;
      else if(d.c[i]>vb.up1[i]&&d.c[i]<vb.up2[i]&&cm[i]>ob)pos[i]=-1;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='Ribbon'){
    // EMA Ribbon alignment: full bullish stack (fast>med>slow, close>fast)
    // → long; full bearish stack → short; mixed → hold last.
    const ef=ema(d.c,P.fast||5), em=ema(d.c,P.med||13), es=ema(d.c,P.slow||34);
    overlay={ribF:ef,ribM:em,ribS:es};
    for(let i=0;i<n;i++){
      if(isNaN(ef[i])||isNaN(em[i])||isNaN(es[i]))continue;
      const bull=ef[i]>em[i]&&em[i]>es[i]&&d.c[i]>ef[i];
      const bear=ef[i]<em[i]&&em[i]<es[i]&&d.c[i]<ef[i];
      if(bull)pos[i]=1;else if(bear)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='VWAPSlope'){
    // Session-VWAP slope sign over slopeLen bars (causal, session-aware).
    const v=vwapSeries(d), L=Math.max(2,Math.round(P.slopeLen||5));
    overlay={vwap:v};
    for(let i=0;i<n;i++){
      if(isNaN(v[i])||i<L)continue;
      if(isNaN(v[i-L])){pos[i]=i>0?pos[i-1]:0;continue;}
      const s=(v[i]-v[i-L])/Math.max(1e-12,Math.abs(v[i-L]));
      if(s>0)pos[i]=1;else if(s<0)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='MACDSlope'){
    // MACD histogram slope: hist>0 & rising → long; hist<0 & falling → short.
    const m=macd(d.c,P.fast||12,P.slow||26,P.signal||9), L=Math.max(2,Math.round(P.slopeLen||3));
    osc={macdLine:m.line,macdSig:m.signal,macdHist:m.hist};
    for(let i=0;i<n;i++){
      if(isNaN(m.hist[i])||i<L||isNaN(m.hist[i-L])){if(!isNaN(m.hist[i]))pos[i]=i>0?pos[i-1]:0;continue;}
      const s=m.hist[i]-m.hist[i-L];
      if(m.hist[i]>0&&s>0)pos[i]=1;else if(m.hist[i]<0&&s<0)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='ADXDI'){
    // ADX + DI cross: trend must be strong (ADX>threshold), then +DI/-DI side wins.
    const p=Math.max(2,Math.round(P.length||14)), th=P.threshold??25;
    const n2=n;
    const tr=new Float64Array(n2), pdm=new Float64Array(n2), mdm=new Float64Array(n2);
    for(let i=1;i<n2;i++){
      tr[i]=Math.max(d.h[i]-d.l[i],Math.abs(d.h[i]-d.c[i-1]),Math.abs(d.l[i]-d.c[i-1]));
      const up=d.h[i]-d.h[i-1], dn=d.l[i-1]-d.l[i];
      pdm[i]=(up>dn&&up>0)?up:0; mdm[i]=(dn>up&&dn>0)?dn:0;
    }
    let atr=0,pdi=0,mdi=0; const ax=new Float64Array(n2).fill(NaN);
    const pdiA=new Float64Array(n2).fill(NaN), mdiA=new Float64Array(n2).fill(NaN);
    for(let i=1;i<n2;i++){
      atr=(atr*(p-1)+tr[i])/p; pdi=(pdi*(p-1)+pdm[i])/p; mdi=(mdi*(p-1)+mdm[i])/p;
      if(i<p)continue;
      const pp=atr>0?100*pdi/atr:0, mm=atr>0?100*mdi/atr:0;
      pdiA[i]=pp; mdiA[i]=mm;
      const dx=(pp+mm)>0?100*Math.abs(pp-mm)/(pp+mm):0;
      ax[i]=i===p?dx:(ax[i-1]*(p-1)+dx)/p;
    }
    osc={adx:ax,plusDI:pdiA,minusDI:mdiA};
    for(let i=0;i<n2;i++){
      if(isNaN(ax[i]))continue;
      if(ax[i]<th){pos[i]=i>0?pos[i-1]:0;}
      else pos[i]=pdiA[i]>mdiA[i]?1:-1;
    }
  } else if(ind==='LRSlope'){
    // Linear-regression slope of close over len bars (ordinary least squares,
    // causal window). Sign gives direction; flat slope holds.
    const L=Math.max(3,Math.round(P.length||14));
    const denom=L*(L-1)*(L+1)/12; // Σ(j-mean)² for j=0..L-1
    for(let i=0;i<n;i++){
      if(i<L-1)continue;
      let s=0;const m=(L-1)/2;
      for(let j=0;j<L;j++)s+=(j-m)*d.c[i-L+1+j];
      const slope=s/denom;
      if(slope>0)pos[i]=1;else if(slope<0)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='PctB'){
    // Bollinger %B mean-reversion: %B<thresholds.lo → long, >thresholds.hi → short.
    const b=bollinger(d.c,P.length||20,P.mult||2);
    const lo=P.lo??0.2, hi=P.hi??0.8;
    overlay={mid:b.mid,up:b.up,lo:b.lo};osc={pctB:new Float64Array(n).fill(NaN)};
    for(let i=0;i<n;i++){
      if(isNaN(b.up[i]))continue;
      const pb=(d.c[i]-b.lo[i])/Math.max(1e-12,b.up[i]-b.lo[i]);
      osc.pctB[i]=pb;
      if(pb<lo)pos[i]=1;else if(pb>hi)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='VWAPDev'){
    // Distance from session VWAP in percent vs ±threshold; fade the stretch.
    const v=vwapSeries(d), th=P.thresh??1.0;
    overlay={vwap:v};osc={vwapDev:new Float64Array(n).fill(NaN)};
    for(let i=0;i<n;i++){
      if(isNaN(v[i])||v[i]===0)continue;
      const dev=100*(d.c[i]-v[i])/Math.abs(v[i]);
      osc.vwapDev[i]=dev;
      if(dev<-th)pos[i]=1;else if(dev>th)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='ATRPct'){
    // ATR-as-%-of-price expansion breakout: ATR% above its own SMA × mult →
    // trade the EMA-bias direction; contraction → hold.
    const p=Math.max(2,Math.round(P.length||14)), mult=P.mult||1.5;
    const at=atr(d.h,d.l,d.c,p), e=ema(d.c,Math.max(5,Math.round(P.emaLen||20)));
    const ap=new Float64Array(n).fill(NaN);
    for(let i=0;i<n;i++)ap[i]=d.c[i]>0?100*at[i]/d.c[i]:NaN;
    const apma=sma(ap.filter(v=>!isNaN(v)).length?Float64Array.from(ap.map(v=>isNaN(v)?0:v)):ap,p);
    osc={atrPct:ap};overlay={atrEma:e};
    for(let i=0;i<n;i++){
      if(isNaN(ap[i])||isNaN(apma[i])||isNaN(e[i]))continue;
      if(ap[i]>apma[i]*mult)pos[i]=d.c[i]>e[i]?1:-1;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='BBWidth'){
    // Bollinger BandWidth expansion: width above its trailing-min × mult →
    // expansion breakout in the direction of close vs mid; else hold.
    const L=Math.max(5,Math.round(P.length||20)), mult=P.mult||1.5, lb=Math.max(20,Math.round(P.lookback||100));
    const b=bollinger(d.c,L,2);
    overlay={mid:b.mid};
    for(let i=0;i<n;i++){
      if(isNaN(b.up[i]))continue;
      const w=(b.up[i]-b.lo[i])/Math.max(1e-12,Math.abs(b.mid[i]));
      let mn=Infinity;
      for(let j=Math.max(L,i-lb+1);j<=i;j++){
        if(isNaN(b.up[j]))continue;
        const wj=(b.up[j]-b.lo[j])/Math.max(1e-12,Math.abs(b.mid[j]));
        if(wj<mn)mn=wj;
      }
      if(isFinite(mn)&&w>mn*mult)pos[i]=d.c[i]>b.mid[i]?1:-1;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='ORB'){
    // Opening Range Breakout (IST day): range = high/low of the first orMin
    // minutes of the session day. Break above (+volume confirm) → long, below
    // → short, once direction is set it holds until the opposite break or EOD
    // (session mask). ENTRY BAR = the break bar itself (documented). O(n):
    // day segments + OR levels are precomputed once, not scanned per bar.
    const orMin=Math.max(5,Math.round(P.rangeMin||30)), volMult=P.volMult||2;
    const va=sma(d.v,20);
    const segs=daySegments(d);
    const orH=new Float64Array(n).fill(NaN), orL=new Float64Array(n).fill(NaN);
    for(const sg of segs){
      const p0=istParts(d.t[sg.s]);
      const openMin=p0.h*60+p0.m;
      let e=sg.s;
      while(e<sg.e){const pe=istParts(d.t[e]);if(pe.h*60+pe.m>=openMin+orMin)break;e++;}
      let rh=-Infinity,rl=Infinity;
      for(let j=sg.s;j<e&&j<sg.e;j++){if(d.h[j]>rh)rh=d.h[j];if(d.l[j]<rl)rl=d.l[j];}
      if(!isFinite(rh))continue;
      for(let j=e;j<sg.e;j++){orH[j]=rh;orL[j]=rl;}
    }
    overlay={orbH:orH,orbL:orL};
    for(let i=0;i<n;i++){
      if(isNaN(orH[i])||isNaN(va[i])){if(!isNaN(va[i]))pos[i]=i>0?pos[i-1]:0;continue;}
      const conf=d.v[i]>volMult*va[i];
      if(d.h[i]>orH[i]&&conf)pos[i]=1;
      else if(d.l[i]<orL[i]&&conf)pos[i]=-1;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='InsideBar'){
    // Inside Bar (mode 1/2/3 = single/double/triple): count consecutive
    // inside bars; break of the mother range → signal. ENTRY BAR = break bar.
    const mode=Math.min(3,Math.max(1,Math.round(P.mode||1)));
    let run=0, mh=0, ml=0;
    for(let i=0;i<n;i++){
      if(i===0){pos[i]=0;continue;}
      const inside=d.h[i]<=d.h[i-1]&&d.l[i]>=d.l[i-1];
      if(inside){
        if(run===0){mh=d.h[i-1];ml=d.l[i-1];}
        run++;
        pos[i]=i>0?pos[i-1]:0;
        continue;
      }
      // not inside: possible break of a qualified mother range
      if(run>=mode&&mh>ml){
        if(d.c[i]>mh)pos[i]=1;
        else if(d.c[i]<ml)pos[i]=-1;
        else pos[i]=i>0?pos[i-1]:0;
      } else pos[i]=i>0?pos[i-1]:0;
      run=0;
    }
  } else if(ind==='NR7'){
    // Narrow Range 7: range[i] is the smallest of the last 7 → setup; next
    // bars break high/low → signal. ibOnly=1 additionally requires the NR7
    // bar itself to be inside (NR7+IB). ENTRY BAR = break bar.
    const ibOnly=P.ibOnly?1:0;
    const setup=new Int8Array(n);
    for(let i=0;i<n;i++){
      if(i<6){continue;}
      let mn=Infinity;
      for(let j=i-6;j<=i;j++){const r=d.h[j]-d.l[j];if(r<mn)mn=r;}
      const isNR=(d.h[i]-d.l[i])<=mn+1e-12;
      const isIB=i>0&&d.h[i]<=d.h[i-1]&&d.l[i]>=d.l[i-1];
      if(isNR&&(!ibOnly||isIB))setup[i]=1;
    }
    let armed=-1, ah=0, al=0;
    for(let i=0;i<n;i++){
      if(setup[i]){armed=i;ah=d.h[i];al=d.l[i];pos[i]=i>0?pos[i-1]:0;continue;}
      if(armed>=0&&i-armed<=3){
        if(d.c[i]>ah){pos[i]=1;armed=-1;}
        else if(d.c[i]<al){pos[i]=-1;armed=-1;}
        else pos[i]=i>0?pos[i-1]:0;
      } else {armed=-1;pos[i]=i>0?pos[i-1]:0;}
    }
  } else if(ind==='VolRate'){
    // Volume-confirmed trend: EMA bias only on bars with volume ≥ mult×SMA.
    const L=Math.max(2,Math.round(P.length||20)), mult=P.mult||1.5, ep=Math.max(2,Math.round(P.emaLen||20));
    const va=sma(d.v,L), e=ema(d.c,ep);
    overlay={volEma:e};
    for(let i=0;i<n;i++){
      if(isNaN(va[i])||isNaN(e[i]))continue;
      if(d.v[i]>=mult*va[i])pos[i]=d.c[i]>e[i]?1:-1;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='VolSpike'){
    // Volume spike burst: vol ≥ mult×SMA(len) → trade the bar's direction,
    // else hold. ENTRY BAR = spike bar (next-bar fill recommended).
    const L=Math.max(2,Math.round(P.length||20)), mult=P.mult||2;
    const va=sma(d.v,L);
    for(let i=0;i<n;i++){
      if(isNaN(va[i]))continue;
      if(d.v[i]>=mult*va[i])pos[i]=d.c[i]>=d.o[i]?1:-1;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='VolReg'){
    // Volatility-regime gate: BB-width percentile over lookback; compressed
    // (pctile<gate) → flat; else EMA-bias trend. Router input AND entry filter
    // are the same series — config states which use is active.
    const L=Math.max(5,Math.round(P.length||20)), lb=Math.max(50,Math.round(P.lookback||100));
    const gate=P.gate??40, ep=Math.max(5,Math.round(P.maPeriod||30));
    const b=bollinger(d.c,L,2), e=ema(d.c,ep);
    osc={volGate:new Float64Array(n).fill(NaN)};overlay={volEma:e};
    for(let i=0;i<n;i++){
      if(isNaN(b.up[i])||isNaN(e[i]))continue;
      const w=(b.up[i]-b.lo[i])/Math.max(1e-12,Math.abs(b.mid[i]));
      // trailing percentile by counting (no per-bar sort — O(n·lb) total)
      let rank=0, cnt=0;
      for(let j=Math.max(L,i-lb+1);j<=i;j++){
        if(isNaN(b.up[j]))continue;cnt++;
        if((b.up[j]-b.lo[j])/Math.max(1e-12,Math.abs(b.mid[j]))<=w)rank++;
      }
      if(cnt<20){pos[i]=i>0?pos[i-1]:0;continue;}
      const pct=100*rank/cnt;
      osc.volGate[i]=pct;
      pos[i]=pct<gate?0:(d.c[i]>e[i]?1:-1);
    }
  } else if(ind==='KaufER'){
    // Kaufman Efficiency Ratio gate: ER>trendTh → EMA trend; ER<rangeTh →
    // flat; between → hold. Entry-filter use and router-input use are the
    // same series — config states which use is active.
    const erP=Math.max(2,Math.round(P.erPeriod||10)), tT=P.trendTh??0.3, rT=P.rangeTh??0.15;
    const ep=Math.max(2,Math.round(P.maPeriod||20));
    const e=ema(d.c,ep);
    osc={ker:new Float64Array(n).fill(NaN)};overlay={kerEma:e};
    for(let i=0;i<n;i++){
      if(i<erP||isNaN(e[i]))continue;
      const chg=Math.abs(d.c[i]-d.c[i-erP]);
      let vol=0;
      for(let j=0;j<erP;j++)vol+=Math.abs(d.c[i-j]-d.c[i-j-1]);
      const er=vol>0?chg/vol:0;
      osc.ker[i]=er;
      if(er>tT)pos[i]=d.c[i]>e[i]?1:-1;
      else if(er<rT)pos[i]=0;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='DecaySlope'){
    // PREMIUM decay slope (NOT theta): linear-regression slope of log-premium
    // over len bars, in %/bar. slope>thresh → premium appreciating (long);
    // slope<-thresh → decaying (short/flat leg). Causal window. Buy-only is
    // enforced at the desk, not here.
    const L=Math.max(3,Math.round(P.length||20)), th=P.thresh??0.05;
    const denom=L*(L-1)*(L+1)/12, m0=(L-1)/2;
    osc={decay:new Float64Array(n).fill(NaN)};
    for(let i=0;i<n;i++){
      if(i<L-1||d.c[i-L+1]<=0)continue;
      let s=0,ok=true;
      for(let j=0;j<L;j++){const px=d.c[i-L+1+j];if(!(px>0)){ok=false;break;}s+=(j-m0)*Math.log(px);}
      if(!ok)continue;
      const slope=100*s/denom; // %/bar
      osc.decay[i]=slope;
      if(slope>th)pos[i]=1;else if(slope<-th)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='TrendFollow'){
    // Preset P1: EMA-ribbon alignment + SuperTrend direction + ADX gate +
    // optional volume confirm. ALL legs must agree; else hold.
    const ef=ema(d.c,P.fast||8), em=ema(d.c,P.med||21), es=ema(d.c,P.slow||55);
    const st=supertrend(d.h,d.l,d.c,P.atrP||10,P.stMult||3);
    const ax=adx(d.h,d.l,d.c,P.adxP||14), th=P.adxTh??25;
    const useVol=P.useVol?1:0, va=sma(d.v,Math.max(2,Math.round(P.volLen||20))), vm=P.volMult||2;
    overlay={tfEmaF:ef,tfST:st.st};osc={tfAdx:ax};
    for(let i=0;i<n;i++){
      if(isNaN(ef[i])||isNaN(em[i])||isNaN(es[i])||isNaN(st.st[i])||isNaN(ax[i]))continue;
      const bull=ef[i]>em[i]&&em[i]>es[i]&&st.dir[i]===1&&ax[i]>th;
      const bear=ef[i]<em[i]&&em[i]<es[i]&&st.dir[i]===-1&&ax[i]>th;
      const vok=!useVol||(!isNaN(va[i])&&d.v[i]>vm*va[i]);
      if(!vok){pos[i]=i>0?pos[i-1]:0;continue;}
      if(bull)pos[i]=1;else if(bear)pos[i]=-1;else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='VWAPMR'){
    // Preset P2: VWAP mean-reversion with RSI confirm. Below lower band +
    // oversold → long leg (maps to LONG CE on the options desk); above upper
    // + overbought → short leg (maps to LONG PE). Buy-only enforced at desk.
    const vb=vwapBands(d,P.sd1??1,P.sd2??2);
    const r=rsi(d.c,P.rsiP||14), os=P.oversold??30, ob=P.overbought??70;
    overlay={vwap:vb.vwap,up:vb.up1,lo:vb.lo1};osc={mrRsi:r};
    for(let i=0;i<n;i++){
      if(isNaN(vb.up1[i])||isNaN(r[i]))continue;
      const revUp=i>0&&!isNaN(vb.up1[i-1])&&d.c[i-1]>vb.up1[i-1]&&d.c[i]<=vb.up1[i];
      const revDn=i>0&&!isNaN(vb.lo1[i-1])&&d.c[i-1]<vb.lo1[i-1]&&d.c[i]>=vb.lo1[i];
      if(d.c[i]<vb.lo1[i]&&r[i]<os)pos[i]=1;
      else if(d.c[i]>vb.up1[i]&&r[i]>ob)pos[i]=-1;
      else if(revUp||revDn)pos[i]=i>0?pos[i-1]:0;
      else pos[i]=i>0?pos[i-1]:0;
    }
  } else if(ind==='PAIR'){
    // Stage-2 discovery combination: AND-agreement of two base legs on the
    // SAME bars (params a/ap/b/bp encode {indicator, params} JSON each).
    // Created only by the pair post-pass — never gridded directly (SCHEMA
    // PAIR is empty). Both legs are causal, so the combination is causal.
    // Nested PAIR legs are refused (flat) to bound recursion.
    let pa=null, pb=null;
    try{
      const a={indicator:P.a,params:JSON.parse(P.ap||'null')};
      const b={indicator:P.b,params:JSON.parse(P.bp||'null')};
      if(a.indicator&&a.indicator!=='PAIR'&&a.params)pa=buildSignals(d,{indicator:a.indicator,params:a.params}).pos;
      if(b.indicator&&b.indicator!=='PAIR'&&b.params)pb=buildSignals(d,{indicator:b.indicator,params:b.params}).pos;
    }catch(e){/* malformed legs → flat */}
    osc={pairAgree:new Float64Array(n).fill(NaN)};
    let ag=0, tot=0;
    for(let i=0;i<n;i++){
      const ok=pa&&pb&&pa[i]!==0&&pa[i]===pb[i];
      pos[i]=ok?pa[i]:0;
      if(pa&&pb&&pa[i]!==0&&pb[i]!==0){tot++;if(ok)ag++;}
      osc.pairAgree[i]=tot?ag/tot:NaN;
    }
  }
  return {pos,overlay,osc};
}

// Preset exit parameters live in signal params; the backtester reads opts.
// This bridge carries them across (used by worker, fallback, detail, compare).
function exitOptsFromParams(indicator, params){
  const P=params||{};
  if(indicator==='SqueezeBreak')return {ckPeriod:P.period||20, ckMult:P.ckMult||3};
  return null;
}

// ---------- market regimes (unsupervised, OHLCV only) ----------
// 0 = trend-up, 1 = trend-down, 2 = range-high-vol, 3 = range-low-vol
function regimeSeries(d, o){
  o=o||{};
  const chopP=Math.max(5,Math.round(o.chopPeriod||14));
  const adxGate=o.adxGate!=null?o.adxGate:20;
  const volGate=o.volGate!=null?o.volGate:0.6;
  const n=d.c.length, out=new Int8Array(n);
  const ch=choppiness(d.h,d.l,d.c,chopP);
  const ax=adx(d.h,d.l,d.c,14);
  const at=atr(d.h,d.l,d.c,14);
  const ef=ema(d.c,20), es=ema(d.c,50);
  const vp=new Float64Array(n);
  for(let i=0;i<n;i++)vp[i]=d.c[i]>0?at[i]/d.c[i]:0;
  for(let i=0;i<n;i++){
    if(isNaN(ch[i])||isNaN(ax[i])||isNaN(vp[i])){out[i]=3;continue;}
    // trailing volatility rank over 100 bars (causal)
    const s=Math.max(0,i-100);
    let below=0,cnt=0;
    for(let j=s;j<i;j++){cnt++;if(vp[j]<vp[i])below++;}
    const vr=cnt>0?below/cnt:0.5;
    const trending=ax[i]>=adxGate;
    const up=ef[i]>=es[i];
    out[i]=trending?(up?0:1):(vr>=volGate?2:3);
  }
  return out;
}
// Router: which regimes each leg may trade. Unlisted legs trade everywhere.
const ROUTER={
  EMA:[0,1],SMA:[0,1],HMA:[0,1],DEMA:[0,1],KAMA:[0,1],MACD:[0,1],SuperTrend:[0,1],
  ADX:[0,1],Aroon:[0,1],VWMA:[0,1],TrendRegime:[0,1],CVD:[0,1,2],
  Bollinger:[2,3],RSI:[2,3],Stochastic:[2,3],CRSI:[2,3],CMO:[2,3],Fisher:[2,3],
  VWAP:[2,3],VWAPBands:[2,3],VWAPRev:[2,3],
  Keltner:[0,1,2],Squeeze:[0,1,2],SqueezeBreak:[0,1,2],ChandeKroll:[0,1,2],
  POC:[2,3],FVG:[2,3],Cyber:[2,3],
  Chop:[0,1,2,3],Regime:[0,1,2,3],
  ITrend:[0,1],HilbertDC:[0,1,2,3],AdaptRSI:[2,3],AdaptBB:[2,3],
  Ribbon:[0,1],VWAPSlope:[0,1],MACDSlope:[0,1],ADXDI:[0,1],LRSlope:[0,1],
  ATRPct:[0,1,2],TrendFollow:[0,1],KaufER:[0,1],VolReg:[0,1,2,3],
  PctB:[2,3],VWAPDev:[2,3],VWAPMR:[2,3],
  BBWidth:[0,1,2],ORB:[0,1,2],InsideBar:[0,1,2,3],NR7:[0,1,2,3],
  VolRate:[0,1,2,3],VolSpike:[0,1,2],
  DecaySlope:[0,1,2,3]
};
// Indicator family tags for diversity tracking (no optimization score is
// built from these — they only describe information content so reviewers and
// the run log can spot redundant all-momentum stacks).
const FAMILY={
  EMA:'trend',SMA:'trend',HMA:'trend',DEMA:'trend',KAMA:'trend',VWMA:'trend',
  MACD:'momentum',MACDSlope:'momentum',RSI:'momentum',CRSI:'momentum',CMO:'momentum',
  Stochastic:'momentum',Fisher:'momentum',Cyber:'momentum',Aroon:'momentum',
  Bollinger:'meanrev',PctB:'meanrev',Keltner:'vol',BBWidth:'vol',Squeeze:'vol',
  SuperTrend:'trend',ADX:'trend',ADXDI:'trend',ChandeKroll:'vol',ITrend:'trend',
  Ribbon:'trend',LRSlope:'trend',TrendRegime:'preset',TrendFollow:'preset',
  SqueezeBreak:'preset',VWAP:'meanrev',VWAPBands:'meanrev',VWAPRev:'preset',VWAPMR:'preset',
  VWAPDev:'meanrev',VWAPSlope:'trend',POC:'volume',CVD:'volume',VolRate:'volume',
  VolSpike:'volume',ATRPct:'vol',ORB:'vol',InsideBar:'pattern',NR7:'pattern',FVG:'pattern',
  Regime:'regime',Chop:'regime',VolReg:'regime',KaufER:'regime',
  HilbertDC:'regime',AdaptRSI:'meanrev',AdaptBB:'meanrev',DecaySlope:'options',
  PAIR:'preset',
};
function regimeMask(regimes, indicator){
  const allow=ROUTER[indicator];
  const n=regimes.length, out=new Int8Array(n);
  if(!allow){out.fill(1);return out;}
  for(let i=0;i<n;i++)out[i]=allow.indexOf(regimes[i])>=0?1:0;
  return out;
}
// ---------- Router v2: persistence + hysteresis (anti flip-flop) ----------
// smoothRegime: a regime label must persist `persist` bars before it is
// confirmed; after any confirmed switch, the next switch costs an extra
// `hysteresis` bars. Bars inside an unconfirmed transition keep the last
// confirmed label (never 0/flat — transitions hold, they don't blank).
// applyMaskPersistence: suppress isolated allow-runs shorter than minBars in
// a 0/1 trade mask (kills single-bar flicker entries).
function smoothRegime(regimes, persist, hysteresis){
  persist=Math.max(1,Math.round(persist||5));hysteresis=Math.max(0,Math.round(hysteresis||2));
  const n=regimes.length, out=new Int8Array(n);
  if(!n)return out;
  let confirmed=regimes[0], need=persist, contender=-999, run=0;
  for(let i=0;i<n;i++){
    const r=regimes[i];
    if(r===confirmed){contender=-999;run=0;}
    else{
      if(r!==contender){contender=r;run=1;}else run++;
      if(run>=need){confirmed=r;need=persist+hysteresis;contender=-999;run=0;}
    }
    out[i]=confirmed;
  }
  return out;
}
function applyMaskPersistence(mask, minBars){
  minBars=Math.max(1,Math.round(minBars||3));
  const n=mask.length, out=Int8Array.from(mask);
  let i=0;
  while(i<n){
    if(out[i]===1){
      let j=i;while(j<n&&out[j]===1)j++;
      if(j-i<minBars)for(let k=i;k<j;k++)out[k]=0;
      i=j;
    } else i++;
  }
  return out;
}

// ---------- ML regime classifier (multinomial softmax, deterministic) ----------
// Features are scale-free and causal (no rolling fits). Target = dominant
// rule-regime over the NEXT K bars. Train in-sample, apply everywhere.
function regimeFeatures(d){
  const n=d.c.length;
  const ch=choppiness(d.h,d.l,d.c,14), ax=adx(d.h,d.l,d.c,14);
  const at=atr(d.h,d.l,d.c,14);
  const bb=bollinger(d.c,20,2), mc=macd(d.c,12,26,9), ef=ema(d.c,20), es=ema(d.c,50);
  const rs=rsi(d.c,14), vsma=sma(d.v,50);
  const F=10, X=new Float64Array(n*F);
  for(let i=0;i<n;i++){
    const a=at[i]||1e-9, c=d.c[i]||1;
    const bw=(isNaN(bb.up[i])||bb.mid[i]===0)?0:(bb.up[i]-bb.lo[i])/Math.abs(bb.mid[i]);
    const f=[
      (isNaN(ch[i])?62:ch[i])/100, (isNaN(ax[i])?20:ax[i])/100,
      Math.min(2,bw*10), Math.min(0.05,a/c)*20,
      (isNaN(rs[i])?50:rs[i])/100,
      (isNaN(mc.hist[i])?0:mc.hist[i])/a,
      (!isNaN(ef[i])&&!isNaN(es[i]))?(ef[i]-es[i])/a:0,
      vsma[i]>0?Math.min(3,(d.v[i]||0)/vsma[i]):1,
      0.5, 0
    ];
    const ip=istParts(d.t[i]);
    f[8]=((ip.h*60+ip.m)-555)/375; // minutes since 09:15 IST / session
    for(let k=0;k<F;k++)X[i*F+k]=(k===F-1)?1:(isFinite(f[k])?f[k]:0);
  }
  return {X, n, p:F};
}
function trainSoftmax(X, y, n, p, C, iters, lr, l2){
  const W=new Float64Array(C*p); // zeros: deterministic
  const probs=new Float64Array(C);
  for(let it=0;it<iters;it++){
    const G=new Float64Array(C*p);
    for(let i=0;i<n;i++){
      let mx=-1e18;
      for(let c=0;c<C;c++){let s=0;for(let k=0;k<p;k++)s+=W[c*p+k]*X[i*p+k];probs[c]=s;if(s>mx)mx=s;}
      let den=0;for(let c=0;c<C;c++){probs[c]=Math.exp(probs[c]-mx);den+=probs[c];}
      for(let c=0;c<C;c++){
        const pr=probs[c]/den, tgt=(y[i]===c)?1:0, err=pr-tgt;
        for(let k=0;k<p;k++)G[c*p+k]+=err*X[i*p+k]/n;
      }
    }
    for(let w=0;w<C*p;w++)W[w]-=lr*(G[w]+l2*W[w]);
  }
  return W;
}
function predictSoftmax(X, W, n, p, C){
  const out=new Int8Array(n);
  for(let i=0;i<n;i++){
    let bc=0,bs=-1e18;
    for(let c=0;c<C;c++){let s=0;for(let k=0;k<p;k++)s+=W[c*p+k]*X[i*p+k];if(s>bs){bs=s;bc=c;}}
    out[i]=bc;
  }
  return out;
}
// Train on rows [0,isN), return weights + train accuracy + predictions for all rows.
// Training subset is strided to ≤ maxTrain rows (speed); prediction covers all.
function trainRegimeML(d, isFrac, K, iters, maxTrain){
  K=K||15;iters=iters||200;maxTrain=maxTrain||5000;
  const f=regimeFeatures(d);
  const X=f.X,n=f.n,p=f.p;
  const rule=regimeSeries(d,{});
  const y=new Int8Array(n);
  for(let i=0;i<n;i++){
    const e=Math.min(n,i+K), cnt=[0,0,0,0];
    for(let j=i;j<e;j++)cnt[rule[j]]++;
    let b=0;for(let c=1;c<4;c++)if(cnt[c]>cnt[b])b=c;
    y[i]=b;
  }
  const isN=Math.max(100,Math.floor(n*isFrac));
  const stride=Math.max(1,Math.floor(isN/maxTrain));
  const nS=Math.ceil(isN/stride);
  const Xs=new Float64Array(nS*p), ys=new Int8Array(nS);
  for(let s=0;s<nS;s++){const i=s*stride;ys[s]=y[i];for(let k=0;k<p;k++)Xs[s*p+k]=X[i*p+k];}
  // Standardize on the training rows (deterministic): unscaled features with
  // ~10x scale spreads stall full-batch GD near uniform (= mass fallback).
  const mu=new Float64Array(p), sd=new Float64Array(p);
  for(let k=0;k<p;k++){let s=0;for(let s2=0;s2<nS;s2++)s+=Xs[s2*p+k];mu[k]=s/Math.max(1,nS);}
  for(let k=0;k<p;k++){
    if(k===p-1){sd[k]=1;continue;} // bias stays 1
    let v=0;for(let s2=0;s2<nS;s2++){const d=Xs[s2*p+k]-mu[k];v+=d*d;}
    sd[k]=Math.sqrt(v/Math.max(1,nS))||1;
  }
  for(let s2=0;s2<nS;s2++)for(let k=0;k<p-1;k++)Xs[s2*p+k]=(Xs[s2*p+k]-mu[k])/sd[k];
  const W=trainSoftmax(Xs,ys,nS,p,4,iters,0.5,0.001);
  // predict with the SAME scaling
  const XsF=new Float64Array(n*p);
  for(let i=0;i<n;i++)for(let k=0;k<p-1;k++)XsF[i*p+k]=(X[i*p+k]-mu[k])/sd[k];
  for(let i=0;i<n;i++)XsF[i*p+p-1]=1;
  const pred=predictSoftmax(XsF,W,n,p,4);
  let hit=0;for(let i=0;i<isN;i++)if(pred[i]===y[i])hit++;
  return {W:Array.from(W), p, trainAcc:isN?hit/isN:0, pred:Array.from(pred), n, stride};
}

// ---------- day-level regimes: classify each SESSION, trade its legs ----------
// A session gets ONE label (stable, interpretable, cheap). Prediction uses
// strictly prior-session bars — no leakage by construction.
function daySegments(d){
  const segs=[];let s=0,cur='';
  const key=t=>istDayKey(t);
  for(let i=0;i<d.t.length;i++){
    const k=key(d.t[i]);
    if(i===0)cur=k;
    if(k!==cur){segs.push({s:s,e:i,label:cur});s=i;cur=k;}
  }
  if(d.t.length)segs.push({s:s,e:d.t.length,label:cur});
  return segs;
}
// 8 features from ONE session's bars only ([s,e)); last-bar indicator reads.
function dayFeatures(d, s, e, pre){
  pre=pre||{};
  const ch=pre.ch||choppiness(d.h,d.l,d.c,14);
  const ax=pre.ax||adx(d.h,d.l,d.c,14);
  const at=pre.at||atr(d.h,d.l,d.c,14);
  const ef=pre.ef||ema(d.c,20), es=pre.es||ema(d.c,50);
  const i=e-1;
  const a=at[i]||1e-9, c=d.c[i]||1;
  let hh=-Infinity,ll=Infinity,vv=0;
  for(let j=s;j<e;j++){if(d.h[j]>hh)hh=d.h[j];if(d.l[j]<ll)ll=d.l[j];vv+=d.v[j]||0;}
  if(!isFinite(hh)||!isFinite(ll)){hh=c;ll=c;}
  const s0=Math.max(0,i-100);
  let below=0,cnt=0;
  for(let j=s0;j<i;j++){cnt++;if((d.c[j]>0?at[j]/d.c[j]:0)<a/c)below++;}
  const gap=s>0&&d.c[s-1]? (d.o[s]-d.c[s-1])/d.c[s-1] : 0;
  return [
    (isNaN(ch[i])?62:ch[i])/100, (isNaN(ax[i])?20:ax[i])/100,
    cnt>0?below/cnt:0.5,
    c>0?(hh-ll)/c:0, gap,
    (!isNaN(ef[i])&&!isNaN(es[i]))?(ef[i]-es[i])/a:0,
    c>0?(c-d.o[s])/d.o[s]:0,
    Math.min(3,vv/Math.max(1,(e-s)*20000))
  ];
}
// Majority rule-regime inside each session (training labels / rules source).
function dayRuleLabels(d, rule){
  const segs=daySegments(d);
  return segs.map(sg=>{
    const cnt=[0,0,0,0];
    for(let i=sg.s;i<sg.e;i++)cnt[rule[i]]++;
    let b=3;for(let c=0;c<4;c++)if(cnt[c]>cnt[b])b=c;
    return b;
  });
}
// Train day-ML: X = features(session i-1) -> y = label(session i). Deterministic.
function trainDayML(d, K){
  K=K||0; // reserved (forward offset in sessions; 0 = next session)
  const segs=daySegments(d);
  const D=segs.length, F=13; // 8 session features + 4-dim one-hot previous label + bias
  const pre={ch:choppiness(d.h,d.l,d.c,14),ax:adx(d.h,d.l,d.c,14),at:atr(d.h,d.l,d.c,14),ef:ema(d.c,20),es:ema(d.c,50)};
  const rule=regimeSeries(d,{});
  const labels=dayRuleLabels(d,rule);
  const n=D-1;
  const X=new Float64Array(Math.max(0,n)*F), y=new Int8Array(Math.max(0,n));
  for(let i=1;i<D;i++){
    const f=dayFeatures(d,segs[i-1].s,segs[i-1].e,pre);
    for(let k=0;k<8;k++)X[(i-1)*F+k]=isFinite(f[k])?f[k]:0;
    const pl=i-2>=0?labels[i-1]:-1; // previous session's rule label (causal)
    for(let c=0;c<4;c++)X[(i-1)*F+8+c]=(pl===c)?1:0;
    X[(i-1)*F+F-1]=1;
    y[i-1]=labels[i];
  }
  // Standardize on training rows (deterministic): unscaled spreads stall GD.
  const mu=new Float64Array(F), sd=new Float64Array(F);
  for(let k=0;k<F;k++){let s=0;for(let s2=0;s2<n;s2++)s+=X[s2*F+k];mu[k]=n>0?s/n:0;}
  for(let k=0;k<F;k++){
    if(k===F-1||k>=8){sd[k]=1;continue;} // bias + one-hots stay as-is
    let v=0;for(let s2=0;s2<n;s2++){const dd=X[s2*F+k]-mu[k];v+=dd*dd;}
    sd[k]=Math.sqrt(v/Math.max(1,n))||1;
  }
  for(let s2=0;s2<n;s2++)for(let k=0;k<8;k++)X[s2*F+k]=(X[s2*F+k]-mu[k])/sd[k];
  const W=n>0?trainSoftmax(X,y,n,F,4,500,0.5,0.001):new Float64Array(4*F);
  const MU=Array.from(mu), SD=Array.from(sd);
  function featScaled(i){ // session i's feature row, same scaling (i>=1)
    const f=dayFeatures(d,segs[i-1].s,segs[i-1].e,pre);
    const fv=[];
    for(let k=0;k<8;k++){const v=isFinite(f[k])?f[k]:0;fv.push((v-MU[k])/SD[k]);}
    const pl=i-2>=0?labels[i-1]:-1;
    for(let c=0;c<4;c++)fv.push(pl===c?1:0);
    fv.push(1);
    return fv;
  }
  // predict every session (session 0 has no prior -> mark unknown)
  const pred=new Int8Array(D).fill(-1), conf=new Float64Array(D);
  for(let i=1;i<D;i++){
    const fv=featScaled(i);
    let bc=0,bs=-1e18;const sc=[];
    for(let c=0;c<4;c++){let s=0;for(let k=0;k<F;k++)s+=W[c*F+k]*fv[k];sc.push(s);if(s>bs){bs=s;bc=c;}}
    let den=0;for(let c=0;c<4;c++)den+=Math.exp(sc[c]-bs);
    pred[i]=bc;conf[i]=1/den; // softmax max-probability, always ≤ 1
  }
  let hit=0;for(let i=1;i<D;i++)if(pred[i]===labels[i])hit++;
  return {W:Array.from(W),F,segs:segs.map(s=>({s:s.s,e:s.e,label:s.label})),labels,pred:Array.from(pred),conf:Array.from(conf),
    acc:D>1?hit/(D-1):0, sessions:D};
}
// Day-constant trade mask: whole session allowed/blocked per router.
// fallbackDays (low confidence / session 0 / ML missing) trade UNROUTED (all 1)
// and are COUNTED — fallback impact is measured, never silent.
function dayRegimeMask(d, dayReg, indicator, confGate){
  const n=d.c.length, out=new Int8Array(n), fb=new Int8Array(n);
  const allow=ROUTER[indicator];
  for(let s=0;s<dayReg.segs.length;s++){
    const sg=dayReg.segs[s];
    const fbDay=dayReg.pred[s]<0||(dayReg.conf&&dayReg.conf[s]<confGate);
    for(let i=sg.s;i<sg.e&&i<n;i++){out[i]=1;fb[i]=0;}
    if(!fbDay&&allow){
      for(let i=sg.s;i<sg.e&&i<n;i++)out[i]=allow.indexOf(dayReg.pred[s])>=0?1:0;
    } else if(fbDay){
      for(let i=sg.s;i<sg.e&&i<n;i++)fb[i]=1;
    }
  }
  let fbN=0;for(let i=0;i<n;i++)if(fb[i])fbN++;
  return {mask:out, fallbackBars:fbN};
}

// Single choke-point for ALL day-routing decisions (worker, fallback, detail,
// walk-forward, validation). Identical rules everywhere — no silent divergence.
// Returns {dayReg:{segs,pred,conf}, mlAcc|null, notices[], fallbackDays, ok}
function dayRouting(d, o){
  o=o||{};
  const source=o.source||'rules', confGate=o.confGate!=null?o.confGate:0.6;
  const segs=daySegments(d);
  const notices=[];
  if(segs.length<5){
    return {dayReg:null, mlAcc:null, notices:['<5 sessions: routing disabled, all legs trade everywhere'], fallbackDays:segs.length, ok:false};
  }
  if(source==='ml'){
    const trainable=segs.length-1;
    if(trainable<20){
      // LOUD fallback: genuinely use RULE labels (not unrouted) — verified below
      const rule=regimeSeries(d,{});
      const labels=dayRuleLabels(d,rule);
      notices.push('ML unavailable: '+trainable+' trainable sessions (<20) — RULE regimes used instead');
      return {dayReg:{segs:segs.map(s=>({s:s.s,e:s.e,label:s.label})),pred:labels,conf:labels.map(()=>1)}, mlAcc:null, notices, fallbackDays:0, ok:true, mlFallback:true};
    }
    const m=trainDayML(d);
    let hi=0;for(let i=1;i<m.conf.length;i++)if(m.conf[i]>=confGate)hi++;
    notices.push('ML day-model: train-acc '+(100*m.acc).toFixed(1)+'%, '+hi+'/'+(segs.length-1)+' confident days ≥ '+Math.round(confGate*100)+'% (rest fallback, counted)');
    return {dayReg:{segs:segs.map(s=>({s:s.s,e:s.e,label:s.label})),pred:m.pred,conf:m.conf}, mlAcc:m.acc, notices, fallbackDays:0, ok:true};
  }
  const rule=regimeSeries(d,{});
  const labels=dayRuleLabels(d,rule);
  return {dayReg:{segs:segs.map(s=>({s:s.s,e:s.e,label:s.label})),pred:labels,conf:labels.map(()=>1)}, mlAcc:null, notices:['rule regimes (no ML)'], fallbackDays:0, ok:true};
}

// ---------- layer validation: assert everything, assume nothing ----------
// Returns checks [{name, pass, warn, detail}]. FAIL = hard error surface;
// warn = amber. Callers must surface failures LOUDLY (banner + log), never silent.
function validateLayers(d, o){
  o=o||{};
  const out=[];
  const n=d.t.length;
  out.push({name:'D1 bars present',pass:n>50,warn:false,detail:n+' 1m bars'});
  let asc=true;for(let i=1;i<n;i+=Math.max(1,Math.floor(n/50000)))if(d.t[i]<=d.t[i-1]){asc=false;break;}
  out.push({name:'D2 timestamps ascending',pass:asc,warn:false,detail:asc?'ordered':'OUT OF ORDER'});
  let hasVol=false;for(let i=0;i<n;i+=Math.max(1,Math.floor(n/50000)))if(d.v[i]>0){hasVol=true;break;}
  out.push({name:'D3 volume present (else volume legs degrade)',pass:true,warn:!hasVol,detail:hasVol?'volume OK':'NO VOLUME — POC skipped, VWAP/VWMA fall back, Squeeze spike bypassed'});
  const segs=daySegments(d);
  out.push({name:'R1 ≥5 sessions for day regimes',pass:segs.length>=5,warn:false,detail:segs.length+' sessions'});
  if(segs.length>=5){
    const rule=regimeSeries(d,{});
    const labels=dayRuleLabels(d,rule);
    const cov=[0,0,0,0];labels.forEach(l=>cov[l]++);
    out.push({name:'R2 regime classes covered',pass:true,warn:cov.some(c=>c===0),detail:'T+/T-/RH/RL = '+cov.join('/')});
  }
  if(o.ml){
    out.push({name:'M1 ML training sessions ≥20',pass:segs.length-1>=20,warn:false,detail:(segs.length-1)+' trainable sessions'});
    if(segs.length-1>=20){
      const a=trainDayML(d), b=trainDayML(d);
      let same=true;for(let i=0;i<a.W.length;i++)if(a.W[i]!==b.W[i]){same=false;break;}
      out.push({name:'M2 ML deterministic (identical weights)',pass:same,warn:false,detail:same?'bit-identical':'NON-DETERMINISTIC'});
      out.push({name:'M3 ML beats chance (>25%)',pass:a.acc>0.25,warn:false,detail:(100*a.acc).toFixed(1)+'% train acc'});
      let fin=true;for(let i=0;i<a.W.length;i++)if(!isFinite(a.W[i])){fin=false;break;}
      out.push({name:'M5 ML weights finite (no blowup)',pass:fin,warn:false,detail:fin?'all ' +a.W.length+' weights finite':'NON-FINITE WEIGHTS'});
      const seen={};for(let i=1;i<a.pred.length;i++)seen[a.pred[i]]=1;
      const ncov=Object.keys(seen).length;
      out.push({name:'M6 ML predicts ≥2 classes (not collapsed)',pass:true,warn:ncov<2,detail:ncov+' distinct predicted classes'});
      let hi=0;for(let i=1;i<a.conf.length;i++)if(a.conf[i]>=(o.confGate||0.6))hi++;
      const cov=segs.length>1?hi/(segs.length-1):0;
      out.push({name:'M4 confident-day coverage',pass:true,warn:cov<0.3,detail:(100*cov).toFixed(0)+'% days ≥ gate (rest fallback, measured)'});
    }
  }
  if(o.wf){
    const span=d.t[n-1]-d.t[0];
    out.push({name:'W1 OOS span viable',pass:span>0,warn:false,detail:'split '+o.wfSplit+'/'+(100-o.wfSplit)});
  }
  // L8 stop/target reachability: with TP/SL armed and enough trades, at least
  // one of each should bind. Zero binds with TP 1% + avg wins far above it
  // means either divine trend-following or a price-scale/file-layout problem.
  if(o.exits){
    const sig=o.exits.sig, bt=o.exits.bt;
    if(bt&&bt.trades.length>=20){
      const tpN=bt.trades.filter(t=>t.reason==='TP').length;
      const slN=bt.trades.filter(t=>['SL','BE','ATR','CK','TRAIL'].indexOf(t.reason)>=0).length;
      let avgWin=0,nw=0;
      for(const t of bt.trades)if(t.pnl>0){avgWin+=t.pnl;nw++;}
      avgWin=nw?avgWin/nw:0;
      out.push({name:'L8a targets bind (TP%)',pass:true,warn:tpN===0,
        detail:tpN+' TP exits / '+bt.trades.length+' trades · avg win ₹'+avgWin.toFixed(0)});
      out.push({name:'L8b stops bind (SL/BE/ATR/CK/TRAIL)',pass:true,warn:slN===0,
        detail:slN+' stop exits / '+bt.trades.length+' trades'});
    } else {
      out.push({name:'L8 stop/target reachability',pass:true,warn:true,detail:'<20 trades — skipped as inconclusive'});
    }
  }
  return out;
}

// ---------- backtest ----------
function timeToMin(s){const[a,b]=s.split(':').map(Number);return a*60+b;}
// ---------- Timezone pin: Asia/Kolkata (IST, fixed +05:30, no DST) ----------
// Strategy/session math MUST NOT depend on viewer-local time: session masks,
// day boundaries, VWAP/CVD resets, expiry-day checks and ML clock features
// all use IST wall-clock derived from epoch ms. Only display formatting may
// use local time. Verified identical under TZ=UTC/Asia_Kolkata/America_New_York.
const IST_OFFSET_MS=19800000;
function istParts(t){ const d=new Date(t+IST_OFFSET_MS); return {h:d.getUTCHours(),m:d.getUTCMinutes(),y:d.getUTCFullYear(),mo:d.getUTCMonth(),day:d.getUTCDate()}; }
function istDayKey(t){ const p=istParts(t); return p.y+'-'+p.mo+'-'+p.day; }
function istDayIndex(t){ return Math.floor((t+IST_OFFSET_MS)/86400000); }
function istFromNaive(ms){ // reinterpret a locally-parsed naive stamp as IST wall-clock
  const off=new Date(ms).getTimezoneOffset()*60000;
  return ms-off-IST_OFFSET_MS;
}
// ---------- Exchange-aware sessions ----------
// NSE equity/F&O 09:15–15:30 IST; MCX commodities 09:00–23:30; NCDEX 09:00–21:00.
// detectExchange sniffs the symbol; resolveSession returns {exchange,start,end}
// with explicit user times winning over the preset (custom choice is kept).
const EXCHANGE_SESSIONS={
  NSE:{start:'09:15',end:'15:30'}, MCX:{start:'09:00',end:'23:30'}, NCDEX:{start:'09:00',end:'21:00'},
};
const MCX_PREFIX=['CRUDEOIL','CRUDE','GOLD','SILVER','COPPER','ZINC','LEAD','NICKEL','ALUMINIUM','NATURALGAS','COTTON','CPO','MENTHAOIL','CARDAMOM','CASTORSEED','DHANIYA','GUARGUM','GUARSEED','JEERA','KAPAS','MUSTARD','PEPPER','RBDPALMOLEIN','RUBBER','SOYBEAN','SOYOIL','SUNFLOWEROIL','WHEAT','BARLEY','BAJRA','CHANA','MOONG','URAD','TURMERIC','CORIANDER'];
const NCDEX_PREFIX=['CASTOR','GUAR','CHANA','SOYA','BARLEY','WHEAT'];
function detectExchange(symbol){
  const s=String(symbol||'').toUpperCase().replace(/[^A-Z]/g,'');
  for(const p of MCX_PREFIX)if(s.indexOf(p)===0)return 'MCX';
  for(const p of NCDEX_PREFIX)if(s.indexOf(p)===0)return 'NCDEX';
  return 'NSE';
}
function resolveSession(exchange, startStr, endStr){
  const ex=EXCHANGE_SESSIONS[exchange]?exchange:'NSE';
  const preset=EXCHANGE_SESSIONS[ex];
  return {exchange:ex, start:startStr||preset.start, end:endStr||preset.end, preset:startStr||endStr?false:true};
}

// ---------- IV-rank proxy (realized-vol percentile, OHLCV-only) ----------
// No IV feed exists in the CSVs, so this proxies implied expensiveness with
// realized-vol percentile: rv = 20-bar log-return stdev (annualised), ranked
// against its trailing history (default ≈252 sessions of 1m bars, clamped to
// file length, min 500 bars or insufficient). High rank = expensive vol
// (avoid buying), low rank = cheap vol. HONEST LIMITS: needs a long file;
// options Greeks (gamma/vanna) need OI data we do not have.
function ivRankSeries(c, rvLen, histBars){
  const n=c.length, out=new Float64Array(n).fill(NaN);
  rvLen=Math.max(5,Math.round(rvLen||20));
  histBars=Math.max(500,Math.round(histBars||252*300));
  const H=Math.min(histBars,n);
  if(n<Math.max(60,rvLen+10))return {ivRank:out, insufficient:true};
  const rv=new Float64Array(n).fill(NaN);
  for(let i=rvLen;i<n;i++){
    let m=0; for(let j=i-rvLen+1;j<=i;j++)m+=Math.log(c[j]/Math.max(1e-12,c[j-1]));
    m/=rvLen; let s=0; for(let j=i-rvLen+1;j<=i;j++){const r=Math.log(c[j]/Math.max(1e-12,c[j-1]))-m;s+=r*r;}
    rv[i]=Math.sqrt(s/Math.max(1,rvLen-1))*Math.sqrt(252*375);
  }
  for(let i=0;i<n;i++){
    if(isNaN(rv[i]))continue;
    const s0=Math.max(rvLen,i-H+1);
    if(i-s0<100)continue; // need history depth for a meaningful percentile
    let lo=0,eq=0,tot=0;
    for(let j=s0;j<=i;j++){ if(isNaN(rv[j]))continue; tot++; if(rv[j]<rv[i])lo++; if(rv[j]===rv[i])eq++; }
    out[i]=tot?(lo+0.5*eq)/tot:NaN;
  }
  let valid=0; for(let i=0;i<n;i++)if(!isNaN(out[i]))valid++;
  return {ivRank:out, insufficient:valid<50};
}
function ivRankMask(d, maxRank, rvLen, histBars){
  // 1 = ivRank ≤ maxRank (cheap enough to trade), 0 = too expensive.
  // maxRank==null/≥1 disables (all-pass). NaN rank (warmup) passes — never
  // silently zero a backtest for missing history.
  const n=d.c.length, out=new Int8Array(n).fill(1);
  if(maxRank==null||!(maxRank<1))return {mask:out, insufficient:false};
  const rr=ivRankSeries(d.c, rvLen, histBars);
  for(let i=0;i<n;i++)if(!isNaN(rr.ivRank[i])&&rr.ivRank[i]>maxRank)out[i]=0;
  return {mask:out, insufficient:rr.insufficient};
}
// ---------- Expiry-day mask ----------
// 0 on bars sharing the contract's expiry calendar date (gamma-risk zone),
// 1 elsewhere. No contract meta or excludeExpiry=false → all-pass.
function buildExpiryMask(d, excludeExpiry){
  const n=d.c.length, out=new Int8Array(n).fill(1);
  const ex=d.contract&&isFinite(d.contract.expiryMs)?d.contract.expiryMs:null;
  if(!excludeExpiry||ex==null)return out;
  const eyp=istParts(ex);
  const ey=eyp.y, em=eyp.mo, eday=eyp.day;
  for(let i=0;i<n;i++){const p=istParts(d.t[i]);out[i]=(p.y===ey&&p.mo===em&&p.day===eday)?0:1;}
  return out;
}

// ---------- Days-to-expiry mask (contract metadata, no Greeks inferred) ----------
// 1 when minDte ≤ DTE ≤ maxDte (null bound = open side). No contract meta →
// all-pass. DTE = (expiryMs - barTime) / day.
function dteMask(d, minDte, maxDte){
  const n=d.c.length, out=new Int8Array(n).fill(1);
  const ex=d.contract&&isFinite(d.contract.expiryMs)?d.contract.expiryMs:null;
  if(ex==null||(minDte==null&&maxDte==null))return out;
  for(let i=0;i<n;i++){
    const dte=(ex-d.t[i])/86400000;
    if((minDte!=null&&dte<minDte)||(maxDte!=null&&dte>maxDte))out[i]=0;
  }
  return out;
}
// ---------- Underlying-led signals (honest cross-series execution) ----------
// Signals computed on the UNDERLYING series, executed on the OPTION series.
// Both resampled to tf, then each option bar is paired with the latest
// underlying bar at/under its timestamp (last-known quote — causal, never
// future; option bars themselves are never filled). Returns option bars +
// aligned position array, ready for backtest(optD, pos, opts).
function underlyingSignal(optD, undD, tf, sigCfg){
  const od=resample(optD, tf), ud=resample(undD, tf);
  const n=od.t.length, pos=new Int8Array(n);
  if(!ud.t.length||!n)return {d:od, pos, aligned:0};
  // signal on the full underlying series, then sample per option bar
  const usig=buildSignals(ud, sigCfg).pos;
  let j=0, aligned=0;
  for(let i=0;i<n;i++){
    while(j+1<ud.t.length&&ud.t[j+1]<=od.t[i])j++;
    if(ud.t[j]<=od.t[i]){pos[i]=usig[j];aligned++;}
    else pos[i]=i>0?pos[i-1]:0;
  }
  return {d:od, pos, aligned};
}

// ---------- ATM universe selection (universe-level, documented) ----------
// Per calendar (IST) day, finds the strike nearest the underlying close using
// ONLY that day's underlying bar (no future knowledge across days — each
// day's ATM is independent). Returns per-day records + the union of strikes
// within ±legs (the tradable universe for the sample).
// HONEST SCOPE: this selects the UNIVERSE (which datasets to enable), not
// per-bar contract switching; backtests run per-contract independently on
// option prices only. Universe selection from full-sample underlying is
// standard practice and is logged, not hidden.
function atmStrikes(uT, uC, strikes, legs){
  legs=Math.max(0,Math.round(legs||1));
  const ss=[...strikes].sort((a,b)=>a-b);
  const perDay=[];
  let lastDay='';
  for(let i=0;i<uT.length;i++){
    const day=istDayKey(uT[i]);
    if(day===lastDay)continue;
    lastDay=day;
    const px=uC[i];
    let best=ss[0], bd=Math.abs(px-best);
    for(const s of ss){const dd=Math.abs(px-s);if(dd<bd){bd=dd;best=s;}}
    const bi=ss.indexOf(best), band=[];
    for(let j=Math.max(0,bi-legs);j<=Math.min(ss.length-1,bi+legs);j++)band.push(ss[j]);
    perDay.push({day, underlying:+px.toFixed(2), atm:best, band});
  }
  const union=[...new Set(perDay.flatMap(r=>r.band))].sort((a,b)=>a-b);
  return {perDay, union};
}

// Precompute once per timeframe (NOT per combo): 1 if bar is inside session, else 0.
// Building this costs ~1M Date() calls — callers must cache it across grid combos.
function buildSessionMask(d, startStr, endStr){
  const n=d.c.length, mask=new Int8Array(n);
  if(!startStr||!endStr){mask.fill(1);return mask;}
  const s0=timeToMin(startStr), s1=timeToMin(endStr);
  for(let i=0;i<n;i++){const p=istParts(d.t[i]);const m=p.h*60+p.m;mask[i]=(m>=s0&&m<=s1)?1:0;}
  return mask;
}
// Intraday window mask: 1 inside the allowed [fromMin,toMin) buckets (local clock).
// Empty/missing list = all-pass (an all-off selection would silently zero every
// backtest, so absence of a filter means no filtering).
function buildWindowMask(t, wins){
  const n=t.length, m=new Int8Array(n);
  if(!wins||!wins.length){m.fill(1);return m;}
  for(let i=0;i<n;i++){const p=istParts(t[i]);const mm=p.h*60+p.m;
    let ok=0;for(let k=0;k<wins.length;k++){const w=wins[k];if(mm>=w[0]&&mm<w[1]){ok=1;break;}}
    m[i]=ok;}
  return m;
}
function combineMasks(a,b){
  if(!a)return b; if(!b)return a;
  const n=a.length,o=new Int8Array(n);
  for(let i=0;i<n;i++)o[i]=a[i]&&b[i];
  return o;
}
// One choke-point for execution gating: session (unless carry) ANDed with
// allowed intraday windows. Returns null = trade everywhere.
function sessionMaskFor(d, opts){
  opts=opts||{};
  let m=null;
  if(!opts.carry)m=buildSessionMask(d,opts.sessionStart,opts.sessionEnd);
  if(opts.tradeWindows&&opts.tradeWindows.length)m=combineMasks(m,buildWindowMask(d.t,opts.tradeWindows));
  return m;
}

function backtest(d, sigPos, opts){
  opts=opts||{};
  const direction=opts.direction||'Both';
  const slPct=(opts.slPct||0)/100, tpPct=(opts.tpPct||0)/100, trailPct=(opts.trailPct||0)/100;
  const capital0=opts.capital||100000, qty=opts.qty||1, lotSize=opts.lotSize||1;
  const costPerTrade=opts.cost||0;
  const n=d.c.length;
  const mask=opts.sessionMask||sessionMaskFor(d, opts);
  const trades=[];
  let position=0, entryPx=0, entryIdx=0, entryTime=0, peak=0, trough=0, stopPx=0, trailPeak=0;
  const allowLong=direction==='Long'||direction==='Both';
  const allowShort=direction==='Short'||direction==='Both';
  function desiredTarget(i){
    let s=sigPos[i];
    if(s===1&&!allowLong)s=0;
    if(s===-1&&!allowShort)s=0;
    if(useMask&&!useMask[i])s=0; // intraday: force flat outside session; carry: hold overnight
    if(tmask&&!tmask[i])s=0; // regime router: only trade in-regime bars
    return s;
  }
  let curQty=0;
  let trMAE=0, trMFE=0; // current-trade excursion (₹), reset on entry
  let liveEq=capital0, ruined=false; // ruin guard: account blown -> no new entries
  const eqMtm=new Float64Array(n).fill(capital0); // mark-to-market equity incl. open heat
  // dynamic exit plumbing
  const exitMode=opts.exit||'fixed'; // fixed | breakeven | atr
  const beTrig=((opts.beTrigger!=null?opts.beTrigger:((opts.slPct||0)))/100); // profit to lock breakeven (default 1R)
  const beLock=(opts.beLock||0)/100; // locked profit once triggered (0 = flat breakeven)
  const atrMult=opts.atrTrailMult||3;
  let atrArr=null;
  if(exitMode==='atr'||exitMode==='atrTP')atrArr=atr(d.h,d.l,d.c,Math.max(2,Math.round(opts.atrTrailPeriod||14)));
  let ckArr=null;
  if(exitMode==='ck')ckArr=chandeKroll(d.h,d.l,d.c,Math.max(2,Math.round(opts.ckPeriod||10)),opts.ckMult||3);
  let hiEntry=0, loEntry=0, beDone=false, barsHeld=0, atrEntryPx=0;
  const useMask=mask; // null = trade everywhere (carry, or no filters at all)
  const tmask=opts.tradeMask||null; // regime router: 1 = may trade this bar
  // Explicit fill timing (anti-lookahead): 'close' fills signal trades at the
  // signal bar's close; 'next' executes them at the NEXT bar's open. Resting
  // stop orders (SL/TP/trailing) always fill intrabar at their stop levels.
  const fillNext=(opts.fill==='next');
  let pendTgt=null; // signal decision from bar i-1, executed at open[i]
  // Entry gating: 'always' = classic always-in-the-market (flip re-entry);
  // 'trigger' = enter ONLY on a fresh signal edge, and never on an exit bar —
  // after any exit the engine stands aside until the next new trigger.
  const trigOnly=(opts.entry==='trigger');
  let prevAct=99, lastExitBar=-1;
  // Options expiry enforcement: a contract cannot be entered at/after its
  // expiry timestamp, and any open position is force-liquidated there
  // (reason EXPIRY). Futures/equity (no contract meta) are unaffected.
  const exMs=(d.contract&&isFinite(d.contract.expiryMs))?d.contract.expiryMs:0;
  const respectExpiry=opts.respectExpiry===false?false:true;
  for(let i=1;i<n;i++){
    const px=d.c[i], ox=d.o[i];
    const expired=respectExpiry&&exMs&&d.t[i]>=exMs;
    if(position!==0&&expired){
      const units=qty*lotSize;
      const exitPx=fillNext?ox:px;
      const pnl=(position===1?(exitPx-entryPx):(entryPx-exitPx))*units-costPerTrade;
      const pnlPct=position===1?(exitPx-entryPx)/entryPx*100:(entryPx-exitPx)/entryPx*100;
      trades.push({id:trades.length+1,entryIdx,exitIdx:i,entryTime:d.t[entryIdx],exitTime:d.t[i],entryPx,exitPx,type:position===1?'LONG':'SHORT',pnl,pnlPct,reason:'EXPIRY',mae:+trMAE.toFixed(2),mfe:+trMFE.toFixed(2),lat:fillNext?1:0});
      position=0;curQty=0;liveEq+=pnl;lastExitBar=i;eqMtm[i]=liveEq;
      continue;
    }
    const decTgt=desiredTarget(i);
    const actTgt=fillNext?pendTgt:decTgt;
    pendTgt=decTgt;
    const noSig=fillNext&&actTgt===null;
    const fillPx=fillNext?ox:px;
    const edge=!noSig&&actTgt!==0&&actTgt!==prevAct;
    prevAct=actTgt;
    // manage open position: SL / target / trailing / signal flip / session exit
    if(position!==0){
      barsHeld++;
      const ret=position===1?(px-entryPx)/entryPx:(entryPx-px)/entryPx;
      if(position===1){if(px>trailPeak)trailPeak=px;if(d.h[i]>hiEntry)hiEntry=d.h[i];}
      else{if(px<trough||trough===0)trough=px; if(trough===0)trough=px;if(d.l[i]<loEntry||loEntry===0)loEntry=d.l[i];}
      // MAE/MFE excursion tracking (₹, includes the entry bar onward)
      if(position===1){const f=(d.h[i]-entryPx)*curQty,a=(entryPx-d.l[i])*curQty;if(f>trMFE)trMFE=f;if(a>trMAE)trMAE=a;}
      else{const f=(entryPx-d.l[i])*curQty,a=(d.h[i]-entryPx)*curQty;if(f>trMFE)trMFE=f;if(a>trMAE)trMAE=a;}
      if(exitMode==='breakeven'&&!beDone&&ret>=beTrig)beDone=true; // lock floor once +beTrigger reached
      // trailing stop
      let stopHit=false, reason='';
      // GUARD: same-bar SL/TP collision resolves STRICTLY to the stop.
      // If one 1-minute bar's range touches both levels, the stop is assumed
      // hit first (conservative — eliminates optimistic TP-first bias).
      const slTouch=slPct>0&&((position===1&&d.l[i]<=slPxEff())||(position===-1&&d.h[i]>=slPxEff()));
      const tpTouch=tpPct>0&&((position===1&&d.h[i]>=tpPx())||(position===-1&&d.l[i]<=tpPx()));
      if(exitMode==='atr'&&atrArr&&!isNaN(atrArr[i])){
        // Chandelier: stop hangs k·ATR below highest-high (long) since entry; replaces fixed SL
        const chL=hiEntry-atrMult*atrArr[i], chS=loEntry+atrMult*atrArr[i];
        if(position===1&&d.l[i]<=chL){stopHit=true;reason='ATR';}
        if(position===-1&&d.h[i]>=chS){stopHit=true;reason='ATR';}
      } else if(exitMode==='atrTP'&&atrArr&&!isNaN(atrArr[i])){
        // ATR stop + ATR target: chandelier stop + fixed ATR-multiple target
        // measured from ATR at entry (volatility-normalized R, not %).
        const chL=hiEntry-atrMult*atrArr[i], chS=loEntry+atrMult*atrArr[i];
        const k=opts.atrTpMult||3, ae=atrEntryPx>0?atrEntryPx:atrArr[i];
        const tL=entryPx+k*ae, tS=entryPx-k*ae;
        if(position===1&&d.l[i]<=chL){stopHit=true;reason='ATR';}
        if(position===-1&&d.h[i]>=chS){stopHit=true;reason='ATR';}
        if(!stopHit&&position===1&&d.h[i]>=tL){stopHit=true;reason='ATRTP';}
        if(!stopHit&&position===-1&&d.l[i]<=tS){stopHit=true;reason='ATRTP';}
      } else if(exitMode==='ck'&&ckArr&&!isNaN(ckArr.longStop[i])){
        // Chande-Kroll structural stop: exit longs below longStop; replaces fixed SL
        if(position===1&&d.l[i]<=ckArr.longStop[i]){stopHit=true;reason='CK';}
        if(position===-1&&d.h[i]>=ckArr.shortStop[i]){stopHit=true;reason='CK';}
      } else if(slTouch){stopHit=true;reason=(beDone&&exitMode==='breakeven')?'BE':'SL';}
      else if(tpTouch){stopHit=true;reason='TP';}
      function slPxEff(){
        const slBase=position===1?entryPx*(1-slPct):entryPx*(1+slPct);
        return (exitMode==='breakeven'&&beDone)?(position===1?entryPx*(1+beLock):entryPx*(1-beLock)):slBase;
      }
      function tpPx(){return position===1?entryPx*(1+tpPct):entryPx*(1-tpPct);}
      if(!stopHit&&trailPct>0){
        if(position===1){const tp2=trailPeak*(1-trailPct);if(d.l[i]<=tp2&&ret>0){stopHit=true;reason='TRAIL';}}
        else{const tp2=trough*(1+trailPct);if(d.h[i]>=tp2&&ret>0){stopHit=true;reason='TRAIL';}}
      }
      const maxHold=Math.max(0,Math.round(opts.maxHoldBars||0));
      if(!stopHit&&maxHold>0&&barsHeld>=maxHold){stopHit=true;reason='TIME';}
      const tgt=actTgt;
      const flip=!noSig&&tgt!==0&&tgt!==position;
      const flatSignal=!noSig&&tgt===0;
      const lastBar=(i===n-1);
      if(stopHit||flip||flatSignal||lastBar){
        let exitPx=(fillNext&&!stopHit&&!lastBar)?ox:px;
        if(stopHit){
          if(reason==='SL')exitPx=position===1?entryPx*(1-slPct):entryPx*(1+slPct);
          else if(reason==='BE')exitPx=position===1?entryPx*(1+beLock):entryPx*(1-beLock);
          else if(reason==='ATR')exitPx=position===1?(hiEntry-atrMult*atrArr[i]):(loEntry+atrMult*atrArr[i]);
          else if(reason==='CK')exitPx=position===1?ckArr.longStop[i]:ckArr.shortStop[i];
          else if(reason==='TP')exitPx=position===1?entryPx*(1+tpPct):entryPx*(1-tpPct);
          else if(reason==='ATRTP'){const k2=opts.atrTpMult||3, ae2=atrEntryPx>0?atrEntryPx:(atrArr?atrArr[i]:0);exitPx=position===1?entryPx+k2*ae2:entryPx-k2*ae2;}
          else if(reason==='TIME')exitPx=px; // time stop: known only at bar close
          else exitPx=position===1?trailPeak*(1-trailPct):trough*(1+trailPct);
        }
        const units=qty*lotSize;
        let pnl=(position===1?(exitPx-entryPx):(entryPx-exitPx))*units - costPerTrade;
        const pnlPct=position===1?(exitPx-entryPx)/entryPx*100:(entryPx-exitPx)/entryPx*100;
        trades.push({id:trades.length+1,entryIdx,exitIdx:i,entryTime:d.t[entryIdx],exitTime:d.t[i],entryPx,exitPx,type:position===1?'LONG':'SHORT',pnl,pnlPct,reason:stopHit?reason:(flip?'FLIP':(flatSignal?'SESSION/FLAT':'END')),mae:+trMAE.toFixed(2),mfe:+trMFE.toFixed(2),lat:stopHit?0:(fillNext?1:0)});
        position=0;curQty=0;
        liveEq+=pnl;
        // GUARD: halt immediately on ruin — fill the tail flat and break
        // (no point burning 1M-bar loops for a dead parameter set).
        if(liveEq<=0){ruined=true;for(let j=i;j<n;j++)eqMtm[j]=liveEq;lastExitBar=i;break;}
        // immediate re-entry on flip (mask already enforced via tgt)
        if(!trigOnly&&flip&&(!useMask||useMask[i])&&(!tmask||tmask[i])&&!ruined&&(!opts.premiumFloor||!(fillPx<opts.premiumFloor))&&!expired){
          position=tgt;entryPx=fillPx;entryIdx=i;trailPeak=fillPx;trough=fillPx;curQty=units;barsHeld=0;
          atrEntryPx=(atrArr&&isFinite(atrArr[i]))?atrArr[i]:0;
          hiEntry=d.h[i];loEntry=d.l[i];beDone=false;trMAE=0;trMFE=0;
        }
        lastExitBar=i;
        eqMtm[i]=liveEq+(position!==0?(position===1?(px-entryPx):(entryPx-px))*curQty:0);
        continue;
      }
    } else {
      const allowEntry=!trigOnly||(edge&&i>lastExitBar);
      const premOk=!opts.premiumFloor||!(fillPx<opts.premiumFloor); // options: never buy dust (sub-floor premium)
      if(!noSig&&actTgt!==0&&(!useMask||useMask[i])&&(!tmask||tmask[i])&&!ruined&&allowEntry&&premOk&&!expired){
        position=actTgt;entryPx=fillPx;entryIdx=i;trailPeak=fillPx;trough=fillPx;curQty=qty*lotSize;barsHeld=0;
        atrEntryPx=(atrArr&&isFinite(atrArr[i]))?atrArr[i]:0;
        hiEntry=d.h[i];loEntry=d.l[i];beDone=false;trMAE=0;trMFE=0;
      }
    }
    if(position!==0)eqMtm[i]=liveEq+(position===1?(px-entryPx):(entryPx-px))*curQty;
    else eqMtm[i]=liveEq;
  }
  // equity = mark-to-market curve (built in-loop, includes open-position heat)
  const eq=eqMtm;
  // GUARD: cash-flow identity — Final = Initial + Σ trade P&L, recomputed
  // independently from the trade list (not from the loop accumulator).
  // Throws in strict mode (default) so accounting bugs can never go quiet.
  let run=capital0;
  for(const t of trades)run+=t.pnl;
  const costSum=trades.length*costPerTrade;
  if(opts.strict!==false&&Math.abs(run-liveEq)>1e-6)
    throw new Error('cash-flow identity violated: equity endpoint ≠ capital + Σ trade P&L');
  // metrics
  let wins=0,grossP=0,grossL=0;
  for(const t of trades){if(t.pnl>0){wins++;grossP+=t.pnl;}else grossL+=-t.pnl;}
  const wr=trades.length?wins/trades.length*100:0;
  const pf=grossL>0?grossP/grossL:(grossP>0?99.99:0);
  const net=run-capital0;
  // max drawdown on MTM equity + peak/trough attribution (which trades made it)
  let peakE=capital0,maxDD=0,peakIdx=0,troughIdx=0;
  const dd=new Float64Array(n);
  for(let i=0;i<n;i++){
    if(eq[i]>peakE){peakE=eq[i];}
    const ddi=peakE>0?(eq[i]-peakE)/peakE*100:0;dd[i]=ddi;
    if(ddi<maxDD){maxDD=ddi;troughIdx=i;}
  }
  peakIdx=0;
  for(let i=0;i<=troughIdx;i++)if(eq[i]>=eq[peakIdx])peakIdx=i;
  // Sharpe/Sortino on DAILY strategy returns: dayPnl / starting capital.
  // Two deliberate choices: (1) denominator is constant initial capital, never
  // live equity — once equity goes negative, equity-based returns invert sign
  // ((-200+100)/-100 = +100%) and fabricate ratios; (2) daily aggregation keeps
  // magnitudes comparable (per-trade annualisation explodes for 100+/day scalps).
  const dayPnl={};
  for(const t of trades){const dy=Math.floor(t.exitTime/86400000);dayPnl[dy]=(dayPnl[dy]||0)+t.pnl;}
  let days=0,lastDay=-1;
  for(let i=0;i<n;i++){const dy=istDayIndex(d.t[i]);if(dy!==lastDay){lastDay=dy;days++;}}
  const tradesPerDay=days>0?trades.length/days:trades.length;
  const dret=[];
  { const seen={};
    for(let i=0;i<n;i++){const dy=istDayIndex(d.t[i]);if(!seen[dy]){seen[dy]=1;dret.push((dayPnl[dy]||0)/Math.max(1e-9,capital0));}} }
  function mean(a){if(!a.length)return 0;let s=0;for(const x of a)s+=x;return s/a.length;}
  function sd(a,m){if(a.length<2)return 0;let s=0;for(const x of a)s+=(x-m)*(x-m);return Math.sqrt(s/(a.length-1));}
  const dm=mean(dret),dsd=sd(dret,dm);
  const sharpe=dsd>0?dm/dsd*Math.sqrt(252):0;
  const ddn=dret.filter(x=>x<0);const dsdn=sd(ddn,mean(ddn));
  const sortino=dsdn>0?dm/dsdn*Math.sqrt(252):(dm>0?99.99:0);
  const expectancy=trades.length?net/trades.length:0;
  return {trades,equity:eq,dd,metrics:{netPnL:net,winRate:wr,totalTrades:trades.length,profitFactor:pf,maxDD:maxDD,sharpe,sortino,expectancy,finalCapital:run,grossProfit:grossP,grossLoss:grossL,tradesPerDay,days,ddPeakTime:d.t[peakIdx],ddTroughTime:d.t[troughIdx],totalCosts:costSum,grossPreCost:(run-capital0)+costSum}};
}

function expandRange(min,max,step){
  const out=[];if(step<=0)step=(max-min)||1;
  for(let v=min;v<=max+1e-9;v+=step){out.push(+v.toFixed(4));if(out.length>25)break;}
  return out;
}

// indicator param schema for grid
const SCHEMA={
  EMA:[{key:'period',min:5,max:100,def:21}],
  SMA:[{key:'period',min:5,max:100,def:21}],
  HMA:[{key:'period',min:5,max:100,def:21}],
  DEMA:[{key:'period',min:5,max:100,def:21}],
  Bollinger:[{key:'period',min:10,max:40,def:20},{key:'mult',min:1,max:3,def:2}],
  Keltner:[{key:'emaPeriod',min:10,max:40,def:20},{key:'atrPeriod',min:7,max:28,def:14},{key:'mult',min:1,max:4,def:2}],
  RSI:[{key:'period',min:5,max:21,def:14},{key:'oversold',min:10,max:40,def:30},{key:'overbought',min:60,max:90,def:70}],
  MACD:[{key:'fast',min:5,max:20,def:12},{key:'slow',min:21,max:35,def:26},{key:'signal',min:5,max:15,def:9}],
  VWAP:[],
  SuperTrend:[{key:'atrPeriod',min:5,max:21,def:10},{key:'mult',min:1,max:4,def:3}],
  ADX:[{key:'adxPeriod',min:7,max:28,def:14},{key:'maPeriod',min:20,max:100,def:50},{key:'threshold',min:10,max:40,def:20}],
  Stochastic:[{key:'k',min:5,max:21,def:14},{key:'d',min:2,max:7,def:3},{key:'oversold',min:10,max:30,def:20},{key:'overbought',min:70,max:90,def:80}],
  ChandeKroll:[{key:'period',min:5,max:21,def:10},{key:'mult',min:1,max:4,def:3}],
  POC:[{key:'lookback',min:20,max:200,def:50}],
  KAMA:[{key:'erPeriod',min:5,max:30,def:10},{key:'fast',min:2,max:8,def:2},{key:'slow',min:15,max:60,def:30}],
  Fisher:[{key:'period',min:5,max:30,def:10}],
  Squeeze:[{key:'bbPeriod',min:10,max:30,def:20},{key:'bbMult',min:1,max:3,def:2},{key:'kcPeriod',min:10,max:30,def:20},{key:'kcMult',min:1,max:3,def:1.5}],
  CRSI:[{key:'rsiPeriod',min:2,max:7,def:3},{key:'streakPeriod',min:2,max:7,def:2},{key:'rankPeriod',min:20,max:200,def:100},{key:'oversold',min:5,max:40,def:30},{key:'overbought',min:60,max:95,def:70}],
  VWAPBands:[{key:'sd1',min:1,max:3,def:1},{key:'sd2',min:1,max:3,def:2}],
  CVD:[{key:'lookback',min:10,max:100,def:40}],
  FVG:[{key:'maxZones',min:1,max:10,def:5},{key:'mitAge',min:10,max:200,def:60}],
  Regime:[{key:'chopPeriod',min:7,max:40,def:14},{key:'gate',min:40,max:80,def:61.8},{key:'maPeriod',min:10,max:100,def:30}],
  Chop:[{key:'chopPeriod',min:7,max:40,def:14},{key:'gate',min:40,max:80,def:61.8},{key:'maPeriod',min:10,max:100,def:30}],
  Cyber:[{key:'alpha',min:0.01,max:0.3,def:0.07}],
  VWMA:[{key:'period',min:5,max:60,def:20}],
  CMO:[{key:'period',min:5,max:30,def:9},{key:'oversold',min:-70,max:0,def:-50},{key:'overbought',min:0,max:70,def:50}],
  Aroon:[{key:'period',min:5,max:60,def:25},{key:'level',min:0,max:50,def:0}],
  SqueezeBreak:[{key:'period',min:5,max:40,def:20},{key:'bbMult',min:1,max:3,def:2},{key:'kcMult',min:1,max:3,def:1.5},{key:'volMult',min:1,max:4,def:2},{key:'ckMult',min:1,max:5,def:3}],
  TrendRegime:[{key:'chopPeriod',min:7,max:40,def:14},{key:'gate',min:40,max:80,def:55},{key:'stMult',min:1,max:5,def:3},{key:'macdFast',min:5,max:20,def:12}],
  VWAPRev:[{key:'sd1',min:0.5,max:3,def:1.5},{key:'sd2',min:1,max:4,def:2},{key:'cmoPeriod',min:3,max:20,def:5},{key:'cmoOS',min:-70,max:0,def:-50},{key:'cmoOB',min:0,max:70,def:50}],
  HilbertDC:[],
  ITrend:[{key:'alpha',min:0.03,max:0.15,def:0.07}],
  AdaptRSI:[{key:'baseLen',min:8,max:21,def:14},{key:'oversold',min:10,max:40,def:30},{key:'overbought',min:60,max:90,def:70}],
  AdaptBB:[{key:'baseLen',min:15,max:30,def:20},{key:'mult',min:1,max:3,def:2}],
  Ribbon:[{key:'fast',min:3,max:8,def:5},{key:'med',min:8,max:21,def:13},{key:'slow',min:21,max:55,def:34}],
  VWAPSlope:[{key:'slopeLen',min:3,max:10,def:5}],
  MACDSlope:[{key:'fast',min:8,max:12,def:12},{key:'slow',min:21,max:26,def:26},{key:'signal',min:5,max:9,def:9},{key:'slopeLen',min:2,max:5,def:3}],
  ADXDI:[{key:'length',min:10,max:20,def:14},{key:'threshold',min:20,max:30,def:25}],
  LRSlope:[{key:'length',min:10,max:20,def:14}],
  PctB:[{key:'length',min:10,max:20,def:20},{key:'mult',min:1.5,max:2,def:2},{key:'lo',min:0.1,max:0.2,def:0.2},{key:'hi',min:0.8,max:0.9,def:0.8}],
  VWAPDev:[{key:'thresh',min:0.5,max:2,def:1}],
  ATRPct:[{key:'length',min:10,max:20,def:14},{key:'mult',min:1.2,max:2,def:1.5},{key:'emaLen',min:10,max:30,def:20}],
  BBWidth:[{key:'length',min:10,max:20,def:20},{key:'mult',min:1.2,max:2,def:1.5},{key:'lookback',min:50,max:200,def:100}],
  ORB:[{key:'rangeMin',min:15,max:45,def:30},{key:'volMult',min:2,max:4,def:2}],
  InsideBar:[{key:'mode',min:1,max:3,def:1}],
  NR7:[{key:'ibOnly',min:0,max:1,def:0}],
  VolRate:[{key:'length',min:10,max:20,def:20},{key:'mult',min:1.5,max:3,def:2},{key:'emaLen',min:10,max:30,def:20}],
  VolSpike:[{key:'length',min:10,max:20,def:20},{key:'mult',min:1.5,max:3,def:2}],
  VolReg:[{key:'length',min:10,max:20,def:20},{key:'lookback',min:50,max:200,def:100},{key:'gate',min:30,max:60,def:40},{key:'maPeriod',min:20,max:50,def:30}],
  KaufER:[{key:'erPeriod',min:10,max:20,def:10},{key:'trendTh',min:0.25,max:0.4,def:0.3},{key:'rangeTh',min:0.1,max:0.25,def:0.15},{key:'maPeriod',min:10,max:30,def:20}],
  DecaySlope:[{key:'length',min:10,max:30,def:20},{key:'thresh',min:0.02,max:0.1,def:0.05}],
  TrendFollow:[{key:'fast',min:5,max:13,def:8},{key:'med',min:13,max:34,def:21},{key:'slow',min:34,max:89,def:55},{key:'atrP',min:7,max:14,def:10},{key:'stMult',min:2,max:3,def:3},{key:'adxP',min:10,max:20,def:14},{key:'adxTh',min:20,max:30,def:25},{key:'useVol',min:0,max:1,def:0},{key:'volLen',min:10,max:30,def:20},{key:'volMult',min:1.5,max:3,def:2}],
  VWAPMR:[{key:'sd1',min:1,max:2,def:1},{key:'sd2',min:2,max:3,def:2},{key:'rsiP',min:7,max:21,def:14},{key:'oversold',min:20,max:40,def:30},{key:'overbought',min:60,max:80,def:70}],
  PAIR:[],
};

function cartesian(arrays){
  let res=[[]];
  for(const arr of arrays){const tmp=[];for(const r of res)for(const v of arr)tmp.push(r.concat([v]));res=tmp;}
  return res;
}

function objectiveValue(m, objective){
  if(!m) return -Infinity;
  if(objective==='winrate')return m.winRate;
  if(objective==='trades')return m.totalTrades;
  if(objective==='drawdown')return m.maxDD; // negative; closer to 0 wins
  if(objective==='sortino')return m.sortino;
  return m.sharpe;
}

const INT_KEYS={period:1,fast:1,slow:1,signal:1,k:1,d:1,emaPeriod:1,atrPeriod:1,adxPeriod:1,maPeriod:1,
  lookback:1,rsiPeriod:1,streakPeriod:1,rankPeriod:1,erPeriod:1,bbPeriod:1,kcPeriod:1};

// One-step neighbors of a config for hill-climbing: each numeric param ±step,
// plus SL/TP ±their steps. Used by the refine loop until no improvement.
function paramNeighbors(row, steps, riskSteps){
  const out=[];
  const P=row.params||{};
  const schema=(typeof SCHEMA!=='undefined'&&SCHEMA[row.indicator])||[];
  const bound=k=>{const p=schema.find(q=>q.key===k);return p?{min:p.min,max:p.max}:null;};
  for(const k of Object.keys(steps||{})){
    if(!(k in P))continue;
    const st=+steps[k]||0; if(st<=0)continue;
    const cur=+P[k], bd=bound(k);
    for(const dir of [-1,1]){
      let v=+(cur+dir*st).toFixed(4);
      if(!isFinite(v)||v<=0||v===cur)continue;
      if(bd&&(v<bd.min||v>bd.max))continue; // never leave the declared research range
      if(INT_KEYS[k]&&(!Number.isInteger(v)||v<2))continue;
      const np=Object.assign({},P);np[k]=v;
      const c={timeframe:row.timeframe,indicator:row.indicator,params:np,exit:row.exit||'fixed',carry:!!row.carry};
      if(row.slPct!=null)c.slPct=row.slPct;
      if(row.tpPct!=null)c.tpPct=row.tpPct;
      if(row.trailPct!=null)c.trailPct=row.trailPct;
      out.push(c);
    }
  }
  function riskNeighbor(key, step, lo, hi){
    if(!step||step<=0||row[key]==null)return;
    for(const dir of [-1,1]){
      const v=+((+row[key])+dir*step).toFixed(4);
      if(!isFinite(v)||v<lo||v>hi)continue;
      const c={timeframe:row.timeframe,indicator:row.indicator,params:Object.assign({},P),exit:row.exit||'fixed',carry:!!row.carry};
      c.slPct=row.slPct;c.tpPct=row.tpPct;
      if(row.trailPct!=null)c.trailPct=row.trailPct;
      c[key]=v;out.push(c);
    }
  }
  riskNeighbor('slPct',(riskSteps||{}).sl,0.05,15);
  riskNeighbor('tpPct',(riskSteps||{}).tp,0.05,30);
  return out;
}

function cfgKey(c){
  return c.timeframe+'|'+c.indicator+'|'+JSON.stringify(c.params)+'|'+(c.slPct||'')+'|'+(c.tpPct||'')+'|'+(c.exit||'fixed')+'|'+(c.carry?1:0);
}

function cfgKey(c){
  return c.timeframe+'|'+c.indicator+'|'+JSON.stringify(c.params)+'|'+(c.slPct||'')+'|'+(c.tpPct||'')+'|'+(c.exit||'fixed')+'|'+(c.carry?1:0);
}

// ---------- Low-discrepancy (Halton) grid sampling ----------
// Covers the SAME Cartesian space as buildGrid with N quasi-random points
// instead of the full product. Deterministic (no seed needed): radical-inverse
// in the first K primes, one prime per flattened axis. We use Halton rather
// than Sobol deliberately — Sobol needs published direction-number tables to
// be correct, Halton is correct by construction.
const HALTON_BASES=[2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53];
function haltonIndex(i, base){
  let f=1,r=0;
  while(i>0){f/=base;r+=f*(i%base);i=Math.floor(i/base);}
  return r;
}
function haltonSequence(nPoints, dims){
  const pts=[];
  for(let i=0;i<nPoints;i++){
    const row=[];
    for(let d=0;d<dims;d++)row.push(haltonIndex(i+1,HALTON_BASES[d%HALTON_BASES.length]));
    pts.push(row);
  }
  return pts;
}
function buildHaltonGrid(selected, risk, dims, nPoints){
  // Same inputs as buildGrid; returns {combos, axes} where each of the
  // nPoints combos picks axis values by Halton coordinate (low-discrepancy
  // coverage of the full Cartesian space). Deterministic.
  nPoints=Math.max(16,Math.round(nPoints||256));
  const slVals=(risk&&risk.sl&&risk.sl.length)?risk.sl:[null];
  const tpVals=(risk&&risk.tp&&risk.tp.length)?risk.tp:[null];
  const trailVals=(risk&&risk.trail&&risk.trail.length)?risk.trail:[null];
  const exits=(dims&&dims.exits&&dims.exits.length)?dims.exits:['fixed'];
  const carrys=(dims&&dims.carry&&dims.carry.length)?dims.carry:[false];
  // Flatten every searchable axis (indicator params + tf + sl/tp/trail/exit/carry)
  const axes=[];
  for(const s of selected){
    const schema=SCHEMA[s.indicator]||[];
    const paxes=schema.map(p=>{
      const r=(s.ranges&&s.ranges[p.key])||{min:p.def,max:p.def,step:1};
      return {kind:'param',ind:s.indicator,key:p.key,vals:expandRange(+r.min,+r.max,+r.step||1)};
    });
    axes.push({ind:s.indicator,tfs:(s.timeframes||[5]).slice(),paxes});
  }
  // Per-indicator Halton draw (axes differ per indicator, so sample per block)
  const combos=[];
  const per=Math.max(8,Math.floor(nPoints/Math.max(1,axes.length)));
  axes.forEach((blk,bi)=>{
    const flat=[...blk.paxes.map(a=>({kind:'param',key:a.key,vals:a.vals})),{kind:'tf',vals:blk.tfs},{kind:'sl',vals:slVals},{kind:'tp',vals:tpVals},{kind:'trail',vals:trailVals},{kind:'exit',vals:exits},{kind:'carry',vals:carrys}];
    const seq=haltonSequence(per,flat.length);
    for(const row of seq){
      const params={};let tf=blk.tfs[0],sl=null,tp=null,tr=null,ex='fixed',cy=false;
      flat.forEach((ax,ai)=>{
        const v=ax.vals[Math.min(ax.vals.length-1,Math.floor(row[(ai+bi*3)%row.length]*ax.vals.length))];
        if(ax.kind==='param')params[ax.key]=v;
        else if(ax.kind==='tf')tf=v;else if(ax.kind==='sl')sl=v;else if(ax.kind==='tp')tp=v;
        else if(ax.kind==='trail')tr=v;else if(ax.kind==='exit')ex=v;else cy=v;
      });
      const c={timeframe:tf,indicator:blk.ind,params,exit:ex,carry:cy};
      if(sl!=null)c.slPct=sl;if(tp!=null)c.tpPct=tp;if(tr!=null)c.trailPct=tr;
      combos.push(c);
    }
  });
  // Halton draws with replacement: dedup so small spaces don't waste evals.
  const seen=new Set(), uniq=[];
  for(const c of combos){const k=cfgKey(c);if(seen.has(k))continue;seen.add(k);uniq.push(c);}
  return uniq;
}

// ---------- Purged / embargoed walk-forward folds (index space) ----------
// nSplits anchored folds over n bars: train grows [0,trainEnd), test follows
// after a purge gap, shortened by an embargo tail. Train and test NEVER share
// or touch bars — prevents leakage from indicator warmup/ATR windows.
function purgedFolds(n, nSplits, purgeBars, embargoBars){
  nSplits=Math.max(1,Math.round(nSplits||5));
  purgeBars=Math.max(0,Math.round(purgeBars||0));embargoBars=Math.max(0,Math.round(embargoBars||0));
  const folds=[], foldSize=Math.floor(n/(nSplits+1));
  for(let f=0;f<nSplits;f++){
    const trainEnd=(f+1)*foldSize;
    const testStart=trainEnd+purgeBars;
    const testEnd=Math.min(testStart+foldSize-embargoBars,n);
    if(testStart<testEnd&&trainEnd>50)folds.push({train:[0,trainEnd],test:[testStart,testEnd]});
  }
  return folds;
}

// ---------- Bayesian refinement (GP-EI proposals over evaluated rows) ----------
// Pure function: fits a Matérn-5/2 GP on ALREADY-EVALUATED rows (no new
// backtests inside) and proposes nPropose new combos maximising Expected
// Improvement via random-search over the EI surface. Caller evaluates the
// proposals with the normal testCfg path. Deterministic given rows.
function _m52(a,b,ls){
  let s=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i])/ls;s+=d*d;}
  const r=Math.sqrt(5*s);return (1+r+r*r/3)*Math.exp(-r);
}
function _chol(A){
  const n=A.length,L=A.map(r=>r.slice());
  for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
    let s=A[i][j];for(let k=0;k<j;k++)s-=L[i][k]*L[j][k];
    L[i][j]=i===j?Math.sqrt(Math.max(1e-12,s)):s/L[j][j];
  }
  return L;
}
function _cholSolve(L,b){
  const n=L.length,y=new Array(n),x=new Array(n);
  for(let i=0;i<n;i++){let s=b[i];for(let j=0;j<i;j++)s-=L[i][j]*y[j];y[i]=s/L[i][i];}
  for(let i=n-1;i>=0;i--){let s=y[i];for(let j=i+1;j<n;j++)s-=L[j][i]*x[j];x[i]=s/L[i][i];}
  return x;
}
function _nPdf(z){return Math.exp(-0.5*z*z)/Math.sqrt(2*Math.PI);}
function _nCdf(z){
  const s=z<0?-1:1,a=Math.abs(z),t=1/(1+0.3275911*a);
  const y=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a);
  return 0.5*(1+s*y);
}
function bayesianRefine(rows, stepsByInd, nPropose){
  // rows: evaluated BoardRows with .m.sharpe. Returns NEW cfg objects
  // (caller must testCfg them). Rows with <10 trades are ignored.
  nPropose=Math.max(4,Math.round(nPropose||24));
  const pool=rows.filter(r=>r.m&&r.m.totalTrades>=10);
  if(pool.length<6)return [];
  // Group by (indicator,timeframe,exit,carry); refine the best group only
  // (keeps the proposal space coherent — no cross-indicator vectors).
  const groups={};
  for(const r of pool){const k=r.indicator+'|'+r.timeframe+'|'+(r.exit||'fixed')+'|'+(r.carry?1:0);(groups[k]=groups[k]||[]).push(r);}
  let best=null;
  for(const k of Object.keys(groups)){const g=groups[k].sort((a,b)=>b.m.sharpe-a.m.sharpe);if(!best||g[0].m.sharpe>best[0].m.sharpe)best=g;}
  const top=best.slice(0,Math.min(40,best.length));
  const keys=Object.keys(top[0].params||{}).filter(k=>typeof top[0].params[k]==='number');
  if(!keys.length)return [];
  const lo={},hi={};
  for(const k of keys){
    const vs=top.map(r=>r.params[k]);
    lo[k]=Math.min(...vs);hi[k]=Math.max(...vs);
    if(!(hi[k]>lo[k])){hi[k]=lo[k]+Math.abs(lo[k]||1)*0.2+1e-9;}
  }
  const norm=r=>keys.map(k=>(r.params[k]-lo[k])/(hi[k]-lo[k]));
  const X=top.map(norm), y=top.map(r=>r.m.sharpe), yMax=Math.max(...y);
  const K=X.map((a,i)=>X.map((b,j)=>_m52(a,b,0.5)+(i===j?1e-6:0)));
  const L=_chol(K), alpha=_cholSolve(L,y);
  const predict=v=>{
    const ks=X.map(a=>_m52(a,v,0.5));
    let mean=0;for(let i=0;i<ks.length;i++)mean+=alpha[i]*ks[i];
    const w=_cholSolve(L,ks);
    let vs=1;for(let i=0;i<w.length;i++)vs-=w[i]*w[i];
    return {mean,sd:Math.sqrt(Math.max(1e-12,vs))};
  };
  // Deterministic candidate lattice: reuse a Halton draw, not Math.random
  const cand=haltonSequence(400,keys.length);
  const scored=cand.map(v=>{
    const {mean,sd}=predict(v);
    const z=(mean-yMax)/Math.max(1e-9,sd);
    return {v,ei:sd*(z*_nCdf(z)+_nPdf(z))};
  }).sort((a,b)=>b.ei-a.ei);
  const seen=new Set(top.map(r=>JSON.stringify(r.params)));
  const out=[];
  const steps=stepsByInd[top[0].indicator]||{};
  for(const s of scored){
    if(out.length>=nPropose)break;
    const params={};
    keys.forEach((k,i)=>{
      let v=lo[k]+s.v[i]*(hi[k]-lo[k]);
      const st=steps[k]||0; // snap to grid step when known
      if(st>0)v=Math.round(v/st)*st;
      params[k]=+v.toFixed(6);
    });
    const k=JSON.stringify(params);
    if(seen.has(k))continue;seen.add(k);
    const c={timeframe:top[0].timeframe,indicator:top[0].indicator,params,exit:top[0].exit||'fixed',carry:!!top[0].carry,refined:true};
    if(top[0].slPct!=null)c.slPct=top[0].slPct;
    if(top[0].tpPct!=null)c.tpPct=top[0].tpPct;
    if(top[0].trailPct!=null)c.trailPct=top[0].trailPct;
    out.push(c);
  }
  if(!out.length){
    // Degenerate space (all EI candidates already evaluated): fall back to
    // ±1-step neighbors of the best row so callers always get proposals.
    // Clamped to the declared SCHEMA range (never walk out of bounds).
    const b=top[0], st=stepsByInd[b.indicator]||{};
    const schema=(typeof SCHEMA!=='undefined'&&SCHEMA[b.indicator])||[];
    const bound=k=>{const p=schema.find(q=>q.key===k);return p?{min:p.min,max:p.max}:null;};
    for(const k of keys){
      const step=st[k]||((hi[k]-lo[k])/10)||1;
      const bd=bound(k);
      for(const dir of [-1,1]){
        if(out.length>=nPropose)break;
        const params=Object.assign({},b.params);
        let pv=+(params[k]+dir*step).toFixed(6);
        if(bd&&(pv<bd.min||pv>bd.max))continue;
        params[k]=pv;
        const kk=JSON.stringify(params);
        if(seen.has(kk))continue;seen.add(kk);
        const c={timeframe:b.timeframe,indicator:b.indicator,params,exit:b.exit||'fixed',carry:!!b.carry,refined:true};
        if(b.slPct!=null)c.slPct=b.slPct;
        if(b.tpPct!=null)c.tpPct=b.tpPct;
        if(b.trailPct!=null)c.trailPct=b.trailPct;
        out.push(c);
      }
    }
  }
  return out;
}

function buildGrid(selected, risk, dims){
  // selected: [{indicator, ranges:{key:{min,max,step}}}, ...], timeframes:[...]
  // risk: {sl:[...], tp:[...], trail:[...]} — stop/target are searched per timeframe+indicator
  // so the data decides the best SL/TP (omit risk => fixed execution opts are used)
  // dims: {exits:['fixed','breakeven','atr'], carry:[false,true]} — exit logic and
  // intraday-vs-carry are searched dimensions too (mode params stay fixed inputs)
  const combos=[];
  const slVals=(risk&&risk.sl&&risk.sl.length)?risk.sl:[null];
  const tpVals=(risk&&risk.tp&&risk.tp.length)?risk.tp:[null];
  const trailVals=(risk&&risk.trail&&risk.trail.length)?risk.trail:[null];
  const exits=(dims&&dims.exits&&dims.exits.length)?dims.exits:['fixed'];
  const carrys=(dims&&dims.carry&&dims.carry.length)?dims.carry:[false];
  for(const s of selected){
    const schema=SCHEMA[s.indicator]||[];
    const axes=schema.map(p=>{
      const r=(s.ranges&&s.ranges[p.key])||{min:p.def,max:p.def,step:1};
      return expandRange(+r.min,+r.max,+r.step||1).map(v=>({key:p.key,val:v}));
    });
    const prod=axes.length?cartesian(axes):[[]];
    for(const t of (s.timeframes||[5])){
      for(const combo of prod){
        const params={};
        for(const kv of combo)params[kv.key]=kv.val;
        for(const sl of slVals)for(const tp of tpVals)for(const tr of trailVals)for(const ex of exits)for(const cy of carrys){
          const c={timeframe:t,indicator:s.indicator,params,exit:ex,carry:cy};
          if(sl!=null)c.slPct=sl; if(tp!=null)c.tpPct=tp; if(tr!=null)c.trailPct=tr;
          combos.push(c);
        }
      }
    }
  }
  return combos;
}

// ---------- Paper-trading gate + knife-edge demotion ----------
// paperEligible: the HARD gate. A row is paper-tradable only if every check
// passes; otherwise reasons[] names each failure. Pure + unit-tested.
// o: {scoreThreshold (def 9.5), requireWF (def true), minTrades (def 200),
//     cost (run cost/trade — must be > 0: zero-cost runs can never pass)}.
function paperEligible(row, o){
  o=o||{};
  const th=o.scoreThreshold==null?9.5:o.scoreThreshold;
  const minN=o.minTrades==null?200:o.minTrades;
  const reasons=[], warnings=[];
  if(row==null||row.m==null) return {eligible:false, reasons:['no result row'], warnings};
  if(!(row.m.netPnL>0)) reasons.push(`netPnL ${row.m.netPnL} ≤ 0`);
  if(!(row.m.totalTrades>=minN)) reasons.push(`trades ${row.m.totalTrades} < ${minN}`);
  if(o.cost!=null&&!(o.cost>0)){
    if(o.allowZeroCost) warnings.push('signal-only run (costs zeroed — size positions for real friction before trading)');
    else reasons.push('zero-cost run (set realistic cost/trade)');
  }
  if(row.robustScore==null) reasons.push('no robustness score (worker path required)');
  else if(!(row.robustScore>=th)) reasons.push(`robustScore ${(row.robustScore||0).toFixed(2)} < ${th}`);
  const rb=row.robustness||{};
  if(rb.surrogate==null) reasons.push('no surrogate evidence');
  else if(rb.surrogate.skipped) reasons.push(`surrogate skipped (n<20)`);
  else if(!(rb.surrogate.p<0.01)) reasons.push(`surrogate p=${rb.surrogate.p} ≥ 0.01`);
  if(rb.paramSensitivity==null) reasons.push('no PSS evidence');
  else if(rb.paramSensitivity.skipped) reasons.push(`PSS skipped (n=${rb.paramSensitivity.baseTrades}<30)`);
  else if(rb.paramSensitivity.knifeEdge) reasons.push(`knife-edge PSS=${rb.paramSensitivity.pss}`);
  if(o.requireWF!==false){
    if(row.survived==null) reasons.push('no OOS verdict (thin OOS folds — enable walk-forward already on? widen OOS window)');
    else if(!row.survived) reasons.push('OOS not survived');
  }
  return {eligible:reasons.length===0, reasons, warnings};
}
// demoteKnifeEdge: stable re-rank pushing knife-edge rows (pssOf(row) ≥ 0.5)
// below every clean row. Rows with unknown PSS keep position (never punished
// for missing evidence — the paper gate handles absence separately).
function demoteKnifeEdge(ranked, pssOf){
  const clean=[], edge=[];
  for(const r of ranked){
    let p=null;
    try{ p=pssOf(r); }catch(e){ p=null; }
    if(p!=null&&isFinite(p)&&p>=0.5)edge.push(r);else clean.push(r);
  }
  return clean.concat(edge);
}

// ---------- Deterministic hashing + offline replay ----------
// FNV-1a 32-bit hex: sync, deterministic, no dependencies. The runner
// upgrades artifact hashes to SHA-256 (crypto.subtle) when available and
// records which algorithm produced each hash — never silently weak.
function fnv1a(str){
  str=typeof str==='string'?str:String(str);
  let h=0x811c9dc5;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,0x01000193);}
  return ('0000000'+(h>>>0).toString(16)).slice(-8);
}
function hashRecord(o){ try{return fnv1a(JSON.stringify(o));}catch(e){return fnv1a(String(o));} }
// replayAudit(artifact): independently reconstruct tiers, composite scores,
// objective rankings, Pareto set and ranking audit from candidate_results
// ALONE (no data, no backtests — pure recomputation), then compare every
// field against the stored values. Returns REPLAY_STATUS + mismatches with
// candidate_id/field/original/replayed/difference.
function replayAudit(art){
  const out={checks:[], mismatches:[], pass:true};
  const fail=(check, m)=>{ out.pass=false; out.checks.push(Object.assign({name:check, pass:false}, m||{})); };
  const cands=art.candidate_results||[];
  const rk=art.ranking_results||{};
  const byId={}; for(const c of cands) byId[c.candidate_id]=c;
  // 1. candidate count
  if(cands.length===(rk.input_count==null?cands.length:rk.input_count)) out.checks.push({name:'CANDIDATE_COUNT_MATCH', pass:true, detail:String(cands.length)});
  else fail('CANDIDATE_COUNT_MATCH', {detail:`artifact=${cands.length} ranking_input=${rk.input_count}`});
  // 2-3. tiers + composite recomputation (METRIC_MATCH + COMPOSITE_MATCH)
  const wsum=(art.config&&art.config.scoreW)||null;
  const over={weights:wsum||undefined, tiers:(art.config&&art.config.sampleTiers)||undefined};
  let metricBad=0, compBad=0, tierBad=0;
  for(const c of cands){
    const m=c.metrics||{};
    const reT=sampleTier(m.totalTrades||0, over.tiers);
    if(reT!==(c.sample_tier||reT)){ tierBad++; if(metricBad+tierBad+compBad<6) out.mismatches.push({candidate_id:c.candidate_id, field:'sample_tier', original:c.sample_tier, replayed:reT, difference:'tier'}); }
    const reS=strategyScore(m, over);
    const oc=c.composite||{};
    if(Math.abs((reS.composite||0)-(oc.score==null?reS.composite:oc.score))>1e-9){ compBad++; if(metricBad+tierBad+compBad<6) out.mismatches.push({candidate_id:c.candidate_id, field:'composite', original:oc.score, replayed:reS.composite, difference:+(((oc.score||0)-reS.composite)).toFixed(6)}); }
    if((oc.tier||reT)!==reT){ metricBad++; }
  }
  (tierBad===0&&compBad===0?out.checks.push({name:'METRIC_MATCH',pass:true,detail:cands.length+' rows'}):fail('METRIC_MATCH',{detail:`tier=${tierBad} composite=${compBad}`}));
  (compBad===0?out.checks.push({name:'COMPOSITE_MATCH',pass:true,detail:cands.length+' rows'}):fail('COMPOSITE_MATCH',{detail:compBad+' mismatches'}));
  // 4. rankings: recompute per-objective order, compare stored top rows.
  // row_index restores the original tie-break (researchCmp falls back to .i).
  const rows=cands.map(c=>({m:c.metrics, _id:c.candidate_id, i:c.row_index}));
  let rankBad=0;
  for(const [key] of RESEARCH_OBJS){
    const reOrder=rows.slice().sort(researchCmp(key)).map(r=>r._id);
    const stored=((rk.per_objective||{})[key]||[]).slice(0, Math.min(20, reOrder.length));
    const head=reOrder.slice(0, stored.length);
    if(JSON.stringify(head)!==JSON.stringify(stored)){ rankBad++; if(rankBad<4) out.mismatches.push({candidate_id:'(board:'+key+')', field:'ranking', original:stored.slice(0,3), replayed:head.slice(0,3), difference:'order'}); }
  }
  (rankBad===0?out.checks.push({name:'RANKING_MATCH',pass:true,detail:'5/5 objectives'}):fail('RANKING_MATCH',{detail:rankBad+' objectives differ'}));
  // 5. pareto: recompute membership
  const rePareto=new Set(paretoFrontier(rows).map(r=>r._id));
  const stPareto=new Set(rk.pareto||[]);
  const pMiss=[...rePareto].filter(id=>!stPareto.has(id)), pExtra=[...stPareto].filter(id=>!rePareto.has(id));
  (pMiss.length===0&&pExtra.length===0?out.checks.push({name:'PARETO_MATCH',pass:true,detail:rePareto.size+' members'}):fail('PARETO_MATCH',{detail:`missing=${pMiss.slice(0,3)} extra=${pExtra.slice(0,3)}`}));
  // 6. robustness summary: internal consistency (stored score vs stored rank).
  // Candidate records carry robust_score (snake); accept legacy robustScore.
  const rb=art.robustness_results||[];
  let rbBad=0;
  for(const r of rb){ const c=byId[r.candidate_id]; const sc=c?(c.robust_score??c.robustScore):null; if(c&&(sc==null||Math.abs(sc-r.adjusted)>1e-9))rbBad++; }
  (rbBad===0?out.checks.push({name:'ROBUSTNESS_MATCH',pass:true,detail:rb.length+' rows'}):fail('ROBUSTNESS_MATCH',{detail:rbBad+' score mismatches'}));
  // 7. hash verification: recompute config + results fingerprints.
  // Dataset hash needs raw bars (absent offline) → presence-checked only.
  const hh=art.hashes||{};
  if(hh.config&&hh.config.hash){
    const re=hashRecord(art.config);
    (re===hh.config.hash?out.checks.push({name:'CONFIG_HASH_MATCH',pass:true,detail:hh.config.algo||'fnv'}):fail('CONFIG_HASH_MATCH',{detail:'stored vs recomputed differ'}));
    if(re!==hh.config.hash)out.mismatches.push({candidate_id:'(config)',field:'config_hash',original:hh.config.hash,replayed:re,difference:'hash'});
  } else out.checks.push({name:'CONFIG_HASH_MATCH',pass:true,detail:'no stored hash (skipped)'});
  if(hh.results&&hh.results.hash){
    const re=hashRecord(cands.map(c=>[c.candidate_id,c.net_pnl,c.trade_count]));
    (re===hh.results.hash?out.checks.push({name:'RESULT_HASH_MATCH',pass:true,detail:cands.length+' rows'}):fail('RESULT_HASH_MATCH',{detail:'stored vs recomputed differ'}));
    if(re!==hh.results.hash)out.mismatches.push({candidate_id:'(results)',field:'results_hash',original:hh.results.hash,replayed:re,difference:'hash'});
  } else out.checks.push({name:'RESULT_HASH_MATCH',pass:true,detail:'no stored hash (skipped)'});
  // per-row hashes attribute tampering to exact candidates (when present)
  for(const c of cands){
    if(c._row_hash==null)continue;
    const re=hashRecord([c.candidate_id,c.net_pnl,c.trade_count]);
    if(re!==c._row_hash){ fail('ROW_HASH_MATCH',{detail:c.candidate_id}); out.mismatches.push({candidate_id:c.candidate_id,field:'row_hash',original:c._row_hash,replayed:re,difference:'hash'}); }
  }
  if(!out.checks.some(c=>c.name==='ROW_HASH_MATCH'))out.checks.push({name:'ROW_HASH_MATCH',pass:true,detail:'all present rows verify'});
  if(hh.dataset&&hh.dataset.hash)out.checks.push({name:'DATASET_HASH_PRESENT',pass:true,detail:String(hh.dataset.hash).slice(0,16)+'… (recompute needs raw bars)'});
  else out.checks.push({name:'DATASET_HASH_PRESENT',pass:true,detail:'absent (skipped)'});
  out.checks.push({name:'REPLAY_STATUS', pass:out.pass, detail:out.pass?'PASS':'FAIL'});
  return out;
}

// ---------- Research ranking: single canonical ordering ----------
// ---------- Research scoring: multi-metric, sample-aware ----------
// LAYER MODEL: RAW_METRICS (informational, everything calculated) →
// RANKABLE_METRICS (composite score determines selection order) →
// ROBUST_METRICS (validation/final selection, separate gate).
// Sharpe is ONE 10% component, winsorized and sample-shrunk, so n=2 with
// Sharpe 1,160 can never dominate. All transforms are absolute (no
// run-relative percentiles) and documented below. Deterministic.
const SCORE_DEF={
  weights:{ret:0.25, winExp:0.20, pf:0.15, sample:0.15, risk:0.15, sharpe:0.10},
  sampleK:30, ddScale:10, sharpeCap:20, shrK:30,
  tiers:{insufficient:10, rankable:30},
};
function sampleTier(n, tiers){
  // RAW = any trade count (displayed, never ranked). Classified tiers:
  // INSUFFICIENT n<insufficient · EXPLORATORY ins≤n<rankable ·
  // RANKABLE n≥rankable · ROBUST_ELIGIBLE handled separately
  // (robustEligible: paper minTrades, default 200).
  tiers=tiers||SCORE_DEF.tiers;
  if(!(n>0))return 'INSUFFICIENT';
  if(n<tiers.insufficient)return 'INSUFFICIENT';
  if(n<tiers.rankable)return 'EXPLORATORY';
  return 'RANKABLE';
}
function robustEligible(n, minTrades){
  return n>=(minTrades==null?200:minTrades);
}
function sharpeAdj(sharpeRaw, n, shrK){
  // Empirical-Bayes-style shrinkage toward 0 (NOT a statistical estimator):
  // factor n/(n+k) → 1 as n grows, crushes tiny n. k configurable.
  // n=2,k=30 → 0.06 (Sharpe 1160 → 73, then winsorized); n=200 → 0.87.
  if(typeof sharpeRaw!=='number'||!isFinite(sharpeRaw))return 0;
  const k=shrK==null?SCORE_DEF.shrK:shrK;
  return sharpeRaw*(Math.max(0,n)/(Math.max(0,n)+Math.max(1,k)));
}
function sharpeReliability(n){
  if(n>=30)return 'HIGH';
  if(n>=10)return 'MEDIUM';
  return 'LOW';
}
function strategyScore(m, over){
  // Components (all 0..1, monotonic, bounded):
  // ret: R-multiple expectancy E/|avgLoss| → R/(1+R) (0 when E≤0)
  // winExp: 50% win-rate scale + 50% positive-expectancy direction
  // pf: profitFactor → pf/(1+pf) (0.5 at breakeven, smooth both sides)
  // sample: n/(n+k) diminishing returns (evidence quality, not frequency)
  // risk: 1/(1+|maxDD|/ddScale), maxDD in %
  // sharpe: winsorized(±cap) sample-adjusted Sharpe → s/(s+2)
  const o=Object.assign({}, SCORE_DEF, over||{});
  const W=Object.assign({}, SCORE_DEF.weights, (over&&over.weights)||{});
  const n=(m&&m.totalTrades)||0;
  const wins=Math.round(((m&&m.winRate)||0)*n/100);
  const avgLoss=(m&&n-wins>0)?(m.grossLoss||0)/Math.max(1,n-wins):0;
  const R=(m&&m.expectancy>0&&avgLoss>0)?m.expectancy/avgLoss:0;
  const ret=R<=0?0:R/(1+R);
  const winExp=0.5*((m&&m.winRate||0)/100)+((m&&m.expectancy>0)?0.5:0);
  const pf=(m&&m.profitFactor)||0;
  const pfQ=pf<=0?0:pf/(1+pf);
  const sample=n<=0?0:n/(n+Math.max(1,o.sampleK));
  const dd=Math.abs((m&&m.maxDD)||0);
  const risk=1/(1+dd/Math.max(1e-9,o.ddScale));
  const sraw=typeof (m&&m.sharpe)==='number'?m.sharpe:0;
  const sadj=sharpeAdj(sraw,n,o.shrK);
  const sc=Math.max(-o.sharpeCap,Math.min(o.sharpeCap,sadj));
  const sharpeQ=sc<=0?0:sc/(sc+2);
  const parts={ret:+ret.toFixed(4),winExp:+winExp.toFixed(4),pf:+pfQ.toFixed(4),sample:+sample.toFixed(4),risk:+risk.toFixed(4),sharpe:+sharpeQ.toFixed(4)};
  const composite=+(W.ret*parts.ret+W.winExp*parts.winExp+W.pf*parts.pf+W.sample*parts.sample+W.risk*parts.risk+W.sharpe*parts.sharpe).toFixed(4);
  return {composite, parts, sharpeRaw:isFinite(sraw)?+sraw.toFixed(2):0, sharpeAdj:+sadj.toFixed(2),
    tier:sampleTier(n,o.tiers), reliability:sharpeReliability(n), n};
}
function rankableScore(m, over){
  // Selection gate: RANKABLE tier or better (n ≥ tiers.rankable, default 30).
  // Returns null when NOT_RANKABLE (row stays visible in RAW discovery,
  // THIN list, Pareto pool — never in composite selection).
  const s=strategyScore(m, over);
  const tiers=(over&&over.tiers)||SCORE_DEF.tiers;
  if(s.n<((tiers.rankable==null)?30:tiers.rankable))return null;
  return s;
}
// whyNotRanked: the explicit exclusion reason for every tier below RANKABLE
// (and for rankable rows that still fail validation). Never silent.
function whyNotRanked(row, over){
  const m=(row&&row.m)||{};
  const n=m.totalTrades||0;
  const tiers=(over&&over.tiers)||SCORE_DEF.tiers;
  const minT=(tiers.rankable==null)?30:tiers.rankable;
  if(!(n>0))return 'INSUFFICIENT_TRADES';
  if(n<minT)return n<((tiers.insufficient==null)?10:tiers.insufficient)?'INSUFFICIENT_TRADES':'EXPLORATORY_ONLY';
  const rb=row.robustness||{};
  if(row.robustScore==null&&!rb.surrogate&&!rb.paramSensitivity)return 'NOT_EVALUATED';
  if(row.robustScore!=null&&row.robustScore<9.5)return 'ROBUSTNESS_FAILURE';
  if(rb.surrogate&&!rb.surrogate.skipped&&!(rb.surrogate.p<0.01))return 'ROBUSTNESS_FAILURE';
  if(row.survived===false)return 'OOS_FAILURE';
  if(!isFinite(m.sharpe)||!isFinite(m.expectancy)||!isFinite(m.profitFactor))return 'INVALID_METRIC';
  return '';
}
function paretoFrontier(rows, keys){
  // Non-dominated set over [key,dir] dims (dir=+1 maximize, -1 minimize).
  // Returns frontier rows in input order — NO 1st/2nd/3rd ranking.
  // Default dims: P&L, expectancy, WR, trades, PF, maxDD, Sharpe.
  keys=keys||[['netPnL',1],['expectancy',1],['winRate',1],['totalTrades',1],['profitFactor',1],['maxDD',1],['sharpe',1]];
  const val=(r,k)=>{const v=r.m&&r.m[k];return (typeof v==='number'&&isFinite(v))?v:-Infinity;};
  const dom=(a,b)=>{let strictly=false;for(const [k,dir] of keys){const d=(val(a,k)-val(b,k))*dir;if(d<0)return false;if(d>0)strictly=true;}return strictly;};
  return rows.filter(a=>!rows.some(b=>b!==a&&dom(b,a)));
}
// RESEARCH_OBJS: the five discovery objectives. researchValue guards NaN/
// undefined explicitly (±Infinity never wins; -Infinity never tops).
// Tie-break chain (explicit, deterministic): primary → netPnL → trades →
// maxDD (higher) → row index. rankResults below implements exactly this.
const RESEARCH_OBJS=[['netPnL','NET_PNL'],['winRate','WIN_RATE'],['expectancy','EXPECTANCY'],['profitFactor','PROFIT_FACTOR'],['sharpe','SHARPE']];
function researchValue(m, key){
  if(!m)return -Infinity;
  const v=m[key];
  if(typeof v!=='number'||!isFinite(v))return -Infinity;
  return v;
}
function researchCmp(key){
  return (a,b)=>(researchValue(b.m,key)-researchValue(a.m,key))
    ||((b.m.netPnL||0)-(a.m.netPnL||0))
    ||((b.m.totalTrades||0)-(a.m.totalTrades||0))
    ||((b.m.maxDD||0)-(a.m.maxDD||0))
    ||((a.i||0)-(b.i||0));
}
// auditRankingIntegrity(allRows, displayed): for each research objective,
// argmax over the COMPLETE evaluated set vs displayed rank #1 under the same
// objective (identity = cfgKey). Any mismatch → RANKING_INTEGRITY = FAIL.
function auditRankingIntegrity(allRows, displayed){
  return RESEARCH_OBJS.map(([key,label])=>{
    // argmax with the SAME comparator the display sort uses (ties included)
    const cmp=researchCmp(key);
    let bi=null;
    for(const r of allRows){ if(!bi||cmp(r,bi)<0) bi=r; }
    const bv=bi?researchValue(bi.m,key):-Infinity;
    const disp=(displayed||[]).slice().sort(researchCmp(key));
    const d0=disp[0]||null;
    const pass=!!(bi&&d0&&cfgKey(bi)===cfgKey(d0));
    return {objective:label, key, pass,
      maxRow:bi?cfgKey(bi):null, maxValue:isFinite(bv)?+bv.toFixed(4):null,
      displayed:d0?cfgKey(d0):null};
  });
}
// Research union: topN by configured objective + top-20 per research
// objective, so no discovery can vanish merely because another objective was
// configured. Returns {board, extra}. Pure + deterministic (tested).
function researchUnion(allRows, topN, objective){
  const keep=new Map();
  for(const r of rankResults(allRows, objective).slice(0, topN)) keep.set(cfgKey(r), r);
  let extra=0;
  for(const [key] of RESEARCH_OBJS){
    for(const r of allRows.slice().sort(researchCmp(key)).slice(0, 20)){
      const k=cfgKey(r);
      if(!keep.has(k)){keep.set(k, r);extra++;}
    }
  }
  return {board:[...keep.values()], extra};
}
function rankResults(rows, objective){
  // Do-nothing rows (0 trades: flat signals, warmup-only, unavailable legs)
  // always rank BELOW traded rows — otherwise a 0/0/0 row tops losing boards.
  const traded=rows.filter(r=>r.m&&r.m.totalTrades>0);
  const flat=rows.filter(r=>!(r.m&&r.m.totalTrades>0));
  const r=[...traded];
  if(objective==='winrate')r.sort((a,b)=>b.m.winRate-a.m.winRate||b.m.netPnL-a.m.netPnL);
  else if(objective==='trades')r.sort((a,b)=>b.m.totalTrades-a.m.totalTrades||b.m.netPnL-a.m.netPnL);
  else if(objective==='drawdown')r.sort((a,b)=>b.m.maxDD-a.m.maxDD||b.m.netPnL-a.m.netPnL); // maxDD negative; higher (closer 0) first
  else if(objective==='sortino')r.sort((a,b)=>b.m.sortino-a.m.sortino);
  else r.sort((a,b)=>b.m.sharpe-a.m.sharpe||b.m.netPnL-a.m.netPnL); // default sharpe
  return r.concat(flat);
}

const api={parseCSV,parseCSVAll,resample,ema,sma,hma,dema,wma,rsi,atr,macd,bollinger,keltner,stoch,supertrend,adx,vwapSeries,chandeKroll,pocSeries,kama,fisherTransform,ttmSqueeze,connorsRSI,vwapBands,cvdSeries,fvgZones,choppiness,cyberCycle,vwma,cmo,aroon,hilbertDC,itrend,adaptivePeriod,smoothRegime,applyMaskPersistence,haltonSequence,buildHaltonGrid,purgedFolds,bayesianRefine,paperEligible,demoteKnifeEdge,parseExpiryFlex,detectExchange,resolveSession,EXCHANGE_SESSIONS,ivRankSeries,ivRankMask,buildExpiryMask,RESEARCH_OBJS,researchValue,researchCmp,auditRankingIntegrity,IST_OFFSET_MS,istParts,istDayKey,istDayIndex,regimeSeries,ROUTER,FAMILY,regimeMask,regimeFeatures,trainSoftmax,predictSoftmax,trainRegimeML,daySegments,dayFeatures,dayRuleLabels,trainDayML,dayRegimeMask,dayRouting,validateLayers,buildSignals,backtest,buildSessionMask,buildWindowMask,combineMasks,sessionMaskFor,buildGrid,rankResults,objectiveValue,paramNeighbors,cfgKey,exitOptsFromParams,expandRange,SCHEMA,timeToMin,parseDateFlex,dteMask,atmStrikes,underlyingSignal,SCORE_DEF,sampleTier,sharpeAdj,sharpeReliability,strategyScore,rankableScore,whyNotRanked,robustEligible,paretoFrontier,researchUnion,fnv1a,hashRecord,replayAudit};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.XBOST_ENGINE=api;
})(typeof self!=='undefined'?self:this);
