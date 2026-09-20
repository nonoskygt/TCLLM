# TCLLM - desinstalador. Uso: powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\TCLLM\scripts\uninstall.ps1" [-Purge]
#   -Purge borra tambien %USERPROFILE%\.tcllm (config, API key y logs)
param([switch]$Purge)
$ErrorActionPreference = 'Continue'
$InstallDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath "$InstallDir\bin\tcllm.js") -or -not (Test-Path -LiteralPath "$InstallDir\scripts\start-hidden.vbs")) { throw "$InstallDir no parece una instalacion de TCLLM (ejecuta el uninstall.ps1 de la carpeta instalada, no del paquete)." }
Write-Host "Desinstalando TCLLM de $InstallDir"
Unregister-ScheduledTask -TaskName 'TCLLM' -Confirm:$false -ErrorAction SilentlyContinue
# Procesos que corren desde la instalacion (node del servidor, Playwright MCP, bridge PowerShell), sin matarnos a nosotros ni a nuestro padre
$parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$procs = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne $parentPid -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)) }
if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Wait-Process -Id ($procs | Select-Object -ExpandProperty ProcessId) -Timeout 10 -ErrorAction SilentlyContinue }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', (($userPath -split ';') | Where-Object { $_ -and $_ -ne $InstallDir }) -join ';', 'User')
if ($Purge) { Remove-Item -LiteralPath "$env:USERPROFILE\.tcllm" -Recurse -Force -ErrorAction SilentlyContinue }
Set-Location $env:USERPROFILE
Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $InstallDir) { Write-Host "Quedaron archivos en $InstallDir (algun proceso los tenia abiertos); borralo a mano tras cerrar sesion." -ForegroundColor Yellow }
else { Write-Host "Listo. (Las entradas 'tcllm' anadidas a los agentes no se tocan; borralas si quieres.)" }
