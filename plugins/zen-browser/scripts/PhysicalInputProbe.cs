using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Passive provenance signal only. No keystrokes, text, or key codes leave this process.
// BiDi events are generated inside Gecko and never pass through the OS keyboard hook.
internal static class PhysicalInputProbe {
    private delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct Key { public uint vk, scan, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; public uint privateData; }
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr hwnd, uint first, uint last);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    private static Hook callback;
    private static long counter;
    private static long lastInputAt;
    private static uint browserPid;
    private static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    private static IntPtr Observe(int code, IntPtr message, IntPtr data) {
        if (code >= 0 && (message.ToInt32() == 0x100 || message.ToInt32() == 0x104)) {
            uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            if (pid == browserPid) {
                Key key = (Key)Marshal.PtrToStructure(data, typeof(Key));
                bool modifier = key.vk == 0x10 || key.vk == 0x11 || key.vk == 0x12 || (key.vk >= 0xA0 && key.vk <= 0xA5);
                bool browserShortcut = Down(0x11) && (key.vk == 9 || key.vk == 0x4C || key.vk == 0x52 || key.vk == 0x54 || key.vk == 0x57 || key.vk == 0x4E);
                if (!modifier && !browserShortcut && !Down(0x12) && !Down(0x5B) && !Down(0x5C)) {
                    Interlocked.Exchange(ref lastInputAt, (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000L);
                    Interlocked.Increment(ref counter);
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }
    public static int Main(string[] args) {
        if (args.Length != 1 || !UInt32.TryParse(args[0], out browserPid)) return 2;
        callback = Observe;
        IntPtr hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) return 3;
        Console.WriteLine("{\"ready\":true,\"counter\":0}"); Console.Out.Flush();
        var reporter = new Thread(() => {
            try { string line; while ((line = Console.ReadLine()) != null) { int sample; if (!Int32.TryParse(line, out sample)) continue; Console.WriteLine("{\"sample\":" + sample + ",\"counter\":" + Interlocked.Read(ref counter) + ",\"at\":" + Interlocked.Read(ref lastInputAt) + "}"); Console.Out.Flush(); } Environment.Exit(0); }
            catch (System.IO.IOException) { Environment.Exit(0); }
        });
        reporter.IsBackground = true; reporter.Start();
        try { Message message; while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { } }
        finally { UnhookWindowsHookEx(hook); }
        return 0;
    }
}
