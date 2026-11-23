#!/usr/bin/env node
/**
 * BountyForge MCP Server & CLI Companion (zero external npm dependencies)
 *
 * Bridges AI agents (Claude, Gemini, Cursor, MCP clients) to the live
 * BountyForge Gno.land realm over ABCI JSON-RPC (`vm/qrender` & `vm/qeval`),
 * parses structured on-chain JSON views, simulates dust-free BPS splits, and
 * builds validated, shell-safe unsigned `gnokey maketx call` commands without
 * ever touching or storing private keys.
 *
 * Usage:
 *   node mcp/bountyforge-mcp.mjs                     # Run stdio JSON-RPC 2.0 MCP server
 *   node mcp/bountyforge-mcp.mjs --cli render ""     # One-shot ABCI qrender query
 *   node mcp/bountyforge-mcp.mjs --cli stats         # Structured ProtocolJSON() query
 *   node mcp/bountyforge-mcp.mjs --cli list OPEN     # Structured ListBountiesJSON() query
 *   node mcp/bountyforge-mcp.mjs --cli eval "BountyCount()"
 *   node mcp/bountyforge-mcp.mjs --cli cmd create    # Print gnokey transaction template
 *   node mcp/bountyforge-mcp.mjs --self-test         # Comprehensive protocol & security tests
 */

import readline from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_RPC = process.env.BOUNTYFORGE_RPC || "https://rpc.onyx.testnets.gno.land:443";
export const DEFAULT_CHAIN_ID = process.env.BOUNTYFORGE_CHAIN_ID || "onyx-1";
export const DEFAULT_REALM =
  process.env.BOUNTYFORGE_REALM || "gno.land/r/g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac/bountyforge";

const TOTAL_BPS = 10000n;
const MIN_REWARD_UGNOT = 1000n;
const ALLOWED_STATUSES = new Set(["", "OPEN", "PAID", "DISPUTED", "CANCELLED"]);

// ---------------------------------------------------------------------------
// Strict Input Validation & Shell-Safe Quoting
// ---------------------------------------------------------------------------

export function assertValidRpcUrl(rpc) {
  let parsed;
  try {
    parsed = new URL(String(rpc || ""));
  } catch {
    throw new Error(`Invalid RPC URL: ${rpc}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported RPC scheme "${parsed.protocol}" (only http/https allowed)`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function assertValidRealmPath(realm) {
  const s = String(realm || "").trim();
  if (!/^[a-zA-Z0-9.-]+\/r\/[a-zA-Z0-9_/-]{1,180}$/.test(s) || s.includes("..")) {
    throw new Error(`Invalid Gno realm path: ${s}`);
  }
  return s;
}

export function assertValidKeyName(keyName) {
  const s = String(keyName ?? "").trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(s)) {
    throw new Error(`Invalid keyName "${s}" (allowed: 1-64 chars of [a-zA-Z0-9_.-])`);
  }
  return s;
}

export function assertValidChainId(chainId) {
  const s = String(chainId ?? "").trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(s)) {
    throw new Error(`Invalid chainId "${s}"`);
  }
  return s;
}

export function assertValidGnoAddress(addr, { allowEmpty = false } = {}) {
  const s = String(addr ?? "").trim();
  if (s === "" && allowEmpty) return "";
  if (!/^g1[0-9a-z]{38}$/.test(s)) {
    throw new Error(`Invalid Gno bech32 address: "${s}"`);
  }
  return s;
}

export function assertSafeInteger(val, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof val === "boolean" || val === null || val === undefined || val === "") {
    throw new Error(`${name} must be an integer`);
  }
  const n = typeof val === "number" ? val : Number(String(val).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(val)}`);
  }
  return n;
}

export function assertSafeBigInt(val, name, { min = 0n, max = 9223372036854775807n } = {}) {
  if (typeof val === "boolean" || val === null || val === undefined || String(val).trim() === "") {
    throw new Error(`${name} must be an integer`);
  }
  const s = String(val).trim();
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`${name} must be a base-10 integer, got ${JSON.stringify(val)}`);
  }
  const n = BigInt(s);
  if (n < min || n > max) {
    throw new Error(`${name} out of range [${min}, ${max}], got ${s}`);
  }
  return n;
}

export function assertValidCsvIntList(csv, name) {
  const s = String(csv ?? "").trim();
  if (!/^\d+(,\s*\d+)*$/.test(s)) {
    throw new Error(`${name} must be a comma-separated list of non-negative integers`);
  }
  return s
    .split(",")
    .map((p) => p.trim())
    .join(",");
}

export function assertValidHttpUrl(urlStr, name) {
  const s = String(urlStr ?? "").trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${name} must be a valid http(s) URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`${name} must use https:// or http:// scheme`);
  }
  return s;
}

/**
 * POSIX-safe single-quoted shell argument (neutralizes $(), backticks, $VAR, etc.).
 */
export function shQuote(val) {
  const s = String(val ?? "").replace(/[\r\n\0]/g, " ");
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// ABCI RPC Queries (`vm/qrender` & `vm/qeval`) + Gno Value Unwrapping
// ---------------------------------------------------------------------------

/**
 * Unwrap a Gno `vm/qeval` string return value formatted as `("..." string)`.
 */
export function unwrapQevalString(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^\((".*")\s+string\)$/s);
  if (match) {
    return JSON.parse(match[1]);
  }
  return trimmed;
}

export async function queryRender({
  rpc = DEFAULT_RPC,
  realm = DEFAULT_REALM,
  path: renderPath = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleanRpc = assertValidRpcUrl(rpc);
  const cleanRealm = assertValidRealmPath(realm);
  const cleanPath = String(renderPath ?? "").replace(/[\r\n\0]/g, "");
  const payload = `${cleanRealm}:${cleanPath}`;
  const dataHex = Buffer.from(payload, "utf8").toString("hex");
  const url = `${cleanRpc}/abci_query?path="vm/qrender"&data=0x${dataHex}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  const resp = json?.result?.response;
  if (!resp) {
    throw new Error("Malformed ABCI response from Gno RPC");
  }
  if (resp.ResponseBase?.Error) {
    throw new Error(`ABCI error: ${JSON.stringify(resp.ResponseBase.Error)}`);
  }
  const b64 = resp.ResponseBase?.Data || resp.value || "";
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
}

export async function queryEval({
  rpc = DEFAULT_RPC,
  realm = DEFAULT_REALM,
  expr = "TotalEscrowed()",
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleanRpc = assertValidRpcUrl(rpc);
  const cleanRealm = assertValidRealmPath(realm);
  const cleanExpr = String(expr || "").trim();
  if (!cleanExpr || cleanExpr.length > 256 || /[;\r\n\0]/.test(cleanExpr)) {
    throw new Error("Invalid qeval expression");
  }
  const payload = `${cleanRealm}.${cleanExpr}`;
  const dataHex = Buffer.from(payload, "utf8").toString("hex");
  const url = `${cleanRpc}/abci_query?path="vm/qeval"&data=0x${dataHex}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  const resp = json?.result?.response;
  if (!resp) {
    throw new Error("Malformed ABCI qeval response");
  }
  if (resp.ResponseBase?.Error) {
    throw new Error(`ABCI qeval error: ${JSON.stringify(resp.ResponseBase.Error)}`);
  }
  const b64 = resp.ResponseBase?.Data || resp.value || "";
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
}

export async function queryEvalJSON(opts) {
  const raw = await queryEval(opts);
  const unwrapped = unwrapQevalString(raw);
  return JSON.parse(unwrapped);
}

// ---------------------------------------------------------------------------
// Offline Exact BPS Split Simulator (mirrors p/escrowmath invariants)
// ---------------------------------------------------------------------------

export function simulateSplit({ totalUgnot, bps }) {
  const total = assertSafeBigInt(totalUgnot, "totalUgnot", { min: 1n });
  if (!Array.isArray(bps) || bps.length === 0) {
    throw new Error("bps must be a non-empty array of integers summing to 10000");
  }
  let sum = 0n;
  let maxIdx = 0;
  const weights = bps.map((raw, i) => {
    const w = assertSafeBigInt(raw, `bps[${i}]`, { min: 1n, max: TOTAL_BPS });
    sum += w;
    if (sum > TOTAL_BPS) {
      throw new Error("basis-point weights exceed 10000");
    }
    if (i > 0 && w > BigInt(bps[maxIdx])) {
      maxIdx = i;
    }
    return w;
  });
  if (sum !== TOTAL_BPS) {
    throw new Error(`basis-point weights must sum to 10000 (got ${sum})`);
  }

  const q = total / TOTAL_BPS;
  const r = total % TOTAL_BPS;
  let distributed = 0n;
  const shares = weights.map((w) => {
    const share = q * w + (r * w) / TOTAL_BPS;
    distributed += share;
    return share;
  });

  const dust = total - distributed;
  if (dust > 0n) {
    shares[maxIdx] += dust;
  }
  for (let i = 0; i < shares.length; i++) {
    if (shares[i] <= 0n) {
      throw new Error(`bps[${i}] (${weights[i]}) produces a zero-ugnot share for total ${total}`);
    }
  }
  return {
    totalUgnot: total.toString(),
    dustUgnot: dust.toString(),
    dustRecipientIndex: maxIdx,
    sharesUgnot: shares.map((s) => s.toString()),
    bps: weights.map((w) => Number(w)),
  };
}

// ---------------------------------------------------------------------------
// Shell-Safe Unsigned `gnokey maketx call` Builder
// ---------------------------------------------------------------------------

export function buildGnokeyCommand({
  action,
  keyName = "onyx-dev",
  realm = DEFAULT_REALM,
  rpc = DEFAULT_RPC,
  chainId = DEFAULT_CHAIN_ID,
  args = {},
}) {
  const cleanKey = assertValidKeyName(keyName);
  const cleanRealm = assertValidRealmPath(realm);
  const cleanRpc = assertValidRpcUrl(rpc);
  const cleanChainId = assertValidChainId(chainId);

  const base = [
    "gnokey maketx call",
    `-pkgpath ${shQuote(cleanRealm)}`,
    `-remote ${shQuote(cleanRpc)}`,
    `-chainid ${shQuote(cleanChainId)}`,
    `-gas-fee '1000000ugnot'`,
    `-gas-wanted '8000000'`,
  ];

  switch (action) {
    case "create": {
      const sendAmt =
        args.sendUgnot !== undefined
          ? assertSafeBigInt(args.sendUgnot, "sendUgnot", { min: MIN_REWARD_UGNOT })
          : 5000000n;
      const arbiter = assertValidGnoAddress(args.arbiter ?? "", { allowEmpty: true });
      const deadline =
        args.deadlineBlocks !== undefined
          ? assertSafeInteger(args.deadlineBlocks, "deadlineBlocks", { min: 0 })
          : 20000;
      const title = String(args.title || "Build Gno Indexer").trim();
      const summary = String(args.summary || "Deliver tested Gno package + README").trim();
      const tags = String(args.tags ?? "gno,tooling").trim();
      if (!title) throw new Error("title cannot be empty");
      if (!summary) throw new Error("summary cannot be empty");
      return [
        ...base,
        `-send ${shQuote(`${sendAmt}ugnot`)}`,
        `-func 'CreateBounty'`,
        `-args ${shQuote(title)}`,
        `-args ${shQuote(summary)}`,
        `-args ${shQuote(tags)}`,
        `-args ${shQuote(arbiter)}`,
        `-args ${shQuote(String(deadline))}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "submit": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      const proofUrl = assertValidHttpUrl(args.proofUrl || "https://github.com/LHorTL/bountyforge", "proofUrl");
      const notes = String(args.notes ?? "All unit tests pass").trim();
      return [
        ...base,
        `-func 'SubmitWork'`,
        `-args ${shQuote(String(bountyId))}`,
        `-args ${shQuote(proofUrl)}`,
        `-args ${shQuote(notes)}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "withdraw": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      return [
        ...base,
        `-func 'WithdrawSubmission'`,
        `-args ${shQuote(String(bountyId))}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "approve": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      const subIdx = assertSafeInteger(args.submissionIndex ?? 0, "submissionIndex", { min: 0, max: 49 });
      return [
        ...base,
        `-func 'ApproveAndPay'`,
        `-args ${shQuote(String(bountyId))}`,
        `-args ${shQuote(String(subIdx))}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "split": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      const indicesCsv = assertValidCsvIntList(args.indicesCsv ?? "0,1", "indicesCsv");
      const bpsCsv = assertValidCsvIntList(args.bpsCsv ?? "7000,3000", "bpsCsv");
      const idxParts = indicesCsv.split(",");
      const bpsParts = bpsCsv.split(",").map((x) => Number(x));
      if (idxParts.length !== bpsParts.length) {
        throw new Error("indicesCsv and bpsCsv must have equal length");
      }
      const bpsSum = bpsParts.reduce((a, b) => a + b, 0);
      if (bpsSum !== 10000 || bpsParts.some((w) => w <= 0 || w > 10000)) {
        throw new Error("bpsCsv weights must each be 1..10000 and sum to 10000");
      }
      return [
        ...base,
        `-func 'SplitAndPay'`,
        `-args ${shQuote(String(bountyId))}`,
        `-args ${shQuote(indicesCsv)}`,
        `-args ${shQuote(bpsCsv)}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "topup": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      const sendAmt =
        args.sendUgnot !== undefined
          ? assertSafeBigInt(args.sendUgnot, "sendUgnot", { min: 1n })
          : 1000000n;
      return [
        ...base,
        `-send ${shQuote(`${sendAmt}ugnot`)}`,
        `-func 'TopUpBounty'`,
        `-args ${shQuote(String(bountyId))}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "dispute": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      const reason = String(args.reason || "Deliverable review disputed").trim();
      if (!reason) throw new Error("reason cannot be empty");
      return [
        ...base,
        `-func 'OpenDispute'`,
        `-args ${shQuote(String(bountyId))}`,
        `-args ${shQuote(reason)}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "resolve": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      const subIdx = assertSafeInteger(args.submissionIndex ?? 0, "submissionIndex", { min: 0, max: 49 });
      const builderBps = assertSafeInteger(args.builderBps ?? 7000, "builderBps", { min: 0, max: 10000 });
      return [
        ...base,
        `-func 'ResolveDispute'`,
        `-args ${shQuote(String(bountyId))}`,
        `-args ${shQuote(String(subIdx))}`,
        `-args ${shQuote(String(builderBps))}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "expire_dispute": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      return [
        ...base,
        `-func 'ExpireDispute'`,
        `-args ${shQuote(String(bountyId))}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    case "cancel": {
      const bountyId = assertSafeInteger(args.bountyId ?? 1, "bountyId", { min: 1 });
      return [
        ...base,
        `-func 'CancelAndRefund'`,
        `-args ${shQuote(String(bountyId))}`,
        `-broadcast ${shQuote(cleanKey)}`,
      ].join(" ");
    }
    default:
      throw new Error(
        `Unknown action "${action}". Supported: create, submit, withdraw, approve, split, topup, dispute, resolve, expire_dispute, cancel`
      );
  }
}

// ---------------------------------------------------------------------------
// MCP Tool Registry & JSON-RPC 2.0 Server
// ---------------------------------------------------------------------------

export const MCP_TOOLS = [
  {
    name: "bountyforge_render",
    description:
      "Read live Gno-Flavored Markdown state from the BountyForge realm (routes: '', 'new', 'bounty/<id>', 'builder/<addr>', 'leaderboard', 'stats').",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "gnoweb route path (empty string for home board)" },
        realm: { type: "string", description: "Optional realm pkgpath override" },
        rpc: { type: "string", description: "Optional Gno RPC http(s) endpoint override" },
      },
    },
  },
  {
    name: "bountyforge_eval",
    description:
      "Evaluate a read-only BountyForge realm view function via ABCI vm/qeval (e.g. 'TotalEscrowed()', 'ProtocolJSON()').",
    inputSchema: {
      type: "object",
      properties: {
        expr: { type: "string", description: "Read-only Gno expression to evaluate" },
        realm: { type: "string" },
        rpc: { type: "string" },
      },
      required: ["expr"],
    },
  },
  {
    name: "bountyforge_protocol_stats",
    description: "Fetch structured JSON protocol metrics (locked escrow, paid volume, quest counts, parameters) via ProtocolJSON().",
    inputSchema: {
      type: "object",
      properties: {
        realm: { type: "string" },
        rpc: { type: "string" },
      },
    },
  },
  {
    name: "bountyforge_list_bounties",
    description: "Fetch a paginated JSON list of bounties filtered by status ('', 'OPEN', 'PAID', 'DISPUTED', 'CANCELLED') via ListBountiesJSON().",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["", "OPEN", "PAID", "DISPUTED", "CANCELLED"] },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 25 },
        realm: { type: "string" },
        rpc: { type: "string" },
      },
    },
  },
  {
    name: "bountyforge_get_bounty",
    description: "Fetch full structured JSON details for a single bounty including sponsor ledger, submissions, payouts, and refunds via BountyJSON(id).",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "integer", minimum: 1 },
        realm: { type: "string" },
        rpc: { type: "string" },
      },
      required: ["bountyId"],
    },
  },
  {
    name: "bountyforge_leaderboard",
    description: "Fetch the O(pageSize) paginated builder reputation leaderboard JSON via LeaderboardJSON().",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 25 },
        realm: { type: "string" },
        rpc: { type: "string" },
      },
    },
  },
  {
    name: "bountyforge_simulate_split",
    description: "Offline exact simulation of escrowmath.SplitBasisPoints showing zero-dust shares and validating overflow/zero-share constraints.",
    inputSchema: {
      type: "object",
      properties: {
        totalUgnot: { type: ["integer", "string"], description: "Total bounty reward in ugnot (> 0)" },
        bps: {
          type: "array",
          items: { type: "integer" },
          description: "Positive basis-point weights summing to 10000",
        },
      },
      required: ["totalUgnot", "bps"],
    },
  },
  {
    name: "bountyforge_build_tx",
    description:
      "Generate a validated, shell-safe unsigned `gnokey maketx call` command for any BountyForge action (never touches private keys).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "submit",
            "withdraw",
            "approve",
            "split",
            "topup",
            "dispute",
            "resolve",
            "expire_dispute",
            "cancel",
          ],
        },
        keyName: { type: "string" },
        realm: { type: "string" },
        rpc: { type: "string" },
        chainId: { type: "string" },
        args: { type: "object" },
      },
      required: ["action"],
    },
  },
];

export async function handleMcpRequest(msg, deps = {}) {
  const { id, method, params = {} } = msg || {};

  // JSON-RPC notifications (no id, or notifications/*) MUST NOT produce a response.
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return null;
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bountyforge-mcp", version: "2.0.0" },
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }
  if (method === "tools/call") {
    const { name, arguments: toolArgs = {} } = params;
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    try {
      let text = "";
      if (name === "bountyforge_render") {
        text = await queryRender({ ...toolArgs, fetchImpl });
      } else if (name === "bountyforge_eval") {
        text = await queryEval({ ...toolArgs, fetchImpl });
      } else if (name === "bountyforge_protocol_stats") {
        const data = await queryEvalJSON({ ...toolArgs, expr: "ProtocolJSON()", fetchImpl });
        text = JSON.stringify(data, null, 2);
      } else if (name === "bountyforge_list_bounties") {
        const status = String(toolArgs.status ?? "").trim().toUpperCase();
        if (!ALLOWED_STATUSES.has(status)) {
          throw new Error(`Invalid status "${status}"`);
        }
        const page = assertSafeInteger(toolArgs.page ?? 1, "page", { min: 1 });
        const pageSize = assertSafeInteger(toolArgs.pageSize ?? 15, "pageSize", { min: 1, max: 25 });
        const data = await queryEvalJSON({
          rpc: toolArgs.rpc,
          realm: toolArgs.realm,
          expr: `ListBountiesJSON(${JSON.stringify(status)}, ${page}, ${pageSize})`,
          fetchImpl,
        });
        text = JSON.stringify(data, null, 2);
      } else if (name === "bountyforge_get_bounty") {
        const bountyId = assertSafeInteger(toolArgs.bountyId, "bountyId", { min: 1 });
        const data = await queryEvalJSON({
          rpc: toolArgs.rpc,
          realm: toolArgs.realm,
          expr: `BountyJSON(${bountyId})`,
          fetchImpl,
        });
        text = JSON.stringify(data, null, 2);
      } else if (name === "bountyforge_leaderboard") {
        const page = assertSafeInteger(toolArgs.page ?? 1, "page", { min: 1 });
        const pageSize = assertSafeInteger(toolArgs.pageSize ?? 15, "pageSize", { min: 1, max: 25 });
        const data = await queryEvalJSON({
          rpc: toolArgs.rpc,
          realm: toolArgs.realm,
          expr: `LeaderboardJSON(${page}, ${pageSize})`,
          fetchImpl,
        });
        text = JSON.stringify(data, null, 2);
      } else if (name === "bountyforge_simulate_split") {
        const sim = simulateSplit(toolArgs);
        text = JSON.stringify(sim, null, 2);
      } else if (name === "bountyforge_build_tx") {
        text = buildGnokeyCommand(toolArgs);
      } else {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Error: ${err.message}` }],
        },
      };
    }
  }
  if (id === undefined) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ---------------------------------------------------------------------------
// Comprehensive Self-Test Suite (Protocol, Structured Views & Security)
// ---------------------------------------------------------------------------

async function runSelfTest() {
  let assertions = 0;
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`Assertion failed: ${msg}`);
    assertions++;
  };
  const assertThrows = (fn, msg) => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`Expected throw: ${msg}`);
    assertions++;
  };

  const mockMarkdown = "# BountyForge\n- Open Bounties: 3";
  const mockStats = { total_bounties: 3, open: 2, total_escrowed_ugnot: 15000000 };
  const mockList = { page: 1, total_pages: 1, total_items: 1, items: [{ id: 1, title: "Audit Realm" }] };
  const mockBounty = { id: 1, title: "Audit Realm", status: "OPEN", reward_ugnot: 5000000 };
  const mockLb = { page: 1, total_pages: 1, total_items: 1, items: [{ rank: 1, xp: 172 }] };

  const makeAbciRes = (text) => ({
    ok: true,
    json: async () => ({
      result: {
        response: {
          ResponseBase: { Data: Buffer.from(text, "utf8").toString("base64") },
        },
      },
    }),
  });

  const mockFetch = async (url) => {
    const hexMatch = url.match(/data=0x([0-9a-fA-F]+)/);
    const decoded = hexMatch ? Buffer.from(hexMatch[1], "hex").toString("utf8") : "";
    if (url.includes("vm/qrender")) return makeAbciRes(mockMarkdown);
    if (decoded.endsWith("ProtocolJSON()")) return makeAbciRes(`(${JSON.stringify(JSON.stringify(mockStats))} string)`);
    if (decoded.includes("ListBountiesJSON(")) return makeAbciRes(`(${JSON.stringify(JSON.stringify(mockList))} string)`);
    if (decoded.includes("BountyJSON(1)")) return makeAbciRes(`(${JSON.stringify(JSON.stringify(mockBounty))} string)`);
    if (decoded.includes("LeaderboardJSON(")) return makeAbciRes(`(${JSON.stringify(JSON.stringify(mockLb))} string)`);
    return makeAbciRes("(15000000 int64)");
  };

  // 1. Lifecycle & MCP spec compliance
  const initRes = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert(initRes?.result?.serverInfo?.version === "2.0.0", "initialize version");
  const pingRes = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert(pingRes?.result && Object.keys(pingRes.result).length === 0, "ping returns empty result");
  const notifRes = await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert(notifRes === null, "notification returns null");
  const listToolsRes = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert(listToolsRes?.result?.tools?.length === 8, "tools/list exposes 8 tools");

  // 2. Render & Eval & Structured JSON tools
  const renderRes = await handleMcpRequest(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bountyforge_render", arguments: { path: "" } } },
    { fetchImpl: mockFetch }
  );
  assert(renderRes?.result?.content?.[0]?.text === mockMarkdown, "bountyforge_render");

  const evalRes = await handleMcpRequest(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "bountyforge_eval", arguments: { expr: "TotalEscrowed()" } } },
    { fetchImpl: mockFetch }
  );
  assert(evalRes?.result?.content?.[0]?.text === "(15000000 int64)", "bountyforge_eval");

  const statsRes = await handleMcpRequest(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "bountyforge_protocol_stats", arguments: {} } },
    { fetchImpl: mockFetch }
  );
  assert(JSON.parse(statsRes.result.content[0].text).total_bounties === 3, "bountyforge_protocol_stats");

  const listRes = await handleMcpRequest(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "bountyforge_list_bounties", arguments: { status: "OPEN", page: 1, pageSize: 10 } } },
    { fetchImpl: mockFetch }
  );
  assert(JSON.parse(listRes.result.content[0].text).items[0].title === "Audit Realm", "bountyforge_list_bounties");

  const bountyRes = await handleMcpRequest(
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "bountyforge_get_bounty", arguments: { bountyId: 1 } } },
    { fetchImpl: mockFetch }
  );
  assert(JSON.parse(bountyRes.result.content[0].text).reward_ugnot === 5000000, "bountyforge_get_bounty");

  const lbRes = await handleMcpRequest(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "bountyforge_leaderboard", arguments: { page: 1 } } },
    { fetchImpl: mockFetch }
  );
  assert(JSON.parse(lbRes.result.content[0].text).items[0].xp === 172, "bountyforge_leaderboard");

  // 3. Split simulator accuracy & invariant enforcement
  const sim = simulateSplit({ totalUgnot: "1000003", bps: [6667, 3333] });
  assert(BigInt(sim.sharesUgnot[0]) + BigInt(sim.sharesUgnot[1]) === 1000003n, "simulateSplit zero dust");
  assert(sim.sharesUgnot[0] === "666703" && sim.sharesUgnot[1] === "333300", "simulateSplit dust to largest weight");
  assertThrows(() => simulateSplit({ totalUgnot: 1000, bps: [9999, 1] }), "simulateSplit rejects zero share");
  assertThrows(() => simulateSplit({ totalUgnot: 20000, bps: [999999999999, 10000] }), "simulateSplit rejects >10000 weight");

  // 4. Tx builder coverage & shell-injection defenses
  const splitCmd = buildGnokeyCommand({
    action: "split",
    keyName: "onyx-dev",
    args: { bountyId: 7, indicesCsv: "0,1", bpsCsv: "6000,4000" },
  });
  assert(splitCmd.includes("-func 'SplitAndPay'") && splitCmd.includes("'6000,4000'"), "split cmd");

  const withdrawCmd = buildGnokeyCommand({ action: "withdraw", args: { bountyId: 3 } });
  assert(withdrawCmd.includes("-func 'WithdrawSubmission'"), "withdraw cmd");

  const expireCmd = buildGnokeyCommand({ action: "expire_dispute", args: { bountyId: 3 } });
  assert(expireCmd.includes("-func 'ExpireDispute'"), "expire_dispute cmd");

  // Single-quote safety against $() / backtick expansion
  const safeCreate = buildGnokeyCommand({
    action: "create",
    args: { title: "$(whoami) `id`", summary: "Safe test", sendUgnot: 2000000 },
  });
  assert(safeCreate.includes("'$(whoami) `id`'"), "POSIX single-quoting neutralizes shell expansion");

  // Security rejections
  assertThrows(() => buildGnokeyCommand({ action: "cancel", keyName: "dev; rm -rf /" }), "rejects shell metachars in keyName");
  assertThrows(() => buildGnokeyCommand({ action: "create", args: { sendUgnot: 0 } }), "rejects 0 sendUgnot");
  assertThrows(() => buildGnokeyCommand({ action: "create", args: { sendUgnot: "NaN" } }), "rejects NaN sendUgnot");
  assertThrows(() => buildGnokeyCommand({ action: "create", args: { arbiter: "not-bech32" } }), "rejects invalid arbiter");
  assertThrows(() => buildGnokeyCommand({ action: "submit", args: { proofUrl: "javascript:alert(1)" } }), "rejects javascript: proofUrl");
  assertThrows(() => assertValidRpcUrl("file:///etc/passwd"), "rejects non-http(s) RPC scheme");
  assertThrows(() => buildGnokeyCommand({ action: "split", args: { indicesCsv: "0;id", bpsCsv: "10000" } }), "rejects non-int CSV");

  // Error handling returns structured MCP isError instead of crashing
  const errRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "bountyforge_build_tx", arguments: { action: "cancel", keyName: "bad key!" } },
  });
  assert(errRes?.result?.isError === true, "tool error returns isError=true");

  console.log(`PASS: bountyforge-mcp self-test (${assertions}/${assertions} assertions)`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }
  if (argv[0] === "--cli") {
    const sub = argv[1];
    if (sub === "render") {
      console.log(await queryRender({ path: argv[2] || "" }));
      return;
    }
    if (sub === "stats") {
      console.log(JSON.stringify(await queryEvalJSON({ expr: "ProtocolJSON()" }), null, 2));
      return;
    }
    if (sub === "list") {
      const status = (argv[2] || "").toUpperCase();
      console.log(JSON.stringify(await queryEvalJSON({ expr: `ListBountiesJSON(${JSON.stringify(status)}, 1, 15)` }), null, 2));
      return;
    }
    if (sub === "eval") {
      console.log(await queryEval({ expr: argv[2] || "TotalEscrowed()" }));
      return;
    }
    if (sub === "cmd") {
      console.log(buildGnokeyCommand({ action: argv[2] || "create" }));
      return;
    }
    console.error("Usage: --cli <render [path] | stats | list [status] | eval <expr> | cmd <action>>");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed);
      const res = await handleMcpRequest(req);
      if (res) {
        process.stdout.write(JSON.stringify(res) + "\n");
      }
    } catch (err) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } }) + "\n"
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
