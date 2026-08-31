# Concurrent Table edits conflict per Field

Concurrent edits to different Fields of one Table Record may merge, while a stale edit to the same Field is rejected and returns the current value. Multi-record Operations remain atomic. This avoids silent last-write-wins data loss without turning every independent Field change into a whole-record conflict.
