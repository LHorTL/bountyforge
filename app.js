/**
 * BountyForge Adena Wallet Web dApp (zero external build dependencies)
 *
 * Pure helpers (split simulation, formatting, ABCI decoding, Adena contract
 * payload construction, HTML escaping) are exported for automated Node tests.
 */

export const DEFAULT_CONFIG = {
  rpc: "https://rpc.onyx.testnets.gno.land:443",
  chainId: "onyx-1",
  realm: "gno.land/r/g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac/bountyforge",
  pkg: "gno.land/p/g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac/escrowmath",
};

const PALETTE = ["#4338CA", "#0F766E", "#0284C7", "#92400E", "#6D28D9", "#BE123C"];
const TOTAL_BPS = 10000n;

// ---------------------------------------------------------------------------
// Pure Helpers (Mirroring p/escrowmath & r/bountyforge Invariants)
// ---------------------------------------------------------------------------

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

export function formatGnot(ugnot) {
  const val = BigInt(ugnot || 0);
  const neg = val < 0n;
  const mag = neg ? -val : val;
  const whole = mag / 1000000n;
  const frac = mag % 1000000n;
  if (frac === 0n) return `${neg ? "-" : ""}${whole} GNOT`;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}.${fracStr} GNOT`;
}

export function formatBps(bps) {
  const n = Number(bps || 0);
  const whole = Math.floor(n / 100);
  const frac = n % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, "0").replace(/0+$/, "")}%`;
}

export function shortAddr(addr) {
  const s = String(addr || "");
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

export function tierForXp(xp) {
  const n = Number(xp || 0);
  if (n >= 5000) return { tier: "Grandmaster", badge: "[GM]", color: "#92400E", next: n };
  if (n >= 2000) return { tier: "Master", badge: "[M]", color: "#6D28D9", next: 5000 };
  if (n >= 800) return { tier: "Artisan", badge: "[A]", color: "#4338CA", next: 2000 };
  if (n >= 300) return { tier: "Journeyman", badge: "[J]", color: "#047857", next: 800 };
  if (n >= 100) return { tier: "Apprentice", badge: "[AP]", color: "#0369A1", next: 300 };
  return { tier: "Novice", badge: "[N]", color: "#52525B", next: 100 };
}

/**
 * Exact BigInt implementation mirroring p/escrowmath.SplitBasisPoints.
 */
export function computeZeroDustSplit(totalUgnot, bpsList) {
  const total = BigInt(totalUgnot);
  if (total <= 0n) throw new Error("Total reward must be positive ugnot");
  if (!Array.isArray(bpsList) || bpsList.length === 0) throw new Error("At least one recipient required");

  let sum = 0n;
  let maxIdx = 0;
  const weights = bpsList.map((w, i) => {
    const bw = BigInt(Math.trunc(Number(w)));
    if (bw <= 0n || bw > TOTAL_BPS) throw new Error(`Weight #${i + 1} must be in 1..10000 BPS`);
    sum += bw;
    if (i > 0 && bw > BigInt(Math.trunc(Number(bpsList[maxIdx])))) maxIdx = i;
    return bw;
  });
  if (sum !== TOTAL_BPS) throw new Error(`Weights must sum to 10000 BPS (currently ${sum})`);

  const q = total / TOTAL_BPS;
  const r = total % TOTAL_BPS;
  let distributed = 0n;
  const shares = weights.map((w) => {
    const share = q * w + (r * w) / TOTAL_BPS;
    distributed += share;
    return share;
  });

  const dust = total - distributed;
  if (dust > 0n) shares[maxIdx] += dust;
  for (let i = 0; i < shares.length; i++) {
    if (shares[i] <= 0n) throw new Error(`Recipient #${i + 1} receives 0 ugnot — increase weight or pool`);
  }
  return { shares, dust, dustRecipientIndex: maxIdx };
}

export function unwrapGnoString(raw) {
  const s = String(raw || "").trim();
  const match = s.match(/^\((".*")\s+string\)$/s);
  return match ? JSON.parse(match[1]) : s;
}

export function buildAdenaContractPayload({ caller, realm, func, args = [], send = "" }) {
  return {
    messages: [
      {
        type: "/vm.m_call",
        value: {
          caller: String(caller || ""),
          send: String(send || ""),
          pkg_path: String(realm),
          func: String(func),
          args: args.map((a) => String(a)),
        },
      },
    ],
    gasFee: 1000000,
    gasWanted: 8000000,
    memo: `BountyForge:${func}`,
  };
}

export function shQuote(val) {
  return `'${String(val ?? "").replace(/[\r\n\0]/g, " ").replace(/'/g, `'\\''`)}'`;
}

export function buildGnokeyCli({ rpc, chainId, realm, func, args = [], send = "", keyName = "onyx-dev" }) {
  const parts = [
    "gnokey maketx call",
    `-pkgpath ${shQuote(realm)}`,
    `-remote ${shQuote(rpc)}`,
    `-chainid ${shQuote(chainId)}`,
    "-gas-fee '1000000ugnot'",
    "-gas-wanted '8000000'",
  ];
  if (send) parts.push(`-send ${shQuote(send)}`);
  parts.push(`-func ${shQuote(func)}`);
  for (const a of args) parts.push(`-args ${shQuote(a)}`);
  parts.push(`-broadcast ${shQuote(keyName)}`);
  return parts.join(" ");
}

export function buildBuilderCredentialSvg(prof) {
  const t = tierForXp(prof.xp);
  const barMax = 392;
  let barFill = prof.xp === 0 ? 0 : barMax;
  if (t.next > 0 && prof.xp < t.next) {
    barFill = Math.max(6, Math.floor((prof.xp * barMax) / t.next));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 170" width="460" height="170">
    <style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style>
    <rect x="1" y="1" width="458" height="168" rx="6" ry="6" fill="#FFFFFF" stroke="#E6E8EC" stroke-width="1.5"/>
    <rect x="1" y="1" width="5" height="168" rx="2" ry="2" fill="${t.color}"/>
    <text x="24" y="33" fill="#52525B" font-size="10.5" font-weight="700" letter-spacing="0.8">BOUNTYFORGE ON-CHAIN BUILDER CREDENTIAL</text>
    <rect x="316" y="17" width="124" height="24" rx="4" ry="4" fill="#F7F8FA" stroke="${t.color}" stroke-width="1"/>
    <text x="328" y="33" fill="${t.color}" font-size="11.5" font-weight="700">${escapeHtml(t.badge + " " + t.tier)}</text>
    <text x="24" y="68" fill="#18181B" font-size="19" font-weight="700">${escapeHtml(shortAddr(prof.address))}</text>
    <text x="24" y="96" fill="#52525B" font-size="12.5">XP: ${Number(prof.xp)}  |  Quests: ${Number(prof.completed)}  |  ${escapeHtml(formatGnot(prof.total_earned_ugnot))}</text>
    <rect x="24" y="114" width="${barMax}" height="10" rx="4" ry="4" fill="#F0F1F4"/>
    ${barFill > 0 ? `<rect x="24" y="114" width="${barFill}" height="10" rx="4" ry="4" fill="${t.color}"/>` : ""}
    <text x="24" y="148" fill="#52525B" font-size="11">Unique Creators: ${Number(prof.unique_creators || 0)}  ·  Verified on Gno.land</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// ABCI RPC Helpers (Browser-Safe Hex/Base64)
// ---------------------------------------------------------------------------

function utf8ToHex(str) {
  const bytes = new TextEncoder().encode(str);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function abciQuery(rpc, path, data) {
  const url = `${rpc.replace(/\/$/, "")}/abci_query?path="${path}"&data=0x${utf8ToHex(data)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const resp = json?.result?.response;
  if (!resp) throw new Error("Malformed ABCI response");
  if (resp.ResponseBase?.Error) {
    throw new Error(JSON.stringify(resp.ResponseBase.Error));
  }
  const b64 = resp.ResponseBase?.Data || resp.value || "";
  return b64 ? base64ToUtf8(b64) : "";
}

// ---------------------------------------------------------------------------
// Realistic Seeded Sandbox State (Used seamlessly while onyx-1 is in inert queue)
// ---------------------------------------------------------------------------

function createSandboxState() {
  return {
    stats: {
      total_bounties: 4,
      open: 2,
      paid: 1,
      disputed: 1,
      cancelled: 0,
      total_escrowed_ugnot: 14_500_003,
      total_paid_ugnot: 12_000_000,
      builders: 3,
      block_height: 1342910,
    },
    bounties: [
      {
        id: 1,
        title: "Build Deterministic ABCI Indexer for Gno Realms",
        summary: "Deliver a clean Go/Node ABCI event indexer that tracks BountyCreated, BountySplitPaid, and DisputeResolved events with pagination and unit tests.",
        tags: "gno,abci,indexer",
        creator: "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac",
        arbiter: "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5",
        reward_ugnot: 6_500_003,
        status: "OPEN",
        created_height: 1341833,
        deadline_height: 1361833,
        active_submissions: 2,
        sponsor_count: 2,
        contributions: [
          { sponsor: "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac", amount_ugnot: 5_000_003 },
          { sponsor: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj", amount_ugnot: 1_500_000 },
        ],
        submissions: [
          {
            index: 0,
            builder: "g125em6arxsnj49vx35f0n0z34putv5ty3376fg5",
            proof_url: "https://github.com/LHorTL/bountyforge/pull/12",
            notes: "Core ABCI decoder + incremental cursor sync",
            submitted_height: 1342100,
            via_session: false,
            withdrawn: false,
          },
          {
            index: 1,
            builder: "g1u7y667z64x2h7vc6fmpcprgey4ck233jaww9zq",
            proof_url: "https://github.com/LHorTL/bountyforge/pull/14",
            notes: "Automated fuzz tests + Docker Compose setup (submitted via AI agent session key)",
            submitted_height: 1342420,
            via_session: true,
            withdrawn: false,
          },
        ],
        payouts: [],
        refunds: [],
      },
      {
        id: 2,
        title: "Security Audit of Hamilton Pro-Rata Escrow Refund Math",
        summary: "Verify 128-bit multiplication/division bounds in escrowmath.ProRataRefund and prove that no contributor can ever be refunded more than their deposit.",
        tags: "security,formal-math,escrow",
        creator: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj",
        arbiter: "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5",
        reward_ugnot: 12_000_000,
        status: "PAID",
        created_height: 1341900,
        deadline_height: 1351900,
        active_submissions: 2,
        sponsor_count: 2,
        contributions: [
          { sponsor: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj", amount_ugnot: 8_000_000 },
          { sponsor: "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac", amount_ugnot: 4_000_000 },
        ],
        submissions: [
          {
            index: 0,
            builder: "g125em6arxsnj49vx35f0n0z34putv5ty3376fg5",
            proof_url: "https://github.com/LHorTL/bountyforge/pull/7",
            notes: "Invariant proofs + overflow fuzz tests",
            submitted_height: 1342010,
            via_session: false,
            withdrawn: false,
          },
          {
            index: 1,
            builder: "g1u7y667z64x2h7vc6fmpcprgey4ck233jaww9zq",
            proof_url: "https://github.com/LHorTL/bountyforge/pull/8",
            notes: "Differential Go/Gno test harness",
            submitted_height: 1342050,
            via_session: true,
            withdrawn: false,
          },
        ],
        payouts: [
          { recipient: "g125em6arxsnj49vx35f0n0z34putv5ty3376fg5", amount_ugnot: 8_000_400, bps: 6667 },
          { recipient: "g1u7y667z64x2h7vc6fmpcprgey4ck233jaww9zq", amount_ugnot: 3_999_600, bps: 3333 },
        ],
        refunds: [],
      },
      {
        id: 3,
        title: "DAO Proposal Adapter Using Canonical RealmSend Banker",
        summary: "Write an example commondao proposal executor calling CreateBountyWithBanker so Gno DAOs can fund and approve engineering quests on-chain.",
        tags: "dao,banker,composability",
        creator: "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac",
        arbiter: "",
        reward_ugnot: 5_000_000,
        status: "OPEN",
        created_height: 1342300,
        deadline_height: 1372300,
        active_submissions: 0,
        sponsor_count: 1,
        contributions: [{ sponsor: "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac", amount_ugnot: 5_000_000 }],
        submissions: [],
        payouts: [],
        refunds: [],
      },
      {
        id: 4,
        title: "gnoweb Markdown Fuzzing Harness against Sanitize v0",
        summary: "Fuzz-test Render routes with CommonMark HTML comments, BiDi overrides, and backtick payloads; dispute opened to arbitrate partial milestone delivery.",
        tags: "gnoweb,sanitize,fuzz",
        creator: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj",
        arbiter: "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5",
        reward_ugnot: 3_000_000,
        status: "DISPUTED",
        created_height: 1342100,
        deadline_height: 1345100,
        dispute_reason: "Core fuzz harness complete; waiting on arbiter ruling for 75/25 milestone split.",
        dispute_opened_height: 1342700,
        active_submissions: 1,
        sponsor_count: 2,
        contributions: [
          { sponsor: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj", amount_ugnot: 2_000_000 },
          { sponsor: "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac", amount_ugnot: 1_000_000 },
        ],
        submissions: [
          {
            index: 0,
            builder: "g1vh7krmhyjva5x803737a2p37432502759q427q",
            proof_url: "https://github.com/LHorTL/bountyforge/pull/15",
            notes: "Delivered 18 sanitization corpus vectors",
            submitted_height: 1342610,
            via_session: false,
            withdrawn: false,
          },
        ],
        payouts: [],
        refunds: [],
      },
    ],
    leaderboard: [
      {
        rank: 1,
        address: "g125em6arxsnj49vx35f0n0z34putv5ty3376fg5",
        xp: 920,
        completed: 5,
        unique_creators: 3,
        total_earned_ugnot: 34_800_400,
        last_height: 1342200,
      },
      {
        rank: 2,
        address: "g1u7y667z64x2h7vc6fmpcprgey4ck233jaww9zq",
        xp: 385,
        completed: 3,
        unique_creators: 2,
        total_earned_ugnot: 14_200_000,
        last_height: 1342420,
      },
      {
        rank: 3,
        address: "g1vh7krmhyjva5x803737a2p37432502759q427q",
        xp: 135,
        completed: 1,
        unique_creators: 1,
        total_earned_ugnot: 5_000_000,
        last_height: 1342610,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Browser UI Controller
// ---------------------------------------------------------------------------

if (typeof document !== "undefined") {
  const state = {
    config: { ...DEFAULT_CONFIG },
    mode: "loading", // "live" | "inert" | "offline"
    walletAddress: null,
    statusFilter: "",
    search: "",
    data: createSandboxState(),
    rawRender: "",
    studioRows: [
      { index: 0, label: "Builder #0 (Core)", bps: 6667 },
      { index: 1, label: "Builder #1 (Tests)", bps: 3333 },
    ],
  };

  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    $("toastRoot").appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  async function copyText(text, label = "Copied to clipboard") {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch {
      toast("Clipboard blocked — copy from preview box");
    }
  }

  async function syncFromOnyx() {
    const pill = $("networkPill");
    const txt = $("networkText");
    pill.className = "status-pill status-loading";
    txt.textContent = "Querying onyx-1...";

    const addrPart = state.config.realm.split("/")[2] || "";
    try {
      const protoRaw = await abciQuery(state.config.rpc, "vm/qeval", `${state.config.realm}.ProtocolJSON()`);
      const proto = JSON.parse(unwrapGnoString(protoRaw));
      const listRaw = await abciQuery(state.config.rpc, "vm/qeval", `${state.config.realm}.ListBountiesJSON("", 1, 25)`);
      const lbRaw = await abciQuery(state.config.rpc, "vm/qeval", `${state.config.realm}.LeaderboardJSON(1, 25)`);
      const renderRaw = await abciQuery(state.config.rpc, "vm/qrender", `${state.config.realm}:`);

      const listObj = JSON.parse(unwrapGnoString(listRaw));
      const lbObj = JSON.parse(unwrapGnoString(lbRaw));

      state.mode = "live";
      state.data.stats = proto;
      state.data.bounties = listObj.items || [];
      state.data.leaderboard = lbObj.items || [];
      state.rawRender = renderRaw;

      pill.className = "status-pill status-live";
      txt.textContent = `LIVE · ${state.config.chainId} #${proto.block_height}`;
      renderBanner(
        "live",
        `Connected live to ${state.config.realm} on ${state.config.chainId}. Adena transactions broadcast directly on-chain.`
      );
    } catch (err) {
      // Check if realm is registered in onyx-1 inert queue awaiting MsgEnablePackage
      let inertFound = false;
      try {
        if (addrPart) {
          const inert = await abciQuery(state.config.rpc, "vm/qinertpaths", `gno.land/r/${addrPart}`);
          inertFound = inert.includes(state.config.realm);
        }
      } catch {
        // Ignore secondary RPC error
      }

      if (inertFound) {
        state.mode = "inert";
        pill.className = "status-pill status-inert";
        txt.textContent = "onyx-1 inert queue · Preview";
        state.rawRender =
          `Verified on-chain in onyx-1 inert queue:\n  ${state.config.realm}\n  ${state.config.pkg}\n\nAwaiting pkg_approvers MsgEnablePackage. Interactive sandbox preview is loaded so you can test every escrow, split-slider, SVG badge, and Adena signing workflow right now.`;
        renderBanner(
          "inert",
          `Realm verified in onyx-1 inert queue (awaiting pkg_approvers enablement). Running Interactive Preview with exact on-chain math + Adena tx builder.`
        );
      } else {
        state.mode = "offline";
        pill.className = "status-pill status-offline";
        txt.textContent = "Interactive Preview Mode";
        state.rawRender = `RPC query returned: ${err.message}\n\nRunning Interactive Preview Mode with exact p/escrowmath BigInt invariants.`;
        renderBanner(
          "inert",
          `Preview Mode active (${err.message}). Connect Adena or click RPC to point at any local gnodev / onyx-1 endpoint.`
        );
      }
    }

    renderAll();
  }

  function renderBanner(kind, message) {
    const el = $("statusBanner");
    el.className = `banner ${kind === "live" ? "banner-live" : ""}`;
    el.innerHTML = `<span>${escapeHtml(message)}</span><span class="mono">${escapeHtml(state.config.realm)}</span>`;
  }

  async function connectAdena() {
    if (!window.adena) {
      toast("Adena Wallet extension not detected — install at adena.app or use Copy gnokey CLI");
      return;
    }
    try {
      await window.adena.AddEstablish("BountyForge");
      const acc = await window.adena.GetAccount();
      const addr = acc?.data?.address;
      if (!addr) throw new Error("No account returned by Adena");
      state.walletAddress = addr;
      $("btnConnectAdena").textContent = shortAddr(addr);
      $("btnConnectAdena").classList.remove("btn-primary");
      $("btnConnectAdena").classList.add("btn-ghost");
      toast(`Connected Adena: ${shortAddr(addr)}`);
    } catch (err) {
      toast(`Adena connection failed: ${err.message || err}`);
    }
  }

  async function executeContract(func, args, send = "", onSandboxSuccess = null) {
    const cli = buildGnokeyCli({ ...state.config, func, args, send });
    if (window.adena && state.walletAddress && state.mode === "live") {
      try {
        const payload = buildAdenaContractPayload({
          caller: state.walletAddress,
          realm: state.config.realm,
          func,
          args,
          send,
        });
        const res = await window.adena.DoContract(payload);
        if (res?.status === "failure") {
          throw new Error(res.message || "Transaction rejected");
        }
        toast(`Broadcast ${func} on ${state.config.chainId}!`);
        await syncFromOnyx();
        return;
      } catch (err) {
        toast(`Adena tx error: ${err.message || err}`);
        return;
      }
    }

    // In preview/inert mode, apply state transition locally AND copy exact gnokey CLI!
    if (onSandboxSuccess) {
      onSandboxSuccess();
      renderAll();
    }
    await copyText(cli, `Simulated ${func} in Preview & copied gnokey CLI!`);
  }

  function renderKPIs() {
    const s = state.data.stats;
    $("kpiEscrowed").textContent = formatGnot(s.total_escrowed_ugnot);
    $("kpiOpenCount").textContent = `${s.open} open · ${s.disputed} disputed · ${s.total_bounties} total`;
    $("kpiPaid").textContent = formatGnot(s.total_paid_ugnot);
    $("kpiPaidCount").textContent = `${s.paid} settled quests`;
    $("kpiBuilders").textContent = String(s.builders);
  }

  function renderBoard() {
    const grid = $("bountyGrid");
    const q = state.search.trim().toLowerCase();
    const list = state.data.bounties.filter((b) => {
      if (state.statusFilter && b.status !== state.statusFilter) return false;
      if (q) {
        const hay = `${b.id} ${b.title} ${b.tags} ${b.creator}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (list.length === 0) {
      grid.innerHTML = `<div class="panel-card"><p class="muted">No bounties match the current filter.</p></div>`;
      return;
    }

    grid.innerHTML = list
      .map((b) => {
        const tags = String(b.tags || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
          .join("");
        return `<article class="bounty-card" data-bounty-id="${Number(b.id)}">
          <div class="bounty-top">
            <span class="bounty-id">QUEST #${Number(b.id)}</span>
            <span class="status-badge status-${escapeHtml(b.status)}">${escapeHtml(b.status)}</span>
          </div>
          <div class="bounty-reward">${escapeHtml(formatGnot(b.reward_ugnot))}</div>
          <h3 class="bounty-title">${escapeHtml(b.title)}</h3>
          <p class="bounty-summary">${escapeHtml(b.summary || "Click to inspect full on-chain escrow ledger and submissions.")}</p>
          <div class="tag-row">${tags}</div>
          <div class="bounty-meta">
            <span>${Number(b.active_submissions ?? b.submissions?.length ?? 0)} submissions</span>
            <span>${Number(b.sponsor_count ?? b.contributions?.length ?? 1)} sponsor(s)</span>
          </div>
        </article>`;
      })
      .join("");

    grid.querySelectorAll(".bounty-card").forEach((card) => {
      card.addEventListener("click", () => openBountyDetail(Number(card.dataset.bountyId)));
    });
  }

  async function openBountyDetail(id) {
    let b = state.data.bounties.find((x) => Number(x.id) === id);
    if (state.mode === "live") {
      try {
        const raw = await abciQuery(state.config.rpc, "vm/qeval", `${state.config.realm}.BountyJSON(${id})`);
        const parsed = JSON.parse(unwrapGnoString(raw));
        if (parsed && parsed.id) b = parsed;
      } catch {
        // Fallback to cached summary
      }
    }
    if (!b) return;

    $("detailBadges").innerHTML = `<span class="bounty-id">QUEST #${Number(b.id)}</span>
      <span class="status-badge status-${escapeHtml(b.status)}">${escapeHtml(b.status)}</span>
      <span class="bounty-reward" style="font-size:15px">${escapeHtml(formatGnot(b.reward_ugnot))}</span>`;
    $("detailTitle").textContent = b.title;

    const contribs = b.contributions || [];
    const subs = b.submissions || [];
    const payouts = b.payouts || [];

    const contribRows = contribs
      .map(
        (c, i) => `<tr>
          <td>${i === 0 ? "Creator" : "Sponsor"}</td>
          <td class="mono">${escapeHtml(shortAddr(c.sponsor))}</td>
          <td class="mono">${escapeHtml(formatGnot(c.amount_ugnot))}</td>
        </tr>`
      )
      .join("");

    const subRows = subs.length
      ? subs
          .map((s) => {
            const href = safeHttpUrl(s.proof_url);
            const proofLink = href
              ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Deliverable</a>`
              : `<span class="muted">Invalid URL</span>`;
            const sessionTag = s.via_session ? ` <span class="tag">agent-session</span>` : "";
            const actBtn =
              b.status === "OPEN" && !s.withdrawn
                ? `<button class="btn btn-primary btn-sm" data-approve="${Number(s.index)}">Approve 100%</button>`
                : s.withdrawn
                  ? `<span class="tag">WITHDRAWN</span>`
                  : "—";
            return `<tr>
              <td class="mono">#${Number(s.index)}</td>
              <td class="mono">${escapeHtml(shortAddr(s.builder))}${sessionTag}</td>
              <td>${proofLink}</td>
              <td>${escapeHtml(s.notes)}</td>
              <td>${actBtn}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="muted">No submissions yet.</td></tr>`;

    const payoutHtml = payouts.length
      ? `<div class="detail-section">
          <h3>On-Chain Settlement</h3>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>Recipient</th><th>Share</th><th>Amount</th></tr></thead>
          <tbody>${payouts
            .map(
              (p) => `<tr>
                <td class="mono">${escapeHtml(shortAddr(p.recipient))}</td>
                <td class="mono">${escapeHtml(formatBps(p.bps))}</td>
                <td class="mono text-accent">${escapeHtml(formatGnot(p.amount_ugnot))}</td>
              </tr>`
            )
            .join("")}</tbody></table></div>
        </div>`
      : "";

    const actionRow =
      b.status === "OPEN"
        ? `<div class="btn-group" style="margin-top:12px;">
            <button class="btn btn-gold btn-sm" id="btnDetailTopUp">+ Top Up 1 GNOT</button>
            ${subs.filter((s) => !s.withdrawn).length >= 2 ? `<button class="btn btn-primary btn-sm" id="btnDetailSplit">Open in Split Studio</button>` : ""}
            ${b.arbiter && subs.length > 0 ? `<button class="btn btn-ghost btn-sm" id="btnDetailDispute">Open Dispute</button>` : ""}
            <button class="btn btn-danger btn-sm" id="btnDetailCancel">Cancel &amp; Refund Sponsors</button>
          </div>`
        : b.status === "DISPUTED"
          ? `<div class="btn-group" style="margin-top:12px;">
              <button class="btn btn-primary btn-sm" id="btnDetailResolve">Arbiter: Resolve 75/25</button>
              <button class="btn btn-danger btn-sm" id="btnDetailExpire">Expire Timed-Out Dispute</button>
            </div>`
          : "";

    $("detailBody").innerHTML = `
      <p style="margin-top:0">${escapeHtml(b.summary || "")}</p>
      <div class="meta-kv">
        <div class="meta-kv-row"><span>Creator</span><span class="mono">${escapeHtml(b.creator)}</span></div>
        <div class="meta-kv-row"><span>Arbiter</span><span class="mono">${escapeHtml(b.arbiter || "None (creator-managed)")}</span></div>
        <div class="meta-kv-row"><span>Deadline Height</span><span class="mono">${b.deadline_height ? `#${Number(b.deadline_height)} (+500 review grace)` : "No expiry"}</span></div>
      </div>
      ${actionRow}
      ${b.dispute_reason ? `<div class="alert alert-danger" style="margin-top:14px"><strong>Dispute Notice:</strong> ${escapeHtml(b.dispute_reason)}</div>` : ""}
      <div class="detail-section">
        <h3>Crowdfund Escrow Ledger (${contribs.length}) — Pro-Rata Protected</h3>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Role</th><th>Sponsor</th><th>Deposited</th></tr></thead><tbody>${contribRows}</tbody></table></div>
      </div>
      <div class="detail-section">
        <h3>Submissions (${subs.length})</h3>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>Builder</th><th>Proof</th><th>Notes</th><th>Action</th></tr></thead><tbody>${subRows}</tbody></table></div>
      </div>
      ${payoutHtml}
    `;

    $("detailModal").classList.remove("hidden");

    // Wire action handlers
    $("detailBody").querySelectorAll("[data-approve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.approve);
        executeContract("ApproveAndPay", [b.id, idx], "", () => {
          b.status = "PAID";
          b.payouts = [{ recipient: subs[idx].builder, amount_ugnot: b.reward_ugnot, bps: 10000 }];
          state.data.stats.open = Math.max(0, state.data.stats.open - 1);
          state.data.stats.paid++;
          state.data.stats.total_escrowed_ugnot -= b.reward_ugnot;
          state.data.stats.total_paid_ugnot += b.reward_ugnot;
          $("detailModal").classList.add("hidden");
        });
      });
    });

    const topUpBtn = $("btnDetailTopUp");
    if (topUpBtn) {
      topUpBtn.addEventListener("click", () => {
        executeContract("TopUpBounty", [b.id], "1000000ugnot", () => {
          b.reward_ugnot += 1_000_000;
          b.contributions.push({ sponsor: state.walletAddress || "g1sponsor0000000000000000000000000000000", amount_ugnot: 1_000_000 });
          b.sponsor_count = b.contributions.length;
          state.data.stats.total_escrowed_ugnot += 1_000_000;
          openBountyDetail(b.id);
        });
      });
    }

    const splitBtn = $("btnDetailSplit");
    if (splitBtn) {
      splitBtn.addEventListener("click", () => {
        const active = subs.filter((s) => !s.withdrawn);
        $("studioBountyId").value = b.id;
        $("studioTotalUgnot").value = b.reward_ugnot;
        const even = Math.floor(10000 / active.length);
        state.studioRows = active.map((s, i) => ({
          index: s.index,
          label: `#${s.index} ${shortAddr(s.builder)}`,
          bps: i === 0 ? 10000 - even * (active.length - 1) : even,
        }));
        $("detailModal").classList.add("hidden");
        switchTab("split");
        renderSplitStudio();
      });
    }

    const cancelBtn = $("btnDetailCancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        executeContract("CancelAndRefund", [b.id], "");
      });
    }

    const dispBtn = $("btnDetailDispute");
    if (dispBtn) {
      dispBtn.addEventListener("click", () => {
        executeContract("OpenDispute", [b.id, "Requesting arbiter milestone ruling"], "");
      });
    }

    const resBtn = $("btnDetailResolve");
    if (resBtn) {
      resBtn.addEventListener("click", () => {
        executeContract("ResolveDispute", [b.id, 0, 7500], "");
      });
    }

    const expBtn = $("btnDetailExpire");
    if (expBtn) {
      expBtn.addEventListener("click", () => {
        executeContract("ExpireDispute", [b.id], "");
      });
    }
  }

  // -------------------------------------------------------------------------
  // Split Studio Interactive Engine
  // -------------------------------------------------------------------------

  function renderSplitStudio() {
    const totalUgnot = Math.max(1, Math.trunc(Number($("studioTotalUgnot").value || 0)));
    const bountyId = Math.max(1, Math.trunc(Number($("studioBountyId").value || 1)));
    const rowsEl = $("splitRows");
    const barEl = $("splitBarVisual");
    const errEl = $("splitError");

    const bpsList = state.studioRows.map((r) => r.bps);
    const bpsSum = bpsList.reduce((a, b) => a + b, 0);
    $("studioBpsTotal").textContent = String(bpsSum);

    let splitRes = null;
    let errMsg = "";
    try {
      splitRes = computeZeroDustSplit(totalUgnot, bpsList);
    } catch (err) {
      errMsg = err.message;
    }

    if (errMsg) {
      errEl.textContent = errMsg;
      errEl.classList.remove("hidden");
      $("studioDust").textContent = "—";
    } else {
      errEl.classList.add("hidden");
      $("studioDust").textContent = `${splitRes.dust} ugnot -> Recipient #${splitRes.dustRecipientIndex + 1}`;
    }

    barEl.innerHTML = state.studioRows
      .map((r, i) => {
        const pct = bpsSum > 0 ? (r.bps / bpsSum) * 100 : 0;
        return `<div class="split-segment" style="width:${pct.toFixed(2)}%;background:${PALETTE[i % PALETTE.length]}" title="${escapeHtml(r.label)}: ${formatBps(r.bps)}"></div>`;
      })
      .join("");

    rowsEl.innerHTML = state.studioRows
      .map((r, i) => {
        const shareTxt = splitRes ? formatGnot(splitRes.shares[i]) : "—";
        const color = PALETTE[i % PALETTE.length];
        return `<div class="split-row">
          <span class="mono" style="color:${color};font-weight:700">Sub #${Number(r.index)}</span>
          <input type="text" value="${escapeHtml(r.label)}" data-row-label="${i}" aria-label="Label" />
          <input type="range" min="1" max="9999" value="${Number(r.bps)}" data-row-slider="${i}" aria-label="BPS slider" />
          <input type="number" min="1" max="10000" value="${Number(r.bps)}" data-row-num="${i}" aria-label="BPS weight" />
          <div class="split-payout-col">${escapeHtml(shareTxt)}<br><span class="muted">${formatBps(r.bps)}</span></div>
          <button type="button" class="icon-btn" data-row-del="${i}" title="Remove">&times;</button>
        </div>`;
      })
      .join("");

    rowsEl.querySelectorAll("[data-row-label]").forEach((inp) => {
      inp.addEventListener("input", () => {
        state.studioRows[Number(inp.dataset.rowLabel)].label = inp.value;
      });
    });

    const rebalanceFrom = (changedIdx, nextVal) => {
      const clamped = Math.max(1, Math.min(10000 - (state.studioRows.length - 1), Math.trunc(Number(nextVal) || 1)));
      state.studioRows[changedIdx].bps = clamped;
      if (state.studioRows.length === 2) {
        state.studioRows[1 - changedIdx].bps = 10000 - clamped;
      } else {
        const remaining = 10000 - clamped;
        const others = state.studioRows.map((r, idx) => ({ r, idx })).filter((o) => o.idx !== changedIdx);
        const otherSum = others.reduce((a, o) => a + o.r.bps, 0) || others.length;
        let alloc = 0;
        others.forEach((o, j) => {
          if (j === others.length - 1) {
            o.r.bps = Math.max(1, remaining - alloc);
          } else {
            const share = Math.max(1, Math.floor((o.r.bps / otherSum) * remaining));
            o.r.bps = share;
            alloc += share;
          }
        });
      }
      renderSplitStudio();
    };

    rowsEl.querySelectorAll("[data-row-slider]").forEach((sl) => {
      sl.addEventListener("input", () => rebalanceFrom(Number(sl.dataset.rowSlider), sl.value));
    });
    rowsEl.querySelectorAll("[data-row-num]").forEach((num) => {
      num.addEventListener("change", () => {
        state.studioRows[Number(num.dataset.rowNum)].bps = Math.max(1, Math.trunc(Number(num.value) || 1));
        renderSplitStudio();
      });
    });
    rowsEl.querySelectorAll("[data-row-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.studioRows.length <= 1) return;
        state.studioRows.splice(Number(btn.dataset.rowDel), 1);
        equalizeStudio();
      });
    });

    const indicesCsv = state.studioRows.map((r) => r.index).join(",");
    const bpsCsv = state.studioRows.map((r) => r.bps).join(",");
    $("studioCmdPreview").textContent = buildGnokeyCli({
      ...state.config,
      func: "SplitAndPay",
      args: [bountyId, indicesCsv, bpsCsv],
    });
  }

  function equalizeStudio() {
    const n = state.studioRows.length;
    const base = Math.floor(10000 / n);
    state.studioRows.forEach((r, i) => {
      r.bps = i === 0 ? 10000 - base * (n - 1) : base;
    });
    renderSplitStudio();
  }

  // -------------------------------------------------------------------------
  // Leaderboard & SVG Credential Showcase
  // -------------------------------------------------------------------------

  function renderLeaderboard() {
    const body = $("leaderboardBody");
    const list = state.data.leaderboard || [];
    if (list.length === 0) {
      body.innerHTML = `<tr><td colspan="7" class="muted">No settled builders yet.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((p, idx) => {
        const t = tierForXp(p.xp);
        return `<tr data-builder-idx="${idx}">
          <td class="mono">#${Number(p.rank || idx + 1)}</td>
          <td class="mono">${escapeHtml(shortAddr(p.address))}</td>
          <td><span class="tag" style="color:${t.color}">${escapeHtml(t.badge)} ${escapeHtml(t.tier)}</span></td>
          <td class="mono">${Number(p.xp)}</td>
          <td class="mono">${Number(p.completed)}</td>
          <td class="mono">${Number(p.unique_creators || 0)}</td>
          <td class="mono text-accent">${escapeHtml(formatGnot(p.total_earned_ugnot))}</td>
        </tr>`;
      })
      .join("");

    body.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => renderCredentialCard(list[Number(tr.dataset.builderIdx)]));
    });
    renderCredentialCard(list[0]);
  }

  function renderCredentialCard(prof) {
    if (!prof) return;
    $("svgCredentialPreview").innerHTML = buildBuilderCredentialSvg(prof);
    const t = tierForXp(prof.xp);
    $("selectedBuilderMeta").innerHTML = `
      <div class="meta-kv-row"><span>Address</span><span class="mono">${escapeHtml(prof.address)}</span></div>
      <div class="meta-kv-row"><span>Tier</span><span class="mono" style="color:${t.color}">${escapeHtml(t.badge + " " + t.tier)}</span></div>
      <div class="meta-kv-row"><span>Total Earned</span><span class="mono">${escapeHtml(formatGnot(prof.total_earned_ugnot))}</span></div>
      <div class="meta-kv-row"><span>Unique Creators</span><span class="mono">${Number(prof.unique_creators || 0)}</span></div>
    `;
  }

  function renderGnowebTab() {
    const gnowebUrl = `https://onyx.testnets.gno.land/${state.config.realm.replace(/^gno\.land\//, "")}`;
    $("gnowebExternalLink").href = gnowebUrl;
    $("realmEndpoints").innerHTML = `
      <div class="meta-kv-row"><span>RPC Endpoint</span><span class="mono">${escapeHtml(state.config.rpc)}</span></div>
      <div class="meta-kv-row"><span>Chain ID</span><span class="mono">${escapeHtml(state.config.chainId)}</span></div>
      <div class="meta-kv-row"><span>Realm Path</span><span class="mono">${escapeHtml(state.config.realm)}</span></div>
      <div class="meta-kv-row"><span>Pure Math Package</span><span class="mono">${escapeHtml(state.config.pkg)}</span></div>
    `;
    $("rawRenderBox").textContent = state.rawRender || "No render data yet.";
    $("mcpConfigBox").textContent = JSON.stringify(
      {
        mcpServers: {
          bountyforge: {
            command: "node",
            args: ["mcp/bountyforge-mcp.mjs"],
            env: {
              BOUNTYFORGE_RPC: state.config.rpc,
              BOUNTYFORGE_CHAIN_ID: state.config.chainId,
              BOUNTYFORGE_REALM: state.config.realm,
            },
          },
        },
      },
      null,
      2
    );
  }

  function switchTab(tabName) {
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t.dataset.tab === tabName;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${tabName}`);
    });
  }

  function updateCreatePreview() {
    const fd = new FormData($("createForm"));
    const ugnot = Math.max(1000, Math.round(Number(fd.get("rewardGnot") || 5) * 1_000_000));
    $("createCmdBox").textContent = buildGnokeyCli({
      ...state.config,
      func: "CreateBounty",
      send: `${ugnot}ugnot`,
      args: [
        fd.get("title") || "New Bounty",
        fd.get("summary") || "Acceptance criteria",
        fd.get("tags") || "gno",
        fd.get("arbiter") || "",
        fd.get("deadlineBlocks") || "20000",
      ],
    });
  }

  function renderAll() {
    renderKPIs();
    renderBoard();
    renderSplitStudio();
    renderLeaderboard();
    renderGnowebTab();
  }

  // Event wiring
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("statusFilters").addEventListener("click", (e) => {
    const pill = e.target.closest(".pill");
    if (!pill) return;
    state.statusFilter = pill.dataset.status;
    $("statusFilters").querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === pill));
    renderBoard();
  });

  $("searchInput").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderBoard();
  });

  $("btnConnectAdena").addEventListener("click", connectAdena);
  $("btnRefreshRpc").addEventListener("click", syncFromOnyx);

  $("btnOpenCreate").addEventListener("click", () => {
    updateCreatePreview();
    $("createModal").classList.remove("hidden");
  });
  $("createForm").addEventListener("input", updateCreatePreview);
  $("btnCopyCreateCmd").addEventListener("click", () => copyText($("createCmdBox").textContent, "Copied CreateBounty CLI"));
  $("createForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ugnot = Math.max(1000, Math.round(Number(fd.get("rewardGnot") || 5) * 1_000_000));
    const title = String(fd.get("title") || "").trim();
    const summary = String(fd.get("summary") || "").trim();
    const tags = String(fd.get("tags") || "").trim();
    const arbiter = String(fd.get("arbiter") || "").trim();
    const deadline = Math.max(0, Math.trunc(Number(fd.get("deadlineBlocks") || 0)));

    executeContract("CreateBounty", [title, summary, tags, arbiter, deadline], `${ugnot}ugnot`, () => {
      const nextId = state.data.bounties.reduce((m, b) => Math.max(m, Number(b.id)), 0) + 1;
      const creatorAddr = state.walletAddress || "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac";
      state.data.bounties.unshift({
        id: nextId,
        title,
        summary,
        tags,
        creator: creatorAddr,
        arbiter,
        reward_ugnot: ugnot,
        status: "OPEN",
        created_height: state.data.stats.block_height,
        deadline_height: deadline > 0 ? state.data.stats.block_height + deadline : 0,
        active_submissions: 0,
        sponsor_count: 1,
        contributions: [{ sponsor: creatorAddr, amount_ugnot: ugnot }],
        submissions: [],
        payouts: [],
        refunds: [],
      });
      state.data.stats.total_bounties++;
      state.data.stats.open++;
      state.data.stats.total_escrowed_ugnot += ugnot;
      $("createModal").classList.add("hidden");
    });
  });

  $("btnAddContributor").addEventListener("click", () => {
    if (state.studioRows.length >= 8) {
      toast("Studio preview supports up to 8 rows");
      return;
    }
    const nextIdx = state.studioRows.length;
    state.studioRows.push({ index: nextIdx, label: `Builder #${nextIdx}`, bps: 1000 });
    equalizeStudio();
  });
  $("studioBountyId").addEventListener("input", renderSplitStudio);
  $("studioTotalUgnot").addEventListener("input", renderSplitStudio);
  $("btnStudioEqual").addEventListener("click", equalizeStudio);
  $("btnStudioCopyCmd").addEventListener("click", () => copyText($("studioCmdPreview").textContent, "Copied SplitAndPay CLI"));
  $("btnStudioSign").addEventListener("click", () => {
    try {
      computeZeroDustSplit($("studioTotalUgnot").value, state.studioRows.map((r) => r.bps));
    } catch (err) {
      toast(`Invalid split: ${err.message}`);
      return;
    }
    const bountyId = Math.max(1, Math.trunc(Number($("studioBountyId").value || 1)));
    const indicesCsv = state.studioRows.map((r) => r.index).join(",");
    const bpsCsv = state.studioRows.map((r) => r.bps).join(",");
    executeContract("SplitAndPay", [bountyId, indicesCsv, bpsCsv], "");
  });

  $("btnConfig").addEventListener("click", () => {
    $("cfgRpc").value = state.config.rpc;
    $("cfgChainId").value = state.config.chainId;
    $("cfgRealm").value = state.config.realm;
    $("configModal").classList.remove("hidden");
  });
  $("configForm").addEventListener("submit", (e) => {
    e.preventDefault();
    state.config.rpc = $("cfgRpc").value.trim();
    state.config.chainId = $("cfgChainId").value.trim();
    state.config.realm = $("cfgRealm").value.trim();
    $("configModal").classList.add("hidden");
    syncFromOnyx();
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => $(btn.dataset.close).classList.add("hidden"));
  });
  document.querySelectorAll(".modal-backdrop").forEach((bg) => {
    bg.addEventListener("click", (e) => {
      if (e.target === bg) bg.classList.add("hidden");
    });
  });

  renderAll();
  syncFromOnyx();
}
