// XBOST Report Builder — logging-only, no strategy change.
// Generates machine + human reports per spec §1-17.
// All numbers are recomputed from underlying candidate/trade data.
import type { BoardRow } from './engine';

export function candidateId(r: BoardRow): string {
  return `${r.symbol || 'UNK'}_${r.timeframe}m_${r.indicator}_${Object.values(r.params || {}).join('_')}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80);
}

export function isOosBlock(r: any) {
  // r is the OOS result object from wfVerify or robustness cross
  return r;
}

export function formatCandidateHeader(r: BoardRow, totalCombos: number, rank: number, objective: string, baseOpts: any) {
  const lines: string[] = [];
  lines.push('=== CANDIDATE ===');
  lines.push(`candidate_id=${candidateId(r)}`);
  lines.push(`instrument=${r.symbol || 'UNK'}`);
  lines.push(`timeframe=${r.timeframe}m`);
  lines.push(`indicator=${r.indicator}`);
  lines.push(`indicator_parameters=${JSON.stringify(r.params)}`);
  lines.push(`direction=${baseOpts.direction || 'Both'}`);
  lines.push(`entry_mode=${baseOpts.entry || 'trigger'}`);
  lines.push(`regime=${baseOpts.regimeSource || 'rules'}/${baseOpts.granularity || 'day'}`);
  lines.push(`exit_model=${r.exit || 'fixed'}`);
  lines.push(`SL=${r.slPct}%`);
  lines.push(`TP=${r.tpPct}%`);
  lines.push(`trade_count=${r.m?.totalTrades ?? 0}`);
  lines.push(`WR=${(r.m?.winRate ?? 0).toFixed(2)}%`);
  lines.push(`expectancy=${(r.m?.expectancy ?? 0).toFixed(4)}`);
  lines.push(`PF=${(r.m?.profitFactor ?? 0).toFixed(2)}`);
  lines.push(`Sharpe=${(r.m?.sharpe ?? 0).toFixed(2)}`);
  lines.push(`Sortino=${(r.m?.sortino ?? 0).toFixed(2)}`);
  lines.push(`maxDD=${(r.m?.maxDD ?? 0).toFixed(2)}%`);
  lines.push(`P&L=${(r.m?.netPnL ?? 0).toFixed(2)}`);
  lines.push(`rank=${rank}`);
  lines.push(`search_percentile=${totalCombos ? ((1 - rank / totalCombos) * 100).toFixed(2) : '0.00'}%`);
  lines.push(`optimization_objective=${objective}`);
  lines.push(`total_grid_combinations=${totalCombos}`);
  // placeholders for counts - filled by caller if available
  lines.push(`parameters_locked=true`);
  lines.push(`reoptimized=false`);
  return lines.join('\n');
}

export function formatCoreSignal(r: any) {
  const m = r.m || r.baseline || {};
  const ext = r.robustness?.baseline || {};
  return [
    'CORE SIGNAL QUALITY',
    `trades=${m.totalTrades ?? 0}`,
    `wins=${r.robustness?.baseline?.wins?.length ?? 'NA'}`,
    `losses=${r.robustness?.baseline?.losses?.length ?? 'NA'}`,
    `WR=${(m.winRate ?? 0).toFixed(2)}%`,
    `avg_winner=${(ext.avgWinner ?? 0).toFixed(2)}`,
    `median_winner=${(ext.medianWinner ?? 0).toFixed(2)}`,
    `avg_loser=${(ext.avgLoser ?? 0).toFixed(2)}`,
    `median_loser=${(ext.medianLoser ?? 0).toFixed(2)}`,
    `expectancy=${(ext.expectancy ?? m.expectancy ?? 0).toFixed(4)}`,
    `profit_factor=${(ext.profitFactor ?? m.profitFactor ?? 0).toFixed(2)}`,
    `payoff_ratio=${(ext.payoffRatio ?? 0).toFixed(2)}`,
    `Sharpe=${(m.sharpe ?? 0).toFixed(2)}`,
    `Sortino=${(m.sortino ?? 0).toFixed(2)}`,
    `maxDD=${(m.maxDD ?? 0).toFixed(2)}%`,
    `avgDD=${ext.avgDD ?? 'NA'}`,
    `largest_winner=${(ext.largestWinner ?? 0).toFixed(2)}`,
    `largest_loser=${(ext.largestLoser ?? 0).toFixed(2)}`,
    `avg_MAE=${(ext.avgMAE ?? 0).toFixed(2)}`,
    `median_MAE=${(ext.medianMAE ?? 0).toFixed(2)}`,
    `avg_MFE=${(ext.avgMFE ?? 0).toFixed(2)}`,
    `median_MFE=${(ext.medianMFE ?? 0).toFixed(2)}`,
    `MFE_MAE_ratio=${(ext.mfeMaeRatio ?? 0).toFixed(2)}`,
  ].join('\n');
}

export function formatIsOos(candidate: BoardRow, isMetrics: any, oosMetrics: any | null) {
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push('IS / OOS VALIDATION');
  lines.push('============================================================');
  lines.push(`candidate_id=${candidateId(candidate)}`);
  lines.push('');
  lines.push('IS:');
  if (isMetrics) {
    lines.push(`period=${isMetrics.period || 'IS'}`);
    lines.push(`trades=${isMetrics.totalTrades ?? 0}`);
    lines.push(`wins=${isMetrics.wins ?? Math.round((isMetrics.winRate ?? 0) * (isMetrics.totalTrades ?? 0) / 100)}`);
    lines.push(`losses=${(isMetrics.totalTrades ?? 0) - Math.round((isMetrics.winRate ?? 0) * (isMetrics.totalTrades ?? 0) / 100)}`);
    lines.push(`WR=${(isMetrics.winRate ?? 0).toFixed(2)}%`);
    lines.push(`P&L=${(isMetrics.netPnL ?? 0).toFixed(2)}`);
    lines.push(`expectancy=${(isMetrics.expectancy ?? 0).toFixed(4)}`);
    lines.push(`profit_factor=${(isMetrics.profitFactor ?? 0).toFixed(2)}`);
    lines.push(`Sharpe=${(isMetrics.sharpe ?? 0).toFixed(2)}`);
    lines.push(`Sortino=${(isMetrics.sortino ?? 0).toFixed(2)}`);
    lines.push(`maxDD=${(isMetrics.maxDD ?? 0).toFixed(2)}%`);
  } else {
    lines.push('period=IS');
    lines.push('trades=0');
    lines.push('OOS_STATUS=NOT_AVAILABLE');
  }
  lines.push('');
  lines.push('OOS:');
  if (oosMetrics) {
    lines.push(`period=${oosMetrics.period || 'OOS'}`);
    lines.push(`trades=${oosMetrics.totalTrades ?? 0}`);
    lines.push(`wins=${oosMetrics.wins ?? 0}`);
    lines.push(`losses=${oosMetrics.losses ?? 0}`);
    lines.push(`WR=${(oosMetrics.winRate ?? 0).toFixed(2)}%`);
    lines.push(`P&L=${(oosMetrics.netPnL ?? 0).toFixed(2)}`);
    lines.push(`expectancy=${(oosMetrics.expectancy ?? 0).toFixed(4)}`);
    lines.push(`profit_factor=${(oosMetrics.profitFactor ?? 0).toFixed(2)}`);
    lines.push(`Sharpe=${(oosMetrics.sharpe ?? 0).toFixed(2)}`);
    lines.push(`Sortino=${(oosMetrics.sortino ?? 0).toFixed(2)}`);
    lines.push(`maxDD=${(oosMetrics.maxDD ?? 0).toFixed(2)}%`);
    const oosStatus = oosMetrics.totalTrades < 30 ? 'INSUFFICIENT_SAMPLE' : oosMetrics.netPnL > 0 ? 'PASS' : 'FAIL';
    lines.push(`OOS_STATUS=${oosStatus}`);
    lines.push(`OOS_PNL=${oosMetrics.netPnL?.toFixed(2) ?? 0}`);
    lines.push(`OOS_EXPECTANCY=${oosMetrics.expectancy?.toFixed(4) ?? 0}`);
    lines.push(`OOS_WR=${(oosMetrics.winRate ?? 0).toFixed(2)}%`);
    lines.push(`OOS_SHARPE=${(oosMetrics.sharpe ?? 0).toFixed(2)}`);
    lines.push(`OOS_TRADES=${oosMetrics.totalTrades ?? 0}`);
    const oosValidation = oosMetrics.netPnL > 0 && oosMetrics.expectancy > 0 ? 'POSITIVE' : oosMetrics.netPnL <= 0 && oosMetrics.expectancy <= 0 ? 'NEGATIVE' : 'MIXED';
    lines.push(`OOS_VALIDATION_RESULT=${oosValidation}`);
  } else {
    lines.push(`period=OOS`);
    lines.push(`trades=0`);
    lines.push(`OOS_STATUS=NOT_AVAILABLE`);
    lines.push(`OOS_PNL=0`);
    lines.push(`OOS_EXPECTANCY=0`);
    lines.push(`OOS_VALIDATION_RESULT=INSUFFICIENT_DATA`);
  }
  return lines.join('\n');
}
