# Derived values also bypass the AI Agent

The zero-data boundary includes filtered records, counts, aggregates, labels, and other values derived from stored data. When a person asks for a result, the AI Agent may construct and connect tool calls, but the final Result Handle is rendered by the host as a Data View without returning its values to model context. The Agent may report that it completed the requested operation but cannot make a value-dependent claim such as which month was highest. Deterministic tools may produce human-facing reports, but those reports also bypass the Agent.
