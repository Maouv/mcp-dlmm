import sharp from "sharp";

const W = 800;
const H = 500;
const PAD = 40;
const CHART_H = 280;
const LIQ_H = 140;
const LIQ_TOP = PAD + CHART_H + 20;

export interface ChartData {
  ohlcv: { t: number; o: number; h: number; l: number; c: number }[];
  bins: { binId: number; price: number; xAmount: number; yAmount: number; liquidity: number }[];
  activeBinId: number;
  binStep: number;
  basePrice: number;
  minPct: number;
  maxPct: number;
  poolName: string;
  timeframe: string;
}

export async function generateChart(data: ChartData): Promise<Buffer> {
  const svg = buildSVG(data);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function buildSVG(d: ChartData): string {
  const candles = d.ohlcv.slice(-60);
  const prices = candles.flatMap(c => [c.h, c.l]);
  let pMin = Math.min(...prices);
  let pMax = Math.max(...prices);
  const pRange = pMax - pMin || pMax * 0.01;
  pMin -= pRange * 0.1;
  pMax += pRange * 0.1;

  const activePrice = d.basePrice * Math.pow(1 + d.binStep / 10000, d.activeBinId);
  const minPrice = activePrice * (1 + d.minPct / 100);
  const maxPrice = activePrice * (1 + d.maxPct / 100);
  const allPrices = [...prices, activePrice, minPrice, maxPrice];
  const cMin = Math.min(...allPrices);
  const cMax = Math.max(...allPrices);
  const cRange = cMax - cMin || cMax * 0.01;

  const xScale = (i: number) => PAD + (i / (candles.length - 1)) * (W - 2 * PAD);
  const yScale = (p: number) => PAD + (1 - (p - cMin) / cRange) * CHART_H;
  const liqScale = (liq: number, maxLiq: number) => LIQ_TOP + (1 - liq / maxLiq) * LIQ_H;

  let parts: string[] = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#0d1117">`);

  parts.push(`<text x="${PAD}" y="22" fill="#c9d1d9" font-size="14" font-family="monospace">${escapeXml(d.poolName)}</text>`);
  parts.push(`<text x="${W - PAD}" y="22" fill="#8b949e" font-size="11" font-family="monospace" text-anchor="end">${d.timeframe}</text>`);

  for (let i = 0; i <= 4; i++) {
    const y = PAD + (i / 4) * CHART_H;
    const p = cMax - (i / 4) * cRange;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#1e2530" stroke-width="0.5"/>`);
    parts.push(`<text x="${PAD - 5}" y="${y + 4}" fill="#8b949e" font-size="9" font-family="monospace" text-anchor="end">${fmtPrice(p)}</text>`);
  }

  candles.forEach((c, i) => {
    const x = xScale(i);
    const color = c.c >= c.o ? "#26a69a" : "#ef5350";
    const w = Math.max(1, (W - 2 * PAD) / candles.length * 0.7);
    const yO = yScale(c.o);
    const yC = yScale(c.c);
    parts.push(`<line x1="${x}" y1="${yScale(c.h)}" x2="${x}" y2="${yScale(c.l)}" stroke="${color}" stroke-width="1"/>`);
    parts.push(`<rect x="${x - w/2}" y="${Math.min(yO, yC)}" width="${w}" height="${Math.abs(yC - yO) || 1}" fill="${color}"/>`);
  });

  const bins = d.bins;
  const maxLiq = Math.max(...bins.map(b => b.liquidity || 0), 1);
  const liqW = (W - 2 * PAD) / bins.length;
  const activeIdx = bins.findIndex(b => b.binId === d.activeBinId);

  parts.push(`<line x1="${PAD}" y1="${LIQ_TOP}" x2="${W - PAD}" y2="${LIQ_TOP}" stroke="#1e2530" stroke-width="0.5"/>`);

  bins.forEach((b, i) => {
    const x = PAD + i * liqW;
    const h = (b.liquidity || 0) / maxLiq * LIQ_H;
    const y = LIQ_TOP + LIQ_H - h;
    const isActive = b.binId === d.activeBinId;
    parts.push(`<rect x="${x}" y="${y}" width="${Math.max(1, liqW - 0.5)}" height="${h}" fill="${isActive ? "#f0b90b" : "#3a4a5a"}"/>`);
  });

  if (activeIdx >= 0) {
    const ax = PAD + activeIdx * liqW + liqW / 2;
    parts.push(`<line x1="${ax}" y1="${PAD}" x2="${ax}" y2="${LIQ_TOP + LIQ_H}" stroke="#f0b90b" stroke-width="1" stroke-dasharray="3,2"/>`);
    parts.push(`<text x="${ax + 3}" y="${PAD + 12}" fill="#f0b90b" font-size="9" font-family="monospace">active</text>`);
  }

  const minIdx = findBinIdx(bins, d.minPct, d.activeBinId, d.binStep, d.basePrice, true);
  const maxIdx = findBinIdx(bins, d.maxPct, d.activeBinId, d.binStep, d.basePrice, false);

  if (minIdx >= 0) {
    const x = PAD + minIdx * liqW + liqW / 2;
    parts.push(`<line x1="${x}" y1="${PAD}" x2="${x}" y2="${LIQ_TOP + LIQ_H}" stroke="#e74c3c" stroke-width="1.5" stroke-dasharray="4,2"/>`);
    parts.push(`<text x="${x + 3}" y="${PAD + 24}" fill="#e74c3c" font-size="9" font-family="monospace">min ${d.minPct}%</text>`);
  }
  if (maxIdx >= 0) {
    const x = PAD + maxIdx * liqW + liqW / 2;
    parts.push(`<line x1="${x}" y1="${PAD}" x2="${x}" y2="${LIQ_TOP + LIQ_H}" stroke="#2ecc71" stroke-width="1.5" stroke-dasharray="4,2"/>`);
    parts.push(`<text x="${x + 3}" y="${PAD + 36}" fill="#2ecc71" font-size="9" font-family="monospace">max ${d.maxPct}%</text>`);
  }

  parts.push(`<rect x="${PAD}" y="${PAD}" width="${W - 2 * PAD}" height="${LIQ_TOP + LIQ_H - PAD}" fill="none" stroke="#1e2530" stroke-width="1"/>`);

  parts.push(`</svg>`);
  return parts.join("");
}

function findBinIdx(bins: any[], pct: number, activeBinId: number, binStep: number, basePrice: number, isMin: boolean): number {
  const activePrice = basePrice * Math.pow(1 + binStep / 10000, activeBinId);
  const targetPrice = activePrice * (1 + pct / 100);
  let targetBinId = activeBinId;
  if (targetPrice > activePrice) {
    while (basePrice * Math.pow(1 + binStep / 10000, targetBinId) < targetPrice) targetBinId++;
  } else {
    while (basePrice * Math.pow(1 + binStep / 10000, targetBinId) > targetPrice) targetBinId--;
  }
  return bins.findIndex(b => b.binId === targetBinId);
}

function fmtPrice(p: number): string {
  if (p < 0.001) return p.toExponential(2);
  if (p < 1) return p.toFixed(6);
  if (p < 100) return p.toFixed(4);
  return p.toFixed(2);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
