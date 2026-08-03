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
  /**
   * Venue host. Polymarket documents exactly one CLOB host; there is no
   * official staging/testnet host. V1 uses it read-only, V2 for live trading.
   */
  POLYMARKET_CLOB_URL: z.string().trim().url().default("https://clob.polymarket.com"),
  /** Documented CLOB market data WebSocket (public, no credentials). */
  POLYMARKET_CLOB_WS_URL: z
    .string()
    .trim()
    .url()
    .default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  /** The docs require a text `PING` frame every 10 seconds on this socket. */
  POLYMARKET_CLOB_WS_PING_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /** No book update within this window marks the CLOB feed STALE. */
  POLYMARKET_CLOB_WS_STALE_MS: z.coerce.number().int().min(2_000).default(20_000),
  /** 0 = EOA, 1 = email/magic proxy, 2 = browser wallet proxy. */
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).default(0),
  WALLET_PRIVATE_KEY: optionalSecret,
  WALLET_ADDRESS: optionalSecret,
  POLYGON_RPC_URL: optionalSecret,
  BINANCE_WS_URL: z.string().trim().url().default("wss://stream.binance.com:9443/ws"),
  BINANCE_SYMBOL: z.string().trim().min(3).default("BTCUSDT"),
  /** No trade message within this window marks the Binance feed STALE. */
  BINANCE_STALE_MS: z.coerce.number().int().min(2_000).default(15_000),

  /** Shared reconnect budget for every venue WebSocket before it reports FAILED. */
  WS_MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(12),
  WS_MAX_BACKOFF_MS: z.coerce.number().int().min(1_000).default(30_000),

  // Chainlink BTC/USD aggregator on Polygon, read through POLYGON_RPC_URL.
  CHAINLINK_BTC_USD_FEED: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0xc907E116054Ad103354f2D350FD2514433D57F6f"),

  // Settlement TWAP providers. The active provider is chosen by the provider
  // registry and persisted in the database; these are transport settings only.
  // Polymarket RTDS is a public, unauthenticated stream — it takes no
  // credentials of any kind.
  RTDS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  RTDS_WS_URL: z.string().trim().url().default("wss://ws-live-data.polymarket.com"),
  /** The docs require a text `PING` frame every 5 seconds on this socket. */
  RTDS_PING_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  RTDS_STALE_MS: z.coerce.number().int().min(2_000).default(20_000),
  /** Documented RTDS symbol filter for the crypto price topics. */
  RTDS_SYMBOL: z.string().trim().min(1).default("btc/usd"),
  RTDS_TWAP_30_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  RTDS_TWAP_30_TOPIC: z.string().trim().min(1).default("crypto_prices_twap_thirty"),
  RTDS_TWAP_60_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  RTDS_TWAP_60_TOPIC: z.string().trim().min(1).default("crypto_prices_twap_sixty"),

  // Chainlink Data Streams (third provider). Disabled until credentials exist.
  CHAINLINK_STREAMS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CHAINLINK_STREAMS_WS_URL: z.string().trim().url().default("wss://ws.dataengine.chain.link"),
  CHAINLINK_STREAMS_HTTP_URL: z.string().trim().url().default("https://api.dataengine.chain.link"),
  CHAINLINK_STREAMS_FEED_ID: optionalSecret,
  CHAINLINK_STREAMS_API_KEY: optionalSecret,
  CHAINLINK_STREAMS_API_SECRET: optionalSecret,

  // Polymarket public metadata API used for market discovery.
  POLYMARKET_GAMMA_URL: z.string().trim().url().default("https://gamma-api.polymarket.com"),
  /** Consecutive Gamma failures before the circuit breaker opens. */
  GAMMA_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  /** How long the breaker stays open before a recovery probe. */
  GAMMA_RECOVERY_MS: z.coerce.number().int().min(1_000).default(60_000),

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
