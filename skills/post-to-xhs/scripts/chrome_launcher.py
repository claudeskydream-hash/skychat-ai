"""
Chrome launcher with CDP remote debugging support.

Manages a dedicated Chrome instance for Xiaohongshu publishing:
- Detects if Chrome is already listening on the debug port
- Launches Chrome with a dedicated user-data-dir for login persistence
- Waits for the debug port to become available
- Supports headless mode for automated publishing without GUI
- Supports switching between headless and headed mode (e.g. for login)
- Supports multiple accounts with separate profile directories
"""

import atexit
import json
import os
import signal
import sys
import time
import socket
import subprocess
from typing import Optional

CDP_PORT = 9222
PROFILE_DIR_NAME = "XiaohongshuProfile"
STARTUP_TIMEOUT = 45  # seconds to wait for Chrome to start

# Track the Chrome process we launched so we can kill it later
_chrome_process: subprocess.Popen | None = None
# Track the current account being used
_current_account: Optional[str] = None
# Track the port our managed Chrome is on (for atexit cleanup)
_managed_port: Optional[int] = None
# Ensure atexit/signal handlers are registered only once
_cleanup_registered: bool = False


def _cleanup_on_exit() -> None:
    """atexit/signal handler — wipe any Chrome we launched.

    Prevents the 'orphan Chrome holding the profile' bug that surfaced on
    2026-05-26: a previous publish task exited without calling kill_chrome,
    leaving Chrome alive on port 9222. The next launch saw the profile
    locked, Chrome's single-instance machinery forwarded the cmdline to the
    orphan, and the new process exited with code 0 — confusing chrome_launcher
    into reporting 'Chrome process exited unexpectedly'.
    """
    global _chrome_process
    if _chrome_process is None:
        return
    try:
        if _chrome_process.poll() is None:
            print(f"[chrome_launcher] atexit: killing managed Chrome PID={_chrome_process.pid}")
            _chrome_process.terminate()
            try:
                _chrome_process.wait(timeout=3)
            except Exception:
                _chrome_process.kill()
    except Exception:
        pass


def _register_cleanup_once() -> None:
    """Register atexit + SIGTERM/SIGINT handlers (idempotent)."""
    global _cleanup_registered
    if _cleanup_registered:
        return
    atexit.register(_cleanup_on_exit)
    # On Windows signal.SIGTERM only fires for explicit Process.terminate; that's fine.
    for sig_name in ("SIGTERM", "SIGINT"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            prev = signal.getsignal(sig)
            def _handler(signum, frame, _prev=prev):
                _cleanup_on_exit()
                # Chain to previous handler so default behavior (exit) still happens
                if callable(_prev) and _prev not in (signal.SIG_DFL, signal.SIG_IGN):
                    _prev(signum, frame)
                else:
                    sys.exit(128 + signum)
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            # signal.signal() only works in main thread; ignore otherwise.
            pass
    _cleanup_registered = True


def detach_managed_chrome() -> None:
    """Keep the headed Chrome alive after the current Python command exits."""
    global _chrome_process, _managed_port
    _chrome_process = None
    _managed_port = None


def _is_managed_alive(port: int) -> bool:
    """True if the Chrome on `port` is the one this process started AND still alive."""
    return (
        _chrome_process is not None
        and _chrome_process.poll() is None
        and _managed_port == port
    )


def get_chrome_path() -> str:
    """Find Chrome executable on Windows/macOS/Linux."""
    candidates = []

    if sys.platform == "win32":
        for env_var in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env_var, "")
            if base:
                candidates.append(
                    os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")
                )
    elif sys.platform == "darwin":
        candidates.extend(
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            ]
        )
    else:
        candidates.extend(
            [
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/usr/bin/chromium-browser",
                "/usr/bin/chromium",
            ]
        )

    for path in candidates:
        if os.path.isfile(path):
            return path

    import shutil
    found = (
        shutil.which("google-chrome")
        or shutil.which("google-chrome-stable")
        or shutil.which("chromium-browser")
        or shutil.which("chromium")
        or shutil.which("chrome")
        or shutil.which("chrome.exe")
    )
    if found:
        return found

    raise FileNotFoundError(
        "Chrome not found. Please install Google Chrome or set its path manually."
    )


def get_user_data_dir(account: Optional[str] = None) -> str:
    """
    Return the Chrome profile directory path for a given account.

    Args:
        account: Account name. If None, uses the default account from account_manager.

    Returns:
        Path to the Chrome user-data-dir for this account.
    """
    try:
        from account_manager import get_profile_dir
        return get_profile_dir(account)
    except ImportError:
        # Fallback if account_manager not available
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        if not local_app_data:
            local_app_data = os.path.expanduser("~")
        return os.path.join(local_app_data, "Google", "Chrome", PROFILE_DIR_NAME)


def is_port_open(port: int, host: str = "127.0.0.1") -> bool:
    """Check if a TCP port is accepting connections."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        try:
            s.connect((host, port))
            return True
        except (ConnectionRefusedError, socket.timeout, OSError):
            return False


def _clear_crash_state(user_data_dir: str) -> None:
    """Reset Chrome's crash-recovery flag so headless mode doesn't exit early.

    When Chrome is killed externally (e.g. by a scheduler), it leaves the
    profile marked as 'not exited cleanly'.  On the next headless launch,
    Chrome tries to show a restore-session dialog; since headless has no UI it
    exits immediately with code 0.  Writing 'exited_cleanly=true' prevents this.
    """
    targets = [
        os.path.join(user_data_dir, "Local State"),
        os.path.join(user_data_dir, "Default", "Preferences"),
    ]
    for path in targets:
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            changed = False
            # Local State 形态: 顶层 stability/exit_type
            stab = data.get("stability", {})
            if not stab.get("exited_cleanly", True):
                data.setdefault("stability", {})["exited_cleanly"] = True
                changed = True
            if data.get("exit_type") not in ("Normal", None, ""):
                data["exit_type"] = "Normal"
                changed = True
            # Default/Preferences 形态: 嵌套在 profile 下 — 这才是 headless Chrome
            # 启动时实际检查的字段。漏掉它会让 Chrome 看到 "Crashed" → 弹 session-restore
            # 对话框 → headless 无 UI → 立即退出 code 0 (2026-05-26 root cause).
            profile = data.get("profile")
            if isinstance(profile, dict):
                if profile.get("exit_type") not in ("Normal", None, ""):
                    profile["exit_type"] = "Normal"
                    changed = True
                if profile.get("exited_cleanly") is False:
                    profile["exited_cleanly"] = True
                    changed = True
            if changed:
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
                print(f"[chrome_launcher] Cleared crash state: {path}")
        except Exception as e:
            print(f"[chrome_launcher] Warning: failed to clear crash state at {path}: {e}", file=sys.stderr)


def launch_chrome(
    port: int = CDP_PORT,
    headless: bool = False,
    account: Optional[str] = None,
) -> subprocess.Popen | None:
    """
    Launch Chrome with remote debugging enabled.

    Args:
        port: CDP remote debugging port.
        headless: If True, launch Chrome in headless mode (no GUI window).
        account: Account name to use. If None, uses the default account.

    Returns the Popen object if a new process was started, or None if Chrome
    was already running on the target port.
    """
    global _chrome_process, _current_account, _managed_port

    # Make sure orphans get cleaned even on SIGTERM/exception.
    _register_cleanup_once()

    if is_port_open(port):
        if _is_managed_alive(port):
            # Same process, same port — reuse without relaunching.
            print(f"[chrome_launcher] Reusing managed Chrome on port {port} (PID={_chrome_process.pid}).")
            return None
        # Orphan: a Chrome from a previous run is still holding port + profile.
        # If we don't evict it, the new Chrome we launch will be single-instance-
        # forwarded to the orphan and immediately exit with code 0 — the exact
        # failure observed on 2026-05-26. Kill it first.
        print(f"[chrome_launcher] Port {port} occupied by orphan Chrome — evicting before relaunch.")
        kill_chrome(port=port)
        # Give the OS a beat to release the port; bail loudly if it doesn't.
        if is_port_open(port):
            raise RuntimeError(
                f"[chrome_launcher] Failed to free port {port} after killing orphan Chrome. "
                f"Another non-Chrome process may be holding it."
            )

    chrome_path = get_chrome_path()
    user_data_dir = get_user_data_dir(account)
    _current_account = account
    _managed_port = port

    # Clean up stale SingletonLock that prevents Chrome from starting after a crash
    singleton_lock = os.path.join(user_data_dir, "SingletonLock")
    if os.path.exists(singleton_lock):
        try:
            os.remove(singleton_lock)
            print(f"[chrome_launcher] Removed stale SingletonLock: {singleton_lock}")
        except OSError:
            pass

    # Reset crash-recovery state so headless Chrome doesn't exit immediately
    # when the profile was previously killed by an external process (e.g. scheduler).
    _clear_crash_state(user_data_dir)

    cmd = [
        chrome_path,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-allow-origins=*",
        # Prevent the "Chrome didn't shut down correctly" restore bubble /
        # session-restore dialog from causing headless Chrome to exit early.
        "--disable-session-crashed-bubble",
        "--restore-last-session=false",
        "--disable-restore-session-state",
    ]

    if headless:
        cmd.extend(["--headless=new", "--disable-gpu"])

    mode_label = "headless" if headless else "headed"
    account_label = account or "default"
    print(f"[chrome_launcher] Launching Chrome ({mode_label}, account: {account_label})...")
    print(f"  executable : {chrome_path}")
    print(f"  profile dir: {user_data_dir}")
    print(f"  debug port : {port}")

    popen_kwargs: dict = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        # CREATE_NO_WINDOW prevents a console window from blocking startup
        popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    proc = subprocess.Popen(cmd, **popen_kwargs)
    _chrome_process = proc

    # Wait for the debug port to become available.
    #
    # 重要：不能因为 proc.poll() != None 就立即报"启动失败"。Windows 下 Chrome 主进程
    # 经常 fork helper 后自身 exit code 0,helper 接管 9222 — 是正常行为。
    # 真正的"启动失败"信号是 port 在超时窗口内一直没就绪 (端口为主, poll 只作诊断).
    #
    # 在主进程退出后, 给 helper 一个 grace 窗口去接管端口; 仍不通则按超时报错.
    deadline = time.time() + STARTUP_TIMEOUT
    main_exited_logged = False
    while time.time() < deadline:
        if is_port_open(port):
            elapsed = STARTUP_TIMEOUT - (deadline - time.time())
            print(f"[chrome_launcher] Chrome is ready on port {port} ({elapsed:.1f}s).")
            return proc
        if proc.poll() is not None and not main_exited_logged:
            # 仅记录, 不抛错: 等端口在 grace 窗口内是否被 helper 顶上.
            print(
                f"[chrome_launcher] Note: launcher process exited (code {proc.returncode}); "
                f"waiting for helper to surface port {port}..."
            )
            main_exited_logged = True
        time.sleep(0.5)

    # 真正的失败: 超时仍未就绪. 报错信息里带上是否曾观察到主进程退出, 便于排查.
    suffix = " (launcher process exited early; helper never bound port)" if main_exited_logged else ""
    raise TimeoutError(
        f"[chrome_launcher] Chrome did not respond on port {port} within {STARTUP_TIMEOUT}s{suffix}. "
        "Check if another Chrome instance is using the same profile directory, "
        "or try running with --kill first."
    )


def kill_chrome(port: int = CDP_PORT):
    """
    Kill the Chrome instance on the given debug port.

    Tries multiple strategies:
    1. Send CDP Browser.close command via HTTP
    2. Terminate the tracked subprocess
    3. Kill by port on Windows (taskkill)
    """
    global _chrome_process, _managed_port

    # Strategy 1: CDP Browser.close
    try:
        import requests
        resp = requests.get(f"http://127.0.0.1:{port}/json/version", timeout=2)
        if resp.ok:
            ws_url = resp.json().get("webSocketDebuggerUrl")
            if ws_url:
                import websockets.sync.client as ws_client
                ws = ws_client.connect(ws_url)
                ws.send('{"id":1,"method":"Browser.close"}')
                try:
                    ws.recv(timeout=2)
                except Exception:
                    pass
                ws.close()
                print("[chrome_launcher] Sent Browser.close via CDP.")
    except Exception:
        pass

    # Wait briefly for Chrome to shut down
    time.sleep(1)

    # Strategy 2: Terminate tracked subprocess
    if _chrome_process and _chrome_process.poll() is None:
        try:
            _chrome_process.terminate()
            _chrome_process.wait(timeout=5)
            print("[chrome_launcher] Terminated tracked Chrome process.")
        except Exception:
            try:
                _chrome_process.kill()
            except Exception:
                pass
    _chrome_process = None
    _managed_port = None

    # Strategy 3: Windows taskkill by port (fallback)
    if sys.platform == "win32" and is_port_open(port):
        try:
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    pid = line.strip().split()[-1]
                    subprocess.run(
                        ["taskkill", "/F", "/PID", pid],
                        capture_output=True, timeout=5
                    )
                    print(f"[chrome_launcher] Killed process {pid} via taskkill.")
                    break
        except Exception:
            pass

    # Wait for port to be released
    deadline = time.time() + 5
    while time.time() < deadline:
        if not is_port_open(port):
            return
        time.sleep(0.5)

    if is_port_open(port):
        print(f"[chrome_launcher] WARNING: port {port} still open after kill attempt.",
              file=sys.stderr)


def restart_chrome(
    port: int = CDP_PORT,
    headless: bool = False,
    account: Optional[str] = None,
) -> subprocess.Popen | None:
    """
    Kill the current Chrome instance and relaunch with the specified mode.

    Useful for switching between headless and headed mode (e.g. when login
    is needed during a headless session), or switching accounts.

    Args:
        port: CDP remote debugging port.
        headless: If True, relaunch in headless mode.
        account: Account name to use. If None, uses the default account.

    Returns the Popen object for the new Chrome process.
    """
    account_label = account or "default"
    mode_label = "headless" if headless else "headed"
    print(f"[chrome_launcher] Restarting Chrome ({mode_label}, account: {account_label})...")
    kill_chrome(port)
    time.sleep(1)
    return launch_chrome(port, headless=headless, account=account)


def ensure_chrome(
    port: int = CDP_PORT,
    headless: bool = False,
    account: Optional[str] = None,
) -> bool:
    """
    Ensure Chrome is running with remote debugging on the given port.

    Args:
        port: CDP remote debugging port.
        headless: If True, launch in headless mode when starting a new instance.
            If Chrome is already running, this parameter is ignored.
        account: Account name to use. If None, uses the default account.

    Returns True if Chrome is available, False otherwise.
    """
    if is_port_open(port):
        return True
    try:
        launch_chrome(port, headless=headless, account=account)
        return is_port_open(port)
    except Exception as e:
        print(f"[chrome_launcher] Error: {e}", file=sys.stderr)
        return False


def get_current_account() -> Optional[str]:
    """Get the name of the currently active account."""
    return _current_account


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Chrome Launcher for CDP")
    parser.add_argument("--port", type=int, default=CDP_PORT,
                        help=f"CDP remote debugging port (default: {CDP_PORT})")
    parser.add_argument("--headless", action="store_true", help="Launch in headless mode")
    parser.add_argument("--kill", action="store_true", help="Kill the running Chrome instance")
    parser.add_argument("--restart", action="store_true", help="Restart Chrome")
    parser.add_argument("--account", help="Account name to use (default: default account)")
    args = parser.parse_args()

    if args.kill:
        kill_chrome(port=args.port)
        print("[chrome_launcher] Chrome killed.")
    elif args.restart:
        restart_chrome(port=args.port, headless=args.headless, account=args.account)
        print("[chrome_launcher] Chrome restarted.")
    elif ensure_chrome(port=args.port, headless=args.headless, account=args.account):
        print("[chrome_launcher] Chrome is ready for CDP connections.")
    else:
        print("[chrome_launcher] Failed to start Chrome.", file=sys.stderr)
        sys.exit(1)
