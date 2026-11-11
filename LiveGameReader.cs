using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal sealed class LiveGameFrame
{
    internal bool Connected;
    internal int StageKey;
    internal string Status, Stage, Wave, Combat, Hero, Gold, Kills;
    internal long? CombatGold, KillCount;
}

internal sealed class LiveXpProfile
{
    public int stageKey { get; set; }
    public int heroKey { get; set; }
    public string heroName { get; set; }
    public string profileId { get; set; }
    public int bossKey { get; set; }
    public Dictionary<string,double> normalXp { get; set; }
    public double bossXp { get; set; }
}

// Lifetime clear counts distinguish the end boss from regular enemies sharing its monster ID.
internal sealed class LiveExperienceSegment
{
    private string profileId;
    private long initialKills, initialClears;
    private Dictionary<int,long> first;

    internal void Reset() { first = null; profileId = null; }

    internal double? Estimate(LiveXpProfile profile, Dictionary<int,long> kills, long total, long clears)
    {
        if (profile == null || String.IsNullOrEmpty(profile.profileId) || profile.normalXp == null) { Reset(); return null; }
        if (first == null || profileId != profile.profileId || total < initialKills || clears < initialClears) {
            first = kills; initialKills = total; initialClears = clears; profileId = profile.profileId;
            return 0;
        }
        long bossCount = clears - initialClears, attributed = 0;
        double xp = bossCount * profile.bossXp;
        foreach (var entry in kills) {
            long was;
            first.TryGetValue(entry.Key, out was);
            long change = entry.Value - was;
            if (change < 0) { Reset(); return null; }
            attributed += change;
            long regular = change - (entry.Key == profile.bossKey ? bossCount : 0);
            if (regular < 0) return null; // The game may be updating the two counters on this frame.
            if (regular == 0) continue;
            double unit;
            if (!profile.normalXp.TryGetValue(entry.Key.ToString(),out unit)) return null;
            xp += regular * unit;
        }
        // Leave this segment unreported if an unmodeled enemy contributed to its total.
        if (attributed != total - initialKills) return null;
        return xp >= 0 && xp < 9e15 ? (double?)xp : null;
    }
}

// Specific to the ordinary StageManager and display data in the installed x64 build.
internal sealed class LiveGameReader : IDisposable
{
    private string gameDirectory;
    private const string AssemblyHash = "E9E3F21AB135F5CC9A344789434E70F32B84C7D2A0AC0789098C19610DE877A5";
    private const string MetadataHash = "BC52516BE95B570189EBB668587F40FD9F598D47ABB3D34180B083AF451D9F91";
    private const int StageManagerClass = 0x6218A48;
    private const int UiManagerClass = 0x6219418;
    private const int StatsManagerClass = 0x621E168;
    private readonly object sync = new object();
    private SafeProcessHandle game;
    private long module;
    private DateTime retry;
    private string status;
    private bool disposed;
    private int segmentStage;
    private long? startGold, startKills, lastGold, lastKills;
    private readonly LiveExperienceSegment experience = new LiveExperienceSegment();
    private long lastSampleTick;

    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool ReadProcessMemory(SafeProcessHandle process, IntPtr address,
        [Out] byte[] data, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, int flags,
        StringBuilder name, ref int length);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);

    private static string HashFile(string path)
    {
        using (var sha = SHA256.Create())
        using (var file = File.OpenRead(path))
            return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "");
    }

    private bool Attach()
    {
        if (DateTime.UtcNow < retry) return false;
        retry = DateTime.UtcNow.AddSeconds(5);
        status = "等待游戏启动";
        var candidates = Process.GetProcessesByName("TaskBarHero");
        try {
            foreach (var proc in candidates) {
                using (var query = OpenProcess(0x1000, false, proc.Id)) {
                    if (query.IsInvalid) { status = "游戏进程不可读取"; continue; }
                    var name = new StringBuilder(1024);
                    int length = name.Capacity;
                    if (!QueryFullProcessImageName(query, 0, name, ref length) ||
                        !String.Equals(name.ToString(), Path.Combine(gameDirectory, "TaskBarHero.exe"), StringComparison.OrdinalIgnoreCase)) continue;
                }
                string assembly = Path.Combine(gameDirectory, "GameAssembly.dll");
                if (IntPtr.Size != 8 || File.ReadAllText(Path.Combine(gameDirectory, "Version.txt")).Trim() != "1.3.2" ||
                    HashFile(assembly) != AssemblyHash ||
                    HashFile(Path.Combine(gameDirectory, @"TaskBarHero_Data\il2cpp_data\Metadata\global-metadata.dat")) != MetadataHash) {
                    status = "此游戏版本暂用存档";
                    retry = DateTime.UtcNow.AddSeconds(30);
                    return false;
                }
                using (var image = FindAssembly(proc, assembly)) {
                    if (image == null) { status = "等待游戏载入"; return false; }
                    var handle = OpenProcess(0x1010, false, proc.Id); // limited query + VM_READ
                    if (handle.IsInvalid) { handle.Dispose(); status = "游戏未授予只读访问"; return false; }
                    game = handle;
                    module = image.BaseAddress.ToInt64();
                    return true;
                }
            }
        } finally { foreach (var proc in candidates) proc.Dispose(); }
        return false;
    }

    private static ProcessModule FindAssembly(Process proc, string expected)
    {
        ProcessModule found = null;
        foreach (ProcessModule item in proc.Modules) {
            if (String.Equals(item.FileName, expected, StringComparison.OrdinalIgnoreCase)) found = item;
            else item.Dispose();
        }
        return found;
    }

    private byte[] Bytes(long address, int size)
    {
        if (address < 65536 || address > 0x00007FFFFFFFFFFF - size) throw new InvalidDataException();
        var data = new byte[size];
        UIntPtr read;
        if (!ReadProcessMemory(game, new IntPtr(address), data, (UIntPtr)size, out read) ||
            read.ToUInt64() != (ulong)size) throw new InvalidDataException();
        return data;
    }

    private long Ptr(long address) { return BitConverter.ToInt64(Bytes(address, 8), 0); }
    private int Int(long address) { return BitConverter.ToInt32(Bytes(address, 4), 0); }
    private float Float(long address) { return BitConverter.ToSingle(Bytes(address, 4), 0); }

    private bool HasClass(long obj, string name)
    {
        if (obj == 0) return false;
        long klass = Ptr(obj);
        return klass != 0 && Encoding.ASCII.GetString(Bytes(Ptr(klass + 0x10), name.Length + 1)) == name + "\0";
    }

    private long Singleton(int cachedClass)
    {
        long klass = Ptr(module + cachedClass);
        if (klass == 0) return 0;
        long fields = Ptr(klass + 0xB8);
        return fields == 0 ? 0 : Ptr(fields);
    }

    private string HudWave()
    {
        long ui = Singleton(UiManagerClass);
        if (!HasClass(ui,"UIManager")) return null;
        long panel = Ptr(ui + 0x88);
        if (!HasClass(panel,"UI_Stage")) return null;
        long controller = Ptr(panel + 0x78);
        if (!HasClass(controller,"StageWaveIconSliderController")) return null;
        long slider = Ptr(controller + 0x20);
        if (!HasClass(slider,"Slider")) return null;
        float min = Float(slider + 0x114), max = Float(slider + 0x118), value = Float(slider + 0x120);
        if (min != 0 || max != 1 || !(value >= 0 && value <= 1)) return null;
        return "波次进度 " + (value * 100).ToString("0.#") + "%";
    }

    // The two dictionaries here contain only aggregate gameplay statistics.
    // Entries have an int key; their value is either a dictionary reference or a long.
    private Dictionary<int,long> Counters(long dict, int limit)
    {
        if (!HasClass(dict,"Dictionary`2")) return null;
        int count = Int(dict + 0x20);
        if (count <= 0 || count > limit) return null;
        long items = Ptr(dict + 0x18);
        if (items == 0) return null;
        long capacity = Ptr(items + 0x18);
        if (capacity < count || capacity > limit * 8) return null;
        var block = Bytes(items + 0x20, count * 24);
        var result = new Dictionary<int,long>(count);
        for (int i = 0; i < count; i++) {
            int offset = i * 24;
            int key = BitConverter.ToInt32(block,offset + 8);
            if (key < 0 || BitConverter.ToInt32(block,offset) != key) continue;
            long value = BitConverter.ToInt64(block,offset+16);
            if (value >= 0) result[key] = value;
        }
        return Ptr(dict + 0x18) == items && Int(dict + 0x20) == count ? result : null;
    }

    private Dictionary<int,long> Category(Dictionary<int,long> categories, int type, int limit)
    {
        long dict;
        return categories != null && categories.TryGetValue(type,out dict) ? Counters(dict,limit) : null;
    }

    private void RewardFields(LiveGameFrame frame, int stageKey, int heroKey, LiveXpProfile profile)
    {
        long stats = Singleton(StatsManagerClass);
        if (!HasClass(stats,"yk")) return;
        var categories = Counters(Ptr(stats + 0x20),256);
        var gold = Category(categories,2,256);
        var kills = Category(categories,0,2048);
        long value;
        // GoldEarn subkey 1 matches the game's combat income counter, not wallet balance.
        if (gold != null && gold.TryGetValue(1,out value)) frame.CombatGold = value;
        if (kills != null && kills.TryGetValue(0,out value)) frame.KillCount = value;
        if (segmentStage != stageKey || frame.CombatGold < lastGold || frame.KillCount < lastKills) {
            ResetSegment();
            segmentStage = stageKey;
        }
        if (frame.CombatGold.HasValue) {
            if (!startGold.HasValue) startGold = frame.CombatGold;
            lastGold = frame.CombatGold;
            frame.Gold = "战斗金币 +" + (lastGold.Value - startGold.Value).ToString("N0");
        }
        if (frame.KillCount.HasValue) {
            if (!startKills.HasValue) startKills = frame.KillCount;
            lastKills = frame.KillCount;
            frame.Kills = "击杀 +" + (lastKills.Value - startKills.Value).ToString("N0");
        }
        if (profile == null || profile.heroKey != heroKey || profile.stageKey != stageKey ||
            profile.normalXp == null || profile.normalXp.Count > 128 || !frame.KillCount.HasValue) {
            experience.Reset(); return;
        }
        var clears = Category(categories,13,2048);
        if (clears == null) { experience.Reset(); return; }
        long stageClears;
        clears.TryGetValue(stageKey,out stageClears);
        var relevant = new Dictionary<int,long>();
        foreach (string id in profile.normalXp.Keys) {
            int key;
            if (!Int32.TryParse(id,out key)) return;
            kills.TryGetValue(key,out value);
            relevant[key] = value;
        }
        kills.TryGetValue(profile.bossKey,out value);
        relevant[profile.bossKey] = value;
        double? xp = experience.Estimate(profile,relevant,frame.KillCount.Value,stageClears);
        if (xp.HasValue) frame.Hero = profile.heroName + "经验估算 +" + Math.Round(xp.Value).ToString("N0");
    }

    private LiveGameFrame ReadFrame(int heroKey, LiveXpProfile profile)
    {
        long manager = Singleton(StageManagerClass);
        if (!HasClass(manager, "StageManager")) throw new InvalidDataException();
        long cache = Ptr(manager + 0x20);
        if (!HasClass(cache, "StageCache")) throw new InvalidDataException();
        long stage = Ptr(cache + 0x10);
        if (!HasClass(stage, "StageInfoData")) throw new InvalidDataException();
        int key = Int(stage + 0x30), act = Int(stage + 0x48), number = Int(stage + 0x4C);
        string[] difficulties = {"", "普通", "噩梦", "地狱", "折磨"};
        int difficulty = key / 1000;
        string label = (difficulty >= 1 && difficulty <= 4 && key % 100 == number && key / 100 % 10 == act)
            ? difficulties[difficulty] + " " + act + "-" + number : "关卡 " + key;
        if (key < 1 || key > 1000000 || act < 0 || act > 100 || number < 0 || number > 100) throw new InvalidDataException();
        int phase = Int(manager + 0xC0);
        string[] phaseNames = {"", "刷怪", "战斗", "重整"};
        var frame = new LiveGameFrame {Connected=true, StageKey=key, Stage=label,
            Combat=Int(manager + 0xE0) == 2 ? "挑战失败" : phase >= 0 && phase < phaseNames.Length ? phaseNames[phase] : ""};
        try { frame.Wave = HudWave(); } catch (InvalidDataException) { }
        try { RewardFields(frame,key,heroKey,profile); } catch (InvalidDataException) { ResetSegment(); }
        if (Ptr(cache + 0x10) != stage || Ptr(manager + 0x20) != cache) throw new InvalidDataException();
        return frame;
    }

    internal LiveGameFrame Sample(string directory, int heroKey, LiveXpProfile profile)
    {
        lock (sync) {
            if (disposed) return new LiveGameFrame {Status="已关闭"};
            if (!String.Equals(directory, gameDirectory, StringComparison.OrdinalIgnoreCase)) {
                Detach();
                gameDirectory = directory;
                retry = DateTime.MinValue;
            }
            if (String.IsNullOrEmpty(gameDirectory))
                return new LiveGameFrame {Status="尚未定位游戏，可在“游戏目录”中选择安装目录"};
            try {
                uint exitCode;
                if (game != null && (!GetExitCodeProcess(game,out exitCode) || exitCode != 259)) Detach();
                if (game == null && !Attach()) return new LiveGameFrame {Status=status};
                long tick = Stopwatch.GetTimestamp();
                if (lastSampleTick != 0 && tick - lastSampleTick > 6 * Stopwatch.Frequency) ResetSegment();
                lastSampleTick = tick;
                return ReadFrame(heroKey,profile);
            } catch (InvalidDataException) {
                ResetSegment();
                return new LiveGameFrame {Status="等待可核对的游戏战况"};
            } catch (Win32Exception) {
                Detach();
                return new LiveGameFrame {Status="游戏进程暂不可读取"};
            } catch (UnauthorizedAccessException) {
                Detach();
                return new LiveGameFrame {Status="游戏未授予只读访问"};
            } catch (InvalidOperationException) {
                Detach();
                return new LiveGameFrame {Status="等待游戏载入"};
            } catch (IOException) {
                Detach();
                return new LiveGameFrame {Status="等待游戏文件就绪"};
            }
        }
    }

    private void Detach()
    {
        if (game != null) game.Dispose();
        game = null;
        module = 0;
        ResetSegment();
    }

    private void ResetSegment()
    {
        segmentStage = 0;
        startGold = lastGold = startKills = lastKills = null;
        experience.Reset();
    }

    public void Dispose() { lock (sync) { disposed = true; Detach(); } }
}
