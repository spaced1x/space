import { envSchema } from "./env.schema";

// The single description of SPACE's environment contract.
//
// `.env.example`, the startup validation report and the Diagnostics workspace
// are all generated from this table, so the three can never drift apart. A
// test asserts the table covers exactly the keys the Zod schema declares —
// adding a variable to the schema without describing it here fails the build.

export type EnvGroup =
  | "Runtime"
  | "Storage"
  | "Logging"
  | "Polymarket CLOB"
  | "Wallet / chain"
  | "Market data"
  | "Settlement TWAP"
  | "Telegram";

export interface EnvVariable {
  name: string;
  group: EnvGroup;
  /** True when the value is a credential and must never be printed. */
  secret: boolean;
  /** True when ARM is blocked until the value is present. */
  requiredForArmed: boolean;
  description: string;
  /** Literal placed in `.env.example`. Empty means "operator must supply". */
  example: string;
}

const V: readonly EnvVariable[] = [
  [
    "NODE_ENV",
    "Runtime",
    false,
    false,
    "Node execution mode. Always `production` on the VPS.",
    "production",
  ],
  [
    "SPACE_ENVIRONMENT",
    "Runtime",
    false,
    false,
    "V1_TESTNET runs the paper venue, V2_MAINNET trades live. Same code, different credentials and database file.",
    "V1_TESTNET",
  ],
  ["PORT", "Runtime", false, false, "HTTP port for the dashboard and the runtime API.", "8080"],
  [
    "DB_PATH",
    "Storage",
    false,
    false,
    "Override for the SQLite file. Leave unset: SPACE then uses ./data/space-v1.db and ./data/space-v2.db so the two environments can never share state. Setting it pins this process to one database and blocks environment switching.",
    "",
  ],
  ["LOG_LEVEL", "Logging", false, false, "debug | info | warn | error.", "info"],
  ["LOG_DIR", "Logging", false, false, "Directory for rotating structured JSON logs.", "./logs"],
  [
    "LOG_MAX_BYTES",
    "Logging",
    false,
    false,
    "Rotate the active log file once it exceeds this size.",
    "10000000",
  ],
  ["LOG_MAX_FILES", "Logging", false, false, "How many rotated log files to retain.", "5"],
  [
    "POLYMARKET_API_KEY",
    "Polymarket CLOB",
    true,
    true,
    "CLOB API key. Absent keeps the engine in READY.",
    "",
  ],
  ["POLYMARKET_API_SECRET", "Polymarket CLOB", true, true, "CLOB API secret.", ""],
  ["POLYMARKET_API_PASSPHRASE", "Polymarket CLOB", true, true, "CLOB API passphrase.", ""],
  [
    "POLYMARKET_FUNDER_ADDRESS",
    "Polymarket CLOB",
    false,
    false,
    "Proxy/safe address holding the collateral. Defaults to WALLET_ADDRESS.",
    "",
  ],
  [
    "POLYMARKET_CLOB_URL",
    "Polymarket CLOB",
    false,
    false,
    "The one documented CLOB host. Polymarket publishes no staging host: V1 reads it, V2 trades on it.",
    "https://clob.polymarket.com",
  ],
  [
    "POLYMARKET_CLOB_WS_URL",
    "Polymarket CLOB",
    false,
    false,
    "Public CLOB market-data WebSocket. No credentials.",
    "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  ],
  [
    "POLYMARKET_CLOB_WS_PING_MS",
    "Polymarket CLOB",
    false,
    false,
    "Documented text PING cadence for the CLOB socket.",
    "10000",
  ],
  [
    "POLYMARKET_CLOB_WS_STALE_MS",
    "Polymarket CLOB",
    false,
    false,
    "No book update within this window marks the CLOB feed STALE.",
    "20000",
  ],
  [
    "POLYMARKET_SIGNATURE_TYPE",
    "Polymarket CLOB",
    false,
    false,
    "0 = EOA, 1 = email/magic proxy, 2 = browser wallet proxy.",
    "0",
  ],
  [
    "WALLET_PRIVATE_KEY",
    "Wallet / chain",
    true,
    true,
    "Signing key. Never logged, never returned by any API.",
    "",
  ],
  [
    "WALLET_ADDRESS",
    "Wallet / chain",
    false,
    true,
    "Address derived from the signing key; verified against the environment.",
    "",
  ],
  [
    "POLYGON_RPC_URL",
    "Wallet / chain",
    true,
    true,
    "Polygon JSON-RPC endpoint. Often carries a provider key, so it is treated as a secret.",
    "",
  ],
  [
    "BINANCE_WS_URL",
    "Market data",
    false,
    false,
    "Display/diagnostics price feed. Never a settlement source.",
    "wss://stream.binance.com:9443/ws",
  ],
  [
    "BINANCE_SYMBOL",
    "Market data",
    false,
    false,
    "Symbol for the Binance stream; lower-cased automatically.",
    "BTCUSDT",
  ],
  [
    "BINANCE_STALE_MS",
    "Market data",
    false,
    false,
    "No trade message within this window marks the Binance feed STALE.",
    "15000",
  ],
  [
    "WS_MAX_RECONNECT_ATTEMPTS",
    "Market data",
    false,
    false,
    "Shared reconnect budget for every venue WebSocket before it reports FAILED.",
    "12",
  ],
  [
    "WS_MAX_BACKOFF_MS",
    "Market data",
    false,
    false,
    "Upper bound on the exponential reconnect backoff.",
    "30000",
  ],
  [
    "CHAINLINK_BTC_USD_FEED",
    "Market data",
    false,
    false,
    "Chainlink BTC/USD aggregator on Polygon, read through POLYGON_RPC_URL.",
    "0xc907E116054Ad103354f2D350FD2514433D57F6f",
  ],
  [
    "POLYMARKET_GAMMA_URL",
    "Market data",
    false,
    false,
    "Public Polymarket metadata API used for market discovery.",
    "https://gamma-api.polymarket.com",
  ],
  [
    "GAMMA_FAILURE_THRESHOLD",
    "Market data",
    false,
    false,
    "Consecutive Gamma failures before the circuit breaker opens.",
    "5",
  ],
  [
    "GAMMA_RECOVERY_MS",
    "Market data",
    false,
    false,
    "How long the Gamma breaker stays open before a recovery probe.",
    "60000",
  ],
  [
    "RTDS_ENABLED",
    "Settlement TWAP",
    false,
    false,
    "Enables the Polymarket RTDS settlement providers.",
    "true",
  ],
  [
    "RTDS_WS_URL",
    "Settlement TWAP",
    false,
    false,
    "Official public RTDS endpoint. No API key, no auth frame.",
    "wss://ws-live-data.polymarket.com",
  ],
  [
    "RTDS_PING_MS",
    "Settlement TWAP",
    false,
    false,
    "Documented text PING cadence for the RTDS socket.",
    "5000",
  ],
  [
    "RTDS_STALE_MS",
    "Settlement TWAP",
    false,
    false,
    "No RTDS message within this window marks the provider STALE.",
    "20000",
  ],
  [
    "RTDS_SYMBOL",
    "Settlement TWAP",
    false,
    false,
    "Documented symbol filter, sent as a single lowercase pair.",
    "btc/usd",
  ],
  [
    "RTDS_TWAP_30_ENABLED",
    "Settlement TWAP",
    false,
    false,
    "Registers the 30-second RTDS TWAP provider.",
    "true",
  ],
  [
    "RTDS_TWAP_30_TOPIC",
    "Settlement TWAP",
    false,
    false,
    "RTDS topic carrying the 30-second TWAP.",
    "crypto_prices_twap_thirty",
  ],
  [
    "RTDS_TWAP_60_ENABLED",
    "Settlement TWAP",
    false,
    false,
    "Registers the 60-second RTDS TWAP provider.",
    "true",
  ],
  [
    "RTDS_TWAP_60_TOPIC",
    "Settlement TWAP",
    false,
    false,
    "RTDS topic carrying the 60-second TWAP.",
    "crypto_prices_twap_sixty",
  ],
  [
    "CHAINLINK_STREAMS_ENABLED",
    "Settlement TWAP",
    false,
    false,
    "Second settlement provider. Registered and observable, awaiting credentials.",
    "false",
  ],
  [
    "CHAINLINK_STREAMS_WS_URL",
    "Settlement TWAP",
    false,
    false,
    "Chainlink Data Streams WebSocket host.",
    "wss://ws.dataengine.chain.link",
  ],
  [
    "CHAINLINK_STREAMS_HTTP_URL",
    "Settlement TWAP",
    false,
    false,
    "Chainlink Data Streams REST host.",
    "https://api.dataengine.chain.link",
  ],
  [
    "CHAINLINK_STREAMS_FEED_ID",
    "Settlement TWAP",
    true,
    false,
    "Chainlink Data Streams feed identifier.",
    "",
  ],
  [
    "CHAINLINK_STREAMS_API_KEY",
    "Settlement TWAP",
    true,
    false,
    "Chainlink Data Streams API key.",
    "",
  ],
  [
    "CHAINLINK_STREAMS_API_SECRET",
    "Settlement TWAP",
    true,
    false,
    "Chainlink Data Streams API secret.",
    "",
  ],
  [
    "TELEGRAM_BOT_TOKEN",
    "Telegram",
    true,
    false,
    "Operator interface bot token. Absence degrades, never blocks.",
    "",
  ],
  [
    "TELEGRAM_CHAT_ID",
    "Telegram",
    true,
    false,
    "The only chat SPACE will talk to. Commands from any other chat are rejected.",
    "",
  ],
].map(([name, group, secret, requiredForArmed, description, example]) => ({
  name: name as string,
  group: group as EnvGroup,
  secret: secret as boolean,
  requiredForArmed: requiredForArmed as boolean,
  description: description as string,
  example: example as string,
}));

export const ENVIRONMENT_MANIFEST: readonly EnvVariable[] = V;

export const MANIFEST_GROUPS: readonly EnvGroup[] = [
  "Runtime",
  "Storage",
  "Logging",
  "Polymarket CLOB",
  "Wallet / chain",
  "Market data",
  "Settlement TWAP",
  "Telegram",
];

/** Every variable name the Zod schema declares. */
export function schemaKeys(): string[] {
  return Object.keys(envSchema.shape).sort();
}

export function manifestKeys(): string[] {
  return ENVIRONMENT_MANIFEST.map((entry) => entry.name).sort();
}

export function secretKeys(): string[] {
  return ENVIRONMENT_MANIFEST.filter((entry) => entry.secret).map((entry) => entry.name);
}

// Only SPACE-shaped names are reported as unknown; a VPS environment is full
// of unrelated variables and flagging those would make the report useless.
const SPACE_PREFIXES = [
  "SPACE_",
  "POLYMARKET_",
  "RTDS_",
  "CHAINLINK_",
  "TELEGRAM_",
  "WALLET_",
  "BINANCE_",
  "GAMMA_",
  "WS_",
  "LOG_",
  "DB_",
  "POLYGON_",
];

/** Keys present in the process environment that SPACE does not understand. */
export function unknownEnvKeys(source: Record<string, string | undefined>): string[] {
  const known = new Set(manifestKeys());
  return Object.keys(source)
    .filter((key) => SPACE_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .filter((key) => !known.has(key))
    .sort();
}

/** Renders the canonical `.env.example`. The file is generated, never edited. */
export function renderEnvExample(): string {
  const lines: string[] = [
    "# ─────────────────────────────────────────────────────────────────────────────",
    "# SPACE — environment contract",
    "#",
    "# GENERATED FILE. Do not edit by hand: run `bun run env:example`.",
    "# The source of truth is src/core/config/manifest.ts, which is verified",
    "# against the Zod schema by tests/unit/env-manifest.test.ts.",
    "#",
    "# Only permanent secrets and immutable runtime facts live here. Every",
    "# operational setting (execution windows, buffers, trade sizes, max positions,",
    "# retries, order modes) is configured inside SPACE from the Operations Desk",
    "# and stored in the database.",
    "# ─────────────────────────────────────────────────────────────────────────────",
  ];

  for (const group of MANIFEST_GROUPS) {
    const entries = ENVIRONMENT_MANIFEST.filter((entry) => entry.group === group);
    if (entries.length === 0) continue;
    lines.push("", `# ${group}`);
    for (const entry of entries) {
      for (const line of wrap(entry.description)) lines.push(`# ${line}`);
      const flags: string[] = [];
      if (entry.secret) flags.push("secret");
      if (entry.requiredForArmed) flags.push("required before ARM");
      if (flags.length) lines.push(`# (${flags.join(", ")})`);
      lines.push(`${entry.name}=${entry.example}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function wrap(text: string, width = 76): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}
