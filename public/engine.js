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
  if(/^\d{8}$/.test(s)){ // YYYYMMDD
    const y=+s.slice(0,4),m=+s.slice(4,6),d=+s.slice(6,8);
    if(m>=1&&m<=12&&d>=1&&d<=31)return new Date(y,m-1,d).getTime();
    return NaN;
  }
  const p=Date.parse(s.replace(' ', 'T'));
  return isNaN(p)?NaN:p;
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
// Extra columns (symbol, expiry, OI, …) are detected and ignored — OHLCV only.
function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const grid=[];
  for (let i=0;i<lines.length;i++) {
    const ln = lines[i].trim();
    if (ln) grid.push(ln.split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')));
  }
  if (!grid.length) return emptyData();
  // ---- header sniff: >=2 known words and mostly non-numeric ----
  const first = grid[0];
  const known = first.filter(c=>/^(symbol|scrip|instrument|ticker|date|datetime|timestamp|time|day|expiry|open|high|low|close|settle|ltp|volume|vol|qty|quantity|oi|openinterest|open_interest|chginoi)$/i.test(c)).length;
  const numeric = first.filter(c=>c!==''&&isFinite(+c)).length;
  let header=null, start=0, layout='positional';
  if (known>=2 && numeric<first.length/2){ header=first.map(s=>s.toLowerCase()); start=1; layout='header'; }
  const HF=(re)=>header?header.findIndex(x=>re.test(x)):-1;
  let symI=-1, dtI=-1, dateI=-1, timeI=-1, oI=-1, hI=-1, lI=-1, cI=-1, vI=-1;
  if (header) {
    symI=HF(/^(symbol|scrip|instrument|ticker)$/);
    dtI=HF(/^(datetime|timestamp)$/);
    dateI=dtI>=0?-1:HF(/^(date|day)$/);
    timeI=dtI>=0?-1:HF(/^(time)$/);
    // guard: a lone 'time' column holding full stamps (e.g. '2024-01-01 09:15')
    oI=HF(/^open$/); hI=HF(/^high$/); lI=HF(/^low$/); cI=HF(/^(close|settle|ltp)$/);
    vI=HF(/^(volume|vol|qty|quantity|traded)$/);
    if (oI<0||hI<0||lI<0||cI<0) return emptyData(); // not OHLCV at all
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
    symI=colKind.findIndex(k=>k==='STR');
    dtI=colKind.findIndex(k=>k==='DT');
    if(dtI<0){ dateI=colKind.findIndex(k=>k==='D8'); timeI=colKind.findIndex(k=>k==='TM'); }
    // OHLCV = NUM columns after the stamp columns; volume = next NUM after close
    const nums=[];
    for(let c=0;c<nCols;c++)if(colKind[c]==='NUM')nums.push(c);
    const ordered=nums.filter(c=>c>Math.max(symI,dtI,dateI,timeI,-1));
    const use=ordered.length>=5?ordered:nums.slice(-5);
    if(use.length<4)return emptyData();
    oI=use[0];hI=use[1];lI=use[2];cI=use[3];vI=use.length>4?use[4]:-1;
  }
  const T=[],O=[],H=[],L=[],C=[],V=[];
  const symCount={};
  for (let i=start;i<grid.length;i++) {
    const p = grid[i];
    if (p.length < 4) continue;
    let t=NaN;
    if (dtI>=0) t=parseDateFlex(p[dtI]);
    else if (dateI>=0){
      const base=parseDateFlex(p[dateI]);
      if(timeI>=0){const tm=parseTimeFlex(p[timeI]); t=isNaN(base)||!tm?NaN:new Date(new Date(base).getFullYear(),new Date(base).getMonth(),new Date(base).getDate(),tm.h,tm.min,tm.s).getTime();}
      else t=base;
    }
    else if (timeI>=0){
      // lone time column: only usable if it carries a full stamp (has a date part)
      t=/[-/]/.test(p[timeI]||'')?parseDateFlex(p[timeI]):NaN;
    }
    else t=+p[0]; // last resort: epoch in first column
    const o=+(p[oI]??NaN),h2=+(p[hI]??NaN),l2=+(p[lI]??NaN),c2=+(p[cI]??NaN),v=+(p[vI]??0);
    if (!isFinite(o)||!isFinite(h2)||!isFinite(l2)||!isFinite(c2)||!isFinite(t)) continue;
    if(symI>=0&&p[symI]){const s=String(p[symI]).split(/[_.\-\s]+/)[0].toUpperCase().slice(0,20);symCount[s]=(symCount[s]||0)+1;}
    T.push(t);O.push(o);H.push(h2);L.push(l2);C.push(c2);V.push(v||0);
  }
  // sort by time
  const n=T.length, idx=new Array(n);
  for(let i=0;i<n;i++) idx[i]=i;
  idx.sort((a,b)=>T[a]-T[b]);
  const out={t:new Float64Array(n),o:new Float64Array(n),h:new Float64Array(n),l:new Float64Array(n),c:new Float64Array(n),v:new Float64Array(n),symbol:null,layout};
  for(let i=0;i<n;i++){const j=idx[i];out.t[i]=T[j];out.o[i]=O[j];out.h[i]=H[j];out.l[i]=L[j];out.c[i]=C[j];out.v[i]=V[j];}
  let best=null,bn=0;
  for(const k of Object.keys(symCount))if(symCount[k]>bn){bn=symCount[k];best=k;}
  if(best)out.symbol=best;
  out.layout=(header?('header['+header.slice(0,9).join(',')+']'):'positional')
    +(symI>=0?'+SYM':'')+(dtI>=0?'+DT':(dateI>=0?'+D':'')+(timeI>=0?'+T':''));
  return out;
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
  const fmt=t=>new Date(t).toDateString();
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
  const fmt=t=>new Date(t).toDateString();
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
  Chop:[0,1,2,3],Regime:[0,1,2,3]
};
function regimeMask(regimes, indicator){
  const allow=ROUTER[indicator];
  const n=regimes.length, out=new Int8Array(n);
  if(!allow){out.fill(1);return out;}
  for(let i=0;i<n;i++)out[i]=allow.indexOf(regimes[i])>=0?1:0;
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
    const dt=new Date(d.t[i]);
    f[8]=((dt.getHours()*60+dt.getMinutes())-555)/375; // minutes since 09:15 / session
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
  const key=t=>new Date(t).toDateString();
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
      let hi=0;for(let i=1;i<a.conf.length;i++)if(a.conf[i]>=(o.confGate||0.6))hi++;
      const cov=segs.length>1?hi/(segs.length-1):0;
      out.push({name:'M4 confident-day coverage',pass:true,warn:cov<0.3,detail:(100*cov).toFixed(0)+'% days ≥ gate (rest fallback, measured)'});
    }
  }
  if(o.wf){
    const span=d.t[n-1]-d.t[0];
    out.push({name:'W1 OOS span viable',pass:span>0,warn:false,detail:'split '+o.wfSplit+'/'+(100-o.wfSplit)});
  }
  return out;
}

// ---------- backtest ----------
function timeToMin(s){const[a,b]=s.split(':').map(Number);return a*60+b;}

// Precompute once per timeframe (NOT per combo): 1 if bar is inside session, else 0.
// Building this costs ~1M Date() calls — callers must cache it across grid combos.
function buildSessionMask(d, startStr, endStr){
  const n=d.c.length, mask=new Int8Array(n);
  if(!startStr||!endStr){mask.fill(1);return mask;}
  const s0=timeToMin(startStr), s1=timeToMin(endStr);
  for(let i=0;i<n;i++){const dt=new Date(d.t[i]);const m=dt.getHours()*60+dt.getMinutes();mask[i]=(m>=s0&&m<=s1)?1:0;}
  return mask;
}

function backtest(d, sigPos, opts){
  opts=opts||{};
  const direction=opts.direction||'Both';
  const slPct=(opts.slPct||0)/100, tpPct=(opts.tpPct||0)/100, trailPct=(opts.trailPct||0)/100;
  const capital0=opts.capital||100000, qty=opts.qty||1, lotSize=opts.lotSize||1;
  const costPerTrade=opts.cost||0;
  const n=d.c.length;
  const mask=opts.sessionMask||buildSessionMask(d, opts.sessionStart, opts.sessionEnd);
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
  let liveEq=capital0, ruined=false; // ruin guard: account blown -> no new entries
  const eqMtm=new Float64Array(n).fill(capital0); // mark-to-market equity incl. open heat
  // dynamic exit plumbing
  const exitMode=opts.exit||'fixed'; // fixed | breakeven | atr
  const beTrig=((opts.beTrigger!=null?opts.beTrigger:((opts.slPct||0)))/100); // profit to lock breakeven (default 1R)
  const beLock=(opts.beLock||0)/100; // locked profit once triggered (0 = flat breakeven)
  const atrMult=opts.atrTrailMult||3;
  let atrArr=null;
  if(exitMode==='atr')atrArr=atr(d.h,d.l,d.c,Math.max(2,Math.round(opts.atrTrailPeriod||14)));
  let ckArr=null;
  if(exitMode==='ck')ckArr=chandeKroll(d.h,d.l,d.c,Math.max(2,Math.round(opts.ckPeriod||10)),opts.ckMult||3);
  let hiEntry=0, loEntry=0, beDone=false;
  const useMask=opts.carry?null:mask; // carry overnight => ignore session flattening
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
  for(let i=1;i<n;i++){
    const px=d.c[i], ox=d.o[i];
    const decTgt=desiredTarget(i);
    const actTgt=fillNext?pendTgt:decTgt;
    pendTgt=decTgt;
    const noSig=fillNext&&actTgt===null;
    const fillPx=fillNext?ox:px;
    const edge=!noSig&&actTgt!==0&&actTgt!==prevAct;
    prevAct=actTgt;
    // manage open position: SL / target / trailing / signal flip / session exit
    if(position!==0){
      const ret=position===1?(px-entryPx)/entryPx:(entryPx-px)/entryPx;
      if(position===1){if(px>trailPeak)trailPeak=px;if(d.h[i]>hiEntry)hiEntry=d.h[i];}
      else{if(px<trough||trough===0)trough=px; if(trough===0)trough=px;if(d.l[i]<loEntry||loEntry===0)loEntry=d.l[i];}
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
          else exitPx=position===1?trailPeak*(1-trailPct):trough*(1+trailPct);
        }
        const units=qty*lotSize;
        let pnl=(position===1?(exitPx-entryPx):(entryPx-exitPx))*units - costPerTrade;
        const pnlPct=position===1?(exitPx-entryPx)/entryPx*100:(entryPx-exitPx)/entryPx*100;
        trades.push({id:trades.length+1,entryIdx,exitIdx:i,entryTime:d.t[entryIdx],exitTime:d.t[i],entryPx,exitPx,type:position===1?'LONG':'SHORT',pnl,pnlPct,reason:stopHit?reason:(flip?'FLIP':(flatSignal?'SESSION/FLAT':'END'))});
        position=0;curQty=0;
        liveEq+=pnl;
        // GUARD: halt immediately on ruin — fill the tail flat and break
        // (no point burning 1M-bar loops for a dead parameter set).
        if(liveEq<=0){ruined=true;for(let j=i;j<n;j++)eqMtm[j]=liveEq;lastExitBar=i;break;}
        // immediate re-entry on flip (mask already enforced via tgt)
        if(!trigOnly&&flip&&(!useMask||useMask[i])&&(!tmask||tmask[i])&&!ruined){
          position=tgt;entryPx=fillPx;entryIdx=i;trailPeak=fillPx;trough=fillPx;curQty=units;
          hiEntry=d.h[i];loEntry=d.l[i];beDone=false;
        }
        lastExitBar=i;
        eqMtm[i]=liveEq+(position!==0?(position===1?(px-entryPx):(entryPx-px))*curQty:0);
        continue;
      }
    } else {
      const allowEntry=!trigOnly||(edge&&i>lastExitBar);
      if(!noSig&&actTgt!==0&&(!useMask||useMask[i])&&(!tmask||tmask[i])&&!ruined&&allowEntry){
        position=actTgt;entryPx=fillPx;entryIdx=i;trailPeak=fillPx;trough=fillPx;curQty=qty*lotSize;
        hiEntry=d.h[i];loEntry=d.l[i];beDone=false;
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
  for(let i=0;i<n;i++){const dy=Math.floor(d.t[i]/86400000);if(dy!==lastDay){lastDay=dy;days++;}}
  const tradesPerDay=days>0?trades.length/days:trades.length;
  const dret=[];
  { const seen={};
    for(let i=0;i<n;i++){const dy=Math.floor(d.t[i]/86400000);if(!seen[dy]){seen[dy]=1;dret.push((dayPnl[dy]||0)/Math.max(1e-9,capital0));}} }
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
  for(const k of Object.keys(steps||{})){
    if(!(k in P))continue;
    const st=+steps[k]||0; if(st<=0)continue;
    const cur=+P[k];
    for(const dir of [-1,1]){
      let v=+(cur+dir*st).toFixed(4);
      if(!isFinite(v)||v<=0||v===cur)continue;
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

const api={parseCSV,resample,ema,sma,hma,dema,wma,rsi,atr,macd,bollinger,keltner,stoch,supertrend,adx,vwapSeries,chandeKroll,pocSeries,kama,fisherTransform,ttmSqueeze,connorsRSI,vwapBands,cvdSeries,fvgZones,choppiness,cyberCycle,vwma,cmo,aroon,regimeSeries,ROUTER,regimeMask,regimeFeatures,trainSoftmax,predictSoftmax,trainRegimeML,daySegments,dayFeatures,dayRuleLabels,trainDayML,dayRegimeMask,dayRouting,validateLayers,buildSignals,backtest,buildSessionMask,buildGrid,rankResults,objectiveValue,paramNeighbors,cfgKey,exitOptsFromParams,expandRange,SCHEMA,timeToMin};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.XBOST_ENGINE=api;
})(typeof self!=='undefined'?self:this);
