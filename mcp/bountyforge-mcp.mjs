#!/usr/bin/env node
/**
 * BountyForge MCP Server & CLI Companion (zero external npm dependencies)
 *
 * Bridges AI agents (Claude, Gemini, Cursor, MCP clients) to the live
 * BountyForge Gno.land realm over ABCI JSON-RPC (`vm/qrender` & `vm/qeval`)
 * and builds ready-to-sign `gnokey maketx call` commands without ever
 * touching or storing private keys.
 *
 * Usage:
 *   node mcp/bountyforge-mcp.mjs                  # Run stdio JSON-RPC 2.0 MCP server
 *   node mcp/bountyforge-mcp.mjs --cli render ""  # One-shot ABCI qrender query
 *   node mcp/bountyforge-mcp.mjs --cli cmd create # Print gnokey transaction template
 *   node mcp/bountyforge-mcp.mjs --self-test      # Offline protocol & builder test
 */

import readline from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_RPC = process.env.BOUNTYFORGE_RPC || "https://rpc.onyx.testnets.gno.land:443";
export const DEFAULT_CHAIN_ID = process.env.BOUNTYFORGE_CHAIN_ID || "onyx-1";
export const DEFAULT_REALM =
  process.env.BOUNTYFORGE_REALM || "gno.land/r/g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac/bountyforge";

/**
 * Query a Gno.land realm's Render(path) via Tendermint ABCI query (`vm/qrender`).
 */
export async function queryRender({
  rpc = DEFAULT_RPC,
  realm = DEFAULT_REALM,
  path = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const payload = `${realm}:${path}`;
  const dataHex = Buffer.from(payload, "utf8").toString("hex");
  const url = `${rpc.replace(/\/$/, "")}/abci_query?path="vm/qrender"&data=0x${dataHex}`;
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

/**
 * Query a read-only exported Gno expression via `vm/qeval`.
 */
export async function queryEval({
  rpc = DEFAULT_RPC,
  realm = DEFAULT_REALM,
  expr = "TotalEscrowed()",
  fetchImpl = globalThis.fetch,
} = {}) {
  const payload = `${realm}.${expr}`;
  const dataHex = Buffer.from(payload, "utf8").toString("hex");
  const url = `${rpc.replace(/\/$/, "")}/abci_query?path="vm/qeval"&data=0x${dataHex}`;
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

/**
 * Quote a shell argument cleanly for gnokey command generation.
 */
function shQuote(val) {
  return JSON.stringify(String(val ?? ""));
}

/**
 * Build an unsigned `gnokey maketx call` command for any BountyForge action.
 */
export function buildGnokeyCommand({
  action,
  keyName = "onyx-dev",
  realm = DEFAULT_REALM,
  rpc = DEFAULT_RPC,
  chainId = DEFAULT_CHAIN_ID,
  args = {},
}) {
  const base = [
    "gnokey maketx call",
    `-pkgpath ${shQuote(realm)}`,
    `-remote ${shQuote(rpc)}`,
    `-chainid ${shQuote(chainId)}`,
    `-gas-fee "1000000ugnot"`,
    `-gas-wanted "8000000"`,
  ];

  switch (action) {
    case "create": {
      const send = args.sendUgnot ? `${Number(args.sendUgnot)}ugnot` : "5000000ugnot";
      return [
        ...base,
        `-send ${shQuote(send)}`,
        `-func "CreateBounty"`,
        `-args ${shQuote(args.title || "Build Gno Indexer")}`,
        `-args ${shQuote(args.summary || "Deliver tested Gno package + README")}`,
        `-args ${shQuote(args.tags || "gno,tooling")}`,
        `-args ${shQuote(args.arbiter || "")}`,
        `-args ${shQuote(String(args.deadlineBlocks ?? 20000))}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    }
    case "submit":
      return [
        ...base,
        `-func "SubmitWork"`,
        `-args ${shQuote(String(args.bountyId ?? 1))}`,
        `-args ${shQuote(args.proofUrl || "https://github.com/LHorTL/bountyforge")}`,
        `-args ${shQuote(args.notes || "All unit tests pass")}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    case "approve":
      return [
        ...base,
        `-func "ApproveAndPay"`,
        `-args ${shQuote(String(args.bountyId ?? 1))}`,
        `-args ${shQuote(String(args.submissionIndex ?? 0))}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    case "split":
      return [
        ...base,
        `-func "SplitAndPay"`,
        `-args ${shQuote(String(args.bountyId ?? 1))}`,
        `-args ${shQuote(args.indicesCsv || "0,1")}`,
        `-args ${shQuote(args.bpsCsv || "7000,3000")}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    case "topup": {
      const send = args.sendUgnot ? `${Number(args.sendUgnot)}ugnot` : "1000000ugnot";
      return [
        ...base,
        `-send ${shQuote(send)}`,
        `-func "TopUpBounty"`,
        `-args ${shQuote(String(args.bountyId ?? 1))}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    }
    case "dispute":
      return [
        ...base,
        `-func "OpenDispute"`,
        `-args ${shQuote(String(args.bountyId ?? 1))}`,
        `-args ${shQuote(args.reason || "Deliverable review disputed")}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    case "resolve":
      return [
        ...base,
        `-func "ResolveDispute"`,
        `-args ${shQuote(String(args.bountyId ?? 1))}`,
        `-args ${shQuote(String(args.submissionIndex ?? 0))}`,
        `-args ${shQuote(String(args.builderBps ?? 7000))}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    case "cancel":
      return [
        ...base,
        `-func "CancelAndRefund"`,
        `-args ${shQuote(String(args.bountyId ?? 1))}`,
        `-broadcast ${keyName}`,
      ].join(" ");
    default:
      throw new Error(
        `Unknown action "${action}". Supported: create, submit, approve, split, topup, dispute, resolve, cancel`
      );
  }
}

export const MCP_TOOLS = [
  {
    name: "bountyforge_render",
    description:
      "Read live Markdown state from the BountyForge Gno.land realm (routes: '', 'bounty/<id>', 'builder/<addr>', 'leaderboard', 'stats').",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "gnoweb route path (empty string for home board)" },
        realm: { type: "string", description: "Optional realm pkgpath override" },
        rpc: { type: "string", description: "Optional Gno RPC endpoint override" },
      },
    },
  },
  {
    name: "bountyforge_eval",
    description:
      "Evaluate a read-only BountyForge realm view function via ABCI vm/qeval (e.g. 'TotalEscrowed()', 'BountyCount()').",
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
    name: "bountyforge_build_tx",
    description:
      "Generate an unsigned `gnokey maketx call` command for creating, funding, submitting, approving, splitting, disputing, or cancelling a BountyForge bounty.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "submit", "approve", "split", "topup", "dispute", "resolve", "cancel"],
        },
        keyName: { type: "string" },
        args: { type: "object" },
      },
      required: ["action"],
    },
  },
];

export async function handleMcpRequest(msg, deps = {}) {
  const { id, method, params = {} } = msg || {};
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bountyforge-mcp", version: "1.0.0" },
      },
    };
  }
  if (method === "notifications/initialized") {
    return null;
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }
  if (method === "tools/call") {
    const { name, arguments: toolArgs = {} } = params;
    try {
      let text = "";
      if (name === "bountyforge_render") {
        text = await queryRender({ ...toolArgs, fetchImpl: deps.fetchImpl || globalThis.fetch });
      } else if (name === "bountyforge_eval") {
        text = await queryEval({ ...toolArgs, fetchImpl: deps.fetchImpl || globalThis.fetch });
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
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

async function runSelfTest() {
  const mockMarkdown = "# BountyForge\n- Open Bounties: 3\n- Locked Escrow: 15 GNOT";
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      result: {
        response: {
          ResponseBase: { Data: Buffer.from(mockMarkdown, "utf8").toString("base64") },
        },
      },
    }),
  });

  const initRes = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  if (initRes?.result?.serverInfo?.name !== "bountyforge-mcp") {
    throw new Error("initialize self-test failed");
  }

  const listRes = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  if (listRes?.result?.tools?.length !== 3) {
    throw new Error("tools/list self-test failed");
  }

  const renderRes = await handleMcpRequest(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bountyforge_render", arguments: { path: "" } } },
    { fetchImpl: mockFetch }
  );
  if (renderRes?.result?.content?.[0]?.text !== mockMarkdown) {
    throw new Error("bountyforge_render self-test failed");
  }

  const txRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "bountyforge_build_tx",
      arguments: { action: "split", args: { bountyId: 7, indicesCsv: "0,1", bpsCsv: "6000,4000" } },
    },
  });
  const cmd = txRes?.result?.content?.[0]?.text || "";
  if (!cmd.includes('-func "SplitAndPay"') || !cmd.includes('"6000,4000"')) {
    throw new Error(`bountyforge_build_tx self-test failed: ${cmd}`);
  }

  console.log("PASS: bountyforge-mcp self-test (4/4 assertions)");
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
    if (sub === "eval") {
      console.log(await queryEval({ expr: argv[2] || "TotalEscrowed()" }));
      return;
    }
    if (sub === "cmd") {
      console.log(buildGnokeyCommand({ action: argv[2] || "create" }));
      return;
    }
    console.error("Usage: --cli <render [path] | eval <expr> | cmd <action>>");
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
