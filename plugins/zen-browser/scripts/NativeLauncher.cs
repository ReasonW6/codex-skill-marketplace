using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

// Windows Native Messaging launcher. No cmd.exe, console window or shell expansion.
// Node remains the protocol implementation; this shim forwards raw binary streams.
internal static class NativeLauncher
{
    private static void Pump(Stream source, Stream destination)
    {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            destination.Write(buffer, 0, count);
            // Native messages are small. Do not wait for a full pipe buffer or EOF.
            destination.Flush();
        }
    }

    private static void Stop(Process child)
    {
        try { if (!child.HasExited) child.Kill(); } catch (InvalidOperationException) { }
    }

    public static int Main()
    {
        try
        {
            string[] config = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher-paths.txt"), Encoding.UTF8);
            if (config.Length != 3) throw new InvalidDataException("Invalid native launcher configuration.");
            foreach (string value in config)
                if (String.IsNullOrWhiteSpace(value) || value.IndexOf('"') >= 0)
                    throw new InvalidDataException("Invalid native launcher path.");
            var info = new ProcessStartInfo
            {
                FileName = config[0], Arguments = "\"" + config[1] + "\" --data-dir \"" + config[2] + "\"",
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (Process child = Process.Start(info))
            {
                Task input = Task.Run(() =>
                {
                    try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    catch (IOException) { Stop(child); }
                    finally { try { child.StandardInput.Close(); } catch (IOException) { } }
                });
                Task output = Task.Run(() =>
                {
                    try { Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); }
                    catch (IOException) { Stop(child); }
                });
                Task errors = Task.Run(() =>
                {
                    try { Pump(child.StandardError.BaseStream, Console.OpenStandardError()); }
                    catch (IOException) { Stop(child); }
                });
                child.WaitForExit();
                Task.WaitAll(output, errors);
                // Do not wait for input: the browser may keep stdin open after Node exits.
                GC.KeepAlive(input);
                return child.ExitCode;
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
