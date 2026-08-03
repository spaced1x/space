import { z } from "zod";

// Only permanent secrets and immutable runtime facts belong here. Every
// operational setting (buffers, windows, sizes, order modes) lives in the
// SPACE database and is edited from the Operations Desk.
const optionalSecret = z.string().trim().min(1).optional();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SPACE_ENVIRONMENT: z.enum(["V1_TESTNET", "V2_MAINNET"]).default("V1_TESTNET"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  DB_PATH: z.string().trim().min(1).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_DIR: z.string().trim().min(1).default("./logs"),
  LOG_MAX_BYTES: z.coerce.number().int().min(64_000).default(10_000_000),
  LOG_MAX_FILES: z.coerce.number().int().min(1).max(50).default(5),

  // Venue + chain credentials. Absent in authoring environments; required on
  // the VPS before the engine may leave OBSERVE.
  POLYMARKET_API_KEY: optionalSecret,
  POLYMARKET_API_SECRET: optionalSecret,
  POLYMARKET_API_PASSPHRASE: optionalSecret,
  /** Proxy/funder wallet that holds the collateral. Defaults to WALLET_ADDRESS. */
  POLYMARKET_FUNDER_ADDRESS: optionalSecret,
  /** Venue host. V1 uses the staging CLOB, V2 the production CLOB. */
  POLYMARKET_CLOB_URL: optionalSecret,
  /** 0 = EOA, 1 = email/magic proxy, 2 = browser wallet proxy. */
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).default(0),
  WALLET_PRIVATE_KEY: optionalSecret,
  WALLET_ADDRESS: optionalSecret,
  POLYGON_RPC_URL: optionalSecret,
  BINANCE_WS_URL: z.string().trim().url().default("wss://stream.binance.com:9443/ws"),
  BINANCE_SYMBOL: z.string().trim().min(3).default("BTCUSDT"),

  // Chainlink BTC/USD aggregator on Polygon, read through POLYGON_RPC_URL.
  CHAINLINK_BTC_USD_FEED: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0xc907E116054Ad103354f2D350FD2514433D57F6f"),

  // Settlement TWAP providers. The active provider is chosen by the provider
  // registry and persisted in the database; these are transport credentials
  // only. Nothing about the RTDS protocol is compiled in.
  RTDS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  RTDS_WS_URL: optionalSecret,
  RTDS_API_KEY: optionalSecret,
  RTDS_API_SECRET: optionalSecret,
  /** Channel name, or a full subscription payload when it is valid JSON. */
  RTDS_CHANNEL: optionalSecret,
  RTDS_SYMBOL: z.string().trim().min(1).default("BTC"),
  RTDS_AUTH_TYPE: z.enum(["none", "api_key", "bearer", "hmac", "query"]).default("none"),

  CHAINLINK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CHAINLINK_API_KEY: optionalSecret,
  CHAINLINK_API_SECRET: optionalSecret,
  CHAINLINK_STREAM_ID: optionalSecret,
  CHAINLINK_WS_URL: optionalSecret,
  CHAINLINK_HTTP_URL: optionalSecret,

  // Polymarket public metadata API used for market discovery.
  POLYMARKET_GAMMA_URL: z.string().trim().url().default("https://gamma-api.polymarket.com"),

  TELEGRAM_BOT_TOKEN: optionalSecret,
  TELEGRAM_CHAT_ID: optionalSecret,
});

export type SpaceEnv = z.infer<typeof envSchema>;

// Secrets that must exist before ARMED is reachable on a production host.
// v1.0 relies on external VPS access control; no operator password is kept in
// the application. The dashboard and Telegram commands are reachable from the
// operator's trusted network only.
export const ARMED_REQUIRED_KEYS = [
  "POLYMARKET_API_KEY",
  "POLYMARKET_API_SECRET",
  "POLYMARKET_API_PASSPHRASE",
  "WALLET_PRIVATE_KEY",
  "WALLET_ADDRESS",
  "POLYGON_RPC_URL",
] as const satisfies readonly (keyof SpaceEnv)[];
