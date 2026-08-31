# Live References do not cross Datagram Services

Channel References and Record Reference Fields resolve only within one authoritative Datagram Service. Services do not perform live cross-Service queries, authorization, or synchronization. Channel Bundles provide explicit export/import; references to Channels excluded from a Bundle remain unresolved after import until an authorized mapping is supplied.
