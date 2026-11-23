param(
    [string]$KeyName = "onyx-dev",
    [string]$Address = "g10yuqyktt4777jn8rt3nmuhw4suz9mvypaec7ac",
    [string]$Remote = "https://rpc.onyx.testnets.gno.land:443",
    [string]$ChainId = "onyx-1",
    [string]$GnokeyBin = "C:\Users\j2494\.gno-tools\bin\gnokey.exe"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "== Checking Onyx testnet balance for $Address ==" -ForegroundColor Cyan
& $GnokeyBin query "bank/balances/$Address" -remote $Remote

Write-Host "`n== Step 1/2: Deploying pure package gno.land/p/$Address/escrowmath ==" -ForegroundColor Cyan
& $GnokeyBin maketx addpkg `
    -pkgpath "gno.land/p/$Address/escrowmath" `
    -pkgdir (Join-Path $RepoRoot "p\escrowmath") `
    -gas-fee "1000000ugnot" `
    -gas-wanted "10000000" `
    -chainid $ChainId `
    -remote $Remote `
    -broadcast `
    $KeyName

Write-Host "`n== Step 2/2: Deploying realm gno.land/r/$Address/bountyforge ==" -ForegroundColor Cyan
& $GnokeyBin maketx addpkg `
    -pkgpath "gno.land/r/$Address/bountyforge" `
    -pkgdir (Join-Path $RepoRoot "r\bountyforge") `
    -gas-fee "1000000ugnot" `
    -gas-wanted "15000000" `
    -chainid $ChainId `
    -remote $Remote `
    -broadcast `
    $KeyName

Write-Host "`n== Deployment complete! ==" -ForegroundColor Green
Write-Host "gnoweb URL: https://onyx.testnets.gno.land/r/$Address/bountyforge"
