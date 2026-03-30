$code = @"
using System;
using System.Runtime.InteropServices;
public class WlanHelper {
    [DllImport("wlanapi.dll")]
    public static extern uint WlanOpenHandle(uint v, IntPtr r, out uint nv, out IntPtr h);
    [DllImport("wlanapi.dll")]
    public static extern uint WlanEnumInterfaces(IntPtr h, IntPtr r, ref IntPtr p);
    [DllImport("wlanapi.dll")]
    public static extern uint WlanScan(IntPtr h, ref Guid g, IntPtr s, IntPtr ie, IntPtr r);
    [DllImport("wlanapi.dll")]
    public static extern uint WlanCloseHandle(IntPtr h, IntPtr r);
    public static void DoScan() {
        uint nv; IntPtr ch;
        if (WlanOpenHandle(2, IntPtr.Zero, out nv, out ch) != 0) return;
        IntPtr pl = IntPtr.Zero;
        if (WlanEnumInterfaces(ch, IntPtr.Zero, ref pl) != 0) { WlanCloseHandle(ch, IntPtr.Zero); return; }
        int cnt = Marshal.ReadInt32(pl);
        IntPtr p = new IntPtr(pl.ToInt64() + 8);
        for (int i = 0; i < cnt; i++) {
            byte[] gb = new byte[16];
            Marshal.Copy(p, gb, 0, 16);
            Guid g = new Guid(gb);
            WlanScan(ch, ref g, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            p = new IntPtr(p.ToInt64() + 532);
        }
        WlanCloseHandle(ch, IntPtr.Zero);
    }
}
"@
Add-Type -TypeDefinition $code
[WlanHelper]::DoScan()
