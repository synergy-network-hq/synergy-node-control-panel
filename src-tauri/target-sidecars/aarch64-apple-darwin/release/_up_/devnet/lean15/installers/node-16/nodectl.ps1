param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop", "restart", "status", "logs", "info")]
  [string]$Action = "status",
  [switch]$Follow
)

$ErrorActionPreference = "Stop"

$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $BaseDir "node.env"
$NodeEnv = @{}

if (-not (Test-Path $EnvPath)) {
  throw "Missing node.env at $EnvPath"
}

Get-Content $EnvPath | ForEach-Object {
  if ($_ -match '^\s*$' -or $_ -match '^\s*#') { return }
  $parts = $_ -split '=', 2
  if ($parts.Count -eq 2) {
    $NodeEnv[$parts[0].Trim()] = $parts[1].Trim()
  }
}

function Get-NodeEnvValue([string]$Name) {
  if ($NodeEnv.ContainsKey($Name)) { return $NodeEnv[$Name] }
  return ""
}

$DataDir = Join-Path $BaseDir "data"
$PidFile = Join-Path $DataDir "node.pid"
$OutFile = Join-Path $DataDir "logs/node.out"

function Test-NodeRunning {
  if (-not (Test-Path $PidFile)) { return $false }
  $pidValue = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $pidValue) { return $false }
  return $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

function Start-Node { & (Join-Path $BaseDir "install_and_start.ps1") }

function Stop-Node {
  if (-not (Test-NodeRunning)) {
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) is not running"
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
    return
  }

  $pidValue = Get-Content $PidFile | Select-Object -First 1
  Stop-Process -Id $pidValue -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
  Write-Host "Stopped $($NodeEnv['NODE_SLOT_ID'])"
}

function Status-Node {
  if (Test-NodeRunning) {
    $pidValue = Get-Content $PidFile | Select-Object -First 1
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) is running (PID $pidValue)"
  } else {
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) is stopped"
  }
}

function Logs-Node {
  if (-not (Test-Path $OutFile)) {
    Write-Host "Log file not found: $OutFile"
    return
  }
  if ($Follow) {
    Get-Content -Path $OutFile -Tail 120 -Wait
  } else {
    Get-Content -Path $OutFile -Tail 120
  }
}

function Info-Node {
  Write-Host "Node Slot ID: $(Get-NodeEnvValue 'NODE_SLOT_ID')"
  Write-Host "Node ID: $(Get-NodeEnvValue 'NODE_ALIAS')"
  Write-Host "Role: $(Get-NodeEnvValue 'ROLE')"
  Write-Host "Node Type: $(Get-NodeEnvValue 'NODE_TYPE')"
  Write-Host "Address Class: $(Get-NodeEnvValue 'ADDRESS_CLASS')"
  Write-Host "Address: $(Get-NodeEnvValue 'NODE_ADDRESS')"
  Write-Host "Monitor Host: $(Get-NodeEnvValue 'MONITOR_HOST')"
  Write-Host "VPN IP: $(Get-NodeEnvValue 'VPN_IP')"
  Write-Host "Transport: $(Get-NodeEnvValue 'NETWORK_TRANSPORT')"
  Write-Host "P2P: $(Get-NodeEnvValue 'P2P_PORT')"
  Write-Host "RPC: $(Get-NodeEnvValue 'RPC_PORT')"
  Write-Host "WS: $(Get-NodeEnvValue 'WS_PORT')"
  Write-Host "gRPC: $(Get-NodeEnvValue 'GRPC_PORT')"
  Write-Host "Discovery: $(Get-NodeEnvValue 'DISCOVERY_PORT')"
  Write-Host "Binary: $(Join-Path $BaseDir 'bin/synergy-devnet-windows-amd64.exe')"
  Write-Host "Config: $(Join-Path $BaseDir 'config/node.toml')"
}

switch ($Action) {
  "start"   { Start-Node }
  "stop"    { Stop-Node }
  "restart" { Stop-Node; Start-Node }
  "status"  { Status-Node }
  "logs"    { Logs-Node }
  "info"    { Info-Node }
}
