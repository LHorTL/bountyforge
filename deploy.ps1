param(
    [string]$KeyName = "onyx-dev",
    [string]$Address = "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac",
    [string]$Remote = "https://rpc.onyx.testnets.gno.land:443",
    [string]$ChainId = "onyx-1",
    [string]$GnokeyBin = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Portable gnokey discovery: explicit override -> PATH -> ~/.gno-tools/bin/gnokey(.exe)
if ([string]::IsNullOrWhiteSpace($GnokeyBin)) {
    $cmd = Get-Command gnokey -ErrorAction SilentlyContinue
    if ($cmd) {
        $GnokeyBin = $cmd.Source
    } else {
        $fallback = Join-Path $HOME ".gno-tools\bin\gnokey.exe"
        if (Test-Path $fallback) {
            $GnokeyBin = $fallback
        } else {
            throw "gnokey binary not found in PATH or $fallback. Pass -GnokeyBin <path> or install gnokey."
        }
    }
}

if ($Address -notmatch '^g1[0-9a-z]{38}$') {
    throw "Invalid Gno bech32 address: $Address"
}

# Warn if gnomod.toml / import path still points to a different deployer address
$realmMod = Get-Content (Join-Path $RepoRoot "r\bountyforge\gnomod.toml") -Raw
if ($realmMod -notmatch [regex]::Escape("gno.land/r/$Address/bountyforge")) {
    throw "Module path mismatch: update gnomod.toml and the escrowmath import path to gno.land/*/$Address/* before deploying under $Address."
}

Write-Host "== Using gnokey: $GnokeyBin ==" -ForegroundColor DarkGray
Write-Host "== Checking Onyx testnet balance for $Address ==" -ForegroundColor Cyan
& $GnokeyBin query "bank/balances/$Address" -remote $Remote

Write-Host "`n== Step 1/2: Deploying pure package gno.land/p/$Address/escrowmath ==" -ForegroundColor Cyan
& $GnokeyBin maketx addpkg `
    -pkgpath "gno.land/p/$Address/escrowmath" `
    -pkgdir (Join-Path $RepoRoot "p\escrowmath") `
    -gas-fee "2000000ugnot" `
    -gas-wanted "30000000" `
    -max-deposit "15000000ugnot" `
    -chainid $ChainId `
    -remote $Remote `
    -broadcast `
    $KeyName

Write-Host "`n== Step 2/2: Deploying realm gno.land/r/$Address/bountyforge ==" -ForegroundColor Cyan
& $GnokeyBin maketx addpkg `
    -pkgpath "gno.land/r/$Address/bountyforge" `
    -pkgdir (Join-Path $RepoRoot "r\bountyforge") `
    -gas-fee "5000000ugnot" `
    -gas-wanted "150000000" `
    -max-deposit "45000000ugnot" `
    -chainid $ChainId `
    -remote $Remote `
    -broadcast `
    $KeyName

Write-Host "`n== Deployment broadcast complete! ==" -ForegroundColor Green
Write-Host "gnoweb URL: https://onyx.testnets.gno.land/r/$Address/bountyforge"
