$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$address = 'http://127.0.0.1:8765'
$listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 8765 -ErrorAction SilentlyContinue
if ($listener) {
    $running = (Invoke-WebRequest -UseBasicParsing "$address/app.js" -TimeoutSec 10).Content
    $expected = [IO.File]::ReadAllText((Join-Path $workspace 'public/app.js'))
    if ($running -cne $expected) { throw 'Port 8765 is not serving this workspace; leaving it running.' }
    $targetPid = $listener.OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid"
    if ($process.CommandLine -notmatch 'node(?:\.exe)?"?\s+server\.mjs(?:\s|$)') { throw 'Unexpected listener command; leaving it running.' }
    Stop-Process -Id $targetPid
}
$env:GURU_ALLOW_REAL = '0'
$nodePath = (Get-Command node).Source
$started = Start-Process -FilePath $nodePath -ArgumentList 'server.mjs' -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $workspace 'data/terminal.stdout.log') -RedirectStandardError (Join-Path $workspace 'data/terminal.stderr.log') -PassThru
Write-Output "Started terminal PID $($started.Id) at $address (real orders disabled)"
