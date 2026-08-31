# Table Record deletion uses tombstones

Deleting a Table Record creates a Tombstoned Record rather than immediately purging it. The Record retains its stable identity and values for restoration, and Record Reference Fields display a deleted target instead of losing the link. Restoration reactivates the same identity. Permanent purge is a separate destructive Operation and never cascades into referencing Records.
