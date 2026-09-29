"""Run a command inside a pseudo-terminal, relaying stdin to it and its output to stdout.

The interactive OMP TUI needs a real terminal, and Bun has no PTY API, so scripts/e2e.ts launches the TUI through this
wrapper and types into it over stdin.
"""

import errno
import os
import pty
import selectors
import signal
import sys

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])


def forward(signum, _frame):
    try:
        os.kill(pid, signum)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)

selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ, "pty")
selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "stdin")

while True:
    try:
        ready = selector.select()
    except InterruptedError:
        continue
    for key, _ in ready:
        if key.data == "pty":
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    data = b""
                else:
                    raise
            if not data:
                _, status = os.waitpid(pid, 0)
                sys.exit(os.waitstatus_to_exitcode(status))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        else:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                selector.unregister(sys.stdin.fileno())
                continue
            os.write(master, data)
