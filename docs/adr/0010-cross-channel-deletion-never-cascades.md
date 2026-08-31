# Cross-Channel deletion never cascades

Deleting a Channel or Channel Record never deletes independently owned data through a Channel Reference. Targets first become recoverable tombstones, and surviving references remain unresolved; permanent deletion requires an explicit action with reference-impact preview. This favors recovery and independent Channel ownership over automatic referential cleanup.
