# Channels pin Channel Type Versions

Each Channel pins an immutable Channel Type Version rather than following the newest installed version automatically. A Type Upgrade previews schema and behavior changes, requires Channel Owner approval, and applies as one atomic Operation. Deployment Operators may disable an unsafe version without gaining Channel access, while data remains available for recovery, export, or a safe migration path wherever the host can render it generically.
