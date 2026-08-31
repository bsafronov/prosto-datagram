# Result Handles are short-lived bound capabilities

A Result Handle is bound to one Datagram Service, actor, and declared purpose, expires quickly, cannot be transferred, and rechecks authorization whenever it is consumed. It grants no broader access than the Query that created it. Durable Data Views persist permission-checked Query definitions and obtain new Handles when reopened; they never persist or share an old Handle as if it were a dataset.
