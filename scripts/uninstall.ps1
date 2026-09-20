# TCLLM - desinstalador. Uso: powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge]  (-Purge borra también ~\.tcllm con config/logs)
param([switch]$Purge)
$ErrorActionPreference = 'Continue'
$InstallDir = Split-Path -Parent $PSScriptRoot
Write-Host "Desinstalando TCLLM de $InstallDir"
Unregister-ScheduledTask -TaskName 'TCLLM' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', (($userPath -split ';') | Where-Object { $_ -and $_ -ne $InstallDir }) -join ';', 'User')
if ($Purge) { Remove-Item "$env:USERPROFILE\.tcllm" -Recurse -Force -ErrorAction SilentlyContinue }
Set-Location $env:USERPROFILE
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Listo. (Las configuraciones MCP añadidas a los agentes no se tocan; borra la entrada 'tcllm' si quieres.)"
