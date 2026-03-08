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

$BinPath = Join-Path $BaseDir "bin/synergy-devnet-windows-amd64.exe"
$ConfigPath = Join-Path $BaseDir "config/node.toml"
$DataDir = Join-Path $BaseDir "data"
$ChainDir = Join-Path $DataDir "chain"
$LogsDir = Join-Path $DataDir "logs"
$PidFile = Join-Path $DataDir "node.pid"
$OutFile = Join-Path $LogsDir "node.out"
$ErrFile = Join-Path $LogsDir "node.err"
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
  $nodeSlotId = Get-NodeEnvValue "NODE_SLOT_ID"
  return $nodeSlotId -eq "node-01" -or $nodeSlotId -eq "node-02"
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
    47990  # Devnet agent service port
  )
  $networkTransport = (Get-NodeEnvValue "NETWORK_TRANSPORT").ToLower()
  if ([string]::IsNullOrWhiteSpace($networkTransport)) { $networkTransport = "wireguard" }
  $vpnCidr = Get-NodeEnvValue "VPN_CIDR"
  if ([string]::IsNullOrWhiteSpace($vpnCidr)) { $vpnCidr = "10.50.0.0/24" }

  if (-not (Test-Admin)) {
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
        if ($networkTransport -eq "wireguard") {
          New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress $vpnCidr | Out-Null
        } else {
          New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
        }
      }
    } catch {
      Write-Warning "Failed to create firewall rule for port ${port}: $_"
    }
  }
}

function Invoke-PreStartSync {
  if (Test-BootnodeSlot) { return $true }

  for ($attempt = 1; $attempt -le 24; $attempt++) {
    Write-Host "Pre-start sync attempt $attempt/24 for $($NodeEnv['NODE_SLOT_ID'])..."
    & $BinPath sync --config $ConfigPath 1>> $OutFile 2>> $ErrFile
    if ($LASTEXITCODE -eq 0) {
      return $true
    }
    Start-Sleep -Seconds 5
  }

  return $false
}

function Start-Node {
  if (Test-NodeRunning) {
    $currentPid = Get-Content $PidFile | Select-Object -First 1
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) already running (PID $currentPid)"
    return
  }

  Apply-StagedBinary

  New-Item -ItemType Directory -Path $ChainDir -Force | Out-Null
  New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
  New-Item -ItemType File -Path $OutFile -Force | Out-Null
  New-Item -ItemType File -Path $ErrFile -Force | Out-Null

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
  if ([string]::IsNullOrWhiteSpace($configuredChainId)) { $configuredChainId = "338638" }
  $env:SYNERGY_CHAIN_ID = $configuredChainId

  $configuredNetworkId = Get-NodeEnvValue "SYNERGY_NETWORK_ID"
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = Get-NodeEnvValue "NETWORK_ID" }
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = $configuredChainId }
  $env:SYNERGY_NETWORK_ID = $configuredNetworkId
  $env:SYNERGY_CONFIG_PATH = $ConfigPath

  if (-not (Invoke-PreStartSync)) {
    if (Test-SyncRequired) {
      throw "Pre-start sync failed for $($NodeEnv['NODE_SLOT_ID']); refusing to start validator while unsynced."
    }
    Write-Warning "Pre-start sync did not complete for $($NodeEnv['NODE_SLOT_ID']); continuing with node start."
  }

  $args = @("start", "--config", $ConfigPath)
  $proc = Start-Process -FilePath $BinPath -ArgumentList $args -WorkingDirectory $BaseDir -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -PassThru
  Set-Content -Path $PidFile -Value $proc.Id

  Write-Host "Started $($NodeEnv['NODE_SLOT_ID']) ($($NodeEnv['NODE_TYPE'])) PID $($proc.Id)"
  Write-Host "Logs: $OutFile"
}

Open-Ports
Start-Node
