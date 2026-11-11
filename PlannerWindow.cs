using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class Route
{
    public string key { get; set; }
    public string route { get; set; }
    public double? xp { get; set; }
    public double? gold { get; set; }
    public double? seconds { get; set; }
    public double? measuredXp { get; set; }
    public double? measuredGold { get; set; }
    public double? expFactor { get; set; }
    public double? targetPerClear { get; set; }
    public double? targetPerHour { get; set; }
    public double? mobShare { get; set; }
    public string basis { get; set; }
    public int? runs { get; set; }
    public int? fails { get; set; }
}

internal sealed class PlannerChoice
{
    public string key { get; set; }
    public string label { get; set; }
    public override string ToString() { return label ?? key ?? ""; }
}

internal sealed class EquippedItem
{
    public string slot { get; set; }
    public string name { get; set; }
    public string stats { get; set; }
    public string affixes { get; set; }
}

internal sealed class Report
{
    public string gameInstallDir { get; set; }
    public bool ok { get; set; }
    public string message { get; set; }
    public string updated { get; set; }
    public string location { get; set; }
    public string party { get; set; }
    public string gold { get; set; }
    public string version { get; set; }
    public string xpPick { get; set; }
    public string goldPick { get; set; }
    public string savedStageKey { get; set; }
    public string farmStageKey { get; set; }
    public string trialStageKey { get; set; }
    public string sampleProgress { get; set; }
    public string note { get; set; }
    public List<Route> rows { get; set; }
    public List<PlannerChoice> heroes { get; set; }
    public string selectedHero { get; set; }
    public List<PlannerChoice> pets { get; set; }
    public string selectedPet { get; set; }
    public string petAccount { get; set; }
    public string petPickKey { get; set; }
    public LiveXpProfile liveXpProfile { get; set; }
    public string gearSummary { get; set; }
    public List<EquippedItem> gearItems { get; set; }
}

internal sealed class EquipmentWindow : Form
{
    private readonly Label summary = new Label();
    private readonly DataGridView grid = new DataGridView();
    private string previous = null;

    public EquipmentWindow(Font font)
    {
        Text = "出战装备";
        Font = font;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(815, 495);
        MinimumSize = new Size(575, 300);
        BackColor = Color.White;
        var layout = new TableLayoutPanel {
            ColumnCount = 1, RowCount = 2, Dock = DockStyle.Fill, Padding = new Padding(14)
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        summary.AutoSize = true;
        summary.Dock = DockStyle.Fill;
        summary.Padding = new Padding(3, 4, 3, 10);
        layout.Controls.Add(summary, 0, 0);
        grid.Dock = DockStyle.Fill;
        grid.ReadOnly = true;
        grid.AllowUserToAddRows = false;
        grid.AllowUserToDeleteRows = false;
        grid.RowHeadersVisible = false;
        grid.BorderStyle = BorderStyle.None;
        grid.BackgroundColor = Color.White;
        grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        grid.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCellsExceptHeaders;
        grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize;
        grid.DefaultCellStyle.WrapMode = DataGridViewTriState.True;
        grid.DefaultCellStyle.Padding = new Padding(3, 4, 3, 4);
        grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        string[] headers = {"部位", "已穿戴装备", "装备自带属性", "本件附加词条"};
        int[] widths = {55, 100, 170, 175};
        for (int i = 0; i < headers.Length; i++) {
            grid.Columns.Add(new DataGridViewTextBoxColumn {
                HeaderText = headers[i], FillWeight = widths[i], SortMode = DataGridViewColumnSortMode.NotSortable
            });
        }
        layout.Controls.Add(grid, 0, 1);
        Controls.Add(layout);
    }

    public void UpdateReport(Report report)
    {
        var selected = report.heroes == null ? null : report.heroes.Find(h => h.key == report.selectedHero);
        Text = selected == null ? "出战装备" : selected.label + " · 出战装备";
        summary.Text = report.ok ? report.gearSummary : report.message;
        string signature = new JavaScriptSerializer().Serialize(report.gearItems);
        if (signature == previous) return;
        previous = signature;
        grid.Rows.Clear();
        if (report.gearItems != null) {
            foreach (var item in report.gearItems)
                grid.Rows.Add(item.slot, item.name, item.stats, item.affixes);
        }
        grid.ClearSelection();
    }
}

internal sealed class PlannerWindow : Form
{
    private static readonly Color Ink = Color.FromArgb(33, 52, 61);
    private static readonly Color Muted = Color.FromArgb(74, 94, 103);
    private static readonly Color Border = Color.FromArgb(223, 229, 230);
    private readonly ToolTip tips = new ToolTip();
    private readonly DataGridView table = new DataGridView();
    private readonly ComboBox sort = new ComboBox();
    private readonly ComboBox hero = new ComboBox();
    private readonly ComboBox pet = new ComboBox();
    private readonly ComboBox mode = new ComboBox();
    private readonly Label state = new Label();
    private readonly Label live = new Label();
    private readonly Label party = new Label();
    private readonly Label profile = new Label();
    private readonly Label xpPick = new Label();
    private readonly Label goldPick = new Label();
    private readonly Label firstHeading = new Label();
    private readonly Label secondHeading = new Label();
    private readonly Label noteStatus = new Label();
    private readonly Label note = new Label();
    private readonly Label empty = new Label();
    private readonly Button refresh = new Button();
    private readonly Button gearButton = new Button();
    private readonly Button directoryButton = new Button();
    private const string SettingsKey = @"HKEY_CURRENT_USER\Software\TaskbarHeroPlanner";
    private string selectedDirectory = ReadRegistryString(SettingsKey, "GameDirectory");
    private volatile string liveDirectory;
    private EquipmentWindow equipmentWindow;
    private Report latestReport;
    private string lastCheckTime;
    private string liveStageKey;
    private string liveStageName;
    private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
    private readonly BackgroundWorker reader = new BackgroundWorker();
    private readonly System.Threading.ManualResetEvent stopLive = new System.Threading.ManualResetEvent(false);
    private volatile Tuple<int, LiveXpProfile> liveChoice = Tuple.Create<int, LiveXpProfile>(101, null);
    private List<Route> routes = new List<Route>();
    private string rendered = null;
    private string columnLayout = null;
    private int displayedMode;
    private string requestedPetKey;
    private bool replacingChoices;
    private bool requestChanged;
    private bool resetScroll;

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [STAThread]
    private static void Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PlannerWindow());
    }

    private PlannerWindow()
    {
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = "Taskbar Hero · 刷图助手";
        Font = new Font("Microsoft YaHei UI", 9F);
        ForeColor = Ink;
        BackColor = Color.White;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(710, 555);
        ClientSize = new Size(885, 610);

        var layout = new TableLayoutPanel {
            Dock = DockStyle.Fill, Padding = new Padding(18, 10, 18, 10),
            ColumnCount = 1, RowCount = 8
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        foreach (int height in new int[] {23, 23, 71, 40})
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(layout);

        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, Margin = Padding.Empty };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var title = new Label {
            Text = "刷图规划", AutoSize = true, Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 0, 16, 0), Font = new Font(Font.FontFamily, 17F, FontStyle.Bold)
        };
        header.Controls.Add(title, 0, 0);
        InfoLabel(state);
        header.Controls.Add(state, 1, 0);
        gearButton.Text = "查看装备";
        gearButton.AutoSize = true;
        gearButton.Anchor = AnchorStyles.Right;
        gearButton.Margin = new Padding(5, 0, 10, 0);
        gearButton.Click += delegate {
            if (equipmentWindow == null || equipmentWindow.IsDisposed)
                equipmentWindow = new EquipmentWindow(Font);
            equipmentWindow.UpdateReport(latestReport);
            if (equipmentWindow.Visible) equipmentWindow.Activate();
            else equipmentWindow.Show(this);
        };
        ConfigureDirectoryButton();
        header.Controls.Add(directoryButton, 2, 0);
        header.Controls.Add(gearButton, 3, 0);
        var pinned = new CheckBox {Text = "窗口置顶", AutoSize = true, Anchor = AnchorStyles.Right};
        pinned.CheckedChanged += delegate { TopMost = pinned.Checked; };
        header.Controls.Add(pinned, 4, 0);
        layout.Controls.Add(header, 0, 0);
        live.AutoSize = true;
        live.Dock = DockStyle.Fill;
        live.Padding = new Padding(8, 5, 8, 5);
        live.Margin = new Padding(0, 0, 0, 3);
        live.BackColor = Color.FromArgb(238, 244, 247);
        live.ForeColor = Muted;
        live.Text = "实时战况　正在连接游戏…";
        layout.Controls.Add(live, 0, 1);
        InfoLabel(party);
        InfoLabel(profile);
        layout.Controls.Add(party, 0, 2);
        layout.Controls.Add(profile, 0, 3);

        var picks = new TableLayoutPanel {
            Dock = DockStyle.Fill, Margin = new Padding(0, 5, 0, 2), ColumnCount = 2, RowCount = 1
        };
        picks.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        picks.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        picks.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        picks.Controls.Add(PickCard(firstHeading, xpPick, Color.FromArgb(235, 247, 242), 0, 4), 0, 0);
        picks.Controls.Add(PickCard(secondHeading, goldPick, Color.FromArgb(251, 245, 229), 4, 0), 1, 0);
        layout.Controls.Add(picks, 0, 4);

        var toolbar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 7, Margin = Padding.Empty };
        for (int i = 0; i < 5; i++) toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var heroCaption = new Label {
            Text = "规划英雄", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 0, 6, 0)
        };
        toolbar.Controls.Add(heroCaption, 0, 0);
        hero.DropDownStyle = ComboBoxStyle.DropDownList;
        hero.Width = 135;
        hero.Anchor = AnchorStyles.Left;
        hero.Enabled = false;
        hero.SelectedIndexChanged += delegate {
            if (!replacingChoices) {
                UpdateLiveHero();
                ChangeQuery();
            }
        };
        toolbar.Controls.Add(hero, 1, 0);
        mode.DropDownStyle = ComboBoxStyle.DropDownList;
        mode.Anchor = AnchorStyles.Left;
        mode.Width = 106;
        mode.Items.AddRange(new object[] {"刷图规划", "实测收益", "模型推算", "宠物刷图"});
        mode.SelectedIndex = 0;
        toolbar.Controls.Add(mode, 2, 0);
        var targetCaption = new Label {
            Text = "目标", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(12, 0, 4, 0)
        };
        toolbar.Controls.Add(targetCaption, 3, 0);
        sort.DropDownStyle = ComboBoxStyle.DropDownList;
        sort.Dock = DockStyle.Fill;
        sort.Items.AddRange(new object[] {"经验 / 小时", "金币 / 小时"});
        sort.SelectedIndex = 0;
        sort.SelectedIndexChanged += delegate {
            if (mode.SelectedIndex == 0) ChangeQuery();
            else RenderRoutes(true);
        };
        var targetBox = new Panel {
            Width = 113, Anchor = AnchorStyles.Left
        };
        pet.DropDownStyle = ComboBoxStyle.DropDownList;
        pet.Dock = DockStyle.Fill;
        pet.Enabled = false;
        pet.Visible = false;
        pet.SelectedIndexChanged += delegate {
            if (!replacingChoices && mode.SelectedIndex == 3) {
                var choice = pet.SelectedItem as PlannerChoice;
                requestedPetKey = choice == null ? null : choice.key;
                ChangeQuery();
            }
        };
        targetBox.Controls.Add(sort);
        targetBox.Controls.Add(pet);
        toolbar.Controls.Add(targetBox, 4, 0);
        mode.SelectedIndexChanged += delegate {
            bool petMode = mode.SelectedIndex == 3;
            heroCaption.Text = petMode ? "战况英雄" : "规划英雄";
            targetCaption.Text = petMode ? "目标宠物" : "目标";
            targetBox.Width = petMode ? 165 : 113;
            sort.Visible = !petMode;
            pet.Visible = petMode;
            if (petMode) pet.Enabled = false;
            ChangeQuery();
        };
        refresh.Text = "立即刷新";
        refresh.AutoSize = true;
        refresh.Anchor = AnchorStyles.Right;
        refresh.Click += delegate { PollNow(); };
        toolbar.Controls.Add(refresh, 6, 0);
        layout.Controls.Add(toolbar, 0, 5);
        targetBox.Height = sort.PreferredHeight;

        var results = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        ConfigureTable();
        results.Controls.Add(table);
        empty.Dock = DockStyle.Fill;
        empty.TextAlign = ContentAlignment.MiddleCenter;
        empty.BackColor = Color.FromArgb(248, 250, 250);
        empty.ForeColor = Muted;
        empty.Padding = new Padding(10);
        results.Controls.Add(empty);
        empty.BringToFront();
        layout.Controls.Add(results, 0, 6);
        var noteBox = new TableLayoutPanel {
            Dock = DockStyle.Fill, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1, RowCount = 2, Margin = new Padding(0, 6, 0, 0),
            Padding = new Padding(1), BackColor = Color.FromArgb(196, 214, 205)
        };
        noteBox.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        noteBox.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        noteBox.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        noteStatus.AutoSize = true;
        noteStatus.Dock = DockStyle.Fill;
        noteStatus.Margin = Padding.Empty;
        noteStatus.Padding = new Padding(8, 4, 8, 4);
        noteStatus.BackColor = Color.FromArgb(232, 243, 237);
        noteStatus.ForeColor = Color.FromArgb(28, 77, 76);
        noteBox.Controls.Add(noteStatus, 0, 0);
        note.AutoSize = true;
        note.Dock = DockStyle.Fill;
        note.Margin = Padding.Empty;
        note.Padding = new Padding(8, 5, 8, 5);
        note.BackColor = Color.FromArgb(242, 248, 244);
        note.ForeColor = Muted;
        noteBox.Controls.Add(note, 0, 1);
        layout.Controls.Add(noteBox, 0, 7);
        ShowReport(new Report { message = "正在读取游戏数据…" });
        reader.DoWork += delegate(object sender, DoWorkEventArgs e) {
            var request = (Tuple<string,string>)e.Argument;
            e.Result = ReadGame(request.Item1, request.Item2);
        };
        reader.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs e) {
            if (IsDisposed || Disposing) return;
            if (requestChanged) { PollNow(); return; }
            refresh.Enabled = true;
            if (e.Error == null) {
                var result = (Report)e.Result;
                SetLiveDirectory(result.gameInstallDir);
                ShowReport(result);
            } else {
                ShowReport(new Report { message = e.Error.Message });
            }
        };
        poll.Interval = 5000;
        poll.Tick += delegate { PollNow(); };
        Shown += delegate {
            PollNow();
            poll.Start();
            var monitor = new System.Threading.Thread(MonitorLive) { IsBackground = true, Name = "TBH 战况" };
            monitor.Start();
        };
        FormClosed += delegate { stopLive.Set(); poll.Stop(); poll.Dispose(); tips.Dispose(); };
    }

    private static string ReadRegistryString(string key, string name)
    {
        try {
            string saved = Registry.GetValue(key, name, null) as string;
            return String.IsNullOrWhiteSpace(saved) ? null : saved;
        } catch (SecurityException) { return null; }
          catch (UnauthorizedAccessException) { return null; }
          catch (IOException) { return null; }
    }

    private static string SteamRoot()
    {
        string root = ReadRegistryString(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath");
        if (Directory.Exists(root)) return root;
        root = ReadRegistryString(@"HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam", "InstallPath");
        if (Directory.Exists(root)) return root;
        root = ReadRegistryString(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath");
        return Directory.Exists(root) ? root : null;
    }

    private void ConfigureDirectoryButton()
    {
        directoryButton.Text = "游戏目录 ▾";
        directoryButton.AutoSize = true;
        directoryButton.Anchor = AnchorStyles.Right;
        var menu = new ContextMenuStrip();
        var current = new ToolStripMenuItem { Enabled = false };
        menu.Items.Add(current);
        menu.Items.Add("选择游戏目录…", null, delegate {
            using (var picker = new FolderBrowserDialog {
                Description = "选择包含 TaskBarHero.exe 和 TaskBarHero_Data 的游戏安装目录。",
                ShowNewFolderButton = false
            }) {
                string initial = liveDirectory ?? selectedDirectory;
                if (Directory.Exists(initial)) picker.SelectedPath = initial;
                if (picker.ShowDialog(this) != DialogResult.OK) return;
                string path = picker.SelectedPath;
                if (!File.Exists(Path.Combine(path, "TaskBarHero.exe")) ||
                    !File.Exists(Path.Combine(path, @"TaskBarHero_Data\sharedassets0.assets"))) {
                    MessageBox.Show(this, "这个目录缺少 TaskBarHero.exe 或关卡资源文件。请在 Steam 中打开游戏的“浏览本地文件”，再选择打开的目录。",
                        "请选择游戏安装目录", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                ChangeDirectory(path);
            }
        });
        var automatic = menu.Items.Add("使用 Steam 自动查找", null, delegate { ChangeDirectory(null); });
        menu.Opening += delegate {
            string path = liveDirectory ?? selectedDirectory;
            current.Text = (selectedDirectory == null ? "自动查找" : "手动选择") + " · " + (path ?? "尚未找到游戏");
            automatic.Enabled = selectedDirectory != null;
        };
        directoryButton.ContextMenuStrip = menu;
        directoryButton.Click += delegate { menu.Show(directoryButton, 0, directoryButton.Height); };
        directoryButton.Disposed += delegate { menu.Dispose(); };
    }

    private void ChangeDirectory(string path)
    {
        try {
            Registry.SetValue(SettingsKey, "GameDirectory", path ?? "", RegistryValueKind.String);
        } catch (Exception error) {
            if (!(error is SecurityException || error is UnauthorizedAccessException || error is IOException)) throw;
            MessageBox.Show(this, "本次将使用所选设置。无法保存目录偏好：" + error.Message, "游戏目录",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        selectedDirectory = path;
        SetLiveDirectory(null);
        ShowReport(new Report { message = "正在读取游戏目录…" });
        requestChanged = true;
        resetScroll = true;
        PollNow();
    }

    private void SetLiveDirectory(string path)
    {
        if (String.Equals(path, liveDirectory, StringComparison.OrdinalIgnoreCase)) return;
        liveDirectory = path;
        liveStageKey = null;
        liveStageName = null;
        SetLabel(live, path == null ? "实时战况　等待定位游戏目录…" : "实时战况　正在连接游戏…");
    }

    private void MonitorLive()
    {
        // One reader, owned by this worker, so closing the form never races a pending read.
        using (var game = new LiveGameReader()) {
            try {
                do {
                    LiveGameFrame frame = null;
                    var selected = liveChoice;
                    string directory = liveDirectory;
                    try { frame = game.Sample(directory, selected.Item1, selected.Item2); }
                    catch (Win32Exception) { /* The process may have exited during a read. */ }
                    catch (InvalidOperationException) { /* The game may be transitioning. */ }
                    DateTime time = DateTime.Now;
                    if (!stopLive.WaitOne(0)) {
                        try { BeginInvoke((MethodInvoker)delegate {
                            if (Object.ReferenceEquals(selected, liveChoice) &&
                                String.Equals(directory, liveDirectory, StringComparison.OrdinalIgnoreCase)) ShowLive(frame, time);
                        }); }
                        catch (InvalidOperationException) { /* The form was closed. */ }
                    }
                } while (!stopLive.WaitOne(1000));
            } finally {
                stopLive.Dispose();
            }
        }
    }

    private void UpdateLiveHero()
    {
        PlannerChoice selected = hero.SelectedItem as PlannerChoice;
        var previous = liveChoice;
        int key = previous.Item1;
        int parsed;
        if (selected != null && Int32.TryParse(selected.key, out parsed)) key = parsed;
        LiveXpProfile profile = selected != null && latestReport != null && latestReport.ok &&
            selected.key == latestReport.selectedHero ? latestReport.liveXpProfile : null;
        if (key != previous.Item1 || !Object.ReferenceEquals(profile, previous.Item2))
            liveChoice = Tuple.Create(key, profile);
        if (key != previous.Item1)
            SetLabel(live, "实时战况　正在读取所选英雄…");
    }

    private void ShowLive(LiveGameFrame frame, DateTime time)
    {
        if (IsDisposed || Disposing) return;
        string key = frame != null && frame.Connected && frame.StageKey > 0
            ? frame.StageKey.ToString(CultureInfo.InvariantCulture) : null;
        if (key != liveStageKey) {
            liveStageKey = key;
            liveStageName = key == null ? null : frame.Stage;
            bool petMode = mode.SelectedIndex == 3;
            if ((mode.SelectedIndex == 0 || petMode) && displayedMode == mode.SelectedIndex && latestReport != null) {
                ShowPicks(latestReport);
                foreach (DataGridViewRow row in table.Rows) {
                    Route route = row.Tag as Route;
                    if (route != null) {
                        string basis = PlanBasis(route);
                        var cell = row.Cells[5];
                        if (!Object.Equals(cell.Value, basis)) cell.Value = basis;
                    }
                }
            }
        }
        if (frame == null || !frame.Connected) {
            live.ForeColor = Muted;
            SetLabel(live, "实时战况　" + (frame == null || String.IsNullOrWhiteSpace(frame.Status)
                ? "本次未读取到游戏" : frame.Status) + "　·　推荐随存档更新");
            return;
        }
        live.ForeColor = Color.FromArgb(28, 77, 76);
        string details = Join(frame.Stage, frame.Wave, frame.Combat, frame.Kills, frame.Hero, frame.Gold, frame.Status);
        SetLabel(live, "实时战况 " + time.ToString("HH:mm:ss") + "　" +
            (String.IsNullOrWhiteSpace(details) ? "等待战斗读数" : details));
    }

    private void InfoLabel(Label label)
    {
        label.Dock = DockStyle.Fill;
        label.TextAlign = ContentAlignment.MiddleLeft;
        label.Margin = Padding.Empty;
        label.AutoEllipsis = true;
        label.ForeColor = Muted;
    }

    private Control PickCard(Label heading, Label value, Color tint, int left, int right)
    {
        var box = new TableLayoutPanel {
            Dock = DockStyle.Fill, Margin = new Padding(left, 0, right, 0), RowCount = 2,
            Padding = new Padding(12, 4, 8, 4), BackColor = tint
        };
        box.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        box.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        InfoLabel(heading);
        box.Controls.Add(heading, 0, 0);
        InfoLabel(value);
        value.ForeColor = Ink;
        value.Font = new Font(Font.FontFamily, 11F, FontStyle.Bold);
        box.Controls.Add(value, 0, 1);
        return box;
    }

    private void ConfigureTable()
    {
        table.Dock = DockStyle.Fill;
        table.ReadOnly = true;
        table.AllowUserToAddRows = false;
        table.AllowUserToDeleteRows = false;
        table.AllowUserToResizeRows = false;
        table.RowHeadersVisible = false;
        table.MultiSelect = false;
        table.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        table.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        table.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize;
        table.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCellsExceptHeaders;
        table.BorderStyle = BorderStyle.None;
        table.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
        table.GridColor = Border;
        table.BackgroundColor = Color.White;
        table.EnableHeadersVisualStyles = false;
        table.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(237, 242, 242);
        table.ColumnHeadersDefaultCellStyle.ForeColor = Ink;
        table.ColumnHeadersDefaultCellStyle.Padding = new Padding(3, 4, 3, 4);
        table.DefaultCellStyle.Padding = new Padding(3, 3, 3, 3);
        table.DefaultCellStyle.SelectionBackColor = Color.FromArgb(218, 236, 232);
        table.DefaultCellStyle.SelectionForeColor = Ink;
        table.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e) {
            if (e.RowIndex < 0 || e.ColumnIndex < 0) return;
            Route route = table.Rows[e.RowIndex].Tag as Route;
            string target = route == null ? null : StagePage(route.key);
            if (target == null) return;
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Win32Exception ex) { SetLabel(state, "浏览器打开失败：" + ex.Message); }
        };
    }

    private void ConfigureColumns(bool planning, bool goldGoal, bool petMode)
    {
        string layout = petMode ? "pet" : planning ? (goldGoal ? "plan-gold" : "plan-xp") : "rates";
        if (layout == columnLayout) return;
        columnLayout = layout;
        string metric = goldGoal ? "金币" : "经验";
        string[] names;
        int[] weights;
        if (petMode) {
            names = new string[] {"关卡（双击查看）", "目标怪 / 时", "目标怪 / 轮", "小怪占比", "参考秒数", "依据"};
            weights = new int[] {145, 86, 83, 67, 67, 125};
        } else if (planning) {
            names = new string[] {"关卡（双击查看）", "推算" + metric + "/时", "实测" + metric + "/时", "参考秒数", "基础经验系数", "依据", "通关 / 失败"};
            weights = new int[] {122, 86, 86, 60, 77, 118, 67};
        } else {
            names = new string[] {"关卡（双击查看）", "经验 / 小时", "金币 / 小时", "用时 (秒)", "依据", "次数"};
            weights = new int[] {130, 80, 80, 62, 145, 39};
        }
        table.Columns.Clear();
        for (int i = 0; i < names.Length; i++) {
            var column = new DataGridViewTextBoxColumn {
                HeaderText = names[i], FillWeight = weights[i], SortMode = DataGridViewColumnSortMode.NotSortable
            };
            if (i == (planning || petMode ? 5 : 4)) column.DefaultCellStyle.WrapMode = DataGridViewTriState.True;
            if (petMode && i == 2) column.ToolTipText = "每轮预计遇到的目标怪数量，包含符合条件的关底首领。";
            if (petMode && i == 3) column.ToolTipText = "目标在随机小怪池中的生成权重占比，关底首领单独计算。";
            table.Columns.Add(column);
        }
    }

    private static string StagePage(string key)
    {
        if (key == null || key.Length != 4 || key[0] < '1' || key[0] > '4' || key[1] < '1' || key[1] > '3')
            return null;
        int stage;
        if (!ValidKey(key) || !Int32.TryParse(key.Substring(2), out stage) || stage < 1 || stage > 10)
            return null;
        string[] difficulties = { "normal", "nightmare", "hell", "torment" };
        return "https://tbhwiki.org/zh/stages?act=" + key[1] + "&difficulty=" + difficulties[key[0] - '1'] + "&stage=" + key;
    }

    private void PollNow()
    {
        if (reader.IsBusy) return;
        requestChanged = false;
        refresh.Enabled = false;
        string args;
        switch (mode.SelectedIndex) {
            case 1: args = "--mode measured"; break;
            case 2: args = "--mode wiki"; break;
            case 3:
                args = "--mode pet";
                if (latestReport != null && latestReport.ok && latestReport.pets != null &&
                    ValidKey(requestedPetKey) && !String.IsNullOrEmpty(latestReport.petAccount) &&
                    latestReport.petAccount.Length <= 64 && latestReport.petAccount.All(Uri.IsHexDigit) &&
                    latestReport.pets.Any(p => p != null && p.key == requestedPetKey))
                    args += " --pet " + requestedPetKey + " --pet-account " + latestReport.petAccount;
                break;
            default: args = "--mode plan --goal " + (sort.SelectedIndex == 1 ? "gold" : "xp"); break;
        }
        var choice = hero.SelectedItem as PlannerChoice;
        if (choice != null && ValidKey(choice.key)) args += " --hero " + choice.key;
        reader.RunWorkerAsync(Tuple.Create(args, selectedDirectory));
    }

    private void ChangeQuery()
    {
        requestChanged = true;
        resetScroll = true;
        SetLabel(state, "正在更新规划…");
        PollNow();
    }

    private static bool ValidKey(string key)
    {
        return !String.IsNullOrEmpty(key) && key.Length < 25 && key.All(c => c >= '0' && c <= '9');
    }

    private void UpdateChoices(ComboBox picker, List<PlannerChoice> options, string selectedKey)
    {
        var choices = options.Where(h => h != null && ValidKey(h.key)).ToList();
        var current = picker.Items.Cast<PlannerChoice>().ToList();
        var previous = picker.SelectedItem as PlannerChoice;
        picker.Enabled = choices.Count > 1;
        if (current.Count == choices.Count && current.Zip(choices, (a, b) => a.key == b.key && a.label == b.label).All(s => s)
            && (previous == null ? selectedKey == null : previous.key == selectedKey)) return;
        replacingChoices = true;
        try {
            picker.BeginUpdate();
            picker.Items.Clear();
            picker.Items.AddRange(choices.ToArray());
            int selected = choices.FindIndex(h => h.key == selectedKey);
            picker.SelectedIndex = selected >= 0 ? selected : choices.Count == 0 ? -1 : 0;
        } finally { picker.EndUpdate(); replacingChoices = false; }
    }

    private static Report ReadGame(string options, string selectedDirectory)
    {
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        if (!File.Exists(Path.Combine(appDir, "planner.cjs")))
            throw new FileNotFoundException("缺少 planner.cjs，请将助手放回配套文件所在目录。");
        string nodePath = Path.Combine(appDir, "runtime", "node.exe");
        if (!File.Exists(nodePath))
            nodePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        var start = new ProcessStartInfo {
            FileName = File.Exists(nodePath) ? nodePath : "node.exe",
            Arguments = "planner.cjs " + options, WorkingDirectory = appDir, UseShellExecute = false,
            CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        if (selectedDirectory != null) start.EnvironmentVariables["TBH_GAME_DIR"] = selectedDirectory;
        else {
            string steam = SteamRoot();
            if (steam != null) start.EnvironmentVariables["TBH_STEAM_ROOT"] = steam;
        }
        using (var proc = new Process { StartInfo = start }) {
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            proc.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data != null) stdout.AppendLine(e.Data);
            };
            proc.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data != null) stderr.AppendLine(e.Data);
            };
            try { proc.Start(); }
            catch (Win32Exception ex) { throw new InvalidOperationException("无法启动 Node.js：" + ex.Message); }
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            if (!proc.WaitForExit(150000)) {
                proc.Kill();
                proc.WaitForExit();
                throw new TimeoutException("读取游戏数据超时，稍后将自动重试。");
            }
            proc.WaitForExit();
            Report result;
            try { result = new JavaScriptSerializer().Deserialize<Report>(stdout.ToString()); }
            catch (ArgumentException) { result = null; }
            catch (InvalidOperationException) { result = null; }
            if (result != null) return result;
            string detail = stderr.ToString().Trim();
            if (detail.Length > 240) detail = detail.Substring(0, 240) + "…";
            throw new InvalidDataException(String.IsNullOrEmpty(detail) ? "未收到可用的游戏数据，稍后将自动重试。" : "读取失败：" + detail);
        }
    }

    private void SetLabel(Label label, string value)
    {
        label.Text = value ?? "";
        tips.SetToolTip(label, label.Text);
    }

    private static string Named(string name, string value)
    {
        return String.IsNullOrWhiteSpace(value) ? null : name + "  " + value;
    }

    private static string Join(params string[] parts)
    {
        return String.Join("     ·     ", parts.Where(s => !String.IsNullOrWhiteSpace(s)).ToArray());
    }

    private string PlanBasis(Route route)
    {
        string key = liveStageKey ?? latestReport.savedStageKey;
        if (key == null || key != route.key) return route.basis;
        string marker = liveStageKey != null ? "当前关卡" : "存档关卡";
        if (liveStageKey != null && key != latestReport.savedStageKey) marker += " · 待存档";
        else if (mode.SelectedIndex == 0 && liveStageKey != null && latestReport.sampleProgress != null) marker += " · 采样中";
        return marker + " · " + route.basis;
    }

    private void ShowPicks(Report report)
    {
        bool planning = mode.SelectedIndex == 0;
        bool petMode = mode.SelectedIndex == 3;
        string left = planning ? "挂机推荐 · 实测" : "经验优先";
        string right = planning ? "下一关试刷" : "金币优先";
        string farm = report.xpPick, trial = report.goldPick, detail = report.note;
        string location = Named("存档关卡", report.location);
        string noteState = report.ok ? "随存档自动更新" : "等待读取存档";
        if (petMode) {
            left = "推荐刷取关卡";
            right = "宠物解锁进度";
            if (report.petPickKey != null && report.petPickKey == (liveStageKey ?? report.savedStageKey))
                left += liveStageKey != null ? " · 当前关卡" : " · 存档关卡";
            if (liveStageKey != null && report.savedStageKey != null && liveStageKey != report.savedStageKey)
                noteState = "等待新关卡存档";
        }
        if (planning && report.ok && report.savedStageKey != null) {
            string current = liveStageKey ?? report.savedStageKey;
            string source = liveStageKey == null ? "存档关卡" : "当前关卡";
            bool waitingForSave = current != report.savedStageKey;
            string currentName = report.location;
            if (waitingForSave) {
                noteState = "等待新关卡存档";
                Route route = report.rows == null ? null : report.rows.Find(r => r != null && r.key == current);
                currentName = route == null ? liveStageName : route.route;
                location = Named("采样关卡", currentName) + "（等待存档同步）";
            } else if (liveStageKey != null) {
                location = Named("采样关卡", currentName);
            }
            if (!waitingForSave && report.farmStageKey != null && report.sampleProgress != null)
                location += "（" + report.sampleProgress + "）";
            if (report.farmStageKey == null) {
                if (waitingForSave) {
                    left = "当前关卡 · 等待存档同步";
                    farm = currentName;
                    detail = "存档仍记录在" + report.location + "。游戏自动保存后更新当前关卡的采样进度。";
                } else {
                    left = source + "采样";
                    if (!String.IsNullOrWhiteSpace(report.sampleProgress)) {
                        left += " · " + report.sampleProgress;
                        farm = report.location;
                    }
                }
            } else if (report.farmStageKey == current) {
                left = "挂机推荐 · " + source;
            }
            if (report.trialStageKey == current) right = "继续本关试刷 · " + source;
            else if (report.trialStageKey == null) right = "试刷安排";
        }
        SetLabel(firstHeading, left);
        SetLabel(secondHeading, right);
        SetLabel(xpPick, String.IsNullOrWhiteSpace(farm) ? "等待数据" : farm);
        SetLabel(goldPick, String.IsNullOrWhiteSpace(trial) ? "等待数据" : trial);
        noteStatus.Visible = planning || petMode;
        if (planning || petMode) SetLabel(noteStatus, Join(petMode ? "宠物刷取说明" : "规划解读", noteState,
            Named("最近检查", lastCheckTime), Named("数据存档", report.updated)));
        SetLabel(note, detail);
        note.Visible = !String.IsNullOrWhiteSpace(detail);
        note.Parent.Visible = planning || petMode || !String.IsNullOrWhiteSpace(detail);
        SetLabel(profile, Join(location, Named("存档金币", report.gold), Named("版本", report.version)));
    }

    private void ShowReport(Report report)
    {
        latestReport = report;
        displayedMode = mode.SelectedIndex;
        lastCheckTime = report.ok ? DateTime.Now.ToString("HH:mm:ss") : null;
        gearButton.Enabled = report.ok && !String.IsNullOrWhiteSpace(report.gearSummary);
        if (equipmentWindow != null && !equipmentWindow.IsDisposed) equipmentWindow.UpdateReport(report);
        if (report.heroes != null) UpdateChoices(hero, report.heroes, report.selectedHero);
        if (mode.SelectedIndex == 3) {
            UpdateChoices(pet, report.pets ?? new List<PlannerChoice>(), report.selectedPet);
            if (requestedPetKey != report.selectedPet) requestedPetKey = null;
        }
        UpdateLiveHero();
        SetLabel(state, report.ok ? Named("存档推荐更新", report.updated) : report.message);
        state.ForeColor = report.ok ? Muted : Color.FromArgb(134, 83, 43);
        SetLabel(party, Named("存档队伍", report.party));
        ShowPicks(report);
        routes = report.ok && report.rows != null ? report.rows.Where(s => s != null).ToList() : new List<Route>();
        empty.Visible = routes.Count == 0;
        empty.Text = !report.ok ? report.message :
            mode.SelectedIndex == 3 ? "暂无可推荐的宠物刷取关卡" : "暂无可比较的关卡";
        RenderRoutes(resetScroll);
        resetScroll = false;
    }

    private static string Number(double? value, string format)
    {
        return value.HasValue ? value.Value.ToString(format, CultureInfo.InvariantCulture) : "—";
    }

    private void RenderRoutes(bool startAtTop)
    {
        bool planning = mode.SelectedIndex == 0;
        bool goldGoal = sort.SelectedIndex == 1;
        bool petMode = mode.SelectedIndex == 3;
        IEnumerable<Route> ordered = routes;
        if (!petMode) ordered = routes.OrderByDescending(r => goldGoal ? r.gold : r.xp);
        string signature = mode.SelectedIndex + "/" + sort.SelectedIndex + "/" + (planning || petMode ? latestReport.savedStageKey : null) +
            "/" + new JavaScriptSerializer().Serialize(ordered.ToList());
        if (signature == rendered) {
            if (startAtTop && table.RowCount > 0) table.FirstDisplayedScrollingRowIndex = 0;
            return;
        }
        rendered = signature;
        int first = startAtTop ? 0 : Math.Max(0, table.FirstDisplayedScrollingRowIndex);
        Route selected = startAtTop || table.SelectedRows.Count == 0 ? null : table.SelectedRows[0].Tag as Route;
        int restore = -1;
        table.SuspendLayout();
        try {
            table.Rows.Clear();
            ConfigureColumns(planning, goldGoal, petMode);
            foreach (Route r in ordered) {
                int index;
                if (petMode) {
                    index = table.Rows.Add(r.route, Number(r.targetPerHour, "#,##0.##"),
                        Number(r.targetPerClear, "0.##"), Number(r.mobShare, "0.#%"),
                        Number(r.seconds, "0.##"), PlanBasis(r));
                } else if (planning) {
                    index = table.Rows.Add(r.route, Number(goldGoal ? r.gold : r.xp, "N0"),
                        Number(goldGoal ? r.measuredGold : r.measuredXp, "N0"), Number(r.seconds, "0.##"),
                        Number(r.expFactor, "0.#%"), PlanBasis(r), Number(r.runs, "0") + " / " + Number(r.fails, "0"));
                } else {
                    index = table.Rows.Add(r.route, Number(r.xp, "N0"), Number(r.gold, "N0"),
                        Number(r.seconds, "0.##"), r.basis, Number(r.runs, "0"));
                }
                string page = StagePage(r.key);
                table.Rows[index].Tag = r;
                table.Rows[index].Cells[0].ToolTipText = page == null ? "Wiki 暂无此关卡条目" : "双击查看本关怪物、Boss 和掉落";
                if (selected != null && r.key == selected.key) restore = index;
            }
            if (restore >= 0) table.CurrentCell = table.Rows[restore].Cells[0];
            else table.ClearSelection();
            if (first < table.RowCount) table.FirstDisplayedScrollingRowIndex = first;
        } finally { table.ResumeLayout(); }
    }
}
