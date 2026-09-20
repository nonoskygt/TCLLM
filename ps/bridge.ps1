# TCLLM PowerShell bridge: proceso persistente que atiende peticiones JSON (una por linea) por stdin
# y responde JSON por stdout. Cubre lo que Node no puede hacer sin modulos nativos:
#   - raton absoluto en VMs de VirtualBox (COM IMouse)      op: mouse {vm,x,y,dz,buttons}
#   - ventanas Win32: listar / mostrar / ocultar / traer al frente   op: windows | show | hide | minimize | restore | foreground {hwnd}
#   - procesos con linea de comandos                          op: procs {names:[...]}
#   - portapapeles del host                                   op: clipboard {text}
#   - salud del host (cpu, ram, discos)                       op: host
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TcWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  public class W { public long hwnd; public uint pid; public string title; public bool visible; public bool minimized; }
  public static List<W> List(bool includeHidden) {
    var list = new List<W>();
    EnumWindows((h, l) => {
      bool vis = IsWindowVisible(h);
      if (!vis && !includeHidden) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true; // GW_OWNER: solo ventanas sin dueno (top-level reales)
      int n = GetWindowTextLength(h); if (n == 0) return true;
      var sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new W { hwnd = h.ToInt64(), pid = pid, title = sb.ToString(), visible = vis, minimized = IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

$vbox = $null
function Get-VBox { if (-not $script:vbox) { $script:vbox = New-Object -ComObject VirtualBox.VirtualBox }; return $script:vbox }

function Do-Mouse($r) {
  $vb = Get-VBox
  $m = $vb.FindMachine([string]$r.vm)
  $s = New-Object -ComObject VirtualBox.Session
  $m.LockMachine($s, 1)  # LockType_Shared
  try {
    $buttons = if ($r.buttons) { [int]$r.buttons } else { 0 }
    $dz = if ($r.dz) { [int]$r.dz } else { 0 }
    # La API cuenta desde 1; nuestras coordenadas (captura) son 0-based.
    $s.Console.Mouse.PutMouseEventAbsolute([int]$r.x + 1, [int]$r.y + 1, $dz, 0, $buttons)
  } finally { try { $s.UnlockMachine() } catch {} }
  return @{ x = $r.x; y = $r.y; buttons = $buttons }
}

function Do-Windows($r) {
  $names = @{}
  Get-Process | ForEach-Object { $names[[uint32]$_.Id] = $_.ProcessName }
  $out = @()
  foreach ($w in [TcWin]::List([bool]$r.includeHidden)) {
    $out += @{ hwnd = $w.hwnd; pid = $w.pid; process = $names[[uint32]$w.pid]; title = $w.title; visible = $w.visible; minimized = $w.minimized }
  }
  return ,$out
}

function Do-Procs($r) {
  $filter = ($r.names | ForEach-Object { "Name='$_'" }) -join ' OR '
  $out = @()
  foreach ($p in (Get-CimInstance Win32_Process -Filter $filter)) {
    $out += @{ pid = $p.ProcessId; ppid = $p.ParentProcessId; name = $p.Name; cmd = $p.CommandLine }
  }
  return ,$out
}

function Do-Host {
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  $disks = @()
  foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) { $disks += @{ drive = $d.DeviceID; freeGB = [math]::Round($d.FreeSpace/1GB,1); totalGB = [math]::Round($d.Size/1GB,1) } }
  return @{ cpuPercent = [int]$cpu; ramTotalMB = [int]($os.TotalVisibleMemorySize/1KB); ramFreeMB = [int]($os.FreePhysicalMemory/1KB); disks = $disks; hostname = $env:COMPUTERNAME; hypervisorPresent = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent }
}

$SW = @{ hide = 0; show = 5; minimize = 6; restore = 9 }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $r = $line | ConvertFrom-Json
    $id = $r.id
    $res = switch ($r.op) {
      'ping'       { 'pong' }
      'mouse'      { Do-Mouse $r }
      'windows'    { Do-Windows $r }
      'procs'      { Do-Procs $r }
      'host'       { Do-Host }
      'clipboard'  { Set-Clipboard -Value ([string]$r.text); 'ok' }
      'show'       { [TcWin]::ShowWindow([IntPtr][long]$r.hwnd, $SW.show) | Out-Null; [TcWin]::SetForegroundWindow([IntPtr][long]$r.hwnd) | Out-Null; 'ok' }
      'hide'       { [TcWin]::ShowWindow([IntPtr][long]$r.hwnd, $SW.hide) | Out-Null; 'ok' }
      'minimize'   { [TcWin]::ShowWindow([IntPtr][long]$r.hwnd, $SW.minimize) | Out-Null; 'ok' }
      'restore'    { [TcWin]::ShowWindow([IntPtr][long]$r.hwnd, $SW.restore) | Out-Null; 'ok' }
      'foreground' { [TcWin]::SetForegroundWindow([IntPtr][long]$r.hwnd) | Out-Null; 'ok' }
      'exit'       { [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = 'bye' } | ConvertTo-Json -Compress)); exit 0 }
      default      { throw "op desconocida: $($r.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $res } | ConvertTo-Json -Compress -Depth 6))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
