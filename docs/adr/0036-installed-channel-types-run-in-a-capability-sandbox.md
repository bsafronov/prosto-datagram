# Installed Channel Types run in a Capability Sandbox

Bundled Channel Types begin as trusted implementations, but the contract assumes future installed logic runs in a Capability Sandbox. Type code has no direct Store, network, filesystem, or secret access. It requests explicitly declared Datagram capabilities, which enforce authorization, validation, limits, and audit through normal Operations. Integrations must therefore enter through mediated capabilities rather than unrestricted type code.
