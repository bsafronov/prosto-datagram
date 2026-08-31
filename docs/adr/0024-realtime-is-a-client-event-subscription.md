# Realtime is a client event subscription

After loading initial state, any authorized client may subscribe to Channel Activity and Operation-result events from the Datagram service. This supports CLI, MCP-adjacent hosts, and future UI clients equally; realtime is not a UI concern. The application protocol defines event identity, ordering, authorization, and reconnection semantics independently from whether the first transport is SSE or WebSocket.
