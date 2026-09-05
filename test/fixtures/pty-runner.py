import os
import json
import fcntl
import pty
import re
import select
import subprocess
import struct
import sys
import time
import termios


master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
steps = iter(json.load(sys.stdin))
step = next(steps, None)
since_input = bytearray()
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
            since_input.extend(chunk)
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            if b'Setup complete.' in output:
                completed_at = time.monotonic()
            visible = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', since_input)
            if step is not None and step['waitFor'].encode() in visible:
                # Wait until the prompt owns the terminal before sending keys.
                time.sleep(0.05)
                os.write(master, step['keys'].encode())
                since_input.clear()
                step = next(steps, None)
    if completed_at is not None and time.monotonic() - completed_at >= 1:
        # End only the test subprocess after its final receipt if a runtime
        # integration keeps an input handle alive under the synthetic PTY.
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
