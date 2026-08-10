import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";
// @ts-ignore - no types
import DLMM from "@meteora-ag/dlmm";
import { getConnection, getWallet } from "./wallet";

const DATAPI = "https://dlmm.datapi.meteora.ag";

async function getDlmm(poolAddress: string) {
  const conn = getConnection();
  const dlmm = await DLMM.create(conn, new PublicKey(poolAddress));
  return { conn, dlmm };
}

export async function searchPools(query?: string, limit = 10) {
  const params = new URLSearchParams({ page: "1", page_size: String(limit), sort_by: "volume_24h:desc" });
  if (query) params.set("query", query);
  const res = await fetch(`${DATAPI}/pools?${params}`);
  return res.json();
}

export async function searchPoolsByToken(tokenMint: string): Promise<any[]> {
  const params = new URLSearchParams({ page: "1", page_size: "20", sort_by: "tvl:desc", query: tokenMint });
  const res = await fetch(`${DATAPI}/pools?${params}`);
  if (!res.ok) throw new Error(`Datapi error: ${res.status}`);
  const data: any = await res.json();
  return data?.data || [];
}

export function formatPoolList(pools: any[]): string {
  if (pools.length === 0) return "No pools found.";
  const lines: string[] = [];
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const name = p.name || "unknown";
    const binStep = p.pool_config?.bin_step || "?";
    const baseFee = p.pool_config?.base_fee_pct ?? "?";
    const tvl = p.tvl ? `$${p.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "$0";
    const vol5m = p.volume?.["30m"] ? `$${p.volume["30m"].toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "$0";
    const vol24h = p.volume?.["24h"] ? `$${p.volume["24h"].toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "$0";
    const liq = p.tvl ? `$${(p.tvl / 1000).toFixed(1)}K` : "$0";
    const link = `https://app.meteora.ag/dlmm/${p.address}?referral_code=METIDN`;
    const num = i + 1;
    lines.push(`${num}. [${name} ${binStep}/${baseFee}](${link})`);
    lines.push(`   TVL: ${tvl} | Vol 5m: ${vol5m} | Vol 24h: ${vol24h} | LIQ: ${liq}`);
  }
  return lines.join("\n");
}

export async function getPool(poolAddress: string) {
  const res = await fetch(`${DATAPI}/pools/${poolAddress}`);
  return res.json();
}

export async function getActiveBin(poolAddress: string) {
  const { dlmm } = await getDlmm(poolAddress);
  const bin = await dlmm.getActiveBin();
  return { binId: bin.binId, price: bin.pricePerToken, xAmount: bin.xAmount?.toString(), yAmount: bin.yAmount?.toString() };
}

export async function getUserPositions(walletAddress: string) {
  const conn = getConnection();
  const posMap = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(walletAddress));
  const result: Array<{ poolAddress: string; positions: Array<{ address: string; lowerBinId: number; upperBinId: number }> }> = [];
  posMap.forEach((info: any, addr: string) => {
    const positions = (info.lbPairPositionsData || []).map((p: any) => ({
      address: p.publicKey?.toString() || "",
      lowerBinId: p.positionData?.lowerBinId || 0,
      upperBinId: p.positionData?.upperBinId || 0,
    }));
    if (positions.length) result.push({ poolAddress: addr, positions });
  });
  return result;
}

export async function getPositionDetail(poolAddress: string, positionAddress: string) {
  const { dlmm } = await getDlmm(poolAddress);
  const pos = await dlmm.getPosition(new PublicKey(positionAddress));
  return {
    lowerBinId: pos.positionData.lowerBinId,
    upperBinId: pos.positionData.upperBinId,
    totalXAmount: pos.positionData.totalXAmount?.toString(),
    totalYAmount: pos.positionData.totalYAmount?.toString(),
    feeX: pos.positionData.feeX?.toString(),
    feeY: pos.positionData.feeY?.toString(),
  };
}

export async function getSwapQuote(poolAddress: string, inToken: string, inAmount: string) {
  const { dlmm } = await getDlmm(poolAddress);
  const swapForY = dlmm.tokenX.publicKey.toBase58() !== inToken;
  const binArrays = await dlmm.getBinArrayForSwap(swapForY);
  const quote: any = dlmm.swapQuote(new BN(inAmount), swapForY, new BN(100), binArrays);
  return { inAmount: quote.inAmount.toString(), outAmount: quote.outAmount.toString(), feeBps: quote.feeBps?.toNumber?.() ?? 0, parts: quote.parts?.length ?? 0 };
}

export async function claimFees(poolAddress: string, positionAddress: string) {
  const wallet = getWallet();
  if (!wallet) throw new Error("Wallet not set. Use /setwallet first.");
  const { dlmm, conn } = await getDlmm(poolAddress);
  const pos = await dlmm.getPosition(new PublicKey(positionAddress));
  const txs = await dlmm.claimSwapFee({ owner: wallet.publicKey, position: pos });
  const sigs: string[] = [];
  for (const tx of Array.isArray(txs) ? txs : [txs]) {
    const sig = await conn.sendTransaction(tx, [wallet], { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    sigs.push(sig);
  }
  return sigs;
}

export async function claimAllRewards(poolAddress: string, positionAddress: string) {
  const wallet = getWallet();
  if (!wallet) throw new Error("Wallet not set. Use /setwallet first.");
  const { dlmm, conn } = await getDlmm(poolAddress);
  const pos = await dlmm.getPosition(new PublicKey(positionAddress));
  const txs = await dlmm.claimAllRewardsByPosition({ owner: wallet.publicKey, position: pos });
  const sigs: string[] = [];
  for (const tx of Array.isArray(txs) ? txs : [txs]) {
    const sig = await conn.sendTransaction(tx, [wallet], { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    sigs.push(sig);
  }
  return sigs;
}

export async function addLiquidity(poolAddress: string, amountX: string, amountY: string, minDelta: number, maxDelta: number, strategy: string = "Spot") {
  const wallet = getWallet();
  if (!wallet) throw new Error("Wallet not set. Use /setwallet first.");
  const { dlmm, conn } = await getDlmm(poolAddress);
  const posKeypair = Keypair.generate();
  const strategyMap: Record<string, number> = { Spot: 0, Curve: 1, BidAsk: 2 };
  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: posKeypair.publicKey,
    user: wallet.publicKey,
    totalXAmount: new BN(amountX),
    totalYAmount: new BN(amountY),
    strategy: { maxBinId: maxDelta, minBinId: minDelta, strategyType: strategyMap[strategy] || 0 },
    slippage: 100,
  });
  const sig = await conn.sendTransaction(tx, [wallet, posKeypair], { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  return { sig, positionAddress: posKeypair.publicKey.toString() };
}

export async function removeLiquidity(poolAddress: string, positionAddress: string, bps: number, claimAndClose: boolean) {
  const wallet = getWallet();
  if (!wallet) throw new Error("Wallet not set. Use /setwallet first.");
  const { dlmm, conn } = await getDlmm(poolAddress);
  const pos = await dlmm.getPosition(new PublicKey(positionAddress));
  const txs = await dlmm.removeLiquidity({
    user: wallet.publicKey,
    position: new PublicKey(positionAddress),
    fromBinId: pos.positionData.lowerBinId,
    toBinId: pos.positionData.upperBinId,
    bps: new BN(bps),
    shouldClaimAndClose: claimAndClose,
  });
  const sigs: string[] = [];
  for (const tx of Array.isArray(txs) ? txs : [txs]) {
    const sig = await conn.sendTransaction(tx, [wallet], { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    sigs.push(sig);
  }
  return { sigs, bps, closed: claimAndClose };
}

export async function dlmmSwap(poolAddress: string, inToken: string, inAmount: string, minOutAmount: string) {
  const wallet = getWallet();
  if (!wallet) throw new Error("Wallet not set. Use /setwallet first.");
  const { dlmm, conn } = await getDlmm(poolAddress);
  const swapForY = dlmm.tokenX.publicKey.toBase58() !== inToken;
  const tx = await dlmm.swap({
    user: wallet.publicKey,
    inToken: new PublicKey(inToken),
    outToken: swapForY ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey,
    inAmount: new BN(inAmount),
    minOutAmount: new BN(minOutAmount),
    lbPair: new PublicKey(poolAddress),
    binArraysPubkey: [],
  });
  const sig = await conn.sendTransaction(tx, [wallet], { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function getPoolFees(poolAddress: string) {
  const { dlmm } = await getDlmm(poolAddress);
  const feeInfo: any = dlmm.getFeeInfo();
  return { baseFeePct: feeInfo.baseFee?.toNumber?.() ?? 0, dynamicFeePct: dlmm.getDynamicFee().toNumber() };
}

export async function getEmissionRate(poolAddress: string) {
  const { dlmm } = await getDlmm(poolAddress);
  return dlmm.getEmissionRate();
}

export async function getBinsForChart(poolAddress: string, range = 100): Promise<{ bins: any[]; activeBinId: number; binStep: number; basePrice: number }> {
  const { dlmm } = await getDlmm(poolAddress);
  const activeBin: any = await dlmm.getActiveBin();
  const activeBinId = activeBin.binId;
  const binStep = dlmm.lbPair.binStep;
  const basePrice = (dlmm.lbPair as any).pricePerToken || 1;
  const rawBins: any = await dlmm.getBinsAroundActiveBin(range, range);
  const bins: any[] = (rawBins.bins || rawBins).map((b: any) => ({
    binId: b.binId,
    price: b.price || basePrice * Math.pow(1 + binStep / 10000, b.binId),
    xAmount: b.xAmount?.toString?.() || "0",
    yAmount: b.yAmount?.toString?.() || "0",
    liquidity: b.liquidity || b.reserveXAmount?.toNumber?.() || 0,
  }));
  return { bins, activeBinId, binStep, basePrice };
}

export async function getPoolOhlcv(poolAddress: string, type: string = "1H", limit: number = 100) {
  const res = await fetch(`${DATAPI}/pools/${poolAddress}/ohlcv?type=${type}&limit=${limit}`);
  return res.json();
}

export async function getPoolVolume(poolAddress: string) {
  const res = await fetch(`${DATAPI}/pools/${poolAddress}/volume`);
  return res.json();
}

export async function getBinsAroundActive(poolAddress: string, left: number, right: number) {
  const { dlmm } = await getDlmm(poolAddress);
  const bins = await dlmm.getBinsAroundActiveBin(left, right);
  const list: any = (bins as any).bins || bins;
  return (list as any[]).map((b: any) => ({
    binId: b.binId,
    price: b.price,
    xAmount: b.xAmount?.toString(),
    yAmount: b.yAmount?.toString(),
  }));
}
