using System;
using System.Runtime.InteropServices;
using System.Threading;

class Program
{
    #region Win32

    const uint WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIM_TYPEHID = 2;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const int WH_KEYBOARD_LL = 13;

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTHEADER { public uint dwType, dwSize; public IntPtr hDevice, wParam; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSEX
    {
        public int cbSize; public uint style; public IntPtr lpfnWndProc;
        public int cbClsExtra, cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }

    delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassEx(ref WNDCLASSEX wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(
        uint ex, string cls, string? name, uint style, int x, int y, int w, int h,
        IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern bool RegisterRawInputDevices(
        [MarshalAs(UnmanagedType.LPArray)] RAWINPUTDEVICE[] devs, uint count, uint size);
    [DllImport("user32.dll")] static extern uint GetRawInputData(
        IntPtr hRaw, uint cmd, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string? name);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, LowLevelKeyboardProc proc, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    #endregion

    static WndProcDelegate? _wndProc;
    static LowLevelKeyboardProc? _kbProc;
    static IntPtr _kbHook = IntPtr.Zero;

    static readonly HashSet<uint> BlockedVKeys = new() { 0xAD, 0xAE, 0xAF }; // MUTE, VOL_DOWN, VOL_UP

    static IntPtr KeyboardHookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var kb = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            if (BlockedVKeys.Contains(kb.vkCode))
                return new IntPtr(1);
        }
        return CallNextHookEx(_kbHook, nCode, wParam, lParam);
    }

    static int Main(string[] args)
    {
        int exit = 0;
        var t = new Thread(() => exit = Run());
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        return exit;
    }

    static int Run()
    {
        _wndProc = WndProc;
        var inst = GetModuleHandle(null);
        const string cls = "BleBridgeWnd";

        var wc = new WNDCLASSEX
        {
            cbSize = Marshal.SizeOf<WNDCLASSEX>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
            hInstance = inst,
            lpszClassName = cls
        };
        RegisterClassEx(ref wc);

        var hwnd = CreateWindowEx(0, cls, null, 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, inst, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return 1;

        var devs = new RAWINPUTDEVICE[]
        {
            new RAWINPUTDEVICE { usUsagePage = 0x0C, usUsage = 0x01, dwFlags = RIDEV_INPUTSINK, hwndTarget = hwnd },
            new RAWINPUTDEVICE { usUsagePage = 0x0D, usUsage = 0x04, dwFlags = RIDEV_INPUTSINK, hwndTarget = hwnd },
        };

        if (!RegisterRawInputDevices(devs, (uint)devs.Length, (uint)Marshal.SizeOf<RAWINPUTDEVICE>()))
            return 1;

        _kbProc = KeyboardHookProc;
        _kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, _kbProc, GetModuleHandle(null), 0);

        Console.WriteLine("CONNECTED");
        Console.Out.Flush();

        MSG msg;
        int ret;
        while ((ret = GetMessage(out msg, IntPtr.Zero, 0, 0)) != 0)
        {
            if (ret < 0) break;
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        return 0;
    }

    static IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_INPUT) ProcessRawInput(lParam);
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    static void ProcessRawInput(IntPtr lParam)
    {
        uint size = 0;
        uint hdrSize = (uint)Marshal.SizeOf<RAWINPUTHEADER>();
        GetRawInputData(lParam, RID_INPUT, IntPtr.Zero, ref size, hdrSize);
        if (size == 0) return;

        var buf = Marshal.AllocHGlobal((int)size);
        try
        {
            uint readSize = size;
            if (GetRawInputData(lParam, RID_INPUT, buf, ref readSize, hdrSize) != size) return;

            var hdr = Marshal.PtrToStructure<RAWINPUTHEADER>(buf);
            if (hdr.dwType != RIM_TYPEHID) return;

            int hidOff = (int)hdrSize;
            uint sizeHid = (uint)Marshal.ReadInt32(buf, hidOff);
            uint count = (uint)Marshal.ReadInt32(buf, hidOff + 4);
            if (sizeHid == 0 || count == 0) return;

            for (int i = 0; i < count; i++)
            {
                var report = new byte[sizeHid];
                Marshal.Copy(IntPtr.Add(buf, hidOff + 8 + i * (int)sizeHid), report, 0, (int)sizeHid);

                byte reportId = report[0];
                string data = sizeHid > 1
                    ? BitConverter.ToString(report, 1, (int)sizeHid - 1).Replace("-", "")
                    : "";
                Console.WriteLine($"REPORT:{reportId:X2}:{data}");
                Console.Out.Flush();
            }
        }
        finally { Marshal.FreeHGlobal(buf); }
    }
}
