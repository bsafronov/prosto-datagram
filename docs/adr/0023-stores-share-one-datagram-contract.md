# Stores share one Datagram contract

Datagram supports multiple persistence implementations behind one Store contract. Local bootstrap runs the normal Datagram service with a SQLite Local Store; server deployment uses a PostgreSQL Server Store. UI, CLI, MCP, Channel Types, permissions, Operations, and realtime behavior use the same application contract in both modes. Store-to-Store synchronization is outside the first slice: collaboration requires clients to connect to the same authoritative service.
