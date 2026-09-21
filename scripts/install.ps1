# TCLLM - instalador para Windows (por usuario, sin admin salvo VirtualBox).
# Uso:  powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallDir C:\ruta] [-Port 7777] [-BindHost 127.0.0.1]
#                 [-NoVirtualBox] [-NoFirefox] [-NoStart] [-Agents claude,codex,opencode,qwen,gemini,cursor,windsurf]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\TCLLM",
    [int]$Port = 7777,
    [string]$BindHost = '127.0.0.1',
    [switch]$NoVirtualBox,
    [switch]$NoFirefox,
    [switch]$NoStart,
    [string]$Agents = ''
)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot   # carpeta del paquete (contiene package.json)
if (-not (Test-Path -LiteralPath "$src\package.json")) { throw "No encuentro package.json en $src. Ejecuta install.ps1 desde el paquete TCLLM extraido." }
$ver = (Get-Content -LiteralPath "$src\package.json" -Raw | ConvertFrom-Json).version
Write-Host "== TCLLM $ver ==" -ForegroundColor Cyan
if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Aviso: estas ejecutando el instalador ELEVADO. TCLLM se instala por usuario ($env:USERNAME); no hace falta admin." -ForegroundColor Yellow
}
$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

# 0. Si ya hay una instancia corriendo desde $InstallDir (reinstalacion/actualizacion), pararla antes de copiar
$parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$running = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne $parentPid -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)) }
if ($running) {
    Write-Host "Deteniendo la instancia de TCLLM en ejecucion ($(@($running).Count) procesos)..."
    Stop-ScheduledTask -TaskName 'TCLLM' -ErrorAction SilentlyContinue
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Wait-Process -Id ($running | Select-Object -ExpandProperty ProcessId) -Timeout 10 -ErrorAction SilentlyContinue
}

# 1. Copiar el paquete (si no se instala en sitio)
$srcResolved = (Resolve-Path -LiteralPath $src).Path
$dstResolved = if (Test-Path -LiteralPath $InstallDir) { (Resolve-Path -LiteralPath $InstallDir).Path } else { $null }
if ($srcResolved -ne $dstResolved) {
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    Write-Host "Copiando a $InstallDir ..."
    robocopy $src $InstallDir /E /R:3 /W:2 /NFL /NDL /NJH /NJS /XD "$src\.git" "$src\.dev-home" "$src\dist" /XF *.log | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy fallo ($LASTEXITCODE)" }
}
Set-Location -LiteralPath $InstallDir

# 2. Node: runtime incluido, o el del sistema, o winget
$node = if (Test-Path -LiteralPath "$InstallDir\runtime\node.exe") { "$InstallDir\runtime\node.exe" } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
    if (-not $hasWinget) { throw "Node.js no encontrado y winget no esta disponible. Instala Node.js 20+ (https://nodejs.org) o usa el paquete con runtime incluido." }
    Write-Host "Node.js no encontrado: instalando con winget (OpenJS.NodeJS.LTS)..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "Node.js sigue sin estar disponible; instalalo y vuelve a ejecutar." }
}
$nodeVer = & $node --version
Write-Host "Node: $node ($nodeVer)"
if ([int]($nodeVer -replace '^v(\d+).*', '$1') -lt 20) { throw "TCLLM necesita Node 20 o superior (tienes $nodeVer)" }

# 3. Dependencias (el paquete ya trae node_modules; si no, npm ci)
if (-not (Test-Path -LiteralPath "$InstallDir\node_modules\@modelcontextprotocol")) {
    $npm = if (Test-Path -LiteralPath "$InstallDir\runtime\npm.cmd") { "$InstallDir\runtime\npm.cmd" } else { 'npm' }
    Write-Host "Instalando dependencias (npm ci --omit=dev)..."
    & $npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci fallo" }
}

# 4. VirtualBox (opcional; requiere UAC)
$vbm = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
if (-not (Test-Path -LiteralPath $vbm)) {
    if ($NoVirtualBox) { Write-Host "VirtualBox no instalado (-NoVirtualBox): el control de VMs quedara deshabilitado hasta instalarlo." -ForegroundColor Yellow }
    elseif (-not $hasWinget) { Write-Host "VirtualBox no encontrado y winget no disponible: instalalo desde https://www.virtualbox.org cuando quieras controlar VMs." -ForegroundColor Yellow }
    else {
        Write-Host "VirtualBox no encontrado: instalando con winget (pedira UAC)..." -ForegroundColor Yellow
        winget install --id Oracle.VirtualBox --exact --accept-package-agreements --accept-source-agreements --silent
        if ($LASTEXITCODE -ne 0) { Write-Host "winget devolvio $LASTEXITCODE; puedes instalar VirtualBox despues." -ForegroundColor Yellow }
        if (-not (Test-Path -LiteralPath $vbm)) { Write-Host "VirtualBox no quedo instalado; puedes instalarlo despues." -ForegroundColor Yellow }
    }
} else { Write-Host "VirtualBox: $(& $vbm --version)" }

# 5. Navegador para Playwright: Firefox (build propia de Playwright, se descarga ~100 MB) por defecto; si no se puede, Chrome o Edge
$fallback = if ((Test-Path -LiteralPath "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") -or (Test-Path -LiteralPath "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") -or (Test-Path -LiteralPath "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")) { 'chrome' } else { 'msedge' }
$browser = $fallback
if ($NoFirefox) { Write-Host "Firefox omitido (-NoFirefox); navegador: $browser" }
else {
    Write-Host "Instalando Firefox (build de Playwright, ~100 MB)..."
    & $node "$InstallDir\node_modules\@playwright\mcp\cli.js" install-browser firefox --no-progress --no-remove 2>&1 | Select-Object -Last 2 | ForEach-Object { "  $_" }
    $rev = ((Get-Content -LiteralPath "$InstallDir\node_modules\playwright-core\browsers.json" -Raw | ConvertFrom-Json).browsers | Where-Object { $_.name -eq 'firefox' }).revision
    $pwDir = if ($env:PLAYWRIGHT_BROWSERS_PATH -and $env:PLAYWRIGHT_BROWSERS_PATH -ne '0') { $env:PLAYWRIGHT_BROWSERS_PATH } else { "$env:LOCALAPPDATA\ms-playwright" }
    if (Test-Path -LiteralPath "$pwDir\firefox-$rev\INSTALLATION_COMPLETE") { $browser = 'firefox'; Write-Host "Navegador para Playwright: firefox (build $rev)" }
    else { Write-Host "No se pudo instalar Firefox (sin red?); navegador: $browser. Puedes instalarlo luego desde el panel > Navegador." -ForegroundColor Yellow }
}

# 6. Config (%USERPROFILE%\.tcllm\config.json): se crea si no existe; en reinstalaciones se respeta lo que haya
$home_ = "$env:USERPROFILE\.tcllm"; New-Item -ItemType Directory -Force $home_, "$home_\logs" | Out-Null
$cfgFile = "$home_\config.json"
if (Test-Path -LiteralPath $cfgFile) { $cfg = (Get-Content -LiteralPath $cfgFile -Raw) -replace '^\xEF\xBB\xBF', '' | ConvertFrom-Json } else { $cfg = [pscustomobject]@{} }
if (-not $cfg.server) { $cfg | Add-Member -NotePropertyName server -NotePropertyValue ([pscustomobject]@{}) }
if (-not $cfg.server.apiKey) { $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $cfg.server | Add-Member -Force -NotePropertyName apiKey -NotePropertyValue ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')) }
if (-not $cfg.server.port -or $PSBoundParameters.ContainsKey('Port')) { $cfg.server | Add-Member -Force -NotePropertyName port -NotePropertyValue $Port }
if (-not $cfg.server.host -or $PSBoundParameters.ContainsKey('BindHost')) { $cfg.server | Add-Member -Force -NotePropertyName host -NotePropertyValue $BindHost }
if (-not $cfg.playwright) { $cfg | Add-Member -NotePropertyName playwright -NotePropertyValue ([pscustomobject]@{ enabled = $true; port = 8932; browser = $browser; isolated = $true }) }
elseif ($cfg.playwright.browser -eq 'firefox' -and $browser -ne 'firefox' -and -not $NoFirefox) { Write-Host "La config pedia firefox pero no esta instalado; TCLLM elegira otro al arrancar." -ForegroundColor Yellow }
if (-not $cfg.vms) { $cfg | Add-Member -NotePropertyName vms -NotePropertyValue ([pscustomobject]@{}) }
[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))   # UTF-8 sin BOM
$apiKey = $cfg.server.apiKey; $Port = [int]$cfg.server.port

# 7. PATH de usuario + tarea programada al iniciar sesion (sesion interactiva: necesaria para mostrar/ocultar ventanas)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") { [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User') }
$vbs = "$InstallDir\scripts\start-hidden.vbs"
if (Get-Command wscript.exe -ErrorAction SilentlyContinue) {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
} else {
    # Windows sin VBScript (Feature on Demand retirada): consola oculta con conhost --headless
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" `"$InstallDir\bin\tcllm.js`" start" -WorkingDirectory $InstallDir
}
# Dos disparadores: al iniciar sesion, y cada 5 min como watchdog. El segundo relanza TCLLM si el proceso murio sin que
# se cerrara la sesion (p.ej. un apagado abortado mata los procesos pero el logon no se repite); con MultipleInstances=IgnoreNew
# no crea duplicados mientras la tarea sigue corriendo. RestartCount no sirve para esto: solo actua si la tarea no pudo lanzarse.
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) -RepetitionInterval (New-TimeSpan -Minutes 5)))
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
try {
    Register-ScheduledTask -TaskName 'TCLLM' -Action $action -Trigger $triggers -Settings $settings -Description "TCLLM $ver - Total Control for LLMs (API + MCP + panel)" -Force -ErrorAction Stop | Out-Null
} catch {
    # Una tarea creada desde una consola elevada pertenece a Administradores y no se puede actualizar sin elevar
    if (Get-ScheduledTask -TaskName 'TCLLM' -ErrorAction SilentlyContinue) { throw "No se pudo actualizar la tarea programada 'TCLLM' ($($_.Exception.Message)). Fue creada desde una consola elevada: ejecuta este instalador como administrador, o borrala (Unregister-ScheduledTask TCLLM) y vuelve a instalar." }
    throw
}
Write-Host "Tarea programada 'TCLLM' registrada (arranca al iniciar sesion; watchdog cada 5 min)."

# 8. Arrancar ahora
if (-not $NoStart) {
    Start-ScheduledTask -TaskName 'TCLLM'
    $deadline = (Get-Date).AddSeconds(60); $ok = $false
    while ((Get-Date) -lt $deadline) { try { $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2; if ($r.ok) { $ok = $true; break } } catch {}; Start-Sleep -Milliseconds 700 }
    if ($ok) { Write-Host "TCLLM responde en http://127.0.0.1:$Port" -ForegroundColor Green }
    else {
        Write-Host "TCLLM no respondio en 60 s (puede seguir arrancando). Revisa $home_\logs\stdout.log, tcllm.log y crash.log:" -ForegroundColor Yellow
        foreach ($f in 'stdout.log','crash.log') { if (Test-Path -LiteralPath "$home_\logs\$f") { Get-Content -LiteralPath "$home_\logs\$f" -Tail 5 | ForEach-Object { "  $f> $_" } } }
    }
}

# 9. Integracion con agentes
if ($Agents) { & $node "$InstallDir\bin\tcllm.js" install-agents --for $Agents }

Write-Host ""
Write-Host "==== TCLLM instalado ====" -ForegroundColor Green
Write-Host "Panel:    http://127.0.0.1:$Port/"
Write-Host "MCP:      http://127.0.0.1:$Port/mcp   (Authorization: Bearer <API key>)"
Write-Host "API key:  $apiKey"
Write-Host "Config:   $cfgFile   (anade tus VMs en 'vms' con user/password del guest)"
Write-Host "Agentes:  tcllm install-agents        (Claude Code, Codex, OpenCode, Qwen Code, Gemini CLI, Cursor, Windsurf)"
Write-Host "Estado:   tcllm status"
Write-Host "Quitar:   powershell -ExecutionPolicy Bypass -File `"$InstallDir\scripts\uninstall.ps1`" [-Purge]"
