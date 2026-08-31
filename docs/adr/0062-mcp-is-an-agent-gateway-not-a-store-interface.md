# MCP is an agent gateway, not a Store interface

Datagram exposes typed Channel Actions and Channel Queries to authenticated agents through an MCP Gateway. Store implementations remain behind the internal Store contract so they cannot bypass domain validation, permissions, Operations, or Activity. Future external MCP tools may be wrapped by declared Datagram capabilities, but a Channel Type or Agent cannot use MCP to write around the application boundary.
