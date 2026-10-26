param([int]$Port = 8765, [switch]$AllowRealOrders)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:GURU_ALLOW_REAL = if ($AllowRealOrders) { '1' } else { '0' }
& node server.mjs --port $Port
exit $LASTEXITCODE
