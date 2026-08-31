# Channel Bundles provide explicit Store portability

Datagram defines a Store-neutral Channel Bundle contract so a Local Store is not a data trap. An authorized export contains selected Channels, their Channel Type version requirements, and included dependencies; import reconstructs that included graph, while references to excluded Channels remain unresolved. This is an explicit export/import path rather than live Store synchronization. The contract is established with the core model, while full import implementation may follow the first vertical slice.
