#!/usr/bin/env node
/**
 * Automated Node unit tests for web/app.js pure logic:
 * - Zero-dust BigInt BPS split invariants
 * - Adena DoContract /vm.m_call payload construction
 * - Shell-safe gnokey CLI escaping
 * - XSS HTML escaping, URL safety, and deterministic SVG credential generation
 */

import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  buildAdenaContractPayload,
  buildBuilderCredentialSvg,
  buildGnokeyCli,
  computeZeroDustSplit,
  escapeHtml,
  formatBps,
  formatGnot,
  safeHttpUrl,
  unwrapGnoString,
} from "./app.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

check("formatGnot & formatBps", () => {
  assert.equal(formatGnot(6_500_000), "6.5 GNOT");
  assert.equal(formatGnot(1), "0.000001 GNOT");
  assert.equal(formatGnot(0), "0 GNOT");
  assert.equal(formatBps(6667), "66.67%");
  assert.equal(formatBps(7500), "75%");
});

check("computeZeroDustSplit exact dust conservation", () => {
  const res = computeZeroDustSplit(1_000_003, [6667, 3333]);
  assert.equal(res.shares[0] + res.shares[1], 1_000_003n);
  assert.equal(res.shares[0], 666_703n);
  assert.equal(res.shares[1], 333_300n);
  assert.equal(res.dust, 1n);
  assert.equal(res.dustRecipientIndex, 0);
});

check("computeZeroDustSplit rejects invalid weights & zero shares", () => {
  assert.throws(() => computeZeroDustSplit(1000, [9999, 1]), /0 ugnot/);
  assert.throws(() => computeZeroDustSplit(5000, [5000, 4000]), /sum to 10000/);
  assert.throws(() => computeZeroDustSplit(5000, [10001]), /1\.\.10000/);
});

check("buildAdenaContractPayload constructs valid /vm.m_call envelope", () => {
  const tx = buildAdenaContractPayload({
    caller: "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac",
    realm: DEFAULT_CONFIG.realm,
    func: "SplitAndPay",
    args: [1, "0,1", "6667,3333"],
    send: "",
  });
  assert.equal(tx.messages.length, 1);
  assert.equal(tx.messages[0].type, "/vm.m_call");
  assert.equal(tx.messages[0].value.func, "SplitAndPay");
  assert.deepEqual(tx.messages[0].value.args, ["1", "0,1", "6667,3333"]);
});

check("buildGnokeyCli neutralizes shell expansion", () => {
  const cli = buildGnokeyCli({
    ...DEFAULT_CONFIG,
    func: "CreateBounty",
    send: "5000000ugnot",
    args: ["$(whoami)", "desc", "gno", "", "20000"],
  });
  assert.ok(cli.includes("'$(whoami)'"));
  assert.ok(cli.includes("-send '5000000ugnot'"));
});

check("escapeHtml, safeHttpUrl & unwrapGnoString defenses", () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(safeHttpUrl("https://github.com/LHorTL/bountyforge"), "https://github.com/LHorTL/bountyforge");
  assert.equal(unwrapGnoString(`("{\\"ok\\":true}" string)`), `{"ok":true}`);
});

check("buildBuilderCredentialSvg embeds safe SVG markup", () => {
  const svg = buildBuilderCredentialSvg({
    address: "g125em6arxsnj49vx35f0n0z34putv5ty3376fg5",
    xp: 920,
    completed: 5,
    unique_creators: 3,
    total_earned_ugnot: 34_800_400,
  });
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.includes("[A] Artisan"));
  assert.ok(svg.includes("34.8004 GNOT"));
});

console.log(`PASS: web/app.test.mjs (${passed}/${passed} test groups)`);
