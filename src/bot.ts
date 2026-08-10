import "dotenv/config";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { PublicKey } from "@solana/web3.js";
import { setWalletKey, getWallet, getConnection } from "./wallet";
import * as met from "./meteora";
import * as jup from "./jupiter";
import { renderChartPNG, ChartParams, BinData, OHLCV } from "./chart";

const bot = new Bot(process.env.BOT_TOKEN!);
const PASSWORD = process.env.BOT_PASSWORD || "Freyana";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const authed = new Set<number>();
const awaitingPassword = new Set<number>();
const awaitingWallet = new Set<number>();

const awaitingPoolToken = new Set<number>();

interface AddLPState {
  poolAddr: string;
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
const addLPStates = new Map<number, AddLPState>();
const awaitingMinPct = new Set<number>();
const awaitingMaxPct = new Set<number>();
const awaitingAmounts = new Set<number>();

function isAuthed(userId: number): boolean {
  return authed.has(userId);
}

function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Pools", "pools").text("Positions", "positions").row()
    .text("Withdraw", "withdraw").text("Swap", "swap").row()
    .text("Add LP", "addlp").text("Pool Info", "poolinfo").row()
    .text("Wallet", "walletinfo").text("Set Wallet", "setwallet");
}

function fmtAddr(addr: string, len = 6): string {
  return `${addr.slice(0, len)}…${addr.slice(-4)}`;
}

function txLink(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

bot.command("start", async (ctx) => {
  if (isAuthed(ctx.from!.id)) {
    await ctx.reply("Authenticated.", { reply_markup: mainMenu() });
    return;
  }
  awaitingPassword.add(ctx.from!.id);
  await ctx.reply("Enter password:");
});

bot.on("message:text", async (ctx) => {
  const uid = ctx.from!.id;
  if (awaitingPassword.has(uid)) {
    awaitingPassword.delete(uid);
    if (ctx.message.text === PASSWORD) {
      authed.add(uid);
      await ctx.reply("Access granted.", { reply_markup: mainMenu() });
    } else {
      await ctx.reply("Wrong. /start to try again.");
    }
    return;
  }
  if (awaitingWallet.has(uid)) {
    const result = setWalletKey(ctx.message.text.trim());
    awaitingWallet.delete(uid);
    try { await ctx.deleteMessage(); } catch {}
    if (result.ok) {
      const kp = getWallet();
      await ctx.reply(`Wallet: ${fmtAddr(kp!.publicKey.toBase58(), 8)}`, { reply_markup: mainMenu() });
    } else {
      await ctx.reply(result.error || "Invalid key.", { reply_markup: mainMenu() });
    }
    return;
  }
  if (awaitingPoolToken.has(uid)) {
    const tokenMint = ctx.message.text.trim();
    awaitingPoolToken.delete(uid);
    try { await ctx.deleteMessage(); } catch {}
    if (tokenMint.length < 32 || tokenMint.length > 44) {
      await ctx.reply("Invalid token address.", { reply_markup: mainMenu() });
      return;
    }
    try {
      const pools = await met.searchPoolsByToken(tokenMint);
      if (pools.length === 0) {
        await ctx.reply("No pools found for this token.", { reply_markup: mainMenu() });
        return;
      }
      const tokenSymbol = pools[0].token_x?.address === tokenMint ? pools[0].token_x?.symbol : pools[0].token_y?.symbol;
      const tokenName = pools[0].token_x?.address === tokenMint ? pools[0].token_x?.name : pools[0].token_y?.name;
      const totalTvl = pools.reduce((sum: number, p: any) => sum + (p.tvl || 0), 0);
      const totalVol24h = pools.reduce((sum: number, p: any) => sum + (p.volume?.["24h"] || 0), 0);
      const header = `CA: ${tokenMint}\nToken: ${tokenName} (${tokenSymbol})\nPools: ${pools.length}\nTotal TVL: $${totalTvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}\nVol 24h: $${totalVol24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n`;
      const body = met.formatPoolList(pools);
      const kb = new InlineKeyboard();
      for (let i = 0; i < pools.length; i++) {
        kb.text(`${i + 1}`, `pool:${pools[i].address}`).row();
      }
      kb.text("Back", "menu");
      await ctx.reply(header + "\n" + body, { reply_markup: kb, parse_mode: "Markdown" });
    } catch (e: any) {
      await ctx.reply(`Error: ${e.message}`, { reply_markup: mainMenu() });
    }
    return;
  }
  if (awaitingMinPct.has(uid)) {
    const val = parseFloat(ctx.message.text.trim());
    awaitingMinPct.delete(uid);
    if (isNaN(val)) { await ctx.reply("Invalid number."); return; }
    const state = addLPStates.get(uid);
    if (!state) { await ctx.reply("Session expired. Start over.", { reply_markup: mainMenu() }); return; }
    state.minPct = val;
    await ctx.reply(`Min range set: ${val}%\nRange: ${state.minPct}% to ${state.maxPct}%\nClick Refresh Chart to update image.`);
    return;
  }
  if (awaitingMaxPct.has(uid)) {
    const val = parseFloat(ctx.message.text.trim());
    awaitingMaxPct.delete(uid);
    if (isNaN(val)) { await ctx.reply("Invalid number."); return; }
    const state = addLPStates.get(uid);
    if (!state) { await ctx.reply("Session expired. Start over.", { reply_markup: mainMenu() }); return; }
    state.maxPct = val;
    await ctx.reply(`Max range set: ${val}%\nRange: ${state.minPct}% to ${state.maxPct}%\nClick Refresh Chart to update image.`);
    return;
  }
  if (awaitingAmounts.has(uid)) {
    const parts = ctx.message.text.trim().split(/\s+/);
    awaitingAmounts.delete(uid);
    if (parts.length < 2) { await ctx.reply("Send 2 numbers: amountX amountY"); return; }
    const amtX = parts[0];
    const amtY = parts[1];
    const state = addLPStates.get(uid);
    if (!state) { await ctx.reply("Session expired. Start over.", { reply_markup: mainMenu() }); return; }
    const kb = new InlineKeyboard()
      .text("Spot", `addlpexec:${state.poolAddr}:spot:${amtX}:${amtY}:${state.minPct}:${state.maxPct}`)
      .text("Curve", `addlpexec:${state.poolAddr}:curve:${amtX}:${amtY}:${state.minPct}:${state.maxPct}`).row()
      .text("Bid-Ask", `addlpexec:${state.poolAddr}:bidask:${amtX}:${amtY}:${state.minPct}:${state.maxPct}`)
      .text("Cancel", "menu");
    await ctx.reply(`Pool: ${state.poolName}\nAmount X: ${amtX}\nAmount Y: ${amtY}\nRange: ${state.minPct}% to ${state.maxPct}%\n\nSelect strategy:`, { reply_markup: kb });
    return;
  }
});

bot.callbackQuery("setwallet", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  awaitingWallet.add(ctx.from!.id);
  await ctx.editMessageText("Send private key. Message will be deleted after.");
});

bot.callbackQuery("walletinfo", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const wallet = getWallet();
  if (!wallet) {
    await ctx.editMessageText("No wallet set.", { reply_markup: new InlineKeyboard().text("Set Wallet", "setwallet").text("Back", "menu") });
    return;
  }
  try {
    const conn = getConnection();
    const solBalance = await conn.getBalance(wallet.publicKey) / 1e9;
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM });
    const tokens = tokenAccounts.value
      .filter((t: any) => t.account.data.parsed.info.tokenAmount.uiAmount > 0)
      .map((t: any) => {
        const info = t.account.data.parsed.info;
        return `${info.tokenAmount.uiAmount} ${fmtAddr(info.mint, 6)}`;
      });
    let msg = `Address: ${wallet.publicKey.toBase58()}\nSOL: ${solBalance.toFixed(4)}`;
    if (tokens.length > 0) msg += `\n\nTokens:\n${tokens.join("\n")}`;
    const kb = new InlineKeyboard().text("Back", "menu");
    await ctx.editMessageText(msg, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery("pools", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  try {
    const data: any = await met.searchPools("", 8);
    const pools = data?.data || data || [];
    if (!Array.isArray(pools) || pools.length === 0) {
      await ctx.editMessageText("No pools.", { reply_markup: mainMenu() });
      return;
    }
    const kb = new InlineKeyboard();
    for (const p of pools) {
      const addr = p.poolAddress || p.address || p.id;
      const name = p.name || p.pairName || fmtAddr(addr);
      kb.text(name, `pool:${addr}`).row();
    }
    kb.text("Back", "menu");
    await ctx.editMessageText("Top pools (24h volume):", { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^pool:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const addr = ctx.match![1];
  try {
    const pool: any = await met.getPool(addr);
    const activeBin = await met.getActiveBin(addr);
    const fees = await met.getPoolFees(addr);
    const kb = new InlineKeyboard()
      .text("Bins", `bins:${addr}`).text("Quote", `quote:${addr}`).row()
      .text("OHLCV", `ohlcv:${addr}`).text("Volume", `volume:${addr}`).row()
      .text("Add LP", `addlpchart:${addr}`).text("Swap", `swapdlmm:${addr}`).row()
      .text("Back", "pools");
    const msg = `Pool: ${pool?.name || fmtAddr(addr)}\nBin: ${activeBin.binId}\nPrice: ${activeBin.price}\nBase Fee: ${fees.baseFeePct}%\nDyn Fee: ${fees.dynamicFeePct}%`;
    await ctx.editMessageText(msg, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery("withdraw", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const wallet = getWallet();
  if (!wallet) {
    await ctx.editMessageText("No wallet. Use Set Wallet.", { reply_markup: mainMenu() });
    return;
  }
  try {
    const positions = await met.getUserPositions(wallet.publicKey.toBase58());
    if (positions.length === 0) {
      await ctx.editMessageText("No positions.", { reply_markup: mainMenu() });
      return;
    }
    const kb = new InlineKeyboard();
    for (const group of positions) {
      for (const pos of group.positions) {
        kb.text(`${fmtAddr(group.poolAddress)} [${pos.lowerBinId}-${pos.upperBinId}]`, `pos:${group.poolAddress}:${pos.address}`).row();
      }
    }
    kb.text("Back", "menu");
    await ctx.editMessageText("Select position to withdraw:", { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery("positions", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const wallet = getWallet();
  if (!wallet) {
    await ctx.editMessageText("No wallet. Use /setwallet", { reply_markup: mainMenu() });
    return;
  }
  try {
    const positions = await met.getUserPositions(wallet.publicKey.toBase58());
    if (positions.length === 0) {
      await ctx.editMessageText("No positions.", { reply_markup: mainMenu() });
      return;
    }
    const kb = new InlineKeyboard();
    for (const group of positions) {
      for (const pos of group.positions) {
        kb.text(`${fmtAddr(group.poolAddress)} [${pos.lowerBinId}-${pos.upperBinId}]`, `pos:${group.poolAddress}:${pos.address}`).row();
      }
    }
    kb.text("Back", "menu");
    await ctx.editMessageText("Positions:", { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^pos:(.+):(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const poolAddr = ctx.match![1];
  const posAddr = ctx.match![2];
  try {
    const detail = await met.getPositionDetail(poolAddr, posAddr);
    const kb = new InlineKeyboard()
      .text("Claim Fees", `claimfees:${poolAddr}:${posAddr}`)
      .text("Claim Rewards", `claimrewards:${poolAddr}:${posAddr}`).row()
      .text("Withdraw & Close", `wdclose:${poolAddr}:${posAddr}`)
      .text("Withdraw Only", `wdonly:${poolAddr}:${posAddr}`).row()
      .text("Back", "positions");
    const msg = `Position: ${fmtAddr(posAddr, 8)}\nPool: ${fmtAddr(poolAddr, 8)}\nBins: ${detail.lowerBinId} to ${detail.upperBinId}\nX: ${detail.totalXAmount}\nY: ${detail.totalYAmount}\nFee X: ${detail.feeX}\nFee Y: ${detail.feeY}`;
    await ctx.editMessageText(msg, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^claimfees:(.+):(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [poolAddr, posAddr] = [ctx.match![1], ctx.match![2]];
  try {
    await ctx.editMessageText("Claiming fees...");
    const sigs = await met.claimFees(poolAddr, posAddr);
    const kb = new InlineKeyboard().text("Back", "positions");
    await ctx.editMessageText(`Fees claimed.\n${sigs.map(s => txLink(s)).join("\n")}`, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^claimrewards:(.+):(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [poolAddr, posAddr] = [ctx.match![1], ctx.match![2]];
  try {
    await ctx.editMessageText("Claiming rewards...");
    const sigs = await met.claimAllRewards(poolAddr, posAddr);
    const kb = new InlineKeyboard().text("Back", "positions");
    await ctx.editMessageText(`Rewards claimed.\n${sigs.map(s => txLink(s)).join("\n")}`, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^wdclose:(.+):(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [poolAddr, posAddr] = [ctx.match![1], ctx.match![2]];
  const kb = new InlineKeyboard()
    .text("Confirm Close", `wdclose_exec:${poolAddr}:${posAddr}`)
    .text("Cancel", "menu");
  await ctx.editMessageText("This will:\n1. Remove all liquidity\n2. Claim fees + rewards\n3. Close position (reclaim SOL rent)\n\nConfirm?", { reply_markup: kb });
});

bot.callbackQuery(/^wdclose_exec:(.+):(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [poolAddr, posAddr] = [ctx.match![1], ctx.match![2]];
  try {
    await ctx.editMessageText("Withdrawing + closing...");
    const result = await met.removeLiquidity(poolAddr, posAddr, 10000, true);
    const kb = new InlineKeyboard().text("Swap to SOL", "swap").text("Menu", "menu");
    await ctx.editMessageText(
      `Withdraw + Close done.\n${result.sigs.map(s => txLink(s)).join("\n")}\n\nTokens in wallet. Swap to SOL when ready.`,
      { reply_markup: kb }
    );
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^wdonly:(.+):(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [poolAddr, posAddr] = [ctx.match![1], ctx.match![2]];
  const kb = new InlineKeyboard()
    .text("100%", `wdonly_exec:${poolAddr}:${posAddr}:10000`)
    .text("75%", `wdonly_exec:${poolAddr}:${posAddr}:7500`)
    .text("50%", `wdonly_exec:${poolAddr}:${posAddr}:5000`)
    .text("25%", `wdonly_exec:${poolAddr}:${posAddr}:2500`).row()
    .text("Cancel", "menu");
  await ctx.editMessageText("Select percentage:", { reply_markup: kb });
});

bot.callbackQuery(/^wdonly_exec:(.+):(.+):(\d+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [poolAddr, posAddr, bps] = [ctx.match![1], ctx.match![2], ctx.match![3]];
  try {
    const pct = parseInt(bps) / 100;
    await ctx.editMessageText(`Withdrawing ${pct}%...`);
    const result = await met.removeLiquidity(poolAddr, posAddr, parseInt(bps), false);
    const kb = new InlineKeyboard().text("Back", "positions");
    await ctx.editMessageText(`Withdrawn ${pct}%.\n${result.sigs.map(s => txLink(s)).join("\n")}`, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery("swap", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const wallet = getWallet();
  if (!wallet) {
    await ctx.editMessageText("No wallet. Use /setwallet", { reply_markup: mainMenu() });
    return;
  }
  try {
    const conn = getConnection();
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM });
    const tokens = tokenAccounts.value
      .filter((t: any) => t.account.data.parsed.info.tokenAmount.uiAmount > 0)
      .map((t: any) => ({ mint: t.account.data.parsed.info.mint, amount: t.account.data.parsed.info.tokenAmount.uiAmount, decimals: t.account.data.parsed.info.tokenAmount.decimals }));
    if (tokens.length === 0) {
      await ctx.editMessageText("No tokens.", { reply_markup: mainMenu() });
      return;
    }
    const kb = new InlineKeyboard();
    for (const t of tokens) {
      kb.text(`${fmtAddr(t.mint, 8)} (${t.amount})`, `swapquote:${t.mint}:${t.decimals}`).row();
    }
    kb.text("Back", "menu");
    await ctx.editMessageText("Select token to swap to SOL:", { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^swapquote:(.+):(\d+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [mint, decimals] = [ctx.match![1], ctx.match![2]];
  try {
    const conn = getConnection();
    const wallet = getWallet()!;
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM });
    const ta = tokenAccounts.value.find((t: any) => t.account.data.parsed.info.mint === mint);
    if (!ta) { await ctx.editMessageText("Token not found.", { reply_markup: mainMenu() }); return; }
    const rawAmount = ta.account.data.parsed.info.tokenAmount.amount;
    const order = await jup.getQuote(mint, SOL_MINT, rawAmount);
    const outAmount = order.outAmount ? (parseInt(order.outAmount) / 1e9).toFixed(4) : "?";
    const kb = new InlineKeyboard()
      .text("Execute", `swapexec:${mint}:${rawAmount}`)
      .text("Cancel", "menu");
    await ctx.editMessageText(`Quote:\nIn: ${fmtAddr(mint, 8)}\nOut: ~${outAmount} SOL\n\nExecute?`, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^swapexec:(.+):(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const [mint, amount] = [ctx.match![1], ctx.match![2]];
  try {
    await ctx.editMessageText("Swapping via Jupiter...");
    const result = await jup.swapToSol(mint, amount);
    const kb = new InlineKeyboard().text("Menu", "menu");
    if (result.status === "Success") {
      await ctx.editMessageText(`Swap done.\n${txLink(result.signature)}\nReceived: ${parseInt(result.outAmount) / 1e9} SOL`, { reply_markup: kb });
    } else {
      await ctx.editMessageText(`Swap failed: ${result.status}\n${txLink(result.signature)}`, { reply_markup: kb });
    }
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery("menu", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Menu:", { reply_markup: mainMenu() });
});

bot.callbackQuery("addlp", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  awaitingPoolToken.add(ctx.from!.id);
  await ctx.editMessageText("Send token contract address to add LP:");
});

bot.callbackQuery(/^addlpchart:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const poolAddr = ctx.match![1];
  const uid = ctx.from!.id;
  try {
    await ctx.editMessageText("Loading chart...");
    const pool: any = await met.getPool(poolAddr);
    const poolName = pool?.name || fmtAddr(poolAddr, 8);
    const binStep = pool?.pool_config?.bin_step || 1;
    const activePrice = pool?.current_price || 0;
    const activeBin = await met.getActiveBin(poolAddr);
    const rawBins = await met.getBinsAroundActive(poolAddr, 60, 60);
    const bins: BinData[] = (rawBins as any[]).map((b: any) => ({
      binId: b.binId,
      price: b.price,
      xAmount: parseFloat(b.xAmount) || 0,
      yAmount: parseFloat(b.yAmount) || 0,
    }));
    const ohlcvRaw = await met.getPoolOhlcv(poolAddr, "1H", 48);
    const ohlcv: OHLCV[] = ((ohlcvRaw as any)?.data || ohlcvRaw || []).map((c: any) => ({
      timestamp: c.timestamp || 0,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
    })).filter((c: OHLCV) => c.open != null);

    addLPStates.set(uid, {
      poolAddr, poolName, binStep,
      activeBinId: activeBin.binId,
      activePrice, bins, ohlcv,
      minPct: -20, maxPct: 20, timeframe: "1H",
    });

    const state = addLPStates.get(uid)!;
    const png = await renderChartPNG({
      poolName: state.poolName, binStep: state.binStep,
      activeBinId: state.activeBinId, activePrice: state.activePrice,
      bins: state.bins, ohlcv: state.ohlcv,
      minPct: state.minPct, maxPct: state.maxPct, timeframe: state.timeframe,
    });

    const kb = new InlineKeyboard()
      .text("Reset", "addlpreset").text("Refresh", "addlprefresh").text("Timeframe", "addlptimeframe").row()
      .text("Min Range", "addlpmin").text("Max Range", "addlpmax").text("Confirm", "addlpconfirm");

    await ctx.api.sendPhoto(ctx.chat!.id, new InputFile(png), {
      caption: `${state.poolName} ${state.binStep}/${pool?.pool_config?.base_fee_pct ?? "?"}\nActive: $${state.activePrice.toExponential(3)}\nRange: ${state.minPct}% to ${state.maxPct}%\nTimeframe: ${state.timeframe}`,
      reply_markup: kb,
    });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery("addlpreset", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const uid = ctx.from!.id;
  const state = addLPStates.get(uid);
  if (!state) return;
  state.minPct = -20;
  state.maxPct = 20;
  await ctx.editMessageCaption({ caption: `${state.poolName} ${state.binStep}\nActive: $${state.activePrice.toExponential(3)}\nRange: ${state.minPct}% to ${state.maxPct}%\nTimeframe: ${state.timeframe}` });
});

bot.callbackQuery("addlprefresh", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const uid = ctx.from!.id;
  const state = addLPStates.get(uid);
  if (!state) return;
  try {
    const png = await renderChartPNG({
      poolName: state.poolName, binStep: state.binStep,
      activeBinId: state.activeBinId, activePrice: state.activePrice,
      bins: state.bins, ohlcv: state.ohlcv,
      minPct: state.minPct, maxPct: state.maxPct, timeframe: state.timeframe,
    });
    const kb = new InlineKeyboard()
      .text("Reset", "addlpreset").text("Refresh", "addlprefresh").text("Timeframe", "addlptimeframe").row()
      .text("Min Range", "addlpmin").text("Max Range", "addlpmax").text("Confirm", "addlpconfirm");
    await ctx.editMessageMedia({ type: "photo", media: new InputFile(png), caption: `${state.poolName} ${state.binStep}\nActive: $${state.activePrice.toExponential(3)}\nRange: ${state.minPct}% to ${state.maxPct}%\nTimeframe: ${state.timeframe}` }, {
      reply_markup: kb,
    });
  } catch (e: any) {
    await ctx.answerCallbackQuery({ text: `Error: ${e.message}` });
  }
});

bot.callbackQuery("addlptimeframe", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("5m", "addlptf:5m").text("1H", "addlptf:1H").row()
    .text("4H", "addlptf:4H").text("1D", "addlptf:1D").row()
    .text("Back", "addlpchartback");
  await ctx.editMessageReplyMarkup({ reply_markup: kb });
});

bot.callbackQuery(/^addlptf:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const tf = ctx.match![1];
  const uid = ctx.from!.id;
  const state = addLPStates.get(uid);
  if (!state) return;
  state.timeframe = tf;
  const ohlcvRaw = await met.getPoolOhlcv(state.poolAddr, tf, 48);
  state.ohlcv = ((ohlcvRaw as any)?.data || ohlcvRaw || []).map((c: any) => ({
    timestamp: c.timestamp || 0,
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
  })).filter((c: OHLCV) => c.open != null);
  const png = await renderChartPNG({
    poolName: state.poolName, binStep: state.binStep,
    activeBinId: state.activeBinId, activePrice: state.activePrice,
    bins: state.bins, ohlcv: state.ohlcv,
    minPct: state.minPct, maxPct: state.maxPct, timeframe: state.timeframe,
  });
  const kb = new InlineKeyboard()
    .text("Reset", "addlpreset").text("Refresh", "addlprefresh").text("Timeframe", "addlptimeframe").row()
    .text("Min Range", "addlpmin").text("Max Range", "addlpmax").text("Confirm", "addlpconfirm");
  await ctx.editMessageMedia({ type: "photo", media: new InputFile(png), caption: `${state.poolName} ${state.binStep}\nActive: $${state.activePrice.toExponential(3)}\nRange: ${state.minPct}% to ${state.maxPct}%\nTimeframe: ${state.timeframe}` }, {
    reply_markup: kb,
  });
});

bot.callbackQuery("addlpchartback", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const uid = ctx.from!.id;
  const state = addLPStates.get(uid);
  if (!state) return;
  const kb = new InlineKeyboard()
    .text("Reset", "addlpreset").text("Refresh", "addlprefresh").text("Timeframe", "addlptimeframe").row()
    .text("Min Range", "addlpmin").text("Max Range", "addlpmax").text("Confirm", "addlpconfirm");
  await ctx.editMessageReplyMarkup({ reply_markup: kb });
});

bot.callbackQuery("addlpmin", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  awaitingMinPct.add(ctx.from!.id);
  await ctx.reply("Send min % (e.g. -20, -15.5):");
});

bot.callbackQuery("addlpmax", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  awaitingMaxPct.add(ctx.from!.id);
  await ctx.reply("Send max % (e.g. 20, 50.5):");
});

bot.callbackQuery("addlpconfirm", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const uid = ctx.from!.id;
  const state = addLPStates.get(uid);
  if (!state) return;
  awaitingAmounts.add(uid);
  await ctx.reply(`Pool: ${state.poolName}\nRange: ${state.minPct}% to ${state.maxPct}%\n\nSend amount X and Y (e.g. 0.5 100):`);
});

bot.callbackQuery("poolinfo", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  awaitingPoolToken.add(ctx.from!.id);
  await ctx.editMessageText("Send token contract address:");
});

bot.callbackQuery(/^bins:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const addr = ctx.match![1];
  try {
    const bins = await met.getBinsAroundActive(addr, 5, 5);
    const kb = new InlineKeyboard().text("Back", `pool:${addr}`);
    const text = bins.slice(0, 10).map((b: any) => `Bin ${b.binId}: ${b.price} | X:${b.xAmount} Y:${b.yAmount}`).join("\n");
    await ctx.editMessageText(`Bins:\n${text}`, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^ohlcv:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const addr = ctx.match![1];
  try {
    const ohlcv = await met.getPoolOhlcv(addr, "1H", 24);
    const kb = new InlineKeyboard().text("Back", `pool:${addr}`);
    await ctx.editMessageText(`OHLCV (24h):\n${JSON.stringify(ohlcv, null, 2).slice(0, 4000)}`, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^volume:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const addr = ctx.match![1];
  try {
    const vol = await met.getPoolVolume(addr);
    const kb = new InlineKeyboard().text("Back", `pool:${addr}`);
    await ctx.editMessageText(`Volume:\n${JSON.stringify(vol, null, 2).slice(0, 4000)}`, { reply_markup: kb });
  } catch (e: any) {
    await ctx.editMessageText(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery(/^addliq:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Use /addliq <pool> <amtX> <amtY> <minBin> <maxBin>", { reply_markup: mainMenu() });
});

bot.callbackQuery(/^swapdlmm:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Use /swap <pool> <inToken> <amount> <minOut>", { reply_markup: mainMenu() });
});

bot.callbackQuery(/^quote:(.+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Use /quote <pool> <inToken> <amount>", { reply_markup: mainMenu() });
});

bot.command("addliq", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  const args = ctx.match?.split(" ") || [];
  if (args.length < 5) { await ctx.reply("Usage: /addliq <pool> <amtX> <amtY> <minBin> <maxBin>"); return; }
  try {
    const result = await met.addLiquidity(args[0], args[1], args[2], parseInt(args[3]), parseInt(args[4]));
    await ctx.reply(`Liquidity added.\nPosition: ${result.positionAddress}\n${txLink(result.sig)}`);
  } catch (e: any) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

bot.command("swap", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  const args = ctx.match?.split(" ") || [];
  if (args.length < 4) { await ctx.reply("Usage: /swap <pool> <inToken> <amount> <minOut>"); return; }
  try {
    const sig = await met.dlmmSwap(args[0], args[1], args[2], args[3]);
    await ctx.reply(`Swap done.\n${txLink(sig)}`);
  } catch (e: any) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

bot.command("quote", async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  const args = ctx.match?.split(" ") || [];
  if (args.length < 3) { await ctx.reply("Usage: /quote <pool> <inToken> <amount>"); return; }
  try {
    const q = await met.getSwapQuote(args[0], args[1], args[2]);
    await ctx.reply(`In: ${q.inAmount}\nOut: ${q.outAmount}\nFee: ${q.feeBps} bps\nParts: ${q.parts}`);
  } catch (e: any) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

bot.callbackQuery(/^addlpexec:(.+):(.+):(.+):(.+):(-?[\d.]+):(-?[\d.]+)$/, async (ctx) => {
  if (!isAuthed(ctx.from!.id)) return;
  await ctx.answerCallbackQuery();
  const poolAddr = ctx.match![1];
  const strategy = ctx.match![2];
  const amtX = ctx.match![3];
  const amtY = ctx.match![4];
  const minPct = parseFloat(ctx.match![5]);
  const maxPct = parseFloat(ctx.match![6]);
  const strategyMap: Record<string, number> = { spot: 0, curve: 1, bidask: 2 };
  const strategyType = strategyMap[strategy] ?? 0;
  try {
    await ctx.reply("Adding liquidity...");
    const result = await met.addLiquidity(poolAddr, amtX, amtY, Math.round(minPct * 100), Math.round(maxPct * 100));
    await ctx.reply(`Liquidity added.\nPosition: ${result.positionAddress}\n${txLink(result.sig)}`, { reply_markup: mainMenu() });
    addLPStates.delete(ctx.from!.id);
  } catch (e: any) {
    await ctx.reply(`Error: ${e.message}`, { reply_markup: mainMenu() });
  }
});

bot.catch((err) => console.error("Bot error:", err.error));
bot.start({ onStart: () => console.log("Bot started") });
