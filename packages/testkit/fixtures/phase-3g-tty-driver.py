#!/usr/bin/env python3

import errno
import fcntl
import os
import re
import select
import signal
import struct
import sys
import termios
import time


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: phase-3g-tty-driver.py NODE FIXTURE")
    node, fixture = sys.argv[1:]
    pid, master = os.forkpty()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execv(node, [node, fixture])

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    steps = [
        ("ready · idle".encode(), b"Review the Stage"),
        (b"> Review the Stage", b"\r"),
        (b"Stage acceptance required", b"y"),
        (b"Tool update_plan: success", b"/plan"),
        (b"> /plan", b"\r"),
        (b"Durable Plan", None),
        (b"Stage 1/1 [accepted]", b"\x1b"),
    ]
    output = bytearray()
    step = 0
    interrupt_at = None
    deadline = time.monotonic() + 20
    status = None
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                output.extend(chunk)
            visible_output = strip_terminal_control(output)
            if step < len(steps) and steps[step][0] in visible_output:
                response = steps[step][1]
                if response is not None:
                    os.write(master, response)
                step += 1
                if step == len(steps):
                    interrupt_at = time.monotonic() + 0.25
            if interrupt_at is not None and time.monotonic() >= interrupt_at:
                os.write(master, b"\x03")
                interrupt_at = None
            waited, candidate = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = candidate
                break
        if status is None:
            terminate_child(pid)
            raise RuntimeError(
                f"TTY fixture timed out after step {step}/{len(steps)}"
            )
    finally:
        os.close(master)
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()

    if step != len(steps):
        raise RuntimeError(f"TTY fixture exited after step {step}/{len(steps)}")
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise RuntimeError(f"TTY fixture exited with wait status {status}")
    return 0


def terminate_child(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return
        time.sleep(0.02)

    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)


def strip_terminal_control(output: bytearray) -> bytes:
    return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(output)).replace(
        b"\r", b""
    )


if __name__ == "__main__":
    raise SystemExit(main())
