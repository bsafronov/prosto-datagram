# Initial Workflows are declarative sequences

The first Workflow model executes a declared sequence of Datagram tool calls through its Automation Principal. A run may begin manually, on a schedule, or from Channel Activity. Arbitrary code, loops, and conditional branches are excluded initially, which keeps authorization, replay, limits, and Operation provenance understandable while the core execution contract stabilizes.
