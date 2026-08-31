# Channel Types produce semantic View Definitions

Channel Types declare or produce semantic JSON View Definitions containing meaning, data bindings, and available commands. They do not emit React components, HTML, terminal formatting, or other host-specific presentation. Each UI, CLI, or future host maps supported semantics to native presentation and uses a generic fallback for unsupported definitions. This keeps Datagram headless while allowing different hosts to improve independently.
