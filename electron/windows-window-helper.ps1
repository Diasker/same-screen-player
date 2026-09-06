$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SameScreenWindow {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr value);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr extra);
  public static readonly IntPtr Top = new IntPtr(-1);
  public const int Style = -16;
  public const long Caption = 0x00C00000L;
  public const long ThickFrame = 0x00040000L;
  public const long SysMenu = 0x00080000L;
  public const uint FrameChanged = 0x0020;
  public const uint NoActivate = 0x0010;
  public const uint ShowWindowFlag = 0x0040;
  public const int Normal = 1;
  public const int Hide = 0;
}
"@

function Write-Result($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Remove-WindowChrome([IntPtr]$handle) {
  $style = [Int64][SameScreenWindow]::GetWindowLongPtr($handle, [SameScreenWindow]::Style)
  $style = $style -band (-bnot ([SameScreenWindow]::Caption -bor [SameScreenWindow]::ThickFrame -bor [SameScreenWindow]::SysMenu))
  [SameScreenWindow]::SetWindowLongPtr($handle, [SameScreenWindow]::Style, [IntPtr]$style) | Out-Null
  [SameScreenWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, 0, 0, [SameScreenWindow]::FrameChanged -bor [SameScreenWindow]::NoActivate) | Out-Null
}

function Raise-Window([IntPtr]$handle) {
  [SameScreenWindow]::ShowWindow($handle, [SameScreenWindow]::Normal) | Out-Null
  [SameScreenWindow]::SetWindowPos($handle, [SameScreenWindow]::Top, 0, 0, 0, 0, [SameScreenWindow]::ShowWindowFlag -bor [SameScreenWindow]::NoActivate) | Out-Null
  [SameScreenWindow]::SetForegroundWindow($handle) | Out-Null
}

while ($line = [Console]::ReadLine()) {
  try {
    $command = $line | ConvertFrom-Json
    $handle = [IntPtr]::new([Int64]$command.hwnd)
    if ($command.action -eq "style") {
      Remove-WindowChrome $handle
    } elseif ($command.action -eq "stylePid") {
      $targetPid = [uint32]$command.pid
      $callback = [SameScreenWindow+EnumWindowsProc]{
        param([IntPtr]$windowHandle, [IntPtr]$extra)
        [uint32]$windowPid = 0
        [SameScreenWindow]::GetWindowThreadProcessId($windowHandle, [ref]$windowPid) | Out-Null
        if ($windowPid -eq [uint32]$extra.ToInt64()) {
          Remove-WindowChrome $windowHandle
          Raise-Window $windowHandle
        }
        return $true
      }
      [SameScreenWindow]::EnumWindows($callback, [IntPtr]$targetPid) | Out-Null
    } elseif ($command.action -eq "bounds") {
      [SameScreenWindow]::SetWindowPos($handle, [SameScreenWindow]::Top, [int]$command.x, [int]$command.y, [int]$command.width, [int]$command.height, [SameScreenWindow]::ShowWindowFlag -bor [SameScreenWindow]::NoActivate) | Out-Null
    } elseif ($command.action -eq "show") {
      [SameScreenWindow]::ShowWindow($handle, [SameScreenWindow]::Normal) | Out-Null
    } elseif ($command.action -eq "hide") {
      [SameScreenWindow]::ShowWindow($handle, [SameScreenWindow]::Hide) | Out-Null
    }
    Write-Result @{ ok = $true }
  } catch {
    Write-Result @{ ok = $false; error = $_.Exception.Message }
  }
}
