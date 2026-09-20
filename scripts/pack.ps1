# TCLLM - empaquetado: dist\TCLLM-<ver>-win64.zip (código + node_modules + Node runtime) y TCLLM-<ver>-setup.exe (auto-extraíble)
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
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\install.ps1`" %*`r`npause`r`n" | Set-Content "$stage\install.cmd" -Encoding ASCII -NoNewline
$zip = "$dist\TCLLM-$ver-win64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal
Write-Host "ZIP: $zip ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)" -ForegroundColor Green

# 5. Auto-extraíble: stub C# (csc.exe de .NET Framework, presente en todo Windows) + ZIP adjunto tras el marcador TCLLMZIP!
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (Test-Path $csc) {
    $setup = "$dist\TCLLM-$ver-setup.exe"; $stub = "$dist\_stub.exe"
    & $csc /nologo /optimize /target:exe /out:$stub /reference:System.IO.Compression.FileSystem.dll /reference:System.IO.Compression.dll "$root\scripts\sfx\Setup.cs"
    if ($LASTEXITCODE -eq 0) {
        $out = [IO.File]::Create($setup)
        try {
            $b = [IO.File]::ReadAllBytes($stub); $out.Write($b, 0, $b.Length)
            $m = [Text.Encoding]::ASCII.GetBytes('TCLLMZIP!'); $out.Write($m, 0, $m.Length)
            $z = [IO.File]::ReadAllBytes($zip); $out.Write($z, 0, $z.Length)
        } finally { $out.Close() }
        Remove-Item $stub
        Write-Host "Setup: $setup ($([math]::Round((Get-Item $setup).Length/1MB,1)) MB)" -ForegroundColor Green
    } else { Write-Host "csc no pudo compilar el stub; usa el ZIP" -ForegroundColor Yellow }
} else { Write-Host "csc.exe no encontrado; usa el ZIP" -ForegroundColor Yellow }

Remove-Item $stage -Recurse -Force
