/* XBOST Quant Engine — resample, indicators, backtest, metrics (shared by UI + Worker) */
(function (root) {
'use strict';

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  let header = null, di=-1, oi=-1, hi=-1, li=-1, ci=-1, vi=-1;
  const T=[],O=[],H=[],L=[],C=[],V=[];
  for (let i=0;i<lines.length;i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (!header) {
      const h = ln.toLowerCase().split(',').map(s=>s.trim().replace(/["']/g,''));
      header = h;
      di=h.findIndex(x=>/date|time|datetime|timestamp/.test(x));
      oi=h.findIndex(x=>x==='open'); hi=h.findIndex(x=>x==='high');
      li=h.findIndex(x=>x==='low'); ci=h.findIndex(x=>x==='close');
      vi=h.findIndex(x=>/vol/.test(x));
      if (oi<0||hi<0||li<0||ci<0) { // assume positional w/o header
        header=null; di=0;oi=1;hi=2;li=3;ci=4;vi=5;
      } else continue;
    }
    // fast split (no quoted commas expected in OHLCV)
    const p = ln.split(',');
    if (p.length < 5) continue;
    let t;
    if (di>=0 && isNaN(Date.parse(p[di]))===false && /[-/:]/.test(p[di])) t = Date.parse(p[di].replace(' ', 'T'));
    else t = +p[di];
    const o=+p[oi],h2=+p[hi],l2=+p[li],c2=+p[ci],v=+(p[vi]||0);
    if (!isFinite(o)||!isFinite(h2)||!isFinite(l2)||!isFinite(c2)||!isFinite(t)) continue;
    T.push(t);O.push(o);H.push(h2);L.push(l2);C.push(c2);V.push(v||0);
  }
  // sort by time
  const n=T.length, idx=new Array(n);
  for(let i=0;i<n;i++) idx[i]=i;
  idx.sort((a,b)=>T[a]-T[b]);
  const out={t:new Float64Array(n),o:new Float64Array(n),h:new Float64Array(n),l:new Float64Array(n),c:new Float64Array(n),v:new Float64Array(n)};
  for(let i=0;i<n;i++){const j=idx[i];out.t[i]=T[j];out.o[i]=O[j];out.h[i]=H[j];out.l[i]=L[j];out.c[i]=C[j];out.v[i]=V[j];}
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
  }
  return {pos,overlay,osc};
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
    return s;
  }
  let curQty=0;
  let liveEq=capital0, ruined=false; // ruin guard: account blown -> no new entries
  // dynamic exit plumbing
  const exitMode=opts.exit||'fixed'; // fixed | breakeven | atr
  const beTrig=((opts.beTrigger!=null?opts.beTrigger:((opts.slPct||0)))/100); // profit to lock breakeven (default 1R)
  const beLock=(opts.beLock||0)/100; // locked profit once triggered (0 = flat breakeven)
  const atrMult=opts.atrTrailMult||3;
  let atrArr=null;
  if(exitMode==='atr')atrArr=atr(d.h,d.l,d.c,Math.max(2,Math.round(opts.atrTrailPeriod||14)));
  let hiEntry=0, loEntry=0, beDone=false;
  const useMask=opts.carry?null:mask; // carry overnight => ignore session flattening
  for(let i=1;i<n;i++){
    const px=d.c[i];
    // manage open position: SL / target / trailing / signal flip / session exit
    if(position!==0){
      const ret=position===1?(px-entryPx)/entryPx:(entryPx-px)/entryPx;
      if(position===1){if(px>trailPeak)trailPeak=px;if(d.h[i]>hiEntry)hiEntry=d.h[i];}
      else{if(px<trough||trough===0)trough=px; if(trough===0)trough=px;if(d.l[i]<loEntry||loEntry===0)loEntry=d.l[i];}
      if(exitMode==='breakeven'&&!beDone&&ret>=beTrig)beDone=true; // lock floor once +beTrigger reached
      // trailing stop
      let stopHit=false, reason='';
      if(exitMode==='atr'&&atrArr&&!isNaN(atrArr[i])){
        // Chandelier: stop hangs k·ATR below highest-high (long) since entry; replaces fixed SL
        const chL=hiEntry-atrMult*atrArr[i], chS=loEntry+atrMult*atrArr[i];
        if(position===1&&d.l[i]<=chL){stopHit=true;reason='ATR';}
        if(position===-1&&d.h[i]>=chS){stopHit=true;reason='ATR';}
      } else if(slPct>0){
        const slBase=position===1?entryPx*(1-slPct):entryPx*(1+slPct);
        const slPx=(exitMode==='breakeven'&&beDone)?(position===1?entryPx*(1+beLock):entryPx*(1-beLock)):slBase;
        if(position===1&&d.l[i]<=slPx){stopHit=true;reason=beDone&&exitMode==='breakeven'?'BE':'SL';}
        if(position===-1&&d.h[i]>=slPx){stopHit=true;reason=beDone&&exitMode==='breakeven'?'BE':'SL';}
      }
      if(!stopHit&&tpPct>0){
        const tpPx=position===1?entryPx*(1+tpPct):entryPx*(1-tpPct);
        if(position===1&&d.h[i]>=tpPx){stopHit=true;reason='TP';}
        if(position===-1&&d.l[i]<=tpPx){stopHit=true;reason='TP';}
      }
      if(!stopHit&&trailPct>0){
        if(position===1){const tp2=trailPeak*(1-trailPct);if(d.l[i]<=tp2&&ret>0){stopHit=true;reason='TRAIL';}}
        else{const tp2=trough*(1+trailPct);if(d.h[i]>=tp2&&ret>0){stopHit=true;reason='TRAIL';}}
      }
      const tgt=desiredTarget(i);
      const flip=(tgt!==0&&tgt!==position);
      const flatSignal=(tgt===0);
      const lastBar=(i===n-1);
      if(stopHit||flip||flatSignal||lastBar){
        let exitPx=px;
        if(stopHit){
          if(reason==='SL')exitPx=position===1?entryPx*(1-slPct):entryPx*(1+slPct);
          else if(reason==='BE')exitPx=position===1?entryPx*(1+beLock):entryPx*(1-beLock);
          else if(reason==='ATR')exitPx=position===1?(hiEntry-atrMult*atrArr[i]):(loEntry+atrMult*atrArr[i]);
          else if(reason==='TP')exitPx=position===1?entryPx*(1+tpPct):entryPx*(1-tpPct);
          else exitPx=position===1?trailPeak*(1-trailPct):trough*(1+trailPct);
        }
        const units=qty*lotSize;
        let pnl=(position===1?(exitPx-entryPx):(entryPx-exitPx))*units - costPerTrade;
        const pnlPct=position===1?(exitPx-entryPx)/entryPx*100:(entryPx-exitPx)/entryPx*100;
        trades.push({id:trades.length+1,entryIdx,exitIdx:i,entryTime:d.t[entryIdx],exitTime:d.t[i],entryPx,exitPx,type:position===1?'LONG':'SHORT',pnl,pnlPct,reason:stopHit?reason:(flip?'FLIP':(flatSignal?'SESSION/FLAT':'END'))});
        position=0;curQty=0;
        liveEq+=pnl;
        if(liveEq<=0)ruined=true; // blown up: manage nothing more, open nothing new
        // immediate re-entry on flip (enter at same close; mask already enforced via tgt)
        if(flip&&(!useMask||useMask[i])&&!ruined){
          position=tgt;entryPx=px;entryIdx=i;trailPeak=px;trough=px;curQty=units;
          hiEntry=d.h[i];loEntry=d.l[i];beDone=false;
        }
        continue;
      }
    } else {
      const tgt=desiredTarget(i);
      if(tgt!==0&&(!useMask||useMask[i])&&!ruined){
        position=tgt;entryPx=px;entryIdx=i;trailPeak=px;trough=px;curQty=qty*lotSize;
        hiEntry=d.h[i];loEntry=d.l[i];beDone=false;
      }
    }
  }
  // equity
  const eq=new Float64Array(n).fill(capital0);
  let run=capital0;
  let ti=0;
  // map trades to exit index for equity steps
  const byExit={};
  for(const t of trades){(byExit[t.exitIdx]=byExit[t.exitIdx]||[]).push(t);}
  for(let i=0;i<n;i++){if(byExit[i])for(const t of byExit[i])run+=t.pnl;eq[i]=run;}
  // metrics
  let wins=0,grossP=0,grossL=0;
  for(const t of trades){if(t.pnl>0){wins++;grossP+=t.pnl;}else grossL+=-t.pnl;}
  const wr=trades.length?wins/trades.length*100:0;
  const pf=grossL>0?grossP/grossL:(grossP>0?99.99:0);
  const net=run-capital0;
  // max drawdown on the account curve (ruin guard keeps this >= -100%)
  let peakE=capital0,maxDD=0;
  const dd=new Float64Array(n);
  for(let i=0;i<n;i++){if(eq[i]>peakE)peakE=eq[i];const ddi=peakE>0?(eq[i]-peakE)/peakE*100:0;dd[i]=ddi;if(ddi<maxDD)maxDD=ddi;}
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
  return {trades,equity:eq,dd,metrics:{netPnL:net,winRate:wr,totalTrades:trades.length,profitFactor:pf,maxDD:maxDD,sharpe,sortino,expectancy,finalCapital:run,grossProfit:grossP,grossLoss:grossL,tradesPerDay,days}};
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
  const r=[...rows];
  if(objective==='winrate')r.sort((a,b)=>b.m.winRate-a.m.winRate||b.m.netPnL-a.m.netPnL);
  else if(objective==='trades')r.sort((a,b)=>b.m.totalTrades-a.m.totalTrades||b.m.netPnL-a.m.netPnL);
  else if(objective==='drawdown')r.sort((a,b)=>b.m.maxDD-a.m.maxDD||b.m.netPnL-a.m.netPnL); // maxDD negative; higher (closer 0) first
  else if(objective==='sortino')r.sort((a,b)=>b.m.sortino-a.m.sortino);
  else r.sort((a,b)=>b.m.sharpe-a.m.sharpe||b.m.netPnL-a.m.netPnL); // default sharpe
  return r;
}

const api={parseCSV,resample,ema,sma,hma,dema,wma,rsi,atr,macd,bollinger,keltner,stoch,supertrend,adx,vwapSeries,chandeKroll,pocSeries,kama,fisherTransform,ttmSqueeze,connorsRSI,buildSignals,backtest,buildSessionMask,buildGrid,rankResults,objectiveValue,paramNeighbors,cfgKey,expandRange,SCHEMA,timeToMin};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.XBOST_ENGINE=api;
})(typeof self!=='undefined'?self:this);
