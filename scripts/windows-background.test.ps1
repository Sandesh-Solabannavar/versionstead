$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scriptPath = Join-Path $PSScriptRoot 'windows-background.ps1'
$errorsFound = $null
$tokensFound = $null
$scriptAst = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokensFound, [ref]$errorsFound)
if ($errorsFound.Count) { throw 'Windows background script does not parse.' }

# Load only read-only helpers, never the installer body or ACL mutation functions.
foreach ($functionAst in $scriptAst.FindAll({
  param($astNode)
  $astNode -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $astNode.Name -in @('Get-AbsolutePath', 'Get-NodeExecutable', 'Get-GlobalToolReadPaths', 'Require-Administrator')
}, $true)) { . ([ScriptBlock]::Create($functionAst.Extent.Text)) }

$DataDir = Join-Path $env:LOCALAPPDATA 'Versionstead'
$NodeExecutable = $null
$nodePath = Get-NodeExecutable
& {
  # Get-Command can return multiple PATH matches; only the first executable is selected.
  function Get-Command {
    param([string]$Name, [string]$CommandType, [string]$ErrorAction)
    return @([pscustomobject]@{ Source = $nodePath }, [pscustomobject]@{ Source = $nodePath })
  }
  if ((Get-NodeExecutable) -ne $nodePath) { throw 'Multiple Node PATH matches were not handled.' }
}
foreach ($literal in $scriptAst.FindAll({
  param($astNode)
  $astNode -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
  $astNode.StringConstantType -eq [System.Management.Automation.Language.StringConstantType]::SingleQuotedHereString
}, $true)) {
  $literal.Value | & $nodePath '--input-type=module' '--check'
  if ($LASTEXITCODE -ne 0) { throw 'An embedded Node helper does not parse.' }
}

$packageRoot = Join-Path $workspaceRoot 'node_modules'
$npmPaths = @(Get-GlobalToolReadPaths (ConvertTo-Json -Compress -InputObject @([pscustomobject]@{ manager = 'npm'; root = $packageRoot })))
if ($npmPaths.Count -ne 1 -or -not $npmPaths[0].Directory -or $npmPaths[0].Path -ne $packageRoot) { throw 'npm access was not scoped to its package directory.' }
$bunPaths = @(Get-GlobalToolReadPaths (ConvertTo-Json -Compress -InputObject @([pscustomobject]@{ manager = 'bun'; root = $packageRoot })))
if ($bunPaths.Count -ne 2 -or $bunPaths[1].Directory -or $bunPaths[1].Path -ne (Join-Path $workspaceRoot 'package.json')) { throw 'Bun metadata access was not scoped to the single manifest file.' }
$missingRoot = Join-Path $workspaceRoot 'versionstead-test-absent-prefix\node_modules'
if (Test-Path -LiteralPath $missingRoot) { throw 'The absent-root test location unexpectedly exists.' }
$emptyPaths = @(Get-GlobalToolReadPaths (ConvertTo-Json -Compress -InputObject @(
  [pscustomobject]@{ manager = 'npm'; root = $missingRoot },
  [pscustomobject]@{ manager = 'bun'; root = $null }
)))
if ($emptyPaths.Count) { throw 'Missing or absent global directories must not receive ACL grants.' }
try {
  Get-GlobalToolReadPaths (ConvertTo-Json -Compress -InputObject @([pscustomobject]@{ manager = 'npm'; root = $workspaceRoot })) | Out-Null
  throw 'A broad directory was accepted as a global package root.'
} catch {
  if ($_.Exception.Message -ne 'Global-tool access must be scoped to a node_modules directory.') { throw }
}

$hostExecutable = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $hostExecutable)) { $hostExecutable = Join-Path $PSHOME 'powershell.exe' }
$status = & $hostExecutable '-NoProfile' '-File' $scriptPath '-Action' 'Status'
if ($LASTEXITCODE -ne 0 -or -not $status) { throw 'Read-only background status failed.' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  try { Require-Administrator; throw 'The nonadmin install guard did not reject.' }
  catch { if ($_.Exception.Message -notmatch '^Open an elevated PowerShell') { throw } }
}

Write-Output 'Background host syntax, Node selection, scoped package grants, status, and privilege checks passed. No ACLs or tasks changed.'
