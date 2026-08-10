import { VersionedTransaction } from "@solana/web3.js";
import { getConnection, getWallet } from "./wallet";

const JUP_API = "https://api.jup.ag/swap/v2";

export async function getQuote(inputMint: string, outputMint: string, amount: string): Promise<any> {
  const wallet = getWallet();
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    taker: wallet?.publicKey.toBase58() || "",
  });
  const res = await fetch(`${JUP_API}/order?${params}`);
  if (!res.ok) throw new Error(`Jupiter /order failed: ${res.status} ${await res.text()}`);
  const order = await res.json();
  return order;
}

export async function executeSwap(order: any): Promise<{ signature: string; status: string; outAmount: string }> {
  const wallet = getWallet();
  if (!wallet) throw new Error("Wallet not set");
  if (!order.transaction) throw new Error("No transaction in order response");

  const txBuf = Buffer.from(order.transaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);
  const signedB64 = Buffer.from(tx.serialize()).toString("base64");

  const res = await fetch(`${JUP_API}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTransaction: signedB64, requestId: order.requestId }),
  });
  if (!res.ok) throw new Error(`Jupiter /execute failed: ${res.status} ${await res.text()}`);
  const result: any = await res.json();
  return {
    signature: result.signature,
    status: result.status,
    outAmount: result.totalOutputAmount || result.outputAmountResult || "0",
  };
}

export async function swapToSol(inputMint: string, amount: string): Promise<{ signature: string; status: string; outAmount: string }> {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const order = await getQuote(inputMint, SOL_MINT, amount);
  return executeSwap(order);
}
