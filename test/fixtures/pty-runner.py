import os
import pty
import select
import subprocess
import sys
import time


master, slave = pty.openpty()
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
os.write(master, sys.stdin.buffer.read())
output = bytearray()
deadline = time.monotonic() + 120
completed_at = None

while process.poll() is None:
    if time.monotonic() >= deadline:
        process.terminate()
        process.wait(timeout=5)
        raise SystemExit(124)
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            chunk = b''
        if chunk:
            output.extend(chunk)
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            if b'Setup complete.' in output:
                completed_at = time.monotonic()
    if completed_at is not None and time.monotonic() - completed_at >= 1:
        # Bun keeps the terminal input iterator alive under a synthetic PTY.
        # Setup has emitted its final receipt, so end only the test subprocess.
        process.terminate()
        process.wait(timeout=5)
        raise SystemExit(0)

while True:
    ready, _, _ = select.select([master], [], [], 0)
    if not ready:
        break
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    sys.stdout.buffer.write(chunk)

raise SystemExit(process.returncode)
