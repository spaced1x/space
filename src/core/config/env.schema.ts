import { z } from "zod";

// Only permanent secrets and immutable runtime facts belong here. Every
// operational setting (buffers, windows, sizes, order modes) lives in the
// SPACE database and is edited from the Operations Desk.
const optionalSecret = z.string().trim().min(1).optional();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SPACE_ENVIRONMENT: z.enum(["V1_TESTNET", "V2_MAINNET"]).default("V1_TESTNET"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  DB_PATH: z.string().trim().min(1).default("./data/space.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_DIR: z.string().trim().min(1).default("./logs"),
  LOG_MAX_BYTES: z.coerce.number().int().min(64_000).default(10_000_000),
  LOG_MAX_FILES: z.coerce.number().int().min(1).max(50).default(5),

  // Single-operator auth (specification §17). Argon2id hash, never a password.
  OPERATOR_PASSWORD_HASH: optionalSecret,
  SESSION_SECRET: optionalSecret,

  // Venue + chain credentials. Absent in authoring environments; required on
  // the VPS before the engine may leave OBSERVE.
  POLYMARKET_API_KEY: optionalSecret,
  POLYMARKET_API_SECRET: optionalSecret,
  POLYMARKET_API_PASSPHRASE: optionalSecret,
  WALLET_PRIVATE_KEY: optionalSecret,
  WALLET_ADDRESS: optionalSecret,
  POLYGON_RPC_URL: optionalSecret,
  BINANCE_WS_URL: z.string().trim().url().default("wss://stream.binance.com:9443/ws"),

  TELEGRAM_BOT_TOKEN: optionalSecret,
  TELEGRAM_CHAT_ID: optionalSecret,
});

export type SpaceEnv = z.infer<typeof envSchema>;

// Secrets that must exist before ARMED is reachable on a production host.
export const ARMED_REQUIRED_KEYS = [
  "OPERATOR_PASSWORD_HASH",
  "SESSION_SECRET",
  "POLYMARKET_API_KEY",
  "POLYMARKET_API_SECRET",
  "POLYMARKET_API_PASSPHRASE",
  "WALLET_PRIVATE_KEY",
  "WALLET_ADDRESS",
  "POLYGON_RPC_URL",
] as const satisfies readonly (keyof SpaceEnv)[];
