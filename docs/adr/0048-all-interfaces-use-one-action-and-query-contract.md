# All interfaces use one Action and Query contract

Each Channel Type declares typed, discoverable Channel Actions and Channel Queries. UI, CLI, MCP, AI Agent, and Workflow clients call these same contracts rather than owning private behavior. Every accepted Action executes through the application boundary and produces an Operation; Queries enforce the same permissions while adapting their output to the calling surface. This is the mechanism behind prompt, CLI, and UI control parity.
