# Field Type Conversion requires explicit failure resolution

A Field Type Conversion previews every value that cannot satisfy the target type. Before commit, an Admin or Owner must correct or map each failure, explicitly replace it with `null` when the target Field permits null, or cancel the conversion. Original Field values remain recoverable for restore and undo until a separate purge. No conversion silently coerces or discards data.
