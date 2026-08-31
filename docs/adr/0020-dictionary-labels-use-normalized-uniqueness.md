# Dictionary labels use normalized uniqueness

Dictionary Entry labels are trimmed, Unicode-normalized, and unique without regard to case while preserving the chosen display casing. Values such as `Apples`, `apples`, and ` Apples ` therefore identify one conflicting label rather than separate Entries. Stable Entry identities remain authoritative so renaming a label does not rewrite consuming Table Records.
