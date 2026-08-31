# Workflow steps commit as separate Operations

Each Workflow step executes and records its own Operation. A failed step stops the Workflow Run while completed steps remain committed; Datagram does not imply transactionality across a run or pretend that external effects were rolled back. Automatic retry is limited to steps with an explicit idempotency contract, and the run records every attempt and failure.
