param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Status', 'Start', 'Stop', 'Restart', 'Uninstall')]
  [string]$Action,
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'Versionstead'),
  [string]$NodeExecutable,
  [string[]]$ProjectRoots = @(),
  [string]$OwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskName = "Versionstead Monitoring ($OwnerSid)"
$localServiceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-19')
$ownerIdentity = [System.Security.Principal.SecurityIdentifier]::new($OwnerSid)

function Get-AbsolutePath([string]$Value, [bool]$Existing = $true) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\x00-\x1f"]' -or $Value.StartsWith('\\')) {
    throw 'Paths must be absolute local paths without control characters or quotes.'
  }
  $resolved = [System.IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($resolved -eq [System.IO.Path]::GetPathRoot($resolved).TrimEnd('\')) { throw 'A drive root cannot be used.' }
  if ($Existing -and -not (Test-Path -LiteralPath $resolved)) { throw 'A required path does not exist.' }
  return $resolved
}

function Require-Administrator {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open an elevated PowerShell window to configure the Windows boot host. No registration was changed.'
  }
}

function Get-NodeExecutable {
  $candidate = $NodeExecutable
  if (-not $candidate) { $candidate = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source }
  $candidate = Get-AbsolutePath $candidate
  if ([System.IO.Path]::GetFileName($candidate) -ne 'node.exe') { throw 'Select the Node.js node.exe executable.' }
  $version = & $candidate '-e' "require('node:sqlite'); process.stdout.write(process.versions.node)" 2>$null
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^24\.') { throw 'Node.js 24 with SQLite support is required.' }
  return $candidate
}

function Get-OwnedTask {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    if ($task.Description -ne "Versionstead read-only monitoring for $OwnerSid" -or $task.Principal.UserId -notin @('NT AUTHORITY\LOCAL SERVICE', 'S-1-5-19', 'LOCAL SERVICE')) {
      throw 'An unrelated task uses this name. It will not be changed.'
    }
  }
  return $task
}

function Grant-ReadAccess([string]$Path, [bool]$Directory = $true) {
  $acl = Get-Acl -LiteralPath $Path
  $rights = if ($Directory) { [System.Security.AccessControl.FileSystemRights]::ReadAndExecute } else { [System.Security.AccessControl.FileSystemRights]::Read }
  $inheritance = if ($Directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $localServiceSid, $rights, $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Get-OwnerGlobalToolSources {
  $nodePath = Get-NodeExecutable
  $inventoryModule = Join-Path $workspaceRoot 'apps\server\dist\adapters\inventory.js'
  $runtimeModule = Join-Path $workspaceRoot 'apps\server\dist\runtime.js'
  $contractModule = Join-Path $workspaceRoot 'packages\contracts\dist\monitoring.js'
  $sameOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq $OwnerSid
  $capture = @'
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const timeout = setTimeout(() => { console.error('Owner global-tool capture timed out; no registration was changed.'); process.exit(1); }, 45000);
try {
  const { discoverGlobalToolSources, validateGlobalToolSources } = await import(pathToFileURL(process.argv[1]).href);
  let sources;
  if (process.argv[5] === 'owner') {
    sources = await discoverGlobalToolSources(AbortSignal.timeout(35000));
  } else {
    const { readRuntime } = await import(pathToFileURL(process.argv[2]).href);
    const { decodeMonitoringSnapshot } = await import(pathToFileURL(process.argv[3]).href);
    const runtime = await readRuntime(process.argv[4]);
    let snapshot;
    if (runtime) {
      try {
        const response = await fetch(`${runtime.origin}/api/monitoring`, { headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(3000) });
        if (response.ok) snapshot = decodeMonitoringSnapshot(await response.json());
      } catch {}
    }
    if (!snapshot) {
      const database = new DatabaseSync(join(process.argv[4], 'monitoring.sqlite'), { readOnly: true, timeout: 3000 });
      try {
        const row = database.prepare('SELECT value FROM monitoring_meta WHERE id=1').get();
        if (!row || typeof row.value !== 'string' || Buffer.byteLength(row.value) > 32 * 1024 * 1024) throw new Error('No saved owner sources');
        snapshot = decodeMonitoringSnapshot({ ...JSON.parse(row.value).snapshot, projects: [], findings: [] });
      } finally { database.close(); }
    }
    sources = snapshot.inventory.managers;
    if (snapshot.inventory.collector !== 'npm-bun-global-v1' || !sources?.length || sources.some(source => !source.checkedAt)) throw new Error('Owner sources not captured');
  }
  sources = await validateGlobalToolSources(sources);
  const json = JSON.stringify(sources);
  if (Buffer.byteLength(json) > 65536) throw new Error('Source configuration too large');
  process.stdout.write(Buffer.from(json, 'utf8').toString('base64'));
} catch {
  console.error('Could not capture npm/Bun sources for the original owner. Launch the updated Versionstead desktop and scan This PC as that owner, then retry Install with the original OwnerSid and DataDir. No registration was changed.');
  process.exitCode = 1;
} finally { clearTimeout(timeout); }
'@
  $identityMode = if ($sameOwner) { 'owner' } else { 'saved' }
  # The adapter uses a neutral directory. ASCII transport preserves Unicode paths in Windows PowerShell 5.1.
  $json = & $nodePath '--input-type=module' '-e' $capture $inventoryModule $runtimeModule $contractModule $DataDir $identityMode
  if ($LASTEXITCODE -ne 0) { throw 'Original-owner global-tool capture failed. Monitoring was not stopped.' }
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(($json -join '')))
}

function Get-GlobalToolReadPaths([string]$SourcesJson) {
  $sources = @($SourcesJson | ConvertFrom-Json)
  $paths = @()
  foreach ($source in $sources) {
    if ($null -eq $source.root) { continue }
    $root = Get-AbsolutePath $source.root $false
    if ([System.IO.Path]::GetFileName($root) -ne 'node_modules') { throw 'Global-tool access must be scoped to a node_modules directory.' }
    if ($root -eq $DataDir -or $root.StartsWith("$DataDir\", [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Global-tool sources cannot be inside the monitoring data directory.' }
    if (Test-Path -LiteralPath $root) {
      $item = Get-Item -LiteralPath $root -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Global-tool sources must be real directories, not junctions or symbolic links.' }
      $paths += [pscustomobject]@{ Path = $root; Directory = $true }
    }
    if ($source.manager -eq 'bun') {
      $manifest = Join-Path ([System.IO.Path]::GetDirectoryName($root)) 'package.json'
      if (Test-Path -LiteralPath $manifest) {
        $item = Get-Item -LiteralPath $manifest -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Bun global package metadata must be a regular file.' }
        $paths += [pscustomobject]@{ Path = $manifest; Directory = $false }
      }
    }
  }
  return $paths
}

function Protect-DataDirectory {
  if ($DataDir -eq $workspaceRoot -or $workspaceRoot.StartsWith("$DataDir\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a dedicated Versionstead data directory outside the application source tree.'
  }
  if (Test-Path -LiteralPath $DataDir) {
    $unexpected = @(Get-ChildItem -LiteralPath $DataDir -Force | Where-Object { $_.PSIsContainer -or $_.Name -notmatch '^(monitoring|coordinator-lock)\.sqlite(?:-shm|-wal|-journal)?$|^runtime(?:\.json|\.\d+\.tmp)$' })
    if ($unexpected.Count) { throw 'The data directory contains unrelated files. Its permissions will not be replaced.' }
  }
  if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  $acl = Get-Acl -LiteralPath $DataDir
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($entry) }
  foreach ($sid in @($ownerIdentity, $localServiceSid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rights = if ($sid.Value -eq 'S-1-5-19') { [System.Security.AccessControl.FileSystemRights]::Modify } else { [System.Security.AccessControl.FileSystemRights]::FullControl }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid, $rights, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $DataDir -AclObject $acl
}

function Stop-Coordinator {
  $nodePath = Get-NodeExecutable
  $runtimeModule = Join-Path $workspaceRoot 'apps\server\dist\runtime.js'
  $shutdown = @'
import { pathToFileURL } from 'node:url';
const { readRuntime } = await import(pathToFileURL(process.argv[1]).href);
const runtime = await readRuntime(process.argv[2]);
if (runtime) {
  try {
    const ready = await fetch(`${runtime.origin}/api/status`, { headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(3000) });
    if (!ready.ok) throw new Error('Unready coordinator');
  } catch { process.exit(0); }
  try {
    const response = await fetch(`${runtime.origin}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Shutdown rejected');
    for (let attempt = 0; attempt < 150; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (!await readRuntime(process.argv[2])) process.exit(0);
    }
    throw new Error('Shutdown timed out');
  } catch { console.error('Coordinator shutdown failed; no unrelated process was terminated.'); process.exitCode = 1; }
}

'@
  & $nodePath '--input-type=module' '-e' $shutdown $runtimeModule $DataDir
  if ($LASTEXITCODE -ne 0) { throw 'Graceful coordinator shutdown failed. Check monitoring status before retrying.' }
}

function Verify-Coordinator([string[]]$SelectedRoots = @(), [string]$SourcesJson = '') {
  $nodePath = Get-NodeExecutable
  $runtimeModule = Join-Path $workspaceRoot 'apps\server\dist\runtime.js'
  $contractModule = Join-Path $workspaceRoot 'packages\contracts\dist\monitoring.js'
  $verification = @'
import { pathToFileURL } from 'node:url';
const { readRuntime } = await import(pathToFileURL(process.argv[1]).href);
const { decodeMonitoringSnapshot, decodeProject } = await import(pathToFileURL(process.argv[3]).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let runtime;
let snapshot;
const overallDeadline = Date.now() + 180000;
const readinessDeadline = Date.now() + 45000;
const request = async (path, body) => {
  const remaining = overallDeadline - Date.now();
  if (remaining <= 0) throw new Error('The three-minute background validation budget expired; registration is retained for diagnostics');
  const response = await fetch(`${runtime.origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.min(10000, remaining)) });
  if (!response.ok) throw new Error('The background account could not complete its access check');
  return response.json();
};
while (Date.now() < readinessDeadline) {
  runtime = await readRuntime(process.argv[2]);
  if (runtime) {
    try {
      snapshot = decodeMonitoringSnapshot(await request('/api/monitoring'));
      if (snapshot.runtime.mode === 'background' && snapshot.runtime.host === 'boot-task') break;
    } catch {}
  }
  await delay(500);
}
if (!snapshot || snapshot.runtime.mode !== 'background' || snapshot.runtime.host !== 'boot-task') {
  console.error('Boot host registration exists, but authenticated readiness failed. Check the task status and account access.');
  process.exit(1);
}
const pcBusy = state => state.scanProgress?.active?.kind === 'pc' || state.scanProgress?.queued.some(target => target.kind === 'pc');
if (process.argv[4] === 'captured') {
  const { readFileSync } = await import('node:fs');
  const encoded = readFileSync(0, 'utf8').trim();
  if (encoded.length > 90000) throw new Error('Source configuration too large');
  const sources = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  while (true) {
    snapshot = decodeMonitoringSnapshot(await request('/api/monitoring'));
    if (pcBusy(snapshot)) { await delay(500); continue; }
    try { snapshot = decodeMonitoringSnapshot(await request('/api/global-tools/sources', { sources })); break; }
    catch (error) {
      snapshot = decodeMonitoringSnapshot(await request('/api/monitoring'));
      if (!pcBusy(snapshot)) throw error;
    }
  }
}
if (snapshot.inventory.collector !== 'npm-bun-global-v1' || !snapshot.inventory.managers?.length || snapshot.inventory.managers.some(source => !source.checkedAt)) {
  console.error('Owner npm/Bun sources are not configured. Run Install as the original owner; the service account will not discover its own tools.');
  process.exit(1);
}
const sources = snapshot.inventory.managers;
const previousPcAttempt = snapshot.inventory.evidence.lastAttempt;
await request('/api/scans', { target: 'pc' });
const selectedProjects = [];
for (const root of process.argv.slice(5)) {
  const project = decodeProject(await request('/api/projects', { path: root, mode: 'watch' }));
  selectedProjects.push({ id: project.id, previousAttempt: project.evidence.lastAttempt });
}
if (selectedProjects.length) await request('/api/scans', { target: 'projects' });
{
  const probeDeadline = overallDeadline;
  const valid = evidence => ['complete', 'partial'].includes(evidence.status) && evidence.lastSuccess;
  const pcReadable = state => valid(state.inventory.evidence) && state.inventory.evidence.lastAttempt !== previousPcAttempt && sources.every(source => {
    if (!source.root) return source.status === 'not-installed';
    const current = state.inventory.managers?.find(item => item.manager === source.manager && item.root === source.root);
    return current?.status === 'detected' && current.checkedAt && Date.parse(current.checkedAt) >= Date.parse(state.inventory.evidence.lastAttempt);
  });
  const allReadable = state => pcReadable(state) && selectedProjects.every(selected => {
    const project = state.projects.find(item => item.id === selected.id);
    return project && valid(project.evidence) && project.evidence.lastAttempt !== selected.previousAttempt;
  });
  let state;
  while (Date.now() < probeDeadline) {
    state = decodeMonitoringSnapshot(await request('/api/monitoring'));
    if (allReadable(state)) break;
    await delay(500);
  }
  if (!state || !allReadable(state)) {
    console.error('Owner global tools or a selected project did not produce fresh readable evidence under LocalService. Inspect source access and coverage before relying on background scans.');
    process.exit(1);
  }
}
console.log('Authenticated background readiness and fresh owner-global-tool/project access checks passed. Boot and sign-out lifecycle still require a manual smoke run.');
'@
  $sourceArgument = if ($SourcesJson) { 'captured' } else { 'saved' }
  $sourceInput = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($SourcesJson))
  $sourceInput | & $nodePath '--input-type=module' '-e' $verification $runtimeModule $DataDir $contractModule $sourceArgument @SelectedRoots
  if ($LASTEXITCODE -ne 0) { throw 'Background host validation failed. The registration is retained for diagnostics.' }
}

$DataDir = Get-AbsolutePath $DataDir $false
$task = Get-OwnedTask
if ($Action -eq 'Status') {
  if ($null -eq $task) { Write-Output 'Windows boot monitoring: not installed'; exit 0 }
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  [pscustomobject]@{ Task = $taskName; Account = 'LocalService'; State = $task.State; LastTaskResult = $info.LastTaskResult; LifecycleVerification = 'Boot and sign-out smoke required'; GlobalTools = 'Saved owner npm/Bun roots; fresh account-access check required' }
  exit 0
}

Require-Administrator
switch ($Action) {
  'Install' {
    $nodePath = Get-NodeExecutable
    $entry = Get-AbsolutePath (Join-Path $workspaceRoot 'apps\server\dist\bin.js')
    $webRoot = Get-AbsolutePath (Join-Path $workspaceRoot 'apps\web\dist')
    if (-not (Test-Path -LiteralPath (Join-Path $webRoot 'index.html') -PathType Leaf)) { throw 'Build Versionstead before installing its boot host.' }
    $roots = @($ProjectRoots | ForEach-Object { Get-AbsolutePath $_ })
    if ($roots.Count -gt 50) { throw 'At most 50 explicit project roots can be configured.' }
    foreach ($root in $roots) {
      $item = Get-Item -LiteralPath $root
      if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Select real local directories, not junctions or symbolic links.' }
      if ($root -eq $env:USERPROFILE -or $root -eq $env:WINDIR) { throw 'Grant access to selected project folders, not a profile or Windows root.' }
      if ($root -eq $DataDir -or $root.StartsWith("$DataDir\", [System.StringComparison]::OrdinalIgnoreCase)) { throw 'The data directory must not contain selected project roots.' }
    }
    $sourcesJson = Get-OwnerGlobalToolSources
    $globalReadPaths = @(Get-GlobalToolReadPaths $sourcesJson)
    # Read grants cover explicit projects and global-package roots, never a whole profile or manager credential file.
    Stop-Coordinator
    Protect-DataDirectory
    Grant-ReadAccess $workspaceRoot
    Grant-ReadAccess ([System.IO.Path]::GetDirectoryName($nodePath))
    foreach ($root in $roots) { Grant-ReadAccess $root }
    foreach ($item in $globalReadPaths) { Grant-ReadAccess $item.Path $item.Directory }
    $arguments = '"{0}" --data-dir "{1}" --port 0 --mode background --host boot-task --web-root "{2}"' -f $entry, $DataDir, $webRoot
    $scheduledAction = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $workspaceRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $scheduledAction -Trigger $trigger -Principal $principal -Settings $settings -Description "Versionstead read-only monitoring for $OwnerSid" -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Verify-Coordinator $roots $sourcesJson
    Write-Output 'Boot host registered under LocalService with saved owner npm/Bun sources. Explicit ProjectRoots are monitored as watch-only unless already selected. Verify boot-before-login and sign-out before relying on unattended monitoring.'
  }
  'Start' {
    if ($null -eq $task) { throw 'Install the boot host first.' }
    Start-ScheduledTask -TaskName $taskName
    Verify-Coordinator
  }
  'Stop' {
    if ($null -eq $task) { throw 'The boot host is not installed.' }
    Stop-Coordinator
    Write-Output 'Coordinator stopped gracefully. Startup registration remains installed.'
  }
  'Restart' {
    if ($null -eq $task) { throw 'Install the boot host first.' }
    Stop-Coordinator
    Start-ScheduledTask -TaskName $taskName
    Verify-Coordinator
  }
  'Uninstall' {
    if ($null -eq $task) { Write-Output 'The boot host is not installed.'; exit 0 }
    Stop-Coordinator
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output 'Startup registration removed. Evidence and explicit LocalService folder grants are preserved.'
  }
}
