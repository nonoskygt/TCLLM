# Regla de firewall de entrada para el Playwright MCP de TCLLM. Se ejecuta ELEVADO (lo lanza src/access.js con UAC).
# Borra reglas anteriores del puerto (incluida la 'Playwright MCP' del servicio retirado) y crea una sola, propia,
# limitada a las IPs/subredes indicadas en -Remote ('Any' = cualquiera). Escribe el resultado en -Result como JSON.
param(
  [int]$Port = 8931,
  [string]$Remote = 'Any',
  [string]$Result = ''
)
$ErrorActionPreference = 'Stop'
$name = "TCLLM Playwright ($Port)"
try {
  # Limpia la regla propia anterior y la del servicio suelto retirado, para no acumular ni dejar una 'Any' que anule el filtro.
  Get-NetFirewallRule -DisplayName $name, 'Playwright MCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  if ([string]::IsNullOrWhiteSpace($Remote) -or $Remote -eq '*' -or $Remote -eq 'Any' -or $Remote -eq 'any') {
    $ra = @('Any')
  } else {
    $ra = @($Remote -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress $ra -Profile Any -Enabled True | Out-Null
  $res = [ordered]@{ ok = $true; name = $name; port = $Port; remote = $ra }
} catch {
  $res = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
if ($Result) { $res | ConvertTo-Json -Compress | Set-Content -Encoding utf8 -LiteralPath $Result }
if (-not $res.ok) { exit 1 }
