import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";

const ENV_PATH = path.resolve(__dirname, "..", ".env");

export function loadKeypair(pk: string): Keypair | null {
  if (!pk) return null;
  try { return Keypair.fromSecretKey(new Uint8Array(JSON.parse(pk))); } catch {}
  try { return Keypair.fromSecretKey(bs58.decode(pk)); } catch {}
  try { return Keypair.fromSecretKey(Buffer.from(pk, "base64")); } catch {}
  return null;
}

export function getWallet(): Keypair | null {
  const pk = process.env.WALLET_PRIVATE_KEY || "";
  return loadKeypair(pk);
}

export function setWalletKey(pk: string): { ok: boolean; error?: string } {
  const kp = loadKeypair(pk);
  if (!kp) return { ok: false, error: "Invalid private key format (tried JSON, base58, base64)" };
  let env = "";
  if (fs.existsSync(ENV_PATH)) env = fs.readFileSync(ENV_PATH, "utf8");
  const lines = env.split("\n").filter(l => l && !l.startsWith("WALLET_PRIVATE_KEY="));
  lines.push(`WALLET_PRIVATE_KEY=${pk}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n");
  process.env.WALLET_PRIVATE_KEY = pk;
  return { ok: true };
}

export function getConnection(): Connection {
  const rpc = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpc, { commitment: "confirmed" });
}
