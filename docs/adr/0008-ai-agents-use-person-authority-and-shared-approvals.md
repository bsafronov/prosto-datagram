# AI Agents use person authority and shared approvals

An AI Agent acts with the requesting person's identity and permissions through the same Datagram actions used by UI, CLI, MCP, and other clients. Reads, previews, and small reversible writes may proceed directly; bulk, destructive, irreversible, externally costly, or data-exposing actions require explicit approval. The Agent plans with schemas and opaque Result Handles rather than stored values. This preserves interface parity without giving prompts a privileged mutation path or data path.
