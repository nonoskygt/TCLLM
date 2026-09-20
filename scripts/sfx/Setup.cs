// TCLLM setup stub: extrae el ZIP adjunto (tras el marcador TCLLMZIP!) a %TEMP%\TCLLM-setup y lanza scripts\install.ps1
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;

static class Setup {
    const string Marker = "TCLLMZIP!";
    static void Pause() { if (!Console.IsInputRedirected) { Console.WriteLine("Pulsa una tecla para cerrar."); Console.ReadKey(); } }
    static int Main(string[] args) {
        string dir = Path.Combine(Path.GetTempPath(), "TCLLM-setup");
        try {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            byte[] data = File.ReadAllBytes(self);
            byte[] mark = Encoding.ASCII.GetBytes(Marker);
            int at = -1;
            for (int i = data.Length - mark.Length; i >= 0; i--) { // buscar desde el final: el marcador precede al zip
                bool ok = true; for (int j = 0; j < mark.Length; j++) if (data[i + j] != mark[j]) { ok = false; break; }
                if (ok) { at = i; break; }
            }
            if (at < 0) { Console.Error.WriteLine("No hay paquete adjunto."); Pause(); return 2; }
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            string zip = Path.Combine(dir, "package.zip");
            using (var fs = new FileStream(zip, FileMode.Create)) fs.Write(data, at + mark.Length, data.Length - at - mark.Length);
            Console.WriteLine("Extrayendo TCLLM a " + dir + " ...");
            ZipFile.ExtractToDirectory(zip, dir);
            File.Delete(zip);
            // Los argumentos se reenvian entrecomillados (rutas con espacios: -InstallDir "D:\Mis Apps\TCLLM")
            string fwd = string.Join(" ", Array.ConvertAll(args, a => "\"" + a.Replace("\"", "\\\"") + "\""));
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(dir, "scripts", "install.ps1") + "\" " + fwd) { UseShellExecute = false };
            int rc;
            using (var p = Process.Start(psi)) { p.WaitForExit(); rc = p.ExitCode; }
            try { Directory.Delete(dir, true); } catch { }
            Pause();
            return rc;
        } catch (Exception e) { Console.Error.WriteLine("Error: " + e.Message); Pause(); return 1; }
    }
}
