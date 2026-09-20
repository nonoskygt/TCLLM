# TCLLM - instalador para Windows (por usuario, sin admin salvo VirtualBox).
# Uso:  powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallDir C:\ruta] [-Port 7777] [-BindHost 127.0.0.1]
#                 [-NoVirtualBox] [-NoStart] [-Agents claude,codex,opencode,qwen,gemini,cursor,windsurf]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\TCLLM",
    [int]$Port = 7777,
    [string]$BindHost = '127.0.0.1',
    [switch]$NoVirtualBox,
    [switch]$NoStart,
    [string]$Agents = ''
)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot   # carpeta del paquete (contiene package.json)
if (-not (Test-Path "$src\package.json")) { throw "No encuentro package.json en $src. Ejecuta install.ps1 desde el paquete TCLLM extraído." }
$ver = (Get-Content "$src\package.json" -Raw | ConvertFrom-Json).version
Write-Host "== TCLLM $ver ==" -ForegroundColor Cyan

# 1. Copiar el paquete (si no se instala en sitio)
if ((Resolve-Path $src).Path -ne (Resolve-Path -LiteralPath $InstallDir -ErrorAction SilentlyContinue).Path) {
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    Write-Host "Copiando a $InstallDir ..."
    robocopy $src $InstallDir /E /NFL /NDL /NJH /NJS /XD "$src\.git" "$src\.dev-home" "$src\dist" /XF *.log | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy falló ($LASTEXITCODE)" }
}
Set-Location $InstallDir

# 2. Node: runtime incluido, o el del sistema, o winget
$node = if (Test-Path "$InstallDir\runtime\node.exe") { "$InstallDir\runtime\node.exe" } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
    Write-Host "Node.js no encontrado: instalando con winget (OpenJS.NodeJS.LTS)..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "Node.js sigue sin estar disponible; instálalo y vuelve a ejecutar." }
}
$nodeVer = & $node --version
Write-Host "Node: $node ($nodeVer)"
if ([int]($nodeVer -replace '^v(\d+).*', '$1') -lt 20) { throw "TCLLM necesita Node 20 o superior (tienes $nodeVer)" }

# 3. Dependencias (el paquete ya trae node_modules; si no, npm ci)
if (-not (Test-Path "$InstallDir\node_modules\@modelcontextprotocol")) {
    $npm = if (Test-Path "$InstallDir\runtime\npm.cmd") { "$InstallDir\runtime\npm.cmd" } else { 'npm' }
    Write-Host "Instalando dependencias (npm ci --omit=dev)..."
    & $npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci falló" }
}

# 4. VirtualBox (opcional; requiere UAC)
$vbm = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
if (-not (Test-Path $vbm)) {
    if ($NoVirtualBox) { Write-Host "VirtualBox no instalado (-NoVirtualBox): el control de VMs quedará deshabilitado hasta instalarlo." -ForegroundColor Yellow }
    else {
        Write-Host "VirtualBox no encontrado: instalando con winget (pedirá UAC)..." -ForegroundColor Yellow
        winget install --id Oracle.VirtualBox --exact --accept-package-agreements --accept-source-agreements --silent
        if (-not (Test-Path $vbm)) { Write-Host "VirtualBox no quedó instalado; puedes instalarlo después." -ForegroundColor Yellow }
    }
} else { Write-Host "VirtualBox: $(& $vbm --version)" }

# 5. Navegador para Playwright: Chrome si existe, si no Edge (siempre presente en Windows 10/11)
$browser = if ((Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") -or (Test-Path "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")) { 'chrome' } else { 'msedge' }
Write-Host "Navegador para Playwright: $browser"

# 6. Config inicial (~\.tcllm\config.json) con API key
$home_ = "$env:USERPROFILE\.tcllm"; New-Item -ItemType Directory -Force $home_, "$home_\logs" | Out-Null
$cfgFile = "$home_\config.json"
if (Test-Path $cfgFile) { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json } else { $cfg = [pscustomobject]@{} }
if (-not $cfg.server) { $cfg | Add-Member -NotePropertyName server -NotePropertyValue ([pscustomobject]@{}) }
if (-not $cfg.server.apiKey) { $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $cfg.server | Add-Member -Force -NotePropertyName apiKey -NotePropertyValue ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')) }
$cfg.server | Add-Member -Force -NotePropertyName port -NotePropertyValue $Port
$cfg.server | Add-Member -Force -NotePropertyName host -NotePropertyValue $BindHost
if (-not $cfg.playwright) { $cfg | Add-Member -NotePropertyName playwright -NotePropertyValue ([pscustomobject]@{ enabled = $true; port = 8932; browser = $browser; isolated = $true }) }
if (-not $cfg.vms) { $cfg | Add-Member -NotePropertyName vms -NotePropertyValue ([pscustomobject]@{}) }
[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))   # UTF-8 sin BOM
$apiKey = $cfg.server.apiKey

# 7. PATH de usuario + tarea programada al iniciar sesión (sesión interactiva: necesaria para mostrar/ocultar ventanas)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") { [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User') }
$vbs = "$InstallDir\scripts\start-hidden.vbs"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'TCLLM' -Action $action -Trigger $trigger -Settings $settings -Description "TCLLM $ver - Total Control for LLMs (API + MCP + panel)" -Force | Out-Null
Write-Host "Tarea programada 'TCLLM' registrada (arranca al iniciar sesión)."

# 8. Arrancar ahora
if (-not $NoStart) {
    Start-ScheduledTask -TaskName 'TCLLM'
    $deadline = (Get-Date).AddSeconds(30); $ok = $false
    while ((Get-Date) -lt $deadline) { try { $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2; if ($r.ok) { $ok = $true; break } } catch {}; Start-Sleep -Milliseconds 700 }
    if ($ok) { Write-Host "TCLLM responde en http://127.0.0.1:$Port" -ForegroundColor Green } else { Write-Host "TCLLM no respondió en 30 s; revisa $home_\logs\tcllm.log" -ForegroundColor Yellow }
}

# 9. Integración con agentes
if ($Agents) { & $node "$InstallDir\bin\tcllm.js" install-agents --for $Agents }

Write-Host ""
Write-Host "==== TCLLM instalado ====" -ForegroundColor Green
Write-Host "Panel:    http://127.0.0.1:$Port/"
Write-Host "MCP:      http://127.0.0.1:$Port/mcp   (Authorization: Bearer <API key>)"
Write-Host "API key:  $apiKey"
Write-Host "Config:   $cfgFile   (añade tus VMs en 'vms' con user/password del guest)"
Write-Host "Agentes:  tcllm install-agents        (Claude Code, Codex, OpenCode, Qwen Code, Gemini CLI, Cursor, Windsurf)"
Write-Host "Estado:   tcllm status"
