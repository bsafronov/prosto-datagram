# SQLite precedes PostgreSQL behind conformance tests

The Local Store backed by SQLite is implemented first. A Store conformance suite defines required transactional, query, identity, reference, and Operation behavior independently from its database. The PostgreSQL Server Store must pass the same suite before multi-user sharing is declared complete. No replication or Store synchronization layer is added.
