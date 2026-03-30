param(
  [switch]$OpenPortsOnly
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

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$BinPath = Join-Path $BaseDir "bin/synergy-testbeta-windows-amd64.exe"
$ConfigPath = Join-Path $BaseDir "config/node.toml"
$DataDir = Join-Path $BaseDir "data"
$ChainDir = Join-Path $DataDir "chain"
$LogsDir = Join-Path $DataDir "logs"
$PidFile = Join-Path $DataDir "node.pid"
$OutFile = Join-Path $LogsDir "node.out"
$ErrFile = Join-Path $LogsDir "node.err"
$InstallStampFile = Join-Path $DataDir ".installed_at"
$StagedBinPath = "$BinPath.pending"

if (-not (Test-Path $BinPath)) {
  throw "Missing Windows binary: $BinPath"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Missing config file: $ConfigPath"
}

function Test-NodeRunning {
  if (-not (Test-Path $PidFile)) { return $false }
  $pidValue = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $pidValue) { return $false }
  return $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

function Test-BootnodeSlot {
  $roleGroup = (Get-NodeEnvValue "ROLE_GROUP").ToLower()
  $nodeType = (Get-NodeEnvValue "NODE_TYPE").ToLower()
  return $roleGroup -eq "bootstrap" -or $nodeType -eq "bootnode"
}

function Test-SyncRequired {
  if (Test-BootnodeSlot) { return $false }
  $roleGroup = (Get-NodeEnvValue "ROLE_GROUP").ToLower()
  $nodeType = (Get-NodeEnvValue "NODE_TYPE").ToLower()
  return $roleGroup -eq "consensus" -and $nodeType -eq "validator"
}

function Apply-StagedBinary {
  if (-not (Test-Path $StagedBinPath)) { return }
  if (Test-Path $BinPath) {
    Remove-Item $BinPath -Force -ErrorAction SilentlyContinue
  }
  Move-Item -Path $StagedBinPath -Destination $BinPath -Force
  Write-Host "Applied staged binary update: $BinPath"
}

function Open-Ports {
  $ports = @(
    [int](Get-NodeEnvValue "P2P_PORT"),
    [int](Get-NodeEnvValue "RPC_PORT"),
    [int](Get-NodeEnvValue "WS_PORT"),
    [int](Get-NodeEnvValue "GRPC_PORT"),
    [int](Get-NodeEnvValue "DISCOVERY_PORT"),
    47990  # Testnet-Beta agent service port
  )
  if (-not (Test-Admin)) {
    $canPromptForElevation = [Environment]::UserInteractive `
      -and [string]::IsNullOrWhiteSpace($env:SSH_CONNECTION) `
      -and [string]::IsNullOrWhiteSpace($env:SSH_CLIENT)
    if ($canPromptForElevation -and -not $OpenPortsOnly) {
      try {
        $argumentList = @(
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "`"$PSCommandPath`"",
          "-OpenPortsOnly"
        )
        $elevated = Start-Process -FilePath "powershell" -Verb RunAs -WorkingDirectory $BaseDir -ArgumentList $argumentList -Wait -PassThru
        if ($elevated.ExitCode -eq 0) {
          Write-Host "Opened Windows Firewall ports using an elevated PowerShell prompt."
          return
        }
        Write-Warning "Elevated firewall setup exited with code $($elevated.ExitCode)."
      } catch {
        Write-Warning "Unable to prompt for Windows Firewall elevation automatically: $_"
      }
    }
    Write-Warning "Run PowerShell as Administrator to auto-open Windows Firewall ports."
    Write-Host "Open these TCP ports manually: $($ports -join ', ')"
    return
  }

  $nodeSlotId = Get-NodeEnvValue "NODE_SLOT_ID"
  foreach ($port in $ports) {
    $ruleName = "Synergy-$nodeSlotId-$port"
    try {
      $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
      if (-not $existing) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
      }
    } catch {
      Write-Warning "Failed to create firewall rule for port ${port}: $_"
    }
  }
}

function Invoke-PreStartSync {
  if (Test-BootnodeSlot) { return $true }

  # Use a wall-clock deadline instead of a fixed attempt count so that nodes
  # far behind the chain tip (e.g. late joiners) are given enough time to
  # fully catch up.  Override with PRESTART_SYNC_TIMEOUT_SECS in the calling
  # environment (default: 600 s = 10 min; use e.g. 3600 for a late joiner).
  $timeoutSecs = if ($env:PRESTART_SYNC_TIMEOUT_SECS) { [int]$env:PRESTART_SYNC_TIMEOUT_SECS } else { 600 }
  $deadline = (Get-Date).AddSeconds($timeoutSecs)
  $attempt = 0

  while ((Get-Date) -lt $deadline) {
    $attempt++
    $remaining = [int]($deadline - (Get-Date)).TotalSeconds
    Write-Host "Pre-start sync attempt $attempt for $($NodeEnv['NODE_SLOT_ID']) (${remaining}s remaining of ${timeoutSecs}s)..."
    & $BinPath sync --config $ConfigPath 1>> $OutFile 2>> $ErrFile
    if ($LASTEXITCODE -eq 0) {
      return $true
    }
    $remaining = ($deadline - (Get-Date)).TotalSeconds
    if ($remaining -gt 5) {
      Start-Sleep -Seconds 5
    }
  }

  return $false
}

function Set-NodeInstalled {
  if (-not (Test-Path $InstallStampFile)) {
    Set-Content -Path $InstallStampFile -Value (Get-Date -AsUTC -Format "yyyy-MM-ddTHH:mm:ssZ")
  }
}

function Initialize-InstallLayout {
  New-Item -ItemType Directory -Path $ChainDir -Force | Out-Null
  New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
  New-Item -ItemType File -Path $OutFile -Force | Out-Null
  New-Item -ItemType File -Path $ErrFile -Force | Out-Null
  Set-NodeInstalled
}

function Start-Node {
  if (Test-NodeRunning) {
    $currentPid = Get-Content $PidFile | Select-Object -First 1
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) already running (PID $currentPid)"
    return
  }

  Apply-StagedBinary

  Initialize-InstallLayout

  $validatorAddress = Get-NodeEnvValue "NODE_ADDRESS"
  if ([string]::IsNullOrWhiteSpace($validatorAddress)) {
    $validatorAddress = $env:SYNERGY_VALIDATOR_ADDRESS
  }
  if (-not [string]::IsNullOrWhiteSpace($validatorAddress)) {
    $env:SYNERGY_VALIDATOR_ADDRESS = $validatorAddress
    $env:NODE_ADDRESS = $validatorAddress
  } else {
    Write-Warning "NODE_ADDRESS is empty; validator identity will fallback to node_name."
  }

  $autoRegister = Get-NodeEnvValue "SYNERGY_AUTO_REGISTER_VALIDATOR"
  if ([string]::IsNullOrWhiteSpace($autoRegister)) { $autoRegister = Get-NodeEnvValue "AUTO_REGISTER_VALIDATOR" }
  if ([string]::IsNullOrWhiteSpace($autoRegister)) { $autoRegister = "false" }
  $env:SYNERGY_AUTO_REGISTER_VALIDATOR = $autoRegister

  $strictAllowlist = Get-NodeEnvValue "SYNERGY_STRICT_VALIDATOR_ALLOWLIST"
  if ([string]::IsNullOrWhiteSpace($strictAllowlist)) { $strictAllowlist = Get-NodeEnvValue "STRICT_VALIDATOR_ALLOWLIST" }
  if ([string]::IsNullOrWhiteSpace($strictAllowlist)) { $strictAllowlist = "true" }
  $env:SYNERGY_STRICT_VALIDATOR_ALLOWLIST = $strictAllowlist

  $allowedValidators = Get-NodeEnvValue "SYNERGY_ALLOWED_VALIDATOR_ADDRESSES"
  if ([string]::IsNullOrWhiteSpace($allowedValidators)) { $allowedValidators = Get-NodeEnvValue "ALLOWED_VALIDATOR_ADDRESSES" }
  if (-not [string]::IsNullOrWhiteSpace($allowedValidators)) {
    $env:SYNERGY_ALLOWED_VALIDATOR_ADDRESSES = $allowedValidators
  }

  $rpcBindAddress = Get-NodeEnvValue "SYNERGY_RPC_BIND_ADDRESS"
  if ([string]::IsNullOrWhiteSpace($rpcBindAddress)) { $rpcBindAddress = Get-NodeEnvValue "RPC_BIND_ADDRESS" }
  if (-not [string]::IsNullOrWhiteSpace($rpcBindAddress)) {
    $env:SYNERGY_RPC_BIND_ADDRESS = $rpcBindAddress
  }

  $configuredChainId = Get-NodeEnvValue "SYNERGY_CHAIN_ID"
  if ([string]::IsNullOrWhiteSpace($configuredChainId)) { $configuredChainId = Get-NodeEnvValue "CHAIN_ID" }
  if ([string]::IsNullOrWhiteSpace($configuredChainId)) { $configuredChainId = "338639" }
  $env:SYNERGY_CHAIN_ID = $configuredChainId

  $configuredNetworkId = Get-NodeEnvValue "SYNERGY_NETWORK_ID"
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = Get-NodeEnvValue "NETWORK_ID" }
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = $configuredChainId }
  $env:SYNERGY_NETWORK_ID = $configuredNetworkId
  $env:SYNERGY_CONFIG_PATH = $ConfigPath

  $skipPrestartSync = $env:SKIP_PRESTART_SYNC -eq "true"
  if (-not $skipPrestartSync) {
    if (-not (Invoke-PreStartSync)) {
      if (Test-SyncRequired) {
        throw "Pre-start sync failed for $($NodeEnv['NODE_SLOT_ID']); refusing to start validator while unsynced."
      }
      Write-Warning "Pre-start sync did not complete for $($NodeEnv['NODE_SLOT_ID']); continuing with node start."
    }
  }

  $args = @("start", "--config", $ConfigPath)
  $proc = Start-Process -FilePath $BinPath -ArgumentList $args -WorkingDirectory $BaseDir -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -PassThru
  Set-Content -Path $PidFile -Value $proc.Id

  Write-Host "Started $($NodeEnv['NODE_SLOT_ID']) ($($NodeEnv['NODE_TYPE'])) PID $($proc.Id)"
  Write-Host "Logs: $OutFile"
}

Open-Ports

if ($OpenPortsOnly) {
  Write-Host "Firewall rule setup completed for $($NodeEnv['NODE_SLOT_ID'])."
  exit 0
}

if ($env:INSTALL_ONLY -eq "true") {
  Initialize-InstallLayout
  Write-Host "[$($NodeEnv['NODE_SLOT_ID'])] Install complete. Node remains offline until sync/start."
  exit 0
}

# SYNC_ONLY=true: run pre-start sync and exit without launching the node process.
# Used by nodectl.ps1 sync to let an operator explicitly catch up a late-joining
# node before starting it. AUTO_START_AFTER_SYNC=true promotes sync into the
# catch-up-and-start path for dashboard-driven node activation.
if ($env:SYNC_ONLY -eq "true") {
  Initialize-InstallLayout
  if (Invoke-PreStartSync) {
    if ($env:AUTO_START_AFTER_SYNC -eq "true") {
      Write-Host "[$($NodeEnv['NODE_SLOT_ID'])] Sync complete. Starting node automatically..."
      $env:SKIP_PRESTART_SYNC = "true"
      Start-Node
    } else {
      Write-Host "[$($NodeEnv['NODE_SLOT_ID'])] Sync complete. Node is ready for manual start."
    }
    exit 0
  } else {
    Write-Error "[$($NodeEnv['NODE_SLOT_ID'])] Sync did not complete within the timeout."
    exit 1
  }
}

Start-Node
