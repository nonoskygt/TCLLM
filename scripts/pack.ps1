# TCLLM - empaquetado: dist\TCLLM-<ver>-win64.zip (código + node_modules + Node runtime) y, si hay iexpress, TCLLM-<ver>-setup.exe
# Uso: powershell -ExecutionPolicy Bypass -File scripts\pack.ps1 [-NoRuntime] [-NodeVersion 24.14.0]
param([switch]$NoRuntime, [string]$NodeVersion = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ver = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
$dist = "$root\dist"; $stage = "$dist\TCLLM"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Write-Host "== Empaquetando TCLLM $ver ==" -ForegroundColor Cyan

# 1. Archivos del proyecto
foreach ($d in 'bin','src','ps','panel','scripts','skills','docs') { if (Test-Path "$root\$d") { robocopy "$root\$d" "$stage\$d" /E /NFL /NDL /NJH /NJS | Out-Null } }
foreach ($f in 'package.json','package-lock.json','README.md','tcllm.cmd','LICENSE') { if (Test-Path "$root\$f") { Copy-Item "$root\$f" $stage } }

# 2. Dependencias de producción
Push-Location $stage
try { npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci falló" } } finally { Pop-Location }

# 3. Node runtime incluido (misma versión que la que empaqueta, o la indicada)
if (-not $NoRuntime) {
    if (-not $NodeVersion) { $NodeVersion = (node --version).TrimStart('v') }
    $zipName = "node-v$NodeVersion-win-x64.zip"; $cache = "$dist\$zipName"
    if (-not (Test-Path $cache)) { Write-Host "Descargando Node $NodeVersion ..."; Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$zipName" -OutFile $cache }
    Expand-Archive $cache -DestinationPath "$dist\_node" -Force
    Move-Item "$dist\_node\node-v$NodeVersion-win-x64" "$stage\runtime"
    Remove-Item "$dist\_node" -Recurse -Force
    Write-Host "Runtime Node $NodeVersion incluido"
}

# 4. install.cmd (doble clic) y ZIP
@"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
pause
"@ | Set-Content "$stage\install.cmd" -Encoding ASCII
$zip = "$dist\TCLLM-$ver-win64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal
Write-Host "ZIP: $zip ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)" -ForegroundColor Green

# 5. Auto-extraíble con iexpress (si existe): extrae el zip a %TEMP% y lanza el instalador
$iexpress = "$env:WINDIR\System32\iexpress.exe"
if (Test-Path $iexpress) {
    $setup = "$dist\TCLLM-$ver-setup.exe"
    $runner = "$dist\tcllm-setup-run.cmd"
    @"
@echo off
set "T=%TEMP%\TCLLM-$ver"
if exist "%T%" rmdir /s /q "%T%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%~dp0TCLLM-$ver-win64.zip' -DestinationPath '%T%' -Force"
powershell -NoProfile -ExecutionPolicy Bypass -File "%T%\scripts\install.ps1"
pause
"@ | Set-Content $runner -Encoding ASCII
    $sed = "$dist\tcllm.sed"
    @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$setup
FriendlyName=TCLLM $ver
AppLaunched=cmd.exe /c tcllm-setup-run.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
[SourceFiles]
SourceFiles0=$dist\
[SourceFiles0]
%FILE0%=
%FILE1%=
[Strings]
FILE0=TCLLM-$ver-win64.zip
FILE1=tcllm-setup-run.cmd
"@ | Set-Content $sed -Encoding ASCII
    if (Test-Path $setup) { Remove-Item $setup }
    & $iexpress /N /Q $sed | Out-Null
    if (Test-Path $setup) { Write-Host "Setup: $setup ($([math]::Round((Get-Item $setup).Length/1MB,1)) MB)" -ForegroundColor Green } else { Write-Host "iexpress no generó el setup (usa el ZIP)" -ForegroundColor Yellow }
}
Remove-Item $stage -Recurse -Force
