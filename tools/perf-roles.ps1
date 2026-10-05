# Attribute CPU/GPU/RSS per VS Code process ROLE (renderer / gpu-process / extensionHost
# / utility / main), so a measurement is not polluted by whatever else the user has
# installed. Process type comes from the Electron command line.
#   .\perf-roles.ps1 -Seconds 15 -Label "both-live"
param([int]$Seconds = 15, [string]$Label = 'sample')

$procs = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" -ErrorAction SilentlyContinue
if (-not $procs) { Write-Host 'NO_CODE_PROCESSES'; exit 1 }

function RoleOf([string]$cmd) {
  if (-not $cmd) { return 'main' }
  if ($cmd -match '--type=([a-zA-Z-]+)') {
    $t = $Matches[1]
    if ($t -eq 'renderer') { return 'renderer' }
    if ($t -eq 'gpu-process') { return 'gpu' }
    if ($t -eq 'utility' -and $cmd -match 'extensionHost') { return 'exthost' }
    return $t
  }
  return 'main'
}

$role = @{}
foreach ($p in $procs) { $role[[int]$p.ProcessId] = RoleOf $p.CommandLine }
$pids = @($role.Keys)

$before = @{}
foreach ($p in @(Get-Process Code -ErrorAction SilentlyContinue)) {
  $before[$p.Id] = $p.TotalProcessorTime.TotalSeconds
}
$gpuBy = @{}

for ($i = 0; $i -lt $Seconds; $i++) {
  Start-Sleep -Seconds 1
  try {
    $rows = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop |
      Where-Object { $_.Name -match 'pid_(\d+)' -and $pids -contains [int]$Matches[1] }
    foreach ($r in $rows) {
      $null = $r.Name -match 'pid_(\d+)'
      $pid2 = [int]$Matches[1]
      if (-not $gpuBy.ContainsKey($pid2)) { $gpuBy[$pid2] = New-Object System.Collections.Generic.List[double] }
      $gpuBy[$pid2].Add([double]$r.UtilizationPercentage)
    }
  } catch { }
}

$after = @{}
foreach ($p in @(Get-Process Code -ErrorAction SilentlyContinue)) { $after[$p.Id] = $p.TotalProcessorTime.TotalSeconds }

$byRole = @{}
foreach ($id in $before.Keys) {
  if (-not $after.ContainsKey($id)) { continue }
  $cpu = ($after[$id] - $before[$id]) / $Seconds * 100
  $r = if ($role.ContainsKey($id)) { $role[$id] } else { 'other' }
  if (-not $byRole.ContainsKey($r)) { $byRole[$r] = [pscustomobject]@{ Role = $r; CpuPct = 0.0; Procs = 0; GpuSum = 0.0 } }
  $byRole[$r].CpuPct += $cpu
  $byRole[$r].Procs += 1
  if ($gpuBy.ContainsKey($id)) { $byRole[$r].GpuSum += ($gpuBy[$id] | Measure-Object -Average).Average }
}

$total = [math]::Round(($byRole.Values | Measure-Object -Property CpuPct -Sum).Sum, 1)
Write-Host ("[{0}] {1}s  CPU(all Code)={2}% of one core" -f $Label, $Seconds, $total)
$byRole.Values | Sort-Object CpuPct -Descending | ForEach-Object {
  Write-Host ("    {0,-10} cpu {1,6:N1}%   gpu {2,5:N1}%   procs {3}" -f $_.Role, $_.CpuPct, $_.GpuSum, $_.Procs)
}
