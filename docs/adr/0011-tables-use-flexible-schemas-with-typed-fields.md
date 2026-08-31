# Tables use flexible schemas with typed Fields

A Table may add Fields while records exist, and different Fields may use different types, but each Table Field has one declared type. Changing a Field type requires a conversion preview and an explicit invalid-value policy; the system never silently coerces or discards data. This interprets hybrid typing as schema flexibility with field-level guarantees rather than mixed value types inside one Field.
