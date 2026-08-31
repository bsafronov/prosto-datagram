# Channel deletion is shared and recoverable

Deleting a Channel changes it to a shared, recoverable Deleted Channel state and hides it from normal use. This is distinct from a person's Archive group. Channel References to the deleted Channel become unresolved and resolve again if it is restored. Permanent purge is a separate destructive Operation requiring explicit approval and never cascades into referencing Channels.
