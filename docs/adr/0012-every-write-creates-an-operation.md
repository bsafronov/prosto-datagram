# Every write creates an Operation

Every state change from UI, CLI, MCP, AI Agent, Workflow, or API executes as one atomic Operation through the same application contract. Operations record actor, origin, changes, and result, produce relevant Channel Activity, and retain enough information for conflict-safe undo when possible. No interface receives a direct-write bypass.
