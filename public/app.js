/* XBOST app controller */
(function(){
'use strict';
const E = window.XBOST_ENGINE;
const $ = id => document.getElementById(id);
const TFS = [1,2,3,4,5,7,10,15];
const state = { raw:null, data:null, board:[], sel:null, detail:null, sortKey:null, sortDir:1, charts:{}, worker:null };

// ---------- high-contrast alert banner (crimson on maroon) ----------
function showAlert(msg){
  const box=$('alertBox');
  if(!box){alert(msg);return;}
  box.innerHTML=`<span class="alert-ico">⚠</span><span>${msg}</span>`;
  box.classList.remove('hidden');
  box.scrollIntoView({block:'nearest'});
}
function clearAlert(){ const box=$('alertBox'); if(box){box.classList.add('hidden');box.innerHTML='';} }

// ---------- sidebar: timeframes (pill toggles) ----------
const tfBox = $('tfBox');
TFS.forEach(tf=>{
  const b=document.createElement('button');
  b.type='button';
  b.className='tf-pill on num';
  b.dataset.tf=tf;
  b.setAttribute('aria-pressed','true');
  b.textContent=tf+'m';
  b.onclick=()=>{ b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); estimateCombos(); };
  tfBox.appendChild(b);
});

// ---------- collapsible configuration sidebar (persisted) ----------
try{ if(localStorage.getItem('xbost_sb')==='hide')document.body.classList.add('sb-hide'); }catch(e){}
$('sideToggle').onclick=()=>{
  document.body.classList.toggle('sb-hide');
  try{localStorage.setItem('xbost_sb',document.body.classList.contains('sb-hide')?'hide':'show');}catch(e){}
};

// ---------- sidebar: indicators ----------
const IND_META = [
  {cat:'A · Classic trend, momentum & volatility'},
  {n:'EMA',d:'Trend · price vs EMA',on:true},{n:'SMA',d:'Trend · price vs SMA',on:true},
  {n:'HMA',d:'Hull MA trend',on:true},{n:'DEMA',d:'Double EMA trend',on:true},
  {n:'Bollinger',d:'Mean-reversion bands',on:true},{n:'Keltner',d:'ATR channel breakout',on:true},
  {n:'RSI',d:'Momentum oversold/overbought',on:true},{n:'MACD',d:'MACD vs signal',on:true},
  {n:'VWAP',d:'Intraday session VWAP',on:true},{n:'SuperTrend',d:'ATR trailing trend',on:true},
  {n:'ADX',d:'ADX strength + MA',on:true},{n:'Stochastic',d:'%K/%D stochastic',on:true},
  {n:'ChandeKroll',d:'Chande-Kroll stops',on:true},{n:'POC',d:'Volume Profile POC',on:true},
  {n:'KAMA',d:'★ Kaufman adaptive MA',on:true},{n:'Fisher',d:'★ Fisher Transform turns',on:true},
  {n:'Squeeze',d:'★ TTM squeeze release',on:true},{n:'CRSI',d:'★ Connors RSI mean-rev',on:true},
  {cat:'B · Institutional Order Flow & Smart Money'},
  {n:'VWAPBands',d:'★ VWAP ±1–3σ deviation bands',on:true},{n:'CVD',d:'★ Cumulative Volume Delta divergence',on:true},
  {n:'FVG',d:'★ Fair Value Gap / imbalance taps',on:true},
  {n:'Regime',d:'★ Choppiness gate for trend loops',on:true},
  {cat:'C · Pure price/volume oscillators (new)'},
  {n:'Chop',d:'★ Choppiness consolidation filter',on:true},{n:'Cyber',d:'★ Ehlers cycle turning points',on:true},
  {n:'VWMA',d:'★ Volume-weighted MA trend',on:true},{n:'CMO',d:'★ Chande momentum exhaustion',on:true},
  {n:'Aroon',d:'★ Time-between-highs trend',on:true},
  {cat:'D · Combinatorial presets (multi-leg)'},
  {n:'SqueezeBreak',d:'★P Squeeze + volume + CK stops',on:true},{n:'TrendRegime',d:'★P Chop gate + ST + MACD',on:true},
  {n:'VWAPRev',d:'★P VWAP fade + CMO trigger',on:true},
];
// Max-coverage default ranges: [min, max, step] — ~115 configs per timeframe
const DEFAULT_RANGES = {
  EMA:{period:[9,30,3]}, SMA:{period:[9,30,3]}, HMA:{period:[9,30,3]}, DEMA:{period:[9,30,3]},
  Bollinger:{period:[14,28,7], mult:[1.5,2.5,0.5]},
  Keltner:{emaPeriod:[14,21,7], atrPeriod:[10,14,4], mult:[1.5,2.5,0.5]},
  RSI:{period:[8,20,2], oversold:[20,30,10], overbought:[70,80,10]},
  MACD:{fast:[8,12,4], slow:[21,26,5], signal:[7,9,2]},
  VWAP:{},
  SuperTrend:{atrPeriod:[7,14,7], mult:[2,4,1]},
  ADX:{adxPeriod:[10,14,4], maPeriod:[30,50,20], threshold:[20,25,5]},
  Stochastic:{k:[10,14,4], d:[3,5,2], oversold:[15,25,10], overbought:[75,85,10]},
  ChandeKroll:{period:[7,10,3], mult:[2,3,1]},
  POC:{lookback:[30,90,30]},
  KAMA:{erPeriod:[10,15,5], fast:[2,4,2], slow:[20,30,10]},
  Fisher:{period:[9,17,4]},
  Squeeze:{bbPeriod:[14,21,7], bbMult:[2,2.5,0.5], kcPeriod:[14,21,7], kcMult:[1.5,2,0.5]},
  CRSI:{rsiPeriod:[2,4,1], streakPeriod:[2,3,1], rankPeriod:[50,100,50], oversold:[10,20,10], overbought:[80,90,10]},
  VWAPBands:{sd1:[1,2,1], sd2:[2,3,1]},
  CVD:{lookback:[20,60,20]},
  FVG:{maxZones:[3,7,2], mitAge:[20,60,20]},
  Regime:{chopPeriod:[10,20,5], gate:[55,65,5], maPeriod:[20,40,10]},
  Chop:{chopPeriod:[10,20,10], gate:[55,65,5], maPeriod:[20,40,20]},
  Cyber:{alpha:[0.05,0.2,0.05]},
  VWMA:{period:[10,30,10]},
  CMO:{period:[9,21,6], oversold:[-50,-30,20], overbought:[30,50,20]},
  Aroon:{period:[14,28,14], level:[0,25,25]},
  SqueezeBreak:{period:[14,21,7], bbMult:[2,2.5,0.5], kcMult:[1.5,2,0.5], volMult:[1.5,2.5,1], ckMult:[2,3,1]},
  TrendRegime:{chopPeriod:[10,20,10], gate:[50,60,10], stMult:[2,3,1], macdFast:[8,12,4]},
  VWAPRev:{sd1:[1,2,1], sd2:[2,3,1], cmoPeriod:[5,9,4], cmoOS:[-50,-30,20], cmoOB:[30,50,20]},
};
const indList=$('indList');
function buildIndCards(){
  indList.innerHTML='';
  IND_META.forEach(m=>{
    if(m.cat){ // category header row
      const h=document.createElement('div');
      h.className='lbl !text-green-400 pt-1';
      h.textContent=m.cat;
      indList.appendChild(h);
      return;
    }
    const schema=E.SCHEMA[m.n]||[];
    const card=document.createElement('div');
    card.className='ind-card'+(m.on?' on':'');
    card.dataset.ind=m.n;
    let params='';
    schema.forEach(p=>{
      const preset=((DEFAULT_RANGES[m.n]||{})[p.key])||[p.def,p.def,1];
      params+=`<div><label>${p.key} min</label><input type="number" step="any" data-k="${p.key}" data-b="min" value="${preset[0]}" class="w-full num"/></div>
      <div><label>max</label><input type="number" step="any" data-k="${p.key}" data-b="max" value="${preset[1]}" class="w-full num"/></div>
      <div><label>step</label><input type="number" step="any" data-k="${p.key}" data-b="step" value="${preset[2]}" class="w-full num"/></div>`;
    });
    card.innerHTML=`<label class="flex items-center gap-2 text-[13px] font-semibold cursor-pointer">
      <input type="checkbox" data-role="en" ${m.on?'checked':''}/> ${m.n} <span class="text-[10px] text-zinc-500 font-normal">${m.d}</span></label>
      ${schema.length?`<div class="param-grid">${params}</div>`:`<div class="text-[10px] text-zinc-500 mt-1">No parameters — single config per timeframe.</div>`}`;
    indList.appendChild(card);
  });
  indList.addEventListener('change', e=>{
    const card=e.target.closest('.ind-card'); if(!card)return;
    card.classList.toggle('on', card.querySelector('[data-role=en]').checked);
    estimateCombos();
  });
  indList.addEventListener('input', estimateCombos);
}
buildIndCards();
$('btnAllInd').onclick=()=>{
  document.querySelectorAll('.ind-card').forEach(c=>{
    c.querySelector('[data-role=en]').checked=true; c.classList.add('on');
    const preset=DEFAULT_RANGES[c.dataset.ind]||{};
    c.querySelectorAll('input[type=number]').forEach(i=>{
      const r=preset[i.dataset.k]; if(!r)return;
      i.value = i.dataset.b==='min'?r[0] : i.dataset.b==='max'?r[1] : r[2];
    });
  });
  estimateCombos();
};
function getSelection(){
  const tfs=[...tfBox.querySelectorAll('.tf-pill.on')].map(b=>+b.dataset.tf);
  const sels=[];
  document.querySelectorAll('.ind-card').forEach(c=>{
    if(!c.querySelector('[data-role=en]').checked)return;
    const ind=c.dataset.ind, ranges={}, steps={};
    c.querySelectorAll('input[type=number]').forEach(i=>{
      const k=i.dataset.k,b=i.dataset.b; ranges[k]=ranges[k]||{}; ranges[k][b]=+i.value;
    });
    Object.keys(ranges).forEach(k=>{ steps[k]=+ranges[k].step||0; });
    sels.push({indicator:ind, ranges, steps, timeframes:tfs.length?tfs:[5]});
  });
  return {tfs, sels};
}
function getRiskGrid(){
  if(!$('optRisk').checked) return null;
  const sl=E.expandRange(+$('slMin').value,+ $('slMax').value,+$('slStep').value||0.3);
  const tp=E.expandRange(+$('tpMin').value,+$('tpMax').value,+$('tpStep').value||0.5);
  if(!sl.length||!tp.length) return null;
  return {sl, tp};
}
['optRisk','slMin','slMax','slStep','tpMin','tpMax','tpStep'].forEach(id=>$(id).addEventListener('change',estimateCombos));
['optRisk','slMin','slMax','slStep','tpMin','tpMax','tpStep'].forEach(id=>$(id).addEventListener('input',estimateCombos));
function updateRiskLock(){
  const on=$('optRisk').checked;
  ['slPct','tpPct'].forEach(id=>{ $(id).disabled=on; $(id).style.opacity=on?0.35:1; });
  $('riskLockNote').textContent=on
    ? '● GRID ACTIVE — every SL × TP below is backtested per combo; winners appear in the board\'s SL % / TP % columns. Fallback inputs above are ignored.'
    : '○ GRID OFF — the single fallback SL/TP values above apply to every combo.';
  $('riskLockNote').className='text-[10px] mt-1 '+(on?'text-green-300':'text-amber-300');
}
$('optRisk').addEventListener('change',updateRiskLock);
function estimateCombos(){
  const {sels}=getSelection();
  try{
    const risk=getRiskGrid();
    const dims=getExitDims();
    const grid=E.buildGrid(sels, risk, dims);
    const mult=risk?` × SL[${risk.sl.join(',')}] × TP[${risk.tp.join(',')}]`:' · fixed SL/TP';
    $('comboEst').textContent=`Combos: ${grid.length}  (${sels.length} ind × TF × exit[${dims.exits.join('/')}] × ${dims.carry.length>1?'day+carry':(dims.carry[0]?'carry':'day')}${mult})`;
    $('comboEst').className='text-[11px] mt-2 num '+(grid.length>+$('maxCombos').value?'text-red-400':'text-amber-300');
  }catch(e){$('comboEst').textContent='Combos: —';}
}
$('maxCombos').addEventListener('input', estimateCombos);
$('objective').addEventListener('change', ()=>{ if(state.board.length) renderBoard(); });

// ---------- data loading ----------
function setData(d, label){
  state.raw=d; applyDateFilter();
  const sym=$('symbol').value||'UNNAMED';
  $('dataBadge').innerHTML=`<span class="pulse"></span><span>${sym} · ${(state.data.t.length/1000).toFixed(0)}k bars · ${label}</span>`;
  $('dataBadge').className='badge badge-live num';
  const t0=new Date(state.data.t[0]), t1=new Date(state.data.t[state.data.t.length-1]);
  $('dataInfo').textContent=`${t0.toLocaleDateString()} → ${t1.toLocaleDateString()} · ${(state.data.t.length).toLocaleString()} 1m bars · fmt: ${state.raw.layout||'auto'}`;
  $('fromDate').value=t0.toISOString().slice(0,10); $('toDate').value=t1.toISOString().slice(0,10);
  estimateCombos();
}
function applyDateFilter(){
  let d=state.raw; if(!d)return;
  const f=$('fromDate').value, t=$('toDate').value;
  if(!f&&!t){state.data=d;return;}
  const lo=f?new Date(f+'T00:00:00').getTime():-Infinity, hi=t?new Date(t+'T23:59:59').getTime():Infinity;
  const idx=[]; for(let i=0;i<d.t.length;i++) if(d.t[i]>=lo&&d.t[i]<=hi) idx.push(i);
  const pick=(a)=>Float64Array.from(idx.map(i=>a[i]));
  state.data={t:pick(d.t),o:pick(d.o),h:pick(d.h),l:pick(d.l),c:pick(d.c),v:pick(d.v)};
}
$('fromDate').addEventListener('change',()=>{if(state.raw){applyDateFilter();$('dataInfo').textContent=`Filtered: ${state.data.t.length.toLocaleString()} bars`;}});
$('toDate').addEventListener('change',()=>{if(state.raw){applyDateFilter();$('dataInfo').textContent=`Filtered: ${state.data.t.length.toLocaleString()} bars`;}});

$('fileInput').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f)return;
  const rd=new FileReader();
  $('loadBarWrap').classList.remove('hidden');
  rd.onprogress=ev=>{ if(ev.lengthComputable)$('loadBar').style.width=(ev.loaded/ev.total*100)+'%'; };
  rd.onload=()=>{
    try{
      const t0=performance.now();
      const d=E.parseCSV(rd.result);
      if(!d.t.length)throw new Error('no valid OHLCV rows found');
      clearAlert();
      // symbol: data column wins (BANKNIFTY_F1 -> BANKNIFTY), else file name
      if(d.symbol)$('symbol').value=d.symbol;
      else{
        const base=f.name.replace(/\.[^.]+$/,'');
        const sym=(base.split(/[_.\-\s]+/)[0]||base).toUpperCase().slice(0,20);
        if(sym)$('symbol').value=sym;
      }
      $('perfBadge').classList.remove('hidden');
      $('perfBadge').textContent=`parsed ${(d.t.length/1000).toFixed(0)}k rows in ${((performance.now()-t0)/1000).toFixed(1)}s`;
      setData(d, f.name+' · real'); $('loadBar').style.width='100%';
      setTimeout(()=>$('loadBarWrap').classList.add('hidden'),800);
    }catch(err){
      $('loadBarWrap').classList.add('hidden');
      showAlert(`Could not parse "${f.name}": ${(err&&err.message)||err}. Expected header date,open,high,low,close,volume.`);
    }
  };
  rd.readAsText(f);
});
$('btnLoadRepo').onclick=loadRepoCSV;
async function loadRepoCSV(){
  try{
    $('progTxt').textContent='fetching HDFCBANK_minute.csv…';
    const r=await fetch('HDFCBANK_minute.csv'); if(!r.ok)throw new Error('HTTP '+r.status);
    const txt=await r.text();
    const t0=performance.now();
    const d=E.parseCSV(txt);
    if(!d.t.length)throw new Error('empty file');
    if(!$('symbol').value)$('symbol').value='HDFCBANK';
    $('perfBadge').classList.remove('hidden');
    $('perfBadge').textContent=`parsed ${(d.t.length/1000).toFixed(0)}k rows in ${((performance.now()-t0)/1000).toFixed(1)}s`;
    setData(d,'HDFCBANK_minute.csv · real');
  }catch(err){
    $('progTxt').textContent='idle';
    $('dataInfo').textContent='Bundled file not found on this server — upload your own 1-min CSV above.';
    showAlert('Bundled HDFCBANK.csv not found on this server — upload a 1-min CSV file instead.');
  }
}
function tradeOpts(){
  return {
    direction:document.querySelector('input[name=dir]:checked').value,
    sessionStart:$('useSession').checked?$('sessStart').value:null,
    sessionEnd:$('useSession').checked?$('sessEnd').value:null,
    slPct:+$('slPct').value||0, tpPct:+$('tpPct').value||0, trailPct:+$('trailPct').value||0,
    capital:+$('capital').value||100000, qty:+$('qty').value||1, lotSize:+$('lotSize').value||1,
    cost:+$('costPer').value||0,
    beTrigger:+$('beTrigger').value||0, beLock:+$('beLock').value||0,
    atrTrailPeriod:+$('atrP').value||14, atrTrailMult:+$('atrM').value||3,
    ckPeriod:+$('ckP').value||10, ckMult:+$('ckM').value||3,
    fill:$('fillMode').value||'close', entry:$('entryMode').value||'trigger'
  };
}
function getExitDims(){
  const exits=[];
  if($('exitFixed').checked)exits.push('fixed');
  if($('exitBE').checked)exits.push('breakeven');
  if($('exitATR').checked)exits.push('atr');
  if($('exitCK').checked)exits.push('ck');
  const sess=(document.querySelector('input[name=sess]:checked')||{}).value||'intraday';
  const carry=sess==='carry'?[true]:sess==='both'?[false,true]:[false];
  return {exits:exits.length?exits:['fixed'], carry};
}
['exitFixed','exitBE','exitATR','exitCK'].forEach(id=>$(id).addEventListener('change',estimateCombos));
document.querySelectorAll('input[name=sess]').forEach(r=>r.addEventListener('change',estimateCombos));
const EXIT_LBL={fixed:'FIX',breakeven:'BE',atr:'ATR',ck:'CK'};

// ---------- grid search ----------
$('btnRun').onclick=runGrid;
$('btnStop').onclick=()=>{
  if(state.worker){try{state.worker.terminate();}catch(e){}state.worker=null;}
  if(state._runReject){const r=state._runReject;state._runReject=null;r(new Error('stopped by user'));}
  state.stopped=true;
  state.runSeq=(state.runSeq||0)+1; // invalidates fallback loop + late worker messages
};
async function runGrid(){
  if(!state.data){showAlert('No market data — upload a 1-min CSV (sidebar ①) before running a search.');return;}
  const {sels}=getSelection();
  if(!sels.length){showAlert('No indicators selected — enable at least one strategy in section ⑤.');return;}
  const risk=getRiskGrid();
  const dims=getExitDims();
  let grid=E.buildGrid(sels, risk, dims);
  // per-indicator param steps for the hill-climb refine loop
  const paramSteps={};
  sels.forEach(s=>{ paramSteps[s.indicator]=s.steps||{}; });
  const cap=+$('maxCombos').value||60000;
  if(grid.length>cap){ if(!confirm(`Grid = ${grid.length} combos > cap ${cap}. Truncate to first ${cap}?`))return; grid=grid.slice(0,cap); }
  if(!grid.length){showAlert('Empty grid — a parameter range produced zero values. Check min/max/step in ⑤.');return;}
  // TF-major + signal-adjacent order: feeds the single-entry signal cache
  // (indicators computed once per parameter set) and keeps progress linear.
  grid.forEach(c=>{c._sk=c.timeframe+'|'+c.indicator+'|'+JSON.stringify(c.params);});
  grid.sort((a,b)=>a._sk<b._sk?-1:1);
  const objective=$('objective').value, topN=+$('topN').value||500;
  const opts=tradeOpts();
  clearAlert();
  $('btnRun').disabled=true;
  $('btnStop').classList.remove('hidden');
  state.stopped=false;
  $('liveBadge').classList.remove('hidden');
  $('progBar').style.width='0%';
  $('progTxt').textContent=`0 / ${grid.length}`;
  $('nowRunning').textContent='warming up…';
  const t0=performance.now();
  const runSeq=(state.runSeq=(state.runSeq||0)+1);
  state.userPicked=0;
  state.runError=null;
  let lastRender=0;
  const onBatch=(done,total,top,current,stage,pass)=>{
    if(runSeq!==state.runSeq)return;
    if(stage==='refine'&&!state._refineAt)state._refineAt=performance.now();
    if(typeof done==='number')state._done=done;
    const pct=typeof done==='number'&&typeof total==='number'?(done/total*100).toFixed(1):'—';
    if(typeof done==='number'&&typeof total==='number')$('progBar').style.width=Math.min(100,done/total*100)+'%';
    const el=(performance.now()-t0)/1000;
    const perSec=(typeof done==='number'?done:0)/Math.max(0.5,el);
    let eta='';
    if(stage!=='refine'&&typeof done==='number'&&typeof total==='number'&&done>5&&perSec>0){
      const s=Math.round((total-done)/perSec);
      eta=` · ETA ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
    }
    $('progTxt').textContent=`${done} / ${total}${stage==='refine'?` · 🔁 refine pass ${pass||''}`:''} (${pct}%) · ${perSec.toFixed(0)}/s${eta} · live ↓`;
    if(current) $('nowRunning').textContent=`${stage==='refine'?'🔁 refining best:':'⚙ now running:'} ${current.indicator} ${current.timeframe}m · ${fmtParams(current.params)}${current.slPct!=null?` · SL ${current.slPct}% TP ${current.tpPct}%`:''}${current.exit?` · ${EXIT_LBL[current.exit]||current.exit}${current.carry?'+carry':''}`:''}`;
    if(state.runError) $('nowRunning').textContent+=` · ⚠ ${state.runError} combos errored`;
    state.board=top;
    const now=performance.now(); // rebuilding 500 DOM rows every batch freezes UI — throttle
    if(now-lastRender>700||done===total){lastRender=now;renderBoard();}
    if(top.length && !state.detail) selectRow(top[0], true); // populate charts with first live leader
  };
  let top=[], refineInfo='', errSamples=[], runMode='worker', stopped=false;
  state._refineAt=null; state._done=0;
  logLine(`run start: ${$('symbol').value||'?'} ${(state.data.t.length/1000).toFixed(0)}k bars ${new Date(state.data.t[0]).toLocaleDateString()}→${new Date(state.data.t[state.data.t.length-1]).toLocaleDateString()} objective=${objective} dir=${opts.direction}/${opts.entry}/${opts.fill} exits=[${dims.exits.join(',')}] sess=${dims.carry.length>1?'day+carry':(dims.carry[0]?'carry':'day')} cap=${opts.capital} qty=${opts.qty}x${opts.lotSize} cost=${opts.cost} grid=${grid.length}`);
  try{
    const out=await runWithWorker(grid,opts,objective,topN,onBatch,paramSteps,risk);
    top=out.top; refineInfo=out.refined?` · 🔁 +${out.refined} refined (${out.passes} passes)`:'';
    errSamples=out.errSamples||[];
    if(runSeq===state.runSeq) state.board=top;
  }catch(err){
    if(state.stopped){ /* user stopped: skip fallback, finalize partial below */ }
    else{
    console.warn('worker failed, fallback async',err);
    logLine(`worker unavailable (${err&&err.message||err}) — main-thread fallback`);
    if(runSeq===state.runSeq) $('nowRunning').textContent=`⚠ worker unavailable (${err&&err.message||err}) — running on main thread…`;
    runMode='fallback';
    try{
      const out=await runAsync(grid,opts,objective,topN,onBatch,paramSteps,risk,runSeq);
      top=out.top; refineInfo=out.refined?` · 🔁 +${out.refined} refined (${out.passes} passes)`:'';
      stopped=!!out.stopped;
      if(runSeq===state.runSeq) state.board=top;
    }catch(err2){
      console.error(err2);
      if(runSeq===state.runSeq){
        $('progTxt').textContent=`❌ ERROR: ${(err2&&err2.message)||err2}`;
        $('nowRunning').textContent='Open DevTools console (F12) for the stack trace.';
        showAlert(`Grid search failed: ${(err2&&err2.message)||err2} — see console (F12). Your data and settings are untouched.`);
        logLine(`run ERROR: ${(err2&&err2.message)||err2}`);
        $('liveBadge').classList.add('hidden');
        $('btnRun').disabled=false;
        $('btnStop').classList.add('hidden');
        state.worker=null;
      }
      return;
    }
    }
  }
  if(state.stopped)stopped=true;
  $('btnStop').classList.add('hidden');
  state.worker=null;
  if(runSeq!==state.runSeq&&!stopped) return; // superseded by a newer run
  const tEnd=performance.now(), secs=((tEnd-t0)/1000);
  const gridSecs=state._refineAt?((state._refineAt-t0)/1000):secs;
  if(stopped){
    $('progTxt').textContent=`■ stopped by user — partial board kept (${state.board.length} rows, ${state._done||0} combos tested)`;
    logLine(`run STOPPED by user after ${secs.toFixed(1)}s (${state._done||0} combos) — partial board kept`);
    showAlert(`Search stopped — showing partial results (${state.board.length} rows). Press RUN to restart clean.`);
  } else {
    $('progTxt').textContent=`done · ${grid.length} combos in ${secs.toFixed(1)}s${refineInfo}${state.runError?` · ⚠ ${state.runError} errored`:''}`;
    logLine(`run done (${runMode}): ${grid.length} combos in ${secs.toFixed(1)}s [grid ${gridSecs.toFixed(1)}s${state._refineAt?` + refine ${(secs-gridSecs).toFixed(1)}s`:''}] ${(grid.length/Math.max(secs,0.01)).toFixed(0)}/s objective=${objective} errors=${state.runError||0}${refineInfo}`);
    errSamples.forEach(e=>logLine(`  combo error: ${e}`));
  }
  state.board.slice(0,3).forEach((r,i)=>logLine(`  #${i+1} ${r.timeframe}m ${r.indicator} ${fmtParams(r.params)} SL=${r.slPct} TP=${r.tpPct} ${EXIT_LBL[r.exit||'fixed']||''}${r.carry?'+C':''} WR=${r.m.winRate.toFixed(1)}% n=${r.m.totalTrades} pnl=${r.m.netPnL.toFixed(0)}`));
  $('nowRunning').textContent='';
  $('liveBadge').classList.add('hidden');
  $('btnRun').disabled=false;
  renderBoard();
  if(state.board.length && state.userPicked!==runSeq) selectRow(state.board[0], true);
}
function runWithWorker(grid,opts,objective,topN,onBatch,paramSteps,risk){
  return new Promise((resolve,reject)=>{
    let w;
    try{ w=new Worker('worker.js'); }catch(e){return reject(e);}
    state.worker=w;
    const d=state.data;
    const payload={t:d.t,o:d.o,h:d.h,l:d.l,c:d.c,v:d.v};
    const timer=setTimeout(()=>{try{w.terminate();}catch(e){}state._runReject=null;reject(new Error('worker timeout'));},1000*60*30);
    state._runReject=reject;
    w.onmessage=e=>{
      const m=e.data;
      if(m.type==='progress'){ if(m.errCount) state.runError=m.errCount; onBatch(m.done,m.total,m.top,m.current,m.stage,m.pass); }
      else if(m.type==='done'){clearTimeout(timer);w.terminate();state._runReject=null; if(m.errCount) state.runError=m.errCount; resolve({top:m.top, refined:m.refined||0, passes:m.passes||0, errSamples:m.errSamples||[]});}
    };
    w.onerror=e=>{clearTimeout(timer);try{w.terminate();}catch(_){}state._runReject=null;reject(e.message||e);};
    // structured-clone copies (originals stay intact for re-runs / charting)
    w.postMessage({type:'run',t:payload.t,o:payload.o,h:payload.h,l:payload.l,c:payload.c,v:payload.v,grid,tradeOpts:opts,objective,topN,
      paramSteps:paramSteps||{}, slStep:risk&&risk.sl?stepsOf(risk.sl):0, tpStep:risk&&risk.tp?stepsOf(risk.tp):0});
  });
}
function stepsOf(arr){ // infer uniform step from an expanded value list
  if(!arr||arr.length<2)return 0;
  return Math.abs(arr[1]-arr[0]);
}
async function runAsync(grid,opts,objective,topN,onBatch,paramSteps,risk,runSeq){
  const res=[];
  // single-TF cache + single-signal cache (grid is TF-major / signal-adjacent)
  let tfCache=null, sigCache={key:null,sig:null};
  const getTF=tf=>{
    if(!tfCache||tfCache.tf!==tf){
      const d=E.resample(state.data,tf);
      tfCache={tf,d,maskIn:E.buildSessionMask(d, opts.sessionStart, opts.sessionEnd),maskCarry:new Int8Array(d.c.length).fill(1)};
    }
    return tfCache;
  };
  function testCfg(cfg, idx, refined){
    const tfc=getTF(cfg.timeframe), d=tfc.d;
    const eff=Object.assign({},opts,{sessionMask:(cfg.carry?tfc.maskCarry:tfc.maskIn)});
    if(cfg.slPct!=null)eff.slPct=cfg.slPct;
    if(cfg.tpPct!=null)eff.tpPct=cfg.tpPct;
    if(cfg.trailPct!=null)eff.trailPct=cfg.trailPct;
    eff.exit=cfg.exit||'fixed'; eff.carry=!!cfg.carry;
    const xof=E.exitOptsFromParams(cfg.indicator,cfg.params||{});
    if(xof){eff.ckPeriod=xof.ckPeriod;eff.ckMult=xof.ckMult;}
    const sk=cfg.timeframe+'|'+cfg.indicator+'|'+JSON.stringify(cfg.params);
    if(sigCache.key!==sk){sigCache={key:sk,sig:E.buildSignals(d,cfg)};}
    const bt=E.backtest(d,sigCache.sig.pos,eff);
    return {i:idx,timeframe:cfg.timeframe,indicator:cfg.indicator,params:cfg.params,slPct:eff.slPct||0,tpPct:eff.tpPct||0,trailPct:eff.trailPct||0,exit:eff.exit,carry:eff.carry,refined:!!refined,m:bt.metrics};
  }
  const partial=()=>({top:E.rankResults(res,objective).slice(0,topN),refined:0,passes:0,stopped:true});
  for(let i=0;i<grid.length;i++){
    if(state.runSeq!==runSeq)return partial();
    const cfg=grid[i];
    try{ res.push(testCfg(cfg, i, false)); }
    catch(err){
      state.runError=(state.runError||0)+1;
      res.push({i,timeframe:cfg.timeframe,indicator:cfg.indicator,params:cfg.params,slPct:cfg.slPct||0,tpPct:cfg.tpPct||0,trailPct:0,exit:cfg.exit||'fixed',carry:!!cfg.carry,refined:false,
        m:{netPnL:0,winRate:0,totalTrades:0,profitFactor:0,maxDD:0,sharpe:-99,sortino:-99,expectancy:0,finalCapital:opts.capital||100000,tradesPerDay:0,days:0},err:String(err&&err.message||err)});
    }
    if(i%10===0||i===grid.length-1){ onBatch(i+1,grid.length,E.rankResults(res,objective).slice(0,topN),{indicator:cfg.indicator,timeframe:cfg.timeframe,params:cfg.params,slPct:cfg.slPct||opts.slPct||0,tpPct:cfg.tpPct||opts.tpPct||0},'grid'); await new Promise(r=>setTimeout(r,0)); }
  }
  // hill-climb refinement (mirrors worker stage 2)
  const tested=new Set(grid.map(c=>E.cfgKey(c)));
  const riskSteps={sl:risk&&risk.sl?stepsOf(risk.sl):0, tp:risk&&risk.tp?stepsOf(risk.tp):0};
  let pool=E.rankResults(res,objective).slice(0,20);
  let best=E.objectiveValue(pool[0].m,objective);
  let pass=0, refined=0, improved=true;
  while(improved&&pass<4){
    if(state.runSeq!==runSeq)return {top:E.rankResults(res,objective).slice(0,topN),refined,passes:pass,stopped:true};
    improved=false;pass++;
    const cands=[];
    for(const row of pool){
      for(const nb of E.paramNeighbors(row,(paramSteps||{})[row.indicator]||{},riskSteps)){
        const k=E.cfgKey(nb);
        if(!tested.has(k)){tested.add(k);cands.push(nb);}
      }
      if(cands.length>600)break;
    }
    if(!cands.length)break;
    for(let j=0;j<cands.length;j++){
      if(state.runSeq!==runSeq)return {top:E.rankResults(res,objective).slice(0,topN),refined,passes:pass,stopped:true};
      try{ res.push(testCfg(cands[j],grid.length+refined,true)); }
      catch(err){ state.runError=(state.runError||0)+1; }
      refined++;
      if(j%25===0||j===cands.length-1){
        onBatch(grid.length+refined,grid.length+'+refine',E.rankResults(res,objective).slice(0,topN),
          {indicator:cands[j].indicator,timeframe:cands[j].timeframe,params:cands[j].params,slPct:cands[j].slPct||0,tpPct:cands[j].tpPct||0},'refine',pass);
        await new Promise(r=>setTimeout(r,0));
      }
    }
    pool=E.rankResults(res,objective).slice(0,20);
    const nowBest=E.objectiveValue(pool[0].m,objective);
    if(nowBest>best+1e-9){best=nowBest;improved=true;}
  }
  return {top:E.rankResults(res,objective).slice(0,topN), refined, passes:pass, stopped:false};
}

// ---------- leaderboard ----------
const COLS=[
  {k:'rank',l:'#'},{k:'timeframe',l:'TF'},{k:'indicator',l:'Strategy'},{k:'params',l:'Params'},
  {k:'exit',l:'Exit'},{k:'sess',l:'Sess'},{k:'sl',l:'SL %'},{k:'tp',l:'TP %'},
  {k:'netPnL',l:'Net P&L ₹'},{k:'winRate',l:'WR %'},{k:'totalTrades',l:'Trades'},{k:'tradesPerDay',l:'T/Day'},
  {k:'profitFactor',l:'PF'},{k:'maxDD',l:'MaxDD %'},{k:'sharpe',l:'Sharpe'},{k:'sortino',l:'Sortino'},
];
function exitTag(r){return (EXIT_LBL[r.exit||'fixed']||'FIX')+(r.carry?'+C':'');}
function fmtParams(p){return Object.entries(p||{}).map(([k,v])=>`${k}=${v}`).join(' ')||'—';}
state.view=state.view||'all';
function bestPerIndicator(){
  // champion row per indicator under the CURRENT objective (grid + refined)
  const ranked=E.rankResults(state.board, $('objective').value);
  const seen={}, out=[];
  for(const r of ranked){ if(!seen[r.indicator]){seen[r.indicator]=1;out.push(r);} }
  return out;
}
function setView(v){
  state.view=v;
  const btn=(id,on)=>{$(id).className=on?'btn !py-1 !px-2.5 !text-[11px]':'btn-ghost btn !py-1 !px-2.5 !text-[11px]';};
  btn('tabAll',v==='all');btn('tabBest',v==='best');btn('tabCmp',v==='cmp');
  $('bestNote').classList.toggle('hidden', v==='all');
  $('bestNote').textContent = v==='best'
    ? '★ One champion row per indicator — the best combination found (grid + hill-climb refinement) for the current objective. Full details in every column.'
    : '⚖ Champion per exit profile (exit logic × intraday/carry) with overlaid equity curves below. Click any row to load it on the charts.';
  $('boardWrap').style.display=v==='cmp'?'none':'';
  $('cmpWrap').style.display=v==='cmp'?'':'none';
  if(v==='cmp')renderCompare();else renderBoard();
}
$('tabAll').onclick=()=>setView('all');
$('tabBest').onclick=()=>setView('best');
$('tabCmp').onclick=()=>setView('cmp');
function profileKey(r){return (EXIT_LBL[r.exit||'fixed']||'FIX')+(r.carry?' + carry':' intraday');}
function profileChampions(){
  // best row per exit-profile (exit mode × day/carry) under current objective
  const ranked=E.rankResults(state.board, $('objective').value);
  const seen={}, out=[];
  for(const r of ranked){const k=profileKey(r);if(!seen[k]){seen[k]=1;out.push(r);}}
  return out;
}
function runDetailFor(r){
  // full detail backtest for any board row (used by compare overlay)
  const d=E.resample(state.data, r.timeframe);
  const sig=E.buildSignals(d,{indicator:r.indicator,params:r.params});
  const eff=tradeOpts();
  if(r.slPct!=null)eff.slPct=r.slPct;
  if(r.tpPct!=null)eff.tpPct=r.tpPct;
  if(r.trailPct!=null)eff.trailPct=r.trailPct;
  eff.exit=r.exit||'fixed'; eff.carry=!!r.carry;
  const xod=E.exitOptsFromParams(r.indicator,r.params||{});
  if(xod){eff.ckPeriod=xod.ckPeriod;eff.ckMult=xod.ckMult;}
  eff.sessionMask=eff.carry?new Int8Array(d.c.length).fill(1):E.buildSessionMask(d, eff.sessionStart, eff.sessionEnd);
  const bt=E.backtest(d,sig.pos,eff);
  return {cfg:r,data:d,sig,bt};
}
function renderCompare(){
  const tb=$('cmpBody'); tb.innerHTML='';
  $('cmpNote').textContent=state.board.length?`${state.board.length} combos ranked by ${$('objective').selectedOptions[0].textContent}`:'Run a grid search first.';
  if(!state.board.length)return;
  const champs=profileChampions();
  const frag=document.createDocumentFragment();
  champs.forEach((r,ix)=>{
    const tr=document.createElement('tr');
    if(state.sel===r)tr.classList.add('sel');
    const m=r.m;
    [ix+1,profileKey(r),r.timeframe+'m',r.indicator,fmtParams(r.params),
     (r.slPct||0).toFixed(2),(r.tpPct||0).toFixed(2),
     fmtMoney(m.netPnL),m.winRate.toFixed(1),m.totalTrades,m.profitFactor.toFixed(2),m.maxDD.toFixed(2),m.sharpe.toFixed(2)
    ].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td);});
    tr.children[7].className=m.netPnL>=0?'pos':'neg';
    tr.onclick=()=>{selectRow(r);tr.classList.add('sel');};
    frag.appendChild(tr);
  });
  tb.appendChild(frag);
  // overlaid equity curves of the profile champions
  const colors=['#22ff88','#38bdf8','#facc15','#f472b6','#c084fc','#fb923c'];
  const details=champs.slice(0,6).map(runDetailFor);
  const stride=Math.max(1,Math.floor(details[0].data.t.length/1500));
  const labels=[];
  for(let i=0;i<details[0].data.t.length;i+=stride)labels.push(new Date(details[0].data.t[i]).toLocaleDateString('en-IN',{day:'2-digit',month:'short'}));
  const datasets=details.map((dt,di)=>{
    const pts=[];
    for(let i=0;i<dt.data.t.length;i+=stride)pts.push(+dt.bt.equity[i].toFixed(0));
    return {label:profileKey(dt.cfg)+' · '+dt.cfg.indicator+' '+dt.cfg.timeframe+'m',data:pts,borderColor:colors[di%colors.length],borderWidth:1.5,pointRadius:0,tension:0.15};
  });
  mkChart('cmpChart',{type:'line',data:{labels,datasets},
    options:{responsive:true,plugins:{legend:{labels:{color:'#a1a1aa',font:{size:10},boxWidth:12}}},
      scales:{x:{display:false},y:{grid:{color:gridColor},ticks:{color:tickColor,font:{size:10}}}}}});
}
function renderBoard(){
  const head=$('boardHead'); head.innerHTML='';
  COLS.forEach(c=>{
    const th=document.createElement('th'); th.textContent=c.l+(state.sortKey===c.k?(state.sortDir>0?' ▲':' ▼'):'');
    th.onclick=()=>{ if(state.sortKey===c.k)state.sortDir*=-1; else{state.sortKey=c.k;state.sortDir=-1;} sortBoard(); renderBoard(); };
    head.appendChild(th);
  });
  const q=($('boardFilter').value||'').toLowerCase();
  const body=$('boardBody'); body.innerHTML='';
  let rows=state.board.filter(r=>!q||(r.indicator+' '+r.timeframe+' '+fmtParams(r.params)+' '+(r.exit||'')+(r.carry?' carry':'')).toLowerCase().includes(q));
  if(state.view==='best'){
    const champs=bestPerIndicator();
    const champSet=new Set(champs);
    rows=rows.filter(r=>champSet.has(r));
    rows.sort((a,b)=>champs.indexOf(a)-champs.indexOf(b)); // keep champion order
  }
  if(!rows.length){body.innerHTML='<tr><td><div class="empty-state">No strategies match — adjust the filter or run a grid search…</div></td></tr>';return;}
  const frag=document.createDocumentFragment();
  rows.forEach((r,ix)=>{
    const tr=document.createElement('tr');
    if(state.sel===r)tr.classList.add('sel');
    const m=r.m;
    const cells=[ix+1,r.timeframe+'m',r.indicator+(r.refined?' 🔁':''),fmtParams(r.params),
      EXIT_LBL[r.exit||'fixed']||'FIX',r.carry?'CRY':'DAY',
      (r.slPct||0).toFixed(2),(r.tpPct||0).toFixed(2),
      fmtMoney(m.netPnL),m.winRate.toFixed(1),m.totalTrades,(m.tradesPerDay||0).toFixed(1),m.profitFactor.toFixed(2),m.maxDD.toFixed(2),m.sharpe.toFixed(2),m.sortino.toFixed(2)];
    cells.forEach((v,ci)=>{
      const td=document.createElement('td'); td.textContent=v;
      if(ci===8)td.className=m.netPnL>=0?'pos':'neg';
      if(ci===9)td.className=m.winRate>=50?'pos':'';
      if(ci===13)td.className='neg';
      tr.appendChild(td);
    });
    tr.onclick=()=>selectRow(r);
    frag.appendChild(tr);
  });
  body.appendChild(frag);
}
function sortBoard(){
  const k=state.sortKey; if(!k||k==='rank')return;
  const val=r=>k==='params'?fmtParams(r.params):k==='sl'?(r.slPct||0):k==='tp'?(r.tpPct||0):k==='exit'?(r.exit||'fixed'):k==='sess'?(r.carry?'carry':'day'):(r.m[k]??r[k]);
  state.board.sort((a,b)=>{const x=val(a),y=val(b);return(typeof x==='string'?x.localeCompare(y):x-y)*state.sortDir;});
}
$('boardFilter').addEventListener('input',renderBoard);
function fmtMoney(v){const s=v<0?'-₹':'₹';return s+Math.abs(v).toLocaleString('en-IN',{maximumFractionDigits:0});}
function fmtT(t){const d=new Date(t);return d.toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false});}
// IST wall-clock for exports (data is IST; toISOString would print misleading UTC)
function fmtIST(t){return new Date(t+5.5*3600*1000).toISOString().slice(0,19)+'+05:30';}

// ---------- select + detail ----------
function selectRow(r, auto){
  state.sel=r;
  if(!auto) state.userPicked=state.runSeq||0;
  document.querySelectorAll('#boardBody tr, #cmpBody tr').forEach(tr=>tr.classList.remove('sel'));
  renderBoardKeepSel();
  state.detail=runDetailFor(r);
  renderAll();
}
function renderBoardKeepSel(){ /* re-render but keep highlight */ renderBoard(); }

// ---------- KPI ----------
function renderKPIs(){
  const m=state.detail?.bt.metrics;
  const items=m?[
    ['Net P&L',fmtMoney(m.netPnL),m.netPnL>=0],
    ['Win Rate',m.winRate.toFixed(1)+'%',m.winRate>=50],
    ['Trades',m.totalTrades,null],
    ['Profit Factor',m.profitFactor.toFixed(2),m.profitFactor>=1.5],
    ['Max DD',m.maxDD.toFixed(2)+'%',false],
    ['Sharpe / Sortino',m.sharpe.toFixed(2)+' / '+m.sortino.toFixed(2),m.sharpe>1],
  ]:[['Net P&L','—'],['Win Rate','—'],['Trades','—'],['Profit Factor','—'],['Max DD','—'],['Sharpe','—']];
  $('kpiStrip').innerHTML=items.map(([l,v,good])=>
    `<div class="card glass kpi p-3${good===false?' neg-kpi':''}"><div class="lbl">${l}</div><div class="num font-disp text-xl font-bold mt-1 ${good===true?'pos':good===false?'neg':''}">${v}</div></div>`).join('');
}

// ---------- main candle canvas ----------
function renderCandles(){
  const cv=$('candleCanvas'), ctx=cv.getContext('2d');
  const W=cv.clientWidth||cv.parentElement.clientWidth, H=420;
  const dpr=window.devicePixelRatio||1;
  cv.width=W*dpr; cv.height=H*dpr; ctx.scale(dpr,dpr);
  ctx.fillStyle='#0a0a0d'; ctx.fillRect(0,0,W,H);
  if(!state.detail){ctx.fillStyle='#71717a';ctx.font='13px sans-serif';ctx.fillText('Load a strategy to render price action…',20,40);return;}
  const {data:d,sig,bt}=state.detail;
  const N=Math.min(+$('barsToShow').value||500, d.t.length);
  const s0=d.t.length-N;
  const o=d.o.slice(s0),h=d.h.slice(s0),l=d.l.slice(s0),c=d.c.slice(s0),v=d.v.slice(s0),t=d.t.slice(s0);
  let mn=Infinity,mx=-Infinity;
  for(let i=0;i<N;i++){if(l[i]<mn)mn=l[i];if(h[i]>mx)mx=h[i];}
  // overlays
  const ov={};
  if($('showOverlay').checked)for(const k of Object.keys(sig.overlay||{})){const a=sig.overlay[k].slice(s0);ov[k]=a;for(let i=0;i<N;i++)if(isFinite(a[i])){if(a[i]<mn)mn=a[i];if(a[i]>mx)mx=a[i];}}
  const pad=(mx-mn)*0.08||1; mn-=pad; mx+=pad;
  const X=i=>8+i*(W-70)/N, Y=p=>H-30-(p-mn)/(mx-mn)*(H-70);
  // grid
  ctx.strokeStyle='#1c1c21';ctx.fillStyle='#52525b';ctx.font='10px JetBrains Mono';ctx.lineWidth=1;
  for(let g=0;g<5;g++){const p=mn+(mx-mn)*g/4,y=Y(p);ctx.beginPath();ctx.moveTo(8,y);ctx.lineTo(W-62,y);ctx.stroke();ctx.fillText(p.toFixed(1),W-58,y+3);}
  const bw=Math.max(1,(W-70)/N*0.62);
  for(let i=0;i<N;i++){
    const up=c[i]>=o[i];
    ctx.strokeStyle=up?'#22ff88':'#ff3b5c';ctx.fillStyle=up?'#22ff88':'#ff3b5c';
    ctx.beginPath();ctx.moveTo(X(i),Y(h[i]));ctx.lineTo(X(i),Y(l[i]));ctx.stroke();
    const yO=Y(o[i]),yC=Y(c[i]);
    ctx.fillRect(X(i)-bw/2,Math.min(yO,yC),bw,Math.max(1,Math.abs(yC-yO)));
  }
  // overlays lines
  const colors={ma:'#facc15',mid:'#38bdf8',up:'#38bdf888',lo:'#38bdf888',vwap:'#c084fc',st:'#fb923c',poc:'#f472b6',ckLong:'#22ff88',ckShort:'#ff3b5c',adxMa:'#facc15'};
  for(const[k,a]of Object.entries(ov)){
    ctx.strokeStyle=colors[k]||'#e4e4e7';ctx.lineWidth=k==='up'||k==='lo'?1:1.6;ctx.beginPath();
    let started=false;
    for(let i=0;i<N;i++){if(!isFinite(a[i]))continue;const x=X(i),y=Y(a[i]);if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);}
    ctx.stroke();
  }
  // markers from trades within window
  if($('showMarkers').checked){
    for(const tr of bt.trades){
      for(const [idx,up,txt] of [[tr.entryIdx,true,tr.type==='LONG'?'▲':'▼'],[tr.exitIdx,false,'◆']]){
        if(idx<s0||idx>=s0+N)continue;
        const i=idx-s0, x=X(i);
        if(up){const isL=tr.type==='LONG';ctx.fillStyle=isL?'#22ff88':'#ff3b5c';ctx.font='bold 11px sans-serif';ctx.fillText(isL?'▲':'▼',x-5,(isL?Y(l[i])+14:Y(h[i])-8));}
        else{ctx.fillStyle='#a1a1aa';ctx.font='8px sans-serif';ctx.fillText('◆',x-3,Y(tr.exitPx)+3);}
      }
    }
  }
  // x labels
  ctx.fillStyle='#52525b';
  for(let i=0;i<N;i+=Math.ceil(N/6)){const dt=new Date(t[i]);ctx.fillText(dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})+' '+String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0'),X(i)-20,H-10);}
  const r=state.sel;
  $('chartTitle').textContent=`· ${$('symbol').value} · ${r.timeframe}m · ${r.indicator} · ${fmtParams(r.params)} · SL ${(r.slPct||0).toFixed(2)}% / TP ${(r.tpPct||0).toFixed(2)}% · ${EXIT_LBL[r.exit||'fixed']||'FIX'}${r.carry?' +carry':''}`;
  $('chartLegend').innerHTML=`<span><i class="inline-block w-2.5 h-2.5 rounded-sm" style="background:#22ff88"></i> bull</span>
    <span><i class="inline-block w-2.5 h-2.5 rounded-sm" style="background:#ff3b5c"></i> bear</span>
    ${Object.keys(ov).map(k=>`<span><i class="inline-block w-4 h-[3px] align-middle" style="background:${colors[k]||'#e4e4e7'}"></i> ${k}</span>`).join('')}
    <span class="text-zinc-500">▲/▼ entries · ◆ exits · showing last ${N} / ${d.t.length} bars</span>`;
}
['barsToShow','showMarkers','showOverlay'].forEach(id=>$(id).addEventListener('change',renderCandles));
window.addEventListener('resize',()=>renderCandles());

// ---------- Chart.js panels ----------
function mkChart(id,cfg){
  if(state.charts[id])state.charts[id].destroy();
  state.charts[id]=new Chart($(id),cfg);
  return state.charts[id];
}
const gridColor='rgba(46,46,54,.55)', tickColor='#8b8b96';
function renderSubCharts(){
  if(!state.detail)return;
  const {data:d,sig,bt}=state.detail;
  const N=Math.min(+$('barsToShow').value||500,d.t.length), s0=d.t.length-N;
  const labels=Array.from(d.t.slice(s0),t=>new Date(t).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}));
  // oscillator: pick first available osc series else RSI computed
  let oscName='RSI',series=null;
  if(sig.osc.rsi){series=sig.osc.rsi.slice(s0);oscName='RSI';}
  else if(sig.osc.crsi){series=sig.osc.crsi.slice(s0);oscName='Connors RSI';}
  else if(sig.osc.fisher){series=sig.osc.fisher.slice(s0);oscName='Fisher Transform';}
  else if(sig.osc.sqzMom){series=sig.osc.sqzMom.slice(s0);oscName='Squeeze momentum';}
  else if(sig.osc.macdHist){series=sig.osc.macdHist.slice(s0);oscName='MACD hist';}
  else if(sig.osc.cyber){series=sig.osc.cyber.slice(s0);oscName='Ehlers Cyber Cycle';}
  else if(sig.osc.cmo){series=sig.osc.cmo.slice(s0);oscName='Chande MO';}
  else if(sig.osc.aroon){series=sig.osc.aroon.slice(s0);oscName='Aroon Oscillator';}
  else if(sig.osc.adx){series=sig.osc.adx.slice(s0);oscName='ADX';}
  else if(sig.osc.stochK){series=sig.osc.stochK.slice(s0);oscName='Stoch %K';}
  else if(sig.osc.cvd){series=Array.from(sig.osc.cvd.slice(s0));oscName='Cumulative Volume Delta';}
  else if(sig.osc.chop){series=sig.osc.chop.slice(s0);oscName='Choppiness Index';}
  else if(sig.osc.fvgBias){series=Array.from(sig.osc.fvgBias.slice(s0));oscName='FVG bias';}
  else{series=E.rsi(d.c,14).slice(s0);oscName='RSI (ref)';}
  $('oscTitle').textContent='· '+oscName;
  const ds=Array.from(series,v=>isFinite(v)?+v.toFixed(2):null);
  mkChart('oscChart',{type:'line',data:{labels,datasets:[{label:oscName,data:ds,borderColor:'#38bdf8',borderWidth:1.2,pointRadius:0,tension:0.1}]},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:gridColor},ticks:{color:tickColor,font:{size:10}}}}}});
  const vol=Array.from(d.v.slice(s0));
  const cl=d.c.slice(s0),op=d.o.slice(s0);
  mkChart('volChart',{type:'bar',data:{labels,datasets:[{label:'Volume',data:vol,backgroundColor:vol.map((_,i)=>cl[i]>=op[i]?'rgba(34,255,136,.55)':'rgba(255,59,92,.55)'),borderWidth:0}]},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:gridColor},ticks:{color:tickColor,font:{size:10}}}}}});
  // equity + dd (downsample to ≤2000 pts)
  const stride=Math.max(1,Math.floor(d.t.length/2000));
  const el=[],eql=[],ddl=[];
  for(let i=0;i<d.t.length;i+=stride){el.push(new Date(d.t[i]).toLocaleDateString('en-IN',{day:'2-digit',month:'short'}));eql.push(+bt.equity[i].toFixed(0));ddl.push(+bt.dd[i].toFixed(2));}
  $('eqTitle').textContent=`· final ${fmtMoney(bt.metrics.finalCapital)}${bt.metrics.maxDD<0?` · DD ${bt.metrics.maxDD.toFixed(2)}% ${fmtT(bt.metrics.ddPeakTime)} → ${fmtT(bt.metrics.ddTroughTime)}`:''}`;
  mkChart('eqChart',{type:'line',data:{labels:el,datasets:[{label:'Equity ₹',data:eql,borderColor:'#22ff88',backgroundColor:'rgba(34,255,136,.08)',fill:true,borderWidth:1.5,pointRadius:0,tension:0.15}]},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:gridColor},ticks:{color:tickColor,font:{size:10}}}}}});
  mkChart('ddChart',{type:'line',data:{labels:el,datasets:[{label:'DD %',data:ddl,borderColor:'#ff3b5c',backgroundColor:'rgba(255,59,92,.10)',fill:true,borderWidth:1.2,pointRadius:0,tension:0.15}]},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:gridColor},ticks:{color:tickColor,font:{size:10}},reverse:false}}}});
}

// ---------- trades ----------
function renderTrades(){
  const tb=$('tradeBody'); tb.innerHTML='';
  if(!state.detail){tb.innerHTML='<tr><td><div class="empty-state">No strategy loaded — run a search and click any row…</div></td></tr>';return;}
  const {bt}=state.detail, m=bt.metrics;
  $('tradeCount').textContent=`· ${bt.trades.length} closed trades`;
  $('tradeSummary').textContent=`avg ${fmtMoney(m.expectancy)} / trade · ${(m.tradesPerDay||0).toFixed(1)} trades/day · costs ${fmtMoney(-(bt.trades.length*(+$('costPer').value||0)))} · gross +${fmtMoney(m.grossProfit)} / -${fmtMoney(m.grossLoss)}`;
  let run=(+$('capital').value||100000);
  const frag=document.createDocumentFragment();
  const show=bt.trades.slice(-500).reverse();
  const inDD=t=>(m.maxDD<0&&t.exitTime>=m.ddPeakTime&&t.exitTime<=m.ddTroughTime);
  for(const t of show){
    run+=0; // running capital shown as final-relative; compute prefix
    const tr=document.createElement('tr');
    if(inDD(t))tr.classList.add('in-dd');
    const cells=[t.id,fmtT(t.entryTime),fmtT(t.exitTime),t.type,t.entryPx.toFixed(2),t.exitPx.toFixed(2),
      (t.pnl>=0?'+':'')+t.pnl.toFixed(0),t.pnlPct.toFixed(2)+'%',t.reason,''];
    cells.forEach((v,ci)=>{
      const td=document.createElement('td');td.textContent=v;
      if(ci===3)td.className=t.type==='LONG'?'pos text-left':'neg text-left';
      if(ci===6)td.className=t.pnl>=0?'pos':'neg';
      if(ci===7)td.className=t.pnlPct>=0?'pos':'neg';
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  }
  // running capital: recompute forward for last 500
  const last500=bt.trades.slice(-500); let c0=(+$('capital').value||100000)+ (bt.trades.length>500?bt.trades.slice(0,-500).reduce((s,t)=>s+t.pnl,0):0);
  [...frag.children].reverse().forEach((tr,i)=>{c0+=last500[i].pnl;tr.lastChild.textContent='₹'+Math.round(c0).toLocaleString('en-IN');});
  tb.appendChild(frag);
}

function renderAll(){renderKPIs();renderCandles();renderSubCharts();renderTrades();}

// ---------- exports ----------
function dl(name, text){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([text],{type:'text/csv'}));a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
$('btnExportBoard').onclick=()=>{
  if(!state.board.length){showAlert('Nothing to export — run a grid search first.');return;}
  let s='rank,timeframe,indicator,params,exit,carry,sl_pct,tp_pct,net_pnl,win_rate,trades,trades_per_day,profit_factor,max_dd,sharpe,sortino,expectancy\n';
  state.board.forEach((r,i)=>{s+=`${i+1},${r.timeframe}m,${r.indicator},"${fmtParams(r.params)}",${r.exit||'fixed'},${r.carry?1:0},${(r.slPct||0).toFixed(3)},${(r.tpPct||0).toFixed(3)},${r.m.netPnL.toFixed(2)},${r.m.winRate.toFixed(2)},${r.m.totalTrades},${(r.m.tradesPerDay||0).toFixed(3)},${r.m.profitFactor.toFixed(3)},${r.m.maxDD.toFixed(3)},${r.m.sharpe.toFixed(3)},${r.m.sortino.toFixed(3)},${r.m.expectancy.toFixed(2)}\n`;});
  dl('xbost_leaderboard.csv',s);
};
$('btnExportTrades').onclick=()=>{
  if(!state.detail){showAlert('No strategy loaded — run a search and click any leaderboard row.');return;}
  const {bt}=state.detail;
  let s='id,entry_time_ist,exit_time_ist,type,entry_px,exit_px,pnl,pnl_pct,reason\n';
  for(const t of bt.trades)s+=`${t.id},${fmtIST(t.entryTime)},${fmtIST(t.exitTime)},${t.type},${t.entryPx},${t.exitPx},${t.pnl.toFixed(2)},${t.pnlPct.toFixed(3)},${t.reason}\n`;
  const r=state.sel; dl(`xbost_trades_${r.indicator}_${r.timeframe}m_${r.exit||'fixed'}${r.carry?'_carry':''}_SL${r.slPct||0}_TP${r.tpPct||0}.csv`,s);
};

// ---------- live-data validation & run log (no synthetic data anywhere) ----------
state.log=[];
function logLine(s){
  const ts=new Date().toLocaleTimeString('en-IN',{hour12:false});
  state.log.push(`[${ts}] ${s}`);
  if(state.log.length>2000)state.log.splice(0,state.log.length-2000);
}
function runValidation(){
  // Audits the LOADED live dataset + engine: identities must hold to the decimal.
  const out=[];let pass=0,fail=0,skip=0;
  const ok=(name,cond,extra)=>{if(cond){pass++;out.push('PASS '+name);}else{fail++;out.push('FAIL '+name+(extra?' :: '+extra:''));}};
  logLine('validation started');
  try{
    if(!state.data||!state.data.t.length){out.push('Load live data first (upload CSV or Load HDFCBANK.csv).');$('valOut').textContent=out.join('\n');return;}
    const d=state.data, n=d.t.length;
    out.push(`live data: ${$('symbol').value} · ${n.toLocaleString()} 1m bars · ${new Date(d.t[0]).toLocaleDateString()} → ${new Date(d.t[n-1]).toLocaleDateString()}`);
    // L1 parse integrity on live bars
    let asc=true,dup=false,nanPx=false;
    const seen=new Set();
    const step=Math.max(1,Math.floor(n/200000));
    for(let i=1;i<n;i+=step){if(d.t[i]<=d.t[i-1])asc=false;}
    for(let i=0;i<n;i+=step){const k=d.t[i];if(seen.has(k))dup=true;seen.add(k);
      if(!isFinite(d.o[i]+d.h[i]+d.l[i]+d.c[i]))nanPx=true;}
    ok('L1 timestamps ascending, no dups, prices finite',asc&&!dup&&!nanPx,`asc=${asc} dup=${dup} nan=${nanPx}`);
    // L2 resample conservation 1m -> 5m on live data
    const d5=E.resample(d,5);
    let v1=0;for(let i=0;i<n;i++)v1+=d.v[i];
    let v5=0;for(let i=0;i<d5.t.length;i++)v5+=d5.v[i];
    ok('L2 resample conserves volume',Math.abs(v1-v5)<1e-6,`1m=${v1} 5m=${v5}`);
    ok('L2 resample bar count sane',d5.t.length>0&&d5.t.length<=n&&d5.t[0]>=d.t[0]-300000&&d5.t[d5.t.length-1]<=d.t[n-1]+300000,`${d5.t.length} bars`);
    // L3 warmup quarantine on live data (EMA21 -> first signal at bar >= 20)
    const sig=E.buildSignals(d5,{indicator:'EMA',params:{period:21}});
    let firstSig=-1;
    for(let i=0;i<sig.pos.length;i++)if(sig.pos[i]!==0){firstSig=i;break;}
    ok('L3 warmup quarantined (first signal >= bar 20)',firstSig>=20,'first='+firstSig);
    // L4 identities on a live backtest with CURRENT sidebar settings
    const eff=tradeOpts();
    eff.sessionMask=eff.carry?new Int8Array(d5.c.length).fill(1):E.buildSessionMask(d5,eff.sessionStart,eff.sessionEnd);
    const bt=E.backtest(d5,sig.pos,eff);
    const m=bt.metrics;
    ok('L4 cost identity (net == grossP - grossL)',Math.abs(m.netPnL-(m.grossProfit-m.grossLoss))<0.01,(m.grossProfit-m.grossLoss).toFixed(2)+' vs '+m.netPnL.toFixed(2));
    let s=0;for(const t of bt.trades)s+=t.pnl;
    ok('L4 equity identity (final == cap + sum pnl)',Math.abs(m.finalCapital-(eff.capital+s))<0.01);
    let handOk=bt.trades.length>0, handMsg='';
    for(let k=0;k<Math.min(3,bt.trades.length);k++){
      const t=bt.trades[k];
      const pxIn=(t.entryPx===d5.o[t.entryIdx]||t.entryPx===d5.c[t.entryIdx]);
      const ux=(t.type==='LONG'?(t.exitPx-t.entryPx):(t.entryPx-t.exitPx))*(eff.qty*eff.lotSize)-eff.cost;
      if(!(pxIn&&Math.abs(ux-t.pnl)<0.01)){handOk=false;handMsg='trade#'+t.id;}
    }
    ok('L4 first 3 trades reprice from bars',handOk,handMsg||(bt.trades.length+' trades'));
    if(eff.fill==='next'){
      const bad=bt.trades.filter(t=>Math.abs(t.entryPx-d5.o[t.entryIdx])>1e-9);
      ok('L4 next-open fills at open[]',bad.length===0,bad.length+' bad');
    } else out.push('SKIP L4-next-open (fill mode = close; switch ⑥ to test)');
    // L5 exit legs engage on live data (1m = most trigger opportunities)
    const d1m=state.data;
    const m1=E.buildSessionMask(d1m,eff.sessionStart,eff.sessionEnd);
    const s1=E.buildSignals(d1m,{indicator:'EMA',params:{period:21}});
    const be=E.backtest(d1m,s1.pos,Object.assign({},eff,{exit:'breakeven',sessionMask:m1}));
    const at=E.backtest(d1m,s1.pos,Object.assign({},eff,{exit:'atr',sessionMask:m1}));
    const hasBE=be.trades.some(t=>t.reason==='BE'), hasATR=at.trades.some(t=>t.reason==='ATR');
    if(be.trades.length+at.trades.length<10){
      out.push(`SKIP L5 legs need ≥10 trades, file gave ${be.trades.length+at.trades.length} — upload more sessions for a conclusive check`);skip++;
    } else ok('L5 breakeven + chandelier legs fire live',hasBE&&hasATR,`BE=${hasBE} ATR=${hasATR}`);
    // L6 ruin-guard invariant + bounded overshoot + finite metrics
    let runEq=eff.capital, ruinAt=-1;
    for(const t of bt.trades){runEq+=t.pnl;if(runEq<=0&&ruinAt<0)ruinAt=t.exitIdx;}
    const postRuin=ruinAt>=0?bt.trades.filter(t=>t.entryIdx>ruinAt).length:0;
    let maxLoss=0;for(const t of bt.trades)if(-t.pnl>maxLoss)maxLoss=-t.pnl;
    ok('L6 no entries after ruin',postRuin===0,postRuin+' post-ruin entries');
    ok('L6 overshoot ≤ one trade',m.finalCapital>=-(maxLoss+1e-6),`final=${m.finalCapital.toFixed(0)} max1loss=${maxLoss.toFixed(0)}`);
    ok('L6 metrics finite, DD ≤ 0',isFinite(m.sharpe)&&isFinite(m.sortino)&&isFinite(m.maxDD)&&m.maxDD<=0,
      `sharpe=${m.sharpe.toFixed(2)} sortino=${m.sortino.toFixed(2)} dd=${m.maxDD.toFixed(2)}`);
    // L7 session status
    let inn=0;for(let i=0;i<eff.sessionMask.length;i++)inn+=eff.sessionMask[i];
    out.push(`L7 session coverage ${(inn/eff.sessionMask.length*100).toFixed(1)}% · OHLCV-only engine · fill=${eff.fill} · exit=${eff.exit||'fixed'}${eff.carry?' +carry':''}`);
    out.push('');
    out.push(`LIVE VALIDATION: ${pass} passed, ${fail} failed${skip?`, ${skip} skipped (thin file)`:''} — ${$('symbol').value}, real data only.`);
    logLine(`validation: ${pass} passed, ${fail} failed${skip?`, ${skip} skipped`:''}`);
  }catch(err){out.push('VALIDATION FATAL: '+(err&&err.message||err));fail++;logLine('validation FATAL: '+(err&&err.message||err));}
  $('valOut').textContent=out.join('\n');
  $('valOut').style.borderColor=fail?'#ff3b5c':'#22ff88';
  out.forEach(l=>logLine('[val] '+l));
}
$('btnValidate').onclick=runValidation;
$('btnLogDl').onclick=()=>{
  if(!state.log.length){showAlert('Session log is empty — run validation or a grid search first.');return;}
  dl(`xbost_log_${$('symbol').value}_${new Date().toISOString().slice(0,10)}.txt`,
    `XBOST run log · ${new Date().toString()}\n${'='.repeat(60)}\n`+state.log.join('\n')+'\n');
};

// boot: neutral — no default symbol, no auto-load. Upload a CSV (or try the
// bundled file) to begin. No synthetic data anywhere.
// Surface unexpected errors in the status line so failures are never silent.
window.addEventListener('error', e=>{
  if($('btnRun')&&$('btnRun').disabled){
    $('nowRunning').textContent='❌ '+(e.message||'script error')+' — see console (F12).';
  }
});
estimateCombos();
updateRiskLock();
renderKPIs();
$('dataInfo').textContent='No file loaded — upload a 1-min CSV to begin.';
})();
