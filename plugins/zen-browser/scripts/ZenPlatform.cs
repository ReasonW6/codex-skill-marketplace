using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Microsoft.Win32;

// Narrow Windows operations used by the connection service. This executable has no
// dependency on PowerShell, Node on PATH, a compiler, or administrator privileges.
internal static class ZenPlatform
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly WindowsIdentity Identity = WindowsIdentity.GetCurrent();
    private const string RegistryParent = @"Software\Mozilla\NativeMessagingHosts";
    private const string Recommended = "remote.prefs.recommended";
    private const string ResumeOnce = "browser.sessionstore.resume_session_once";

    private sealed class Failure : Exception
    {
        public readonly string Code;
        public Failure(string code, string message) : base(message) { Code = code; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct AffectedProcess
    {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
        public uint Type, Status, Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] private static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] private static extern int RmRegisterResources(uint session, uint fileCount, string[] files, uint processCount, UniqueProcess[] processes, uint serviceCount, string[] services);
    [DllImport("rstrtmgr.dll")] private static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] AffectedProcess[] processes, ref uint reasons);
    [DllImport("rstrtmgr.dll")] private static extern int RmShutdown(uint session, uint flags, IntPtr callback);
    [DllImport("rstrtmgr.dll")] private static extern int RmEndSession(uint session);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name);
    private static string PackageName()
    {
        uint length = 0; int result = GetCurrentPackageFullName(ref length, null);
        if (result == 15700) return null;
        if (result != 122) return "unavailable:" + result.ToString(CultureInfo.InvariantCulture);
        var name = new StringBuilder((int)length);
        return GetCurrentPackageFullName(ref length, name) == 0 ? name.ToString() : "unavailable";
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public long PerProcessUserTime, PerJobUserTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JobLimits limits, uint size, out uint returned);
    private static object JobState()
    {
        bool inJob;
        if (!IsProcessInJob(Process.GetCurrentProcess().Handle, IntPtr.Zero, out inJob)) throw new Failure("JOB_INSPECTION", "Windows process lifecycle inspection failed.");
        JobLimits limits = new JobLimits(); uint returned;
        if (inJob && !QueryInformationJobObject(IntPtr.Zero, 2, out limits, (uint)Marshal.SizeOf(typeof(JobLimits)), out returned)) throw new Failure("JOB_INSPECTION", "Windows job limits could not be read.");
        return Map("inJob", inJob, "limitFlags", limits.Flags);
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short Show, ReservedBytes; public IntPtr ReservedPointer, StandardInput, StandardOutput, StandardError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFileW(string file, uint access, uint sharing, ref SecurityAttributes security, uint disposition, uint attributes, IntPtr template);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    private static uint ShowLaunchedBrowser(uint launcherPid, string binary, string profile)
    {
        for (int attempt = 0; attempt < 40; attempt++)
        {
            var candidates = new List<int> { (int)launcherPid };
            using (var search = new ManagementObjectSearcher("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId=" + launcherPid.ToString(CultureInfo.InvariantCulture) + " AND Name='zen.exe'"))
            using (var results = search.Get()) foreach (ManagementObject process in results) candidates.Add(Convert.ToInt32(process["ProcessId"]));
            foreach (int pid in candidates)
            {
                var info = ProcessInfo(pid);
                if (info == null || info["profile"] == null || !Same((string)info["binary"], binary) || !Same((string)info["profile"], profile)) continue;
                try
                {
                    using (var process = Process.GetProcessById(pid))
                    {
                        IntPtr window = process.MainWindowHandle;
                        if (window == IntPtr.Zero) continue;
                        // The launcher can expose a short-lived placeholder with
                        // the same window class. Wait for real browser chrome.
                        var root = AutomationElement.FromHandle(window);
                        var chrome = root.FindFirst(TreeScope.Descendants, new OrCondition(
                            new PropertyCondition(AutomationElement.AutomationIdProperty, "nav-bar"),
                            new PropertyCondition(AutomationElement.AutomationIdProperty, "zen-welcome")));
                        if (chrome == null) continue;
                        // Gecko delays startup until its first paint. Expose this
                        // explicitly opened window without taking keyboard focus.
                        ShowWindowAsync(window, 4); // SW_SHOWNOACTIVATE
                        if (!SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0x0013)) // NOSIZE | NOMOVE | NOACTIVATE
                            throw new Failure("BROWSER_WINDOW_UNAVAILABLE", "Windows could not display the confirmed browser window.");
                        return (uint)pid;
                    }
                }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
                catch (ElementNotAvailableException) { }
            }
            Thread.Sleep(150);
        }
        throw new Failure("BROWSER_WINDOW_UNAVAILABLE", "Zen did not expose its initial window. Open the browser window and retry the connection.");
    }
    private static string Quote(string value)
    {
        // CommandLineToArgvW-compatible quoting, including trailing backslashes.
        return "\"" + Regex.Replace(value, @"(\\*)(""|$)", match => match.Groups[1].Value + match.Groups[1].Value + (match.Groups[2].Value == "\"" ? "\\\"" : "")) + "\"";
    }
    private static object LaunchBrowser(Dictionary<string, object> input)
    {
        NormalUser(); string binary = Full(Text(input, "binary")), profile = Full(Text(input, "profile")), record = Full(Text(input, "launchRecord"));
        OwnedDirectory(profile); OwnedDirectory(Path.GetDirectoryName(record));
        var info = FileVersionInfo.GetVersionInfo(binary);
        if (!String.Equals(Path.GetFileName(binary), "zen.exe", StringComparison.OrdinalIgnoreCase) || ((info.ProductName ?? "") + " " + (info.FileDescription ?? "")).IndexOf("Zen", StringComparison.OrdinalIgnoreCase) < 0)
            throw new Failure("WRONG_BROWSER", "The discovered executable is not Zen Browser.");
        if ((bool)ProfileState(profile)["locked"]) throw new Failure("PROFILE_IN_USE", "The selected profile is still running.");
        int port = Convert.ToInt32(input["port"]);
        if (port < 1 || port > 65535) throw new Failure("INVALID_PORT", "Invalid loopback port.");
        object supplied;
        if (input.TryGetValue("environment", out supplied))
            foreach (var pair in (Dictionary<string, object>)supplied)
            {
                if (!new[] { "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH" }.Contains(pair.Key) || !(pair.Value is string) || ((string)pair.Value).IndexOf('\0') >= 0)
                    throw new Failure("INVALID_INPUT", "Unsupported browser environment setting.");
                Environment.SetEnvironmentVariable(pair.Key, (string)pair.Value);
            }
        string command = Quote(binary) + " --new-instance --profile " + Quote(profile) + " --remote-debugging-port " + port.ToString(CultureInfo.InvariantCulture);
        if (Flag(input, "headless")) command += " --headless";
        Environment.SetEnvironmentVariable("ZEN_BROWSER_LAUNCH", record);
        // An inherited Firefox restart environment must not override this exact
        // profile. These changes affect this short-lived helper and its child only.
        Environment.SetEnvironmentVariable("XRE_PROFILE_PATH", null);
        Environment.SetEnvironmentVariable("XRE_PROFILE_LOCAL_PATH", null);
        var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
        IntPtr nullStream = CreateFileW("NUL", 0xc0000000, 3, ref security, 3, 0x80, IntPtr.Zero);
        if (nullStream == new IntPtr(-1)) throw new Failure("BROWSER_LAUNCH_FAILED", "Windows could not prepare browser I/O.");
        IntPtr logStream = IntPtr.Zero;
        if (Flag(input, "diagnostics"))
        {
            logStream = CreateFileW(record + ".log", 0x40000000, 3, ref security, 1, 0x80, IntPtr.Zero);
            if (logStream == new IntPtr(-1)) { CloseHandle(nullStream); throw new Failure("BROWSER_LAUNCH_FAILED", "Windows could not create the requested startup log."); }
        }
        var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x101, Show = Flag(input, "hidden") ? (short)4 : (short)1,
            StandardInput = nullStream, StandardOutput = logStream == IntPtr.Zero ? nullStream : logStream, StandardError = logStream == IntPtr.Zero ? nullStream : logStream };
        ProcessInformation child;
        // This worker is activated by the user's Windows desktop. It is not an
        // MCP descendant, and does not inherit the MCP transport's stdio handles.
        uint flags = 0x00000008 | 0x00000200;
        try
        {
            if (!CreateProcessW(binary, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, Path.GetDirectoryName(binary), ref startup, out child))
                throw new Failure("BROWSER_LAUNCH_FAILED", "Windows did not start the confirmed browser (" + Marshal.GetLastWin32Error() + "). Its process restrictions were left unchanged.");
        }
        finally { CloseHandle(nullStream); if (logStream != IntPtr.Zero) CloseHandle(logStream); }
        try { return Map("pid", Flag(input, "headless") ? child.ProcessId : ShowLaunchedBrowser(child.ProcessId, binary, profile), "independentLifecycle", true); }
        finally { CloseHandle(child.Thread); CloseHandle(child.Process); }
    }
    private static void ValidatePipe(string pipe, string nonce)
    {
        if (!Regex.IsMatch(pipe, "^ReasonW6\\.ZenBrowser\\.[a-f0-9]{40}$") || !Regex.IsMatch(nonce, "^[a-f0-9]{64}$"))
            throw new Failure("INVALID_INPUT", "Invalid desktop connection identity.");
    }
    private static object DispatchDesktop(Dictionary<string, object> input)
    {
        NormalUser(); string pipe = Text(input, "pipe"), nonce = Text(input, "nonce");
        ValidatePipe(pipe, nonce);
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        object windows = null, desktop = null, document = null, shell = null;
        try
        {
            // Standard ShellWindows desktop activation, following Microsoft's
            // Execute in Explorer pattern. No token, job or system setting edits.
            windows = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));
            object location = 0, locationRoot = null; int window = 0;
            desktop = ((dynamic)windows).FindWindowSW(ref location, ref locationRoot, 8, out window, 1);
            if (desktop == null) throw new Failure("DESKTOP_UNAVAILABLE", "The Windows desktop could not open Zen. Sign in to an interactive desktop and retry.");
            document = ((dynamic)desktop).Document; shell = ((dynamic)document).Application;
            // Only activate this exact helper; callers cannot supply a command.
            ((dynamic)shell).ShellExecute(executable, "--desktop-pipe " + Quote(pipe) + " " + Quote(nonce), Path.GetDirectoryName(executable), "open", 0);
            return Map("dispatched", true, "method", "Windows desktop application activation");
        }
        finally
        {
            foreach (object value in new[] { shell, document, desktop, windows }) if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
        }
    }
    private static int RunDesktopPipe(string pipe, string nonce)
    {
        NormalUser(); ValidatePipe(pipe, nonce);
        using (var stream = new NamedPipeClientStream(".", pipe, PipeDirection.InOut))
        {
            stream.Connect(10000);
            using (var deadline = new Timer(state => { try { stream.Close(); } catch (IOException) { } }, null, 60000, Timeout.Infinite))
            using (var reader = new StreamReader(stream, Utf8))
            using (var writer = new StreamWriter(stream, Utf8) { AutoFlush = true })
            {
                writer.WriteLine(Json.Serialize(Map("nonce", nonce)));
                var source = new StringBuilder();
                for (int next; (next = reader.Read()) != -1 && next != '\n'; )
                {
                    source.Append((char)next);
                    if (source.Length > 65536) throw new Failure("INVALID_INPUT", "Desktop request is too large.");
                }
                if (source.Length == 0) return 0;
                object result;
                try { result = Map("ok", true, "result", Execute(Json.Deserialize<Dictionary<string, object>>(source.ToString()))); }
                catch (Exception error) { result = ErrorResult(error); }
                writer.WriteLine(Json.Serialize(result));
            }
        }
        return 0;
    }

    private static object ErrorResult(Exception error)
    {
        var known = error as Failure;
        return Map("ok", false, "error", Map("code", known == null ? "PLATFORM_ERROR" : known.Code, "message", error.Message));
    }
    private static object Execute(Dictionary<string, object> input)
    {
        string action = Text(input, "action");
        switch (action)
        {
            case "profile-catalog":
                string catalog = Path.Combine(Full(Text(input, "roaming")), "zen", "profiles.ini");
                return Map("source", File.Exists(catalog) ? ReadText(catalog) : null);
            case "inspect": return Inspect(input);
            case "profile-state": return ProfileState(Text(input, "profile"));
            case "verify-process": return VerifyProcess(input);
            case "verify-install": return VerifyInstall(input);
        }
        NormalUser();
        // Keep an in-flight desktop mutation serialized even if Codex exits and
        // releases its longer-lived connection lock before this action finishes.
        using (var mutex = new Mutex(false, @"Local\ReasonW6.ZenBrowser.Settings." + Identity.User.Value))
        {
            bool acquired;
            try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new Failure("CONNECTION_BUSY", "Another Windows connection operation is still finishing. Retry shortly.");
            try
            {
                switch (action)
                {
                    case "launch-browser": return LaunchBrowser(input);
                    case "close-profile": return CloseProfile(input);
                    case "install": return Install(input);
                    case "restore-host": return RestoreHost(input);
                    case "prepare-profile": return PrepareProfile(input);
                    case "restore-profile": return RestoreProfile(input);
                    default: throw new Failure("UNKNOWN_ACTION", "Unknown Windows operation.");
                }
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private static Dictionary<string, object> Map(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]);
        return result;
    }
    private static string Text(Dictionary<string, object> input, string key, bool optional = false)
    {
        object value;
        if (!input.TryGetValue(key, out value) || value == null) { if (optional) return null; throw new Failure("INVALID_INPUT", "Missing " + key + "."); }
        string text = value as string;
        if (text == null || text.Length > 32760 || text.IndexOf('\0') >= 0) throw new Failure("INVALID_INPUT", "Invalid " + key + ".");
        return text;
    }
    private static bool Flag(Dictionary<string, object> input, string key)
    { object value; return input.TryGetValue(key, out value) && value is bool && (bool)value; }
    private static string Full(string value) { string full = Path.GetFullPath(value); return full.Length > Path.GetPathRoot(full).Length ? full.TrimEnd(Path.DirectorySeparatorChar) : full; }
    private static bool Same(string a, string b) { return String.Equals(Full(a), Full(b), StringComparison.OrdinalIgnoreCase); }
    private static string Hash(byte[] data) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(data)).Replace("-", "").ToLowerInvariant(); }
    private static string HashFile(string file) { using (var hash = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    private static string Host(Dictionary<string, object> input)
    {
        string host = Text(input, "hostName", true) ?? "io.github.reasonw6.zen_browser";
        if (!Regex.IsMatch(host, @"^io\.github\.reasonw6\.zen_browser(?:_test)?$")) throw new Failure("INVALID_HOST", "Unknown native host.");
        return host;
    }
    private static void NormalUser()
    {
        if (Identity.Name.IndexOf("CodexSandbox", StringComparison.OrdinalIgnoreCase) >= 0)
            throw new Failure("WRONG_ACCOUNT", "Connect from your normal Windows account, not a dedicated sandbox account.");
    }
    private static void OwnedDirectory(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new Failure("LINKED_DIRECTORY", "The target directory must not be a filesystem link.");
        var owner = (SecurityIdentifier)Directory.GetAccessControl(directory).GetOwner(typeof(SecurityIdentifier));
        if (!owner.Equals(Identity.User)) throw new Failure("WRONG_OWNER", "The selected directory belongs to another Windows account.");
    }
    private static void PrivateDirectory(string directory)
    {
        Directory.CreateDirectory(directory); OwnedDirectory(directory);
        var acl = new DirectorySecurity(); acl.SetOwner(Identity.User); acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { Identity.User, new SecurityIdentifier("S-1-5-18"), new SecurityIdentifier("S-1-5-32-544") })
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(directory, acl);
    }
    private static string[] Args(string command)
    {
        if (String.IsNullOrEmpty(command)) return new string[0];
        int count; IntPtr data = CommandLineToArgvW(command, out count);
        if (data == IntPtr.Zero) throw new Failure("PROCESS_INSPECTION", "Cannot read the browser command line.");
        try { var result = new string[count]; for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(data, i * IntPtr.Size)); return result; }
        finally { LocalFree(data); }
    }
    private static Dictionary<string, object> ProcessInfo(int pid)
    {
        try
        {
        using (var search = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine, SessionId FROM Win32_Process WHERE ProcessId=" + pid.ToString(CultureInfo.InvariantCulture)))
        using (var objects = search.Get())
        {
            foreach (ManagementObject process in objects)
            {
                string binary = process["ExecutablePath"] as string;
                if (String.IsNullOrEmpty(binary) || !String.Equals(Path.GetFileName(binary), "zen.exe", StringComparison.OrdinalIgnoreCase)) return null;
                using (var instance = new ManagementObject("Win32_Process.Handle='" + pid.ToString(CultureInfo.InvariantCulture) + "'"))
                using (var owner = instance.InvokeMethod("GetOwnerSid", null, null))
                    if (owner == null || !String.Equals(owner["Sid"] as string, Identity.User.Value, StringComparison.OrdinalIgnoreCase)) return null;
                string[] args = Args(process["CommandLine"] as string);
                if (args.Any(arg => String.Equals(arg, "-contentproc", StringComparison.OrdinalIgnoreCase))) return null;
                string profile = null;
                for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--profile" || args[i] == "-profile") profile = Full(args[i + 1]);
                using (Process live = Process.GetProcessById(pid))
                    return Map("pid", pid, "parentPid", Convert.ToInt32(process["ParentProcessId"]), "binary", Full(binary), "profile", profile,
                        "started", live.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture), "session", Convert.ToInt32(process["SessionId"]), "window", live.MainWindowHandle.ToInt64());
            }
        }
        return null;
        }
        catch (ManagementException error) { if (error.ErrorCode == ManagementStatus.NotFound) return null; throw; }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
    }
    private static UniqueProcess Unique(int pid, string started)
    {
        long value = Int64.Parse(started, CultureInfo.InvariantCulture);
        return new UniqueProcess { Pid = pid, Start = new System.Runtime.InteropServices.ComTypes.FILETIME { dwLowDateTime = unchecked((int)value), dwHighDateTime = (int)(value >> 32) } };
    }
    private static List<int> LockOwners(string file)
    {
        var result = new List<int>(); uint session;
        int error = RmStartSession(out session, 0, new StringBuilder(33));
        if (error != 0) throw new Failure("LOCK_INSPECTION", "Windows could not inspect this profile lock (" + error + ").");
        try
        {
            error = RmRegisterResources(session, 1, new[] { file }, 0, null, 0, null);
            if (error != 0) throw new Failure("LOCK_INSPECTION", "Windows could not register the profile lock for inspection (" + error + ").");
            uint count = 0, needed, reasons = 0;
            error = RmGetList(session, out needed, ref count, null, ref reasons);
            for (int attempt = 0; error == 234 && attempt < 3; attempt++)
            {
                count = needed; var entries = new AffectedProcess[count];
                error = RmGetList(session, out needed, ref count, entries, ref reasons);
                if (error == 0) for (int i = 0; i < count; i++) result.Add(entries[i].Process.Pid);
            }
            if (error != 0) throw new Failure("LOCK_INSPECTION", "The profile changed during lock inspection (" + error + "). Retry discovery.");
            return result;
        }
        finally { RmEndSession(session); }
    }
    private static Dictionary<string, object> ProfileState(string directory)
    {
        directory = Full(directory);
        if (!Directory.Exists(directory)) return Map("path", directory, "exists", false, "locked", false, "processes", new object[0]);
        OwnedDirectory(directory);
        string file = Path.Combine(directory, "parent.lock"); bool locked = false;
        if (File.Exists(file))
        {
            try { using (File.Open(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { } }
            catch (IOException) { locked = true; }
        }
        var processes = new List<object>(); string lockError = null;
        if (locked)
        {
            try { foreach (int pid in LockOwners(file)) { var process = ProcessInfo(pid); if (process != null) processes.Add(process); } }
            catch (Failure error) { lockError = error.Message; }
        }
        using (var search = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='zen.exe'"))
        using (var running = search.Get()) foreach (ManagementObject candidate in running)
        {
            string[] args = Args(candidate["CommandLine"] as string);
            if (args.Any(arg => String.Equals(arg, "-contentproc", StringComparison.OrdinalIgnoreCase))) continue;
            bool matches = false;
            for (int i = 0; i + 1 < args.Length; i++) if ((args[i] == "--profile" || args[i] == "-profile") && Same(args[i + 1], directory)) matches = true;
            if (!matches) continue;
            var info = ProcessInfo(Convert.ToInt32(candidate["ProcessId"]));
            if (info == null) continue;
            locked = true; // A closing process can outlive its profile file lock.
            if (!processes.Cast<Dictionary<string, object>>().Any(item => (int)item["pid"] == (int)info["pid"])) processes.Add(info);
        }
        string sessionFile = Path.Combine(directory, "sessionstore.jsonlz4");
        return Map("path", directory, "exists", true, "locked", locked, "processes", processes, "lockError", lockError,
            "recommendedPreferencesDisabled", RecommendedDisabled(directory), "welcomeSeen", PreferenceTrue(directory, "zen.welcome-screen.seen"),
            "hasSession", File.Exists(sessionFile) && new FileInfo(sessionFile).Length > 0);
    }
    private static object Inspect(Dictionary<string, object> input)
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        object knownBinaries;
        if (input.TryGetValue("binaries", out knownBinaries)) foreach (object value in (IEnumerable)knownBinaries) if (value is string && !String.IsNullOrWhiteSpace((string)value)) paths.Add((string)value);
        foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            using (var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\zen.exe"))
            { string value = key == null ? null : key.GetValue("") as string; if (!String.IsNullOrWhiteSpace(value)) paths.Add(value.Trim('"')); }
        foreach (string parent in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
            if (!String.IsNullOrWhiteSpace(parent)) paths.Add(Path.Combine(parent, "Zen Browser", "zen.exe"));
        var processes = new List<object>();
        using (var search = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='zen.exe'"))
        using (var running = search.Get())
        {
            foreach (ManagementObject process in running)
            {
                if (Args(process["CommandLine"] as string).Any(arg => String.Equals(arg, "-contentproc", StringComparison.OrdinalIgnoreCase))) continue;
                try { var info = ProcessInfo(Convert.ToInt32(process["ProcessId"])); if (info != null) { processes.Add(info); paths.Add((string)info["binary"]); } }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
                catch (ManagementException error) { if (error.ErrorCode != ManagementStatus.NotFound) throw; }
            }
        }
        var binaries = new List<object>();
        foreach (string candidate in paths)
        {
            string file = Full(candidate);
            if (!File.Exists(file)) continue;
            var info = FileVersionInfo.GetVersionInfo(file);
            if (!String.Equals(Path.GetFileName(file), "zen.exe", StringComparison.OrdinalIgnoreCase) ||
                ((info.ProductName ?? "") + " " + (info.FileDescription ?? "")).IndexOf("Zen", StringComparison.OrdinalIgnoreCase) < 0) continue;
            binaries.Add(Map("path", file, "version", info.ProductVersion));
        }
        var profiles = new List<object>(); object supplied;
        if (input.TryGetValue("profiles", out supplied))
            foreach (object profile in (IEnumerable)supplied)
            {
                try { profiles.Add(ProfileState((string)profile)); }
                catch (UnauthorizedAccessException) { profiles.Add(Map("path", (string)profile, "exists", true, "accessible", false, "processes", new object[0])); }
                catch (Failure error) { profiles.Add(Map("path", (string)profile, "exists", true, "accessible", false, "processes", new object[0], "error", error.Code)); }
            }
        string currentManifest = null;
        using (var key = Registry.CurrentUser.OpenSubKey(RegistryParent + "\\" + Host(input))) if (key != null) currentManifest = key.GetValue("") as string;
        return Map("binaries", binaries, "processes", processes, "profiles", profiles, "currentManifest", currentManifest, "identity", Identity.Name, "package", PackageName(), "administrator", new WindowsPrincipal(Identity).IsInRole(WindowsBuiltInRole.Administrator), "job", JobState());
    }
    private static object VerifyProcess(Dictionary<string, object> input)
    {
        int pid = Convert.ToInt32(input["pid"]), launcher = Convert.ToInt32(input["launcherPid"]);
        var process = ProcessInfo(pid);
        if (process == null || (pid != launcher && Convert.ToInt32(process["parentPid"]) != launcher) || !Same((string)process["binary"], Text(input, "binary")) ||
            process["profile"] == null || !Same((string)process["profile"], Text(input, "profile")))
            throw new Failure("WRONG_BROWSER", "The process is not the exact Zen instance started for this profile.");
        return Map("verified", true, "pid", pid, "started", process["started"]);
    }
    private static object CloseProfile(Dictionary<string, object> input)
    {
        NormalUser(); string directory = Full(Text(input, "profile")), binary = Full(Text(input, "binary")), started = Text(input, "started"); int pid = Convert.ToInt32(input["pid"]);
        var process = ProcessInfo(pid);
        bool exactProfile = process != null && process["profile"] != null && Same((string)process["profile"], directory);
        if (process == null || !Same((string)process["binary"], binary) || (string)process["started"] != started ||
            (!exactProfile && !LockOwners(Path.Combine(directory, "parent.lock")).Contains(pid))) throw new Failure("BROWSER_CHANGED", "The confirmed browser process no longer owns this profile. Nothing was closed.");
        // Register the exact process, not the file: another process taking over the
        // lock after this check must never expand the set of applications closed.
        uint session; int error = RmStartSession(out session, 0, new StringBuilder(33));
        if (error != 0) throw new Failure("CLOSE_UNAVAILABLE", "Windows cannot request a graceful restart (" + error + ").");
        try
        {
            error = RmRegisterResources(session, 0, null, 1, new[] { Unique(pid, started) }, 0, null);
            if (error == 0) error = RmShutdown(session, 0, IntPtr.Zero); // Never RmForceShutdown.
            if (error != 0) throw new Failure("CLOSE_DECLINED", "Zen did not finish closing (" + error + "). Save your work, close the selected profile normally, then retry.");
            return Map("requested", true, "forced", false, "pid", pid);
        }
        finally { RmEndSession(session); }
    }
    private static void CopyFile(string from, string to)
    {
        if ((File.GetAttributes(from) & FileAttributes.ReparsePoint) != 0) throw new Failure("LINKED_SOURCE", "The bundled runtime must not contain filesystem links.");
        Directory.CreateDirectory(Path.GetDirectoryName(to)); File.Copy(from, to, false);
    }
    private static void CopyTree(string from, string to)
    {
        if ((File.GetAttributes(from) & FileAttributes.ReparsePoint) != 0) throw new Failure("LINKED_SOURCE", "The extension must not contain filesystem links.");
        Directory.CreateDirectory(to);
        foreach (string file in Directory.GetFiles(from)) CopyFile(file, Path.Combine(to, Path.GetFileName(file)));
        foreach (string directory in Directory.GetDirectories(from)) CopyTree(directory, Path.Combine(to, Path.GetFileName(directory)));
    }
    private static object Install(Dictionary<string, object> input)
    {
        NormalUser(); string source = Full(Text(input, "source")), home = Full(Text(input, "home")), host = Host(input), build = Text(input, "buildId");
        if (!Regex.IsMatch(build, "^[a-f0-9]{64}$")) throw new Failure("INVALID_BUILD", "Invalid runtime identity.");
        // Validate the supplied package before creating an installation directory.
        foreach (string relative in new[] { "package.json", "runtime/manifest.json", "runtime/node.exe", "runtime/LICENSE.node.txt", "bin/manifest.json", "extension/manifest.json", "server/native-host.mjs", "server/wire.mjs", "server/paths.mjs", "server/bidi.mjs", "server/native-driver.mjs" })
            if (!File.Exists(Path.Combine(source, relative))) throw new Failure("BUNDLE_INCOMPLETE", "A bundled component is missing. Reinstall the Zen Browser plugin in Codex.");
        var package = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(source, "package.json"), Utf8));
        var runtime = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(source, "runtime", "manifest.json"), Utf8));
        string node = Path.Combine(source, "runtime", "node.exe");
        if (HashFile(node) != (string)runtime["sha256"]) throw new Failure("RUNTIME_INTEGRITY", "The bundled Node runtime is damaged. Reinstall the plugin package.");
        var helpers = Json.Deserialize<object[]>(File.ReadAllText(Path.Combine(source, "bin", "manifest.json"), Utf8)).Cast<Dictionary<string, object>>().ToArray();
        foreach (string name in new[] { "zen-native-host.exe", "zen-input-probe.exe", "zen-platform.exe" })
        {
            var entry = helpers.SingleOrDefault(item => (string)item["file"] == name);
            string file = Path.Combine(source, "bin", name);
            if (entry == null || !File.Exists(file) || HashFile(file) != (string)entry["sha256"]) throw new Failure("RUNTIME_INTEGRITY", "A bundled Windows component is damaged. Reinstall the plugin package.");
        }
        if (Directory.Exists(home) && Directory.EnumerateFileSystemEntries(home).Any())
        {
            OwnedDirectory(home);
            bool owned = Directory.GetFiles(home, "install-*.json").Any(file => {
                var receipt = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Utf8));
                return receipt.ContainsKey("installRoot") && Same((string)receipt["installRoot"], home) &&
                    receipt.ContainsKey("registryPath") && (string)receipt["registryPath"] == "HKCU:\\" + RegistryParent + "\\" + host;
            });
            if (!owned) throw new Failure("INSTALL_CONFLICT", "This non-empty folder is not an existing Zen Browser installation. It was left unchanged.");
        }
        PrivateDirectory(home);
        string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture);
        string target = Path.Combine(home, "runtime", (string)package["version"] + "-" + build.Substring(0, 12) + "-" + stamp);
        string manifest = Path.Combine(target, host + ".json"), previous = null, previousReceipt = null;
        using (var key = Registry.CurrentUser.OpenSubKey(RegistryParent + "\\" + host)) if (key != null) previous = key.GetValue("") as string;
        if (previous != null)
            foreach (string file in Directory.GetFiles(home, "install-*.json"))
            {
                var old = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Utf8));
                if (old.ContainsKey("manifestPath") && Same((string)old["manifestPath"], previous) && Same((string)old["installRoot"], home) && (string)old["registryPath"] == "HKCU:\\" + RegistryParent + "\\" + host) previousReceipt = file;
            }
        string receiptFile = Path.Combine(home, "install-" + stamp + ".json");
        var receiptData = Map("version", package["version"], "buildId", build, "installedAt", DateTime.UtcNow.ToString("o"), "identity", Identity.Name,
            "registryPath", "HKCU:\\" + RegistryParent + "\\" + host, "hostName", host, "previousManifest", previous, "previousManagedReceipt", previousReceipt, "manifestPath", manifest,
            "nodePath", Path.Combine(target, "node.exe"), "runtimePath", target, "installRoot", home, "extensionPath", Path.Combine(target, "extension"), "files", new Dictionary<string, string>(), "stage", "preparing");
        // A failed copy remains a recognized, reversible installation attempt.
        File.WriteAllText(receiptFile, Json.Serialize(receiptData), Utf8);
        Directory.CreateDirectory(target);
        foreach (string file in new[] { "native-host.mjs", "wire.mjs", "paths.mjs", "bidi.mjs", "native-driver.mjs" }) CopyFile(Path.Combine(source, "server", file), Path.Combine(target, file));
        foreach (string file in new[] { "zen-native-host.exe", "zen-input-probe.exe", "zen-platform.exe" }) CopyFile(Path.Combine(source, "bin", file), Path.Combine(target, file));
        CopyFile(node, Path.Combine(target, "node.exe"));
        CopyFile(Path.Combine(source, "runtime", "LICENSE.node.txt"), Path.Combine(target, "LICENSE.node.txt"));
        CopyTree(Path.Combine(source, "extension"), Path.Combine(target, "extension"));
        File.WriteAllText(Path.Combine(target, "launcher-paths.txt"), String.Join("\n", new[] { Path.Combine(target, "node.exe"), Path.Combine(target, "native-host.mjs"), home }), Utf8);
        File.WriteAllText(manifest, Json.Serialize(Map("name", host, "description", "Local Zen Browser bridge for Codex", "path", Path.Combine(target, "zen-native-host.exe"), "type", "stdio", "allowed_extensions", new[] { "zen-browser@reasonw6.github.io" })), Utf8);
        var files = Directory.GetFiles(target, "*", SearchOption.AllDirectories).ToDictionary(file => file.Substring(target.Length + 1).Replace('\\', '/'), HashFile);
        receiptData["files"] = files; receiptData["stage"] = "ready";
        File.WriteAllText(receiptFile, Json.Serialize(receiptData), Utf8);
        using (var key = Registry.CurrentUser.CreateSubKey(RegistryParent + "\\" + host)) { key.SetValue("", manifest, RegistryValueKind.String); if ((string)key.GetValue("") != manifest) throw new Failure("REGISTER_FAILED", "Native Messaging registration did not verify."); }
        receiptData.Add("receipt", receiptFile); receiptData.Add("platformPath", Path.Combine(target, "zen-platform.exe")); return receiptData;
    }
    private static object RestoreHost(Dictionary<string, object> input)
    {
        NormalUser(); string file = Full(Text(input, "receipt"));
        var receipt = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Utf8));
        string home = Full((string)receipt["installRoot"]), host = Host(input);
        OwnedDirectory(home);
        if (!Same(Path.GetDirectoryName(file), home) || (string)receipt["registryPath"] != "HKCU:\\" + RegistryParent + "\\" + host) throw new Failure("WRONG_RECEIPT", "The rollback receipt does not belong to this installation.");
        string previous = receipt["previousManifest"] as string;
        if (Flag(input, "allManagedVersions"))
        {
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase); var ancestor = receipt; object value;
            while (ancestor.TryGetValue("previousManagedReceipt", out value) && value is string)
            {
                string ancestorFile = Full((string)value);
                if (!Same(Path.GetDirectoryName(ancestorFile), home) || !visited.Add(ancestorFile)) throw new Failure("WRONG_RECEIPT", "The upgrade rollback chain is invalid.");
                ancestor = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(ancestorFile, Utf8));
                if (!Same((string)ancestor["installRoot"], home) || (string)ancestor["registryPath"] != (string)receipt["registryPath"] || previous == null || !Same((string)ancestor["manifestPath"], previous))
                    throw new Failure("WRONG_RECEIPT", "The upgrade rollback chain belongs to another installation.");
                previous = ancestor["previousManifest"] as string;
            }
        }
        using (var key = Registry.CurrentUser.OpenSubKey(RegistryParent + "\\" + host, true))
        {
            if (key == null || (string)key.GetValue("") != (string)receipt["manifestPath"]) throw new Failure("ROLLBACK_CONFLICT", "Native Messaging registration changed after this installation. It was not overwritten.");
            if (previous == null) key.DeleteValue("", false); else key.SetValue("", previous, RegistryValueKind.String);
        }
        using (var parent = Registry.CurrentUser.OpenSubKey(RegistryParent, true))
        {
            bool empty; using (var key = parent.OpenSubKey(host)) empty = key != null && key.ValueCount == 0 && key.SubKeyCount == 0;
            if (empty) parent.DeleteSubKey(host, false);
        }
        return Map("restored", true, "filesRetained", true, "restoredManifest", previous);
    }
    private static object VerifyInstall(Dictionary<string, object> input)
    {
        var receipt = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Text(input, "receipt"), Utf8));
        object value;
        if (!receipt.TryGetValue("files", out value) || !(value is Dictionary<string, object>) || ((Dictionary<string, object>)value).Count == 0) return Map("healthy", false);
        string root = Full((string)receipt["runtimePath"]);
        if (!Directory.Exists(root)) return Map("healthy", false);
        OwnedDirectory(root);
        foreach (var pair in (Dictionary<string, object>)value)
        {
            string file = Full(Path.Combine(root, pair.Key.Replace('/', '\\')));
            if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file) || HashFile(file) != (string)pair.Value)
                return Map("healthy", false);
        }
        return Map("healthy", true);
    }
    private static string ReadText(string file) { return File.Exists(file) ? Utf8.GetString(File.ReadAllBytes(file)) : ""; }
    private static string PrefPattern(string name) { return @"(?m)^user_pref\(""" + Regex.Escape(name) + @""",\s*(true|false)\);\r?\n?"; }
    private static string Pref(string text, string name)
    {
        var matches = Regex.Matches(text, PrefPattern(name));
        if (matches.Count > 1) throw new Failure("PREF_CONFLICT", "This browser preference has duplicate stored values. No automatic edit was made.");
        return matches.Count == 0 ? null : matches[0].Value;
    }
    private static string PutPref(string text, string name, string replacement)
    {
        string original = Pref(text, name);
        if (original == null) return replacement == null ? text : text + (text.Length == 0 || text.EndsWith("\n") ? "" : "\r\n") + replacement;
        return Regex.Replace(text, PrefPattern(name), match => replacement ?? "");
    }
    private static bool RecommendedDisabled(string profile)
    {
        bool disabled = false;
        foreach (string name in new[] { "prefs.js", "user.js" })
            foreach (Match match in Regex.Matches(ReadText(Path.Combine(profile, name)).TrimStart('\uFEFF'), @"(?m)^\s*user_pref\(\s*[""']remote\.prefs\.recommended[""']\s*,\s*(true|false)\s*\)\s*;")) disabled = match.Groups[1].Value == "false";
        return disabled;
    }
    private static bool PreferenceTrue(string profile, string preference)
    {
        bool enabled = false;
        foreach (string name in new[] { "prefs.js", "user.js" })
            foreach (Match match in Regex.Matches(ReadText(Path.Combine(profile, name)).TrimStart('\uFEFF'), @"(?m)^\s*user_pref\(\s*[""']" + Regex.Escape(preference) + @"[""']\s*,\s*(true|false)\s*\)\s*;")) enabled = match.Groups[1].Value == "true";
        return enabled;
    }
    private static FileStream ProfileLock(string profile)
    {
        OwnedDirectory(profile);
        try { return File.Open(Path.Combine(profile, "parent.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new Failure("PROFILE_IN_USE", "The selected profile is still running. Its configuration was not edited."); }
    }
    private static object PrepareProfile(Dictionary<string, object> input)
    {
        NormalUser(); string profile = Full(Text(input, "profile")), home = Full(Text(input, "home")); OwnedDirectory(home);
        string receipts = Path.Combine(home, "profile-receipts"); Directory.CreateDirectory(receipts);
        using (ProfileLock(profile))
        {
            string userFile = Path.Combine(profile, "user.js"), prefsFile = Path.Combine(profile, "prefs.js");
            byte[] original = File.Exists(userFile) ? File.ReadAllBytes(userFile) : new byte[0];
            string user = Utf8.GetString(original), prefs = ReadText(prefsFile), previous = Pref(prefs, Recommended), resume = Pref(prefs, ResumeOnce);
            bool changed = !RecommendedDisabled(profile); string id = Guid.NewGuid().ToString();
            string block = changed ? "\r\n// BEGIN Zen Browser Bridge " + id + "\r\nuser_pref(\"" + Recommended + "\", false);\r\n// END Zen Browser Bridge " + id + "\r\n" : "";
            string receiptFile = Path.Combine(receipts, id + ".json");
            var receipt = Map("schemaVersion", 1, "profile", profile, "target", userFile, "block", block, "originalBase64", Convert.ToBase64String(original),
                "originalPreference", previous, "originalResumePreference", resume, "resumeRequested", Flag(input, "restoreSession"), "resultHash", Hash(Utf8.GetBytes(user + block)));
            File.WriteAllText(receiptFile, Json.Serialize(receipt), Utf8);
            if (changed) File.WriteAllText(userFile, user + block, Utf8);
            if (Flag(input, "restoreSession")) File.WriteAllText(prefsFile, PutPref(prefs, ResumeOnce, "user_pref(\"" + ResumeOnce + "\", true);\r\n"), Utf8);
            return Map("receipt", receiptFile, "preferenceChanged", changed, "sessionRestoreRequested", Flag(input, "restoreSession"));
        }
    }
    private static object RestoreProfile(Dictionary<string, object> input)
    {
        NormalUser(); string file = Full(Text(input, "receipt")), profile = Full(Text(input, "profile"));
        var receipt = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Utf8));
        if (!Same((string)receipt["profile"], profile) || !Same((string)receipt["target"], Path.Combine(profile, "user.js"))) throw new Failure("WRONG_RECEIPT", "The receipt belongs to another browser profile.");
        if (receipt.ContainsKey("restoredAt")) return Map("restored", true, "alreadyRestored", true, "otherSettingsPreserved", true, "profile", profile);
        using (ProfileLock(profile))
        {
            string userFile = Path.Combine(profile, "user.js"), user = ReadText(userFile), block = (string)receipt["block"];
            string prefsFile = Path.Combine(profile, "prefs.js"), prefs = ReadText(prefsFile);
            if (block.Length > 0)
            {
                int offset = user.IndexOf(block, StringComparison.Ordinal);
                if (offset < 0 || user.IndexOf(block, offset + block.Length, StringComparison.Ordinal) >= 0) throw new Failure("ROLLBACK_CONFLICT", "The managed profile setting changed. It was left intact for review.");
                user = user.Remove(offset, block.Length);
                prefs = PutPref(prefs, Recommended, receipt["originalPreference"] as string);
            }
            string resume = Pref(prefs, ResumeOnce);
            if (Flag(receipt, "resumeRequested") && resume != null && Regex.IsMatch(resume, @",\s*true\s*\)"))
                prefs = PutPref(prefs, ResumeOnce, receipt["originalResumePreference"] as string);
            if (block.Length > 0) File.WriteAllText(userFile, user, Utf8);
            if (File.Exists(prefsFile)) File.WriteAllText(prefsFile, prefs, Utf8);
            receipt["restoredAt"] = DateTime.UtcNow.ToString("o"); File.WriteAllText(file, Json.Serialize(receipt), Utf8);
            return Map("restored", true, "otherSettingsPreserved", true, "profile", profile);
        }
    }
    [STAThread]
    public static int Main(string[] args)
    {
        Console.InputEncoding = Utf8; Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 3 && args[0] == "--desktop-pipe") return RunDesktopPipe(args[1], args[2]);
            if (args.Length != 0) throw new Failure("INVALID_INPUT", "Unknown helper arguments.");
            string source = Console.In.ReadLine(); if (source == null || source.Length > 65536) throw new Failure("INVALID_INPUT", "Platform request is missing or too large.");
            var input = Json.Deserialize<Dictionary<string, object>>(source);
            if (Text(input, "action") == "hold-lock")
            {
                NormalUser();
                string name = @"Local\ReasonW6.ZenBrowser.Connection." + Identity.User.Value;
                using (var mutex = new Mutex(false, name))
                {
                    bool acquired;
                    try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new Failure("CONNECTION_BUSY", "Another Codex connection is already changing this browser connection. Wait for it to finish.");
                    try { Console.WriteLine(Json.Serialize(Map("ok", true, "result", Map("locked", true)))); Console.Out.Flush(); Console.In.ReadLine(); }
                    finally { mutex.ReleaseMutex(); }
                }
                return 0;
            }
            object result = Text(input, "action") == "desktop-rpc" ? DispatchDesktop(input) : Execute(input);
            Console.WriteLine(Json.Serialize(Map("ok", true, "result", result))); return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(Json.Serialize(ErrorResult(error))); return 1;
        }
    }
}
