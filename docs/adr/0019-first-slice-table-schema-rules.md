# First-slice Table schema rules

Table Fields may declare `required`, `unique`, and constant `default` constraints, while formulas and computed defaults are deferred. A Table may select one Text or Dictionary Field as its Display Field, falling back to stable record identity. Removing a Field creates a recoverable Tombstoned Field with preserved values; permanent purge is a separate approved Operation. Together these rules keep live schema changes useful without silent data loss or premature formula semantics.
