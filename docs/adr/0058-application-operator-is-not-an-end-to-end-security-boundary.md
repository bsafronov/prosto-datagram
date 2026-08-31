# Application operator is not an end-to-end security boundary

Deployment Operator actions do not grant Channel membership or application-level access to Channel data. A person who controls the underlying host, database, backups, or encryption keys can nevertheless inspect raw storage. The first release does not claim protection from that infrastructure operator because server-side Query, Search, and aggregation require readable data. End-to-end encryption is deferred and must be treated as a different execution architecture rather than a configuration flag.
