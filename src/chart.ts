import sharp from "sharp";

export interface BinData {
  binId: number;
  price: number;
  xAmount: number;
  yAmount: number;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartParams {
  poolName: string;
  binStep: number;
  activeBinId: number;
  activePrice: number;
  bins: BinData[];
  ohlcv: OHLCV[];
  minPct: number;
  maxPct: number;
  timeframe: string;
}

const W = 800;
const H = 500;
const PAD_L = 60;
const PAD_R = 50;
const PAD_T = 40;
const PAD_B = 30;
const CHART_H = 280;
const LIQ_H = 140;
const LIQ_Y = PAD_T + CHART_H + 20;

function fmtPrice(p: number): string {
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  if (p >= 0.0001) return p.toFixed(7);
  return p.toExponential(2);
}

export function generateChartSVG(p: ChartParams): string {
  const { bins, ohlcv, minPct, maxPct, activeBinId, activePrice, binStep, poolName, timeframe } = p;

  const chartW = W - PAD_L - PAD_R;
  const candleW = ohlcv.length > 0 ? Math.max(1, chartW / ohlcv.length * 0.7) : 1;
  const step = ohlcv.length > 0 ? chartW / ohlcv.length : chartW;

  const allPrices = ohlcv.flatMap(c => [c.high, c.low]);
  if (activePrice > 0) allPrices.push(activePrice);
  const minPrice = Math.min(...allPrices) * 0.95;
  const maxPrice = Math.max(...allPrices) * 1.05;
  const priceRange = maxPrice - minPrice || 1;

  const maxLiq = Math.max(...bins.map(b => b.xAmount + b.yAmount), 1);
  const binStepX = bins.length > 0 ? chartW / bins.length : chartW;
  const barW = Math.max(1, binStepX * 0.7);

  const minPriceLine = activePrice * (1 + minPct / 100);
  const maxPriceLine = activePrice * (1 + maxPct / 100);

  const priceToY = (price: number) => PAD_T + CHART_H - ((price - minPrice) / priceRange) * CHART_H;

  const liqMinY = LIQ_Y;
  const liqMaxY = LIQ_Y + LIQ_H;

  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="background:#0d1117">`;

  svg += `<rect width="${W}" height="${H}" fill="#0d1117"/>`;

  svg += `<text x="${PAD_L}" y="22" fill="#c9d1d9" font-size="14" font-family="monospace" font-weight="bold">${poolName}</text>`;
  svg += `<text x="${W - PAD_R}" y="22" fill="#8b949e" font-size="11" font-family="monospace" text-anchor="end">${timeframe}</text>`;

  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + (CHART_H / 4) * i;
    const price = maxPrice - (priceRange / 4) * i;
    svg += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#21262d" stroke-width="0.5"/>`;
    svg += `<text x="${PAD_L - 5}" y="${y + 3}" fill="#8b949e" font-size="9" font-family="monospace" text-anchor="end">${fmtPrice(price)}</text>`;
  }

  if (minPriceLine >= minPrice && minPriceLine <= maxPrice) {
    const y = priceToY(minPriceLine);
    svg += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#f85149" stroke-width="1" stroke-dasharray="4 2"/>`;
    svg += `<text x="${W - PAD_R + 3}" y="${y + 3}" fill="#f85149" font-size="9" font-family="monospace">${minPct}%</text>`;
  }
  if (maxPriceLine >= minPrice && maxPriceLine <= maxPrice) {
    const y = priceToY(maxPriceLine);
    svg += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#3fb950" stroke-width="1" stroke-dasharray="4 2"/>`;
    svg += `<text x="${W - PAD_R + 3}" y="${y + 3}" fill="#3fb950" font-size="9" font-family="monospace">${maxPct}%</text>`;
  }

  if (activePrice >= minPrice && activePrice <= maxPrice) {
    const y = priceToY(activePrice);
    svg += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#ffd33d" stroke-width="1" stroke-dasharray="2 2"/>`;
    svg += `<text x="${W - PAD_R + 3}" y="${y - 3}" fill="#ffd33d" font-size="9" font-family="monospace">act</text>`;
  }

  ohlcv.forEach((c, i) => {
    const x = PAD_L + i * step + step / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? "#26a4c4" : "#f85149";
    const yHigh = priceToY(c.high);
    const yLow = priceToY(c.low);
    const yOpen = priceToY(c.open);
    const yClose = priceToY(c.close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    svg += `<line x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke="${color}" stroke-width="0.8"/>`;
    svg += `<rect x="${x - candleW / 2}" y="${bodyTop}" width="${candleW}" height="${bodyH}" fill="${color}" opacity="0.8"/>`;
  });

  svg += `<line x1="${PAD_L}" y1="${liqMinY - 10}" x2="${W - PAD_R}" y2="${liqMinY - 10}" stroke="#21262d" stroke-width="0.5"/>`;
  svg += `<text x="${PAD_L}" y="${liqMinY - 3}" fill="#8b949e" font-size="9" font-family="monospace">Liquidity</text>`;

  bins.forEach((b, i) => {
    const x = PAD_L + i * binStepX + binStepX / 2;
    const liq = b.xAmount + b.yAmount;
    const h = (liq / maxLiq) * LIQ_H;
    const y = liqMaxY - h;
    const isActive = b.binId === activeBinId;
    const inRange = b.price >= minPriceLine && b.price <= maxPriceLine;
    let color = "#30363d";
    if (isActive) color = "#ffd33d";
    else if (inRange) color = "#3fb950";
    svg += `<rect x="${x - barW / 2}" y="${y}" width="${barW}" height="${h}" fill="${color}" opacity="0.7"/>`;
  });

  const minBinIdx = bins.findIndex(b => b.price >= minPriceLine);
  const maxBinIdx = bins.findIndex(b => b.price >= maxPriceLine);
  if (minBinIdx >= 0 && maxBinIdx >= 0 && maxBinIdx >= minBinIdx) {
    const x1 = PAD_L + minBinIdx * binStepX;
    const x2 = PAD_L + (maxBinIdx + 1) * binStepX;
    svg += `<rect x="${x1}" y="${liqMinY}" width="${x2 - x1}" height="${LIQ_H}" fill="#3fb950" opacity="0.08"/>`;
    svg += `<line x1="${x1}" y1="${liqMinY}" x2="${x1}" y2="${liqMaxY}" stroke="#3fb950" stroke-width="0.5" opacity="0.5"/>`;
    svg += `<line x1="${x2}" y1="${liqMinY}" x2="${x2}" y2="${liqMaxY}" stroke="#3fb950" stroke-width="0.5" opacity="0.5"/>`;
  }

  svg += `<line x1="${PAD_L}" y1="${liqMaxY}" x2="${W - PAD_R}" y2="${liqMaxY}" stroke="#30363d" stroke-width="0.5"/>`;
  const labelBins = [0, Math.floor(bins.length / 2), bins.length - 1];
  labelBins.forEach(i => {
    if (i < bins.length) {
      const x = PAD_L + i * binStepX + binStepX / 2;
      svg += `<text x="${x}" y="${liqMaxY + 15}" fill="#8b949e" font-size="8" font-family="monospace" text-anchor="middle">${bins[i].binId}</text>`;
    }
  });

  svg += `<text x="${PAD_L}" y="${H - 5}" fill="#8b949e" font-size="9" font-family="monospace">Bin</text>`;
  svg += `<text x="${W - PAD_R}" y="${H - 5}" fill="#8b949e" font-size="9" font-family="monospace" text-anchor="end">Step ${binStep}</text>`;

  svg += `</svg>`;
  return svg;
}

export async function renderChartPNG(p: ChartParams): Promise<Buffer> {
  const svg = generateChartSVG(p);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
